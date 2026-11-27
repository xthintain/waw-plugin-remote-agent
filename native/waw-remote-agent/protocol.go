package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const maxFrameBytes = 16 << 20
const maxOutputBytes = 512 << 10

/**
 * The worker protocol this binary speaks.
 *
 * 5: background jobs (`job_*`) and a capability list in `ping`. Bump it whenever
 * the host must refuse an older binary — an added method alone does not, because
 * `ping.methods` already lets the host route around it.
 *
 * 6: Windows hosts run commands through PowerShell and advertise it in `ping`
 * (`os` / `shell` / `capabilities`). Only the Windows bootstrap requires 6; POSIX
 * remotes keep working on 5 so the upgrade does not force a reinstall of every
 * existing Linux agent.
 *
 * `mkdir` and `move` were removed in 5: `exec` expresses both exactly, and two
 * implementations of the same operation meant two sets of semantics to keep in
 * step. `remove` keeps its handler because the "cannot remove a configured root"
 * guard has no shell equivalent; `stat` keeps its because parsing `ls` output is
 * not portable.
 */
const protocolVersion = 6

var workerMethods = []string{
	"ping",
	"exec",
	"read_file",
	"write_file",
	"stat",
	"list_dir",
	"remove",
	"job_start",
	"job_status",
	"job_output",
	"job_kill",
	"cancel",
	"shutdown",
}

var workerFeatures = []string{"jobs"}

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Token  string          `json:"token"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID     string      `json:"id"`
	OK     bool        `json:"ok"`
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

type helloMsg struct {
	Type      string `json:"type"`
	AgentID   string `json:"agentId"`
	Token     string `json:"token"`
	Workspace string `json:"workspace"`
	Hostname  string `json:"hostname,omitempty"`
}

type execParams struct {
	Command   string `json:"command"`
	Cwd       string `json:"cwd"`
	TimeoutMs int    `json:"timeoutMs"`
	/** Which shell the command was written for: auto (default), powershell, gitbash/posix. */
	Shell string `json:"shell"`
}

type pathParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mkdir   bool   `json:"mkdir"`
}

type removeParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

type jobStartParams struct {
	Command string `json:"command"`
	Cwd     string `json:"cwd"`
	/** Same meaning as exec's shell: auto (default), powershell, gitbash/posix. */
	Shell string `json:"shell"`
}

type jobIDParams struct {
	JobID string `json:"jobId"`
}

type jobOutputParams struct {
	JobID     string `json:"jobId"`
	OutOffset int64  `json:"outOffset"`
	ErrOffset int64  `json:"errOffset"`
	MaxBytes  int    `json:"maxBytes"`
}

type cancelParams struct {
	ID string `json:"id"`
}

type frameWriter interface {
	WriteFrame(payload []byte) error
}

type agent struct {
	workspace string
	/** 允许访问的根目录集合（第一个是默认工作区）。 */
	roots     []string
	/** 本机可用的 shell：POSIX 只有 bash/sh；Windows 有 PowerShell + 可选 Git Bash（见 shell.go）。 */
	shells    shellSet
	token     string
	agentID   string
	mu        sync.Mutex
	cancels   map[string]context.CancelFunc
	outMu     sync.Mutex
	writer    frameWriter

	/** Background jobs (job_start family). Guarded by jobMu. */
	jobMu    sync.Mutex
	jobs     map[string]*job
	jobDir   string
	jobLimit int
}

type stdioWriter struct {
	w io.Writer
}

func (s *stdioWriter) WriteFrame(payload []byte) error {
	return writeFrame(s.w, payload)
}

type wsWriter struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (w *wsWriter) WriteFrame(payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.WriteMessage(websocket.BinaryMessage, payload)
}

func newAgent(workspace, token, agentID string, writer frameWriter, roots ...string) *agent {
	allowed := normalizeRoots(workspace, roots)
	return &agent{
		workspace: workspace,
		roots:     allowed,
		shells:    defaultShells(),
		token:     token,
		agentID:   agentID,
		cancels:   make(map[string]context.CancelFunc),
		writer:    writer,
		jobs:      make(map[string]*job),
		jobLimit:  64,
	}
}

func unwrapWSPayload(data []byte) []byte {
	// 兼容控制面误发「长度前缀 + JSON」整包作为单条 WS 消息的情况
	if len(data) >= 4 {
		n := binary.BigEndian.Uint32(data[:4])
		if n > 0 && int(n) <= len(data)-4 && n < maxFrameBytes {
			inner := data[4 : 4+n]
			if json.Valid(inner) {
				return inner
			}
		}
	}
	return data
}

func (a *agent) serveReader(readFrame func() ([]byte, error)) error {
	for {
		frame, err := readFrame()
		if err != nil {
			return err
		}
		var req request
		if err := json.Unmarshal(frame, &req); err != nil {
			_ = a.writeResponse(response{ID: "", OK: false, Error: "invalid json"})
			continue
		}
		// 跳过 welcome / hello 等控制消息
		if strings.TrimSpace(req.Method) == "" {
			continue
		}
		if req.Token != a.token {
			_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "unauthorized"})
			continue
		}
		go a.handle(req)
	}
}

func (a *agent) serveStdio(in io.Reader) error {
	return a.serveReader(func() ([]byte, error) { return readFrame(in) })
}

func (a *agent) serveWS(conn *websocket.Conn) error {
	return a.serveReader(func() ([]byte, error) {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return nil, err
		}
		if mt != websocket.BinaryMessage && mt != websocket.TextMessage {
			return nil, fmt.Errorf("unexpected ws message type %d", mt)
		}
		return unwrapWSPayload(data), nil
	})
}

func (a *agent) handle(req request) {
	switch req.Method {
	case "ping":
		host, _ := os.Hostname()
		shellError := ""
		if a.shells.err != nil {
			shellError = a.shells.err.Error()
		}
		posixShell := ""
		if a.shells.posix != nil {
			posixShell = a.shells.posix.name
		}
		_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]interface{}{
			"pong":            "ok",
			"hostname":        host,
			"workspace":       a.workspace,
			"agentId":         a.agentID,
			"roots":           a.roots,
			"protocolVersion": protocolVersion,
			// The host has to know WHICH shells the model's commands can land in:
			// a Windows remote defaults to PowerShell and may also have Git Bash,
			// which is what makes the POSIX-only tools (snapshots, codemap) usable.
			"os":         runtime.GOOS,
			"shell":      a.shells.primary.name,
			"shells":     a.shells.names,
			"posixShell": posixShell,
			"shellError": shellError,
			"capabilities": map[string]interface{}{
				"posixScripts": a.shells.posix != nil,
				"powershell":   a.shells.err == nil && a.shells.primary.flavor == "powershell",
			},
			// The tool surface, advertised so the host routes only what this
			// binary can actually do — a host-side hardcoded list went stale
			// every time a method was added or removed.
			"methods":  workerMethods,
			"features": workerFeatures,
		}})
	case "exec":
		a.handleExec(req)
	case "read_file":
		a.handleRead(req)
	case "write_file":
		a.handleWrite(req)
	case "stat":
		a.handleStat(req)
	case "list_dir":
		a.handleListDir(req)
	case "remove":
		a.handleRemove(req)
	case "job_start":
		a.handleJobStart(req)
	case "job_status":
		a.handleJobStatus(req)
	case "job_output":
		a.handleJobOutput(req)
	case "job_kill":
		a.handleJobKill(req)
	case "cancel":
		var p cancelParams
		_ = json.Unmarshal(req.Params, &p)
		a.mu.Lock()
		cancel := a.cancels[p.ID]
		a.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]bool{"cancelled": cancel != nil}})
	case "shutdown":
		a.killAllJobs()
		_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]string{"bye": "ok"}})
		os.Exit(0)
	default:
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "unknown method"})
	}
}

func (a *agent) handleExec(req request) {
	var p execParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "bad params"})
		return
	}
	cmdLine := strings.TrimSpace(p.Command)
	if cmdLine == "" {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "command required"})
		return
	}
	cwd := a.workspace
	if strings.TrimSpace(p.Cwd) != "" {
		resolved, err := a.resolveInside(p.Cwd)
		if err != nil {
			_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
			return
		}
		cwd = resolved
	}
	timeout := time.Duration(p.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	a.mu.Lock()
	a.cancels[req.ID] = cancel
	a.mu.Unlock()
	defer func() {
		cancel()
		a.mu.Lock()
		delete(a.cancels, req.ID)
		a.mu.Unlock()
	}()

	cmd, shellErr := a.commandFor(ctx, p.Shell, cmdLine)
	if shellErr != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: shellErr.Error()})
		return
	}
	cmd.Dir = cwd
	armCancel(cmd)
	stdout, errOut, err := runCapture(cmd)
	exit := 0
	if err != nil {
		// Ask WHY the wait ended BEFORE classifying the error: exec.CommandContext
		// kills the process on deadline, so a timeout arrives as *exec.ExitError
		// too — checking it first reported `OK:true, exitCode:-1` and the caller
		// never learned it had timed out.
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "timeout"})
			return
		case errors.Is(ctx.Err(), context.Canceled):
			_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "cancelled"})
			return
		}
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exit = ee.ExitCode()
		} else {
			_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
			return
		}
	}
	_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]interface{}{
		"stdout":   truncate(stdout),
		"stderr":   truncate(errOut),
		"exitCode": exit,
	}})
}

func (a *agent) handleRead(req request) {
	var p pathParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "bad params"})
		return
	}
	path, err := a.resolveInside(p.Path)
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]string{"content": string(b)}})
}

func (a *agent) handleWrite(req request) {
	var p pathParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "bad params"})
		return
	}
	path, err := a.resolveInside(p.Path)
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	if p.Mkdir {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
			return
		}
	}
	if err := os.WriteFile(path, []byte(p.Content), 0o644); err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]string{"path": path}})
}

func (a *agent) handleStat(req request) {
	var p pathParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "bad params"})
		return
	}
	path, err := a.resolveInside(p.Path)
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	st, err := os.Stat(path)
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]interface{}{
		"path":    path,
		"size":    st.Size(),
		"isDir":   st.IsDir(),
		"mode":    st.Mode().String(),
		"modTime": st.ModTime().UTC().Format(time.RFC3339),
	}})
}

func (a *agent) handleListDir(req request) {
	var p pathParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "bad params"})
		return
	}
	path, err := a.resolveInside(p.Path)
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	out := make([]map[string]interface{}, 0, len(entries))
	for _, e := range entries {
		item := map[string]interface{}{
			"name":  e.Name(),
			"isDir": e.IsDir(),
		}
		if info, err := e.Info(); err == nil {
			item["size"] = info.Size()
			item["modTime"] = info.ModTime().UTC().Format(time.RFC3339)
		}
		out = append(out, item)
	}
	_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]interface{}{
		"path":    path,
		"entries": out,
	}})
}

func (a *agent) handleRemove(req request) {
	var p removeParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "bad params"})
		return
	}
	path, err := a.resolveInside(p.Path)
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	// EVERY configured root is off limits, not just --workspace: `--root /data/ws2`
	// is a place this agent may work IN, and a recursive remove of the root itself
	// would wipe the whole tree the operator meant to expose (both sides resolved,
	// so "rm ." and a symlink to the root are refused too).
	real := realPath(path)
	for _, root := range a.roots {
		if real == realPath(root) {
			_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "cannot remove root"})
			return
		}
	}
	if p.Recursive {
		err = os.RemoveAll(path)
	} else {
		err = os.Remove(path)
	}
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]string{"path": path}})
}

// normalizeRoots 把 --workspace 与若干 --root 归一成去重后的绝对路径集合。
// --workspace 永远在集合里，并作为相对路径的基准与默认 cwd。
func normalizeRoots(workspace string, extra []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(extra)+1)
	add := func(raw string) {
		if strings.TrimSpace(raw) == "" {
			return
		}
		path := filepath.Clean(raw)
		if !filepath.IsAbs(path) {
			// A relative --root silently widening nothing is a setup mistake the
			// operator must hear about: the agent would otherwise run with fewer
			// roots than the command line reads as.
			fmt.Fprintf(os.Stderr, "[agent] ignoring non-absolute --root %q (roots must be absolute)\n", raw)
			return
		}
		if seen[path] {
			return
		}
		seen[path] = true
		out = append(out, path)
	}
	if filepath.IsAbs(workspace) {
		add(workspace)
	}
	for _, root := range extra {
		add(root)
	}
	if len(out) == 0 && filepath.IsAbs(workspace) {
		out = append(out, filepath.Clean(workspace))
	}
	return out
}

// insideRoot：cand 等于 root 或位于其下。
//
// 用 filepath.Rel 而不是 "root + 分隔符" 前缀比较：前缀法在 Windows 盘符根
//（C:\）上会拼出双分隔符，把该根下的所有路径都当成越界；Rel 还会把卷不同的
// 路径判为错误（越界），这正是我们要的。
func insideRoot(cand, root string) bool {
	rel, err := filepath.Rel(root, cand)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}

// realPath 解析符号链接，但对「尚不存在的路径」保留其已存在的祖先。
//
// 只做 Clean 的围栏挡不住根内的 symlink 指向根外：写入会顺着链接落到被禁
// 止的位置。path 本身可能是待创建文件，所以逐步向上找到第一个存在的祖先，
// 解析它，再把剩余部分拼回去。
func realPath(path string) string {
	clean := filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(clean); err == nil {
		return resolved
	}
	parent := filepath.Dir(clean)
	if parent == clean {
		return clean
	}
	return filepath.Join(realPath(parent), filepath.Base(clean))
}

func (a *agent) resolveInside(raw string) (string, error) {
	cand := raw
	if !filepath.IsAbs(cand) {
		cand = filepath.Join(a.workspace, cand)
	}
	cand = filepath.Clean(cand)
	real := realPath(cand)
	for _, root := range a.roots {
		// Both sides are resolved, so a root that IS a symlink still matches.
		if insideRoot(real, realPath(root)) {
			return cand, nil
		}
	}
	return "", errors.New("path outside allowed roots")
}

func (a *agent) writeResponse(resp response) error {
	b, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	a.outMu.Lock()
	defer a.outMu.Unlock()
	return a.writer.WriteFrame(b)
}

func dialAndServe(wsURL, token, agentID, workspace string, roots []string) error {
	u, err := url.Parse(wsURL)
	if err != nil {
		return err
	}
	q := u.Query()
	q.Set("token", token)
	q.Set("agentId", agentID)
	u.RawQuery = q.Encode()

	conn, _, err := websocket.DefaultDialer.Dial(u.String(), http.Header{})
	if err != nil {
		return err
	}
	defer conn.Close()

	host, _ := os.Hostname()
	hello, _ := json.Marshal(helloMsg{
		Type:      "hello",
		AgentID:   agentID,
		Token:     token,
		Workspace: workspace,
		Hostname:  host,
	})
	if err := conn.WriteMessage(websocket.TextMessage, hello); err != nil {
		return err
	}

	a := newAgent(workspace, token, agentID, &wsWriter{conn: conn}, roots...)
	return a.serveWS(conn)
}

func readFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 || n > maxFrameBytes {
		return nil, fmt.Errorf("invalid frame size %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func writeFrame(w io.Writer, payload []byte) error {
	if len(payload) > maxFrameBytes {
		return errors.New("frame too large")
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func runCapture(cmd *exec.Cmd) (string, string, error) {
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

func truncate(s string) string {
	if len(s) <= maxOutputBytes {
		return s
	}
	return s[:maxOutputBytes] + "\n…[truncated]"
}
