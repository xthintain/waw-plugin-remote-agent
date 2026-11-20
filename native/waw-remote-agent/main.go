package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	workspace := flag.String("workspace", "", "workspace root (required)")
	var roots stringList
	flag.Var(&roots, "root", "additional allowed root (repeatable); --workspace is always allowed")
	token := flag.String("token", "", "auth token (required)")
	agentID := flag.String("agent-id", "", "stable agent id (required for --dial-ws)")
	dialWS := flag.String("dial-ws", "", "dial control plane WebSocket URL (web 平台逆连)")
	dialHTTP := flag.String("dial-http", "", "dial control plane HTTP base URL, e.g. http://127.0.0.1:5191 (TUI host 长轮询)")
	daemon := flag.Bool("daemon", false, "run as常驻 daemon supervisor（派生 worker，常驻控制面）")
	daemonWorker := flag.Bool("daemon-worker", false, "internal: run as the worker child spawned by daemon")
	idleStop := flag.Duration(
		"idle-stop",
		30*time.Minute,
		"daemon: stop all workers after this long without a control-plane connection (daemon stays)",
	)
	flag.Parse()

	if strings.TrimSpace(*workspace) == "" || strings.TrimSpace(*token) == "" {
		fmt.Fprintln(os.Stderr, "usage: waw-remote-agent --workspace <abs> --token <tok> [--dial-ws URL | --dial-http URL] [--agent-id ID] [--daemon]")
		os.Exit(2)
	}
	ws, err := filepath.Abs(*workspace)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	ws = filepath.Clean(ws)
	id := strings.TrimSpace(*agentID)
	if id == "" {
		host, _ := os.Hostname()
		id = host
	}

	switch {
	case *daemon:
		// daemon 模式：常驻 supervisor，派生 worker 子进程，自身以 <agentId>:daemon 连控制面
		if err := runDaemon(daemonConfig{
			workspace: ws,
			roots:     roots,
			token:     *token,
			agentID:   id,
			dialWS:    strings.TrimSpace(*dialWS),
			dialHTTP:  strings.TrimSpace(*dialHTTP),
			idleStop:  *idleStop,
		}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	case *daemonWorker:
		// worker 子进程（由 daemon 派生）：以 <agentId> 连控制面，走常规工具面
		if err := serveToolAgent(ws, roots, *token, id, strings.TrimSpace(*dialWS), strings.TrimSpace(*dialHTTP)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	// 兼容旧调用：无 --daemon / --daemon-worker，直接作为 worker 运行
	if err := serveToolAgent(ws, roots, *token, id, strings.TrimSpace(*dialWS), strings.TrimSpace(*dialHTTP)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// serveToolAgent：worker 主体。--dial-http 走 TUI host 长轮询；--dial-ws 逆连 web
// 平台；都没有则走 stdio（SSH 管道场景）。两者同时给以 --dial-http 为准，并在
// 启动时明说，避免用户以为另一个配置生效了。
// stringList 是 repeatable 的字符串 flag（--root a --root b）。
type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }

func (s *stringList) Set(value string) error {
	*s = append(*s, value)
	return nil
}

func serveToolAgent(ws string, roots []string, token, agentID, dialWS, dialHTTP string) error {
	if dialHTTP != "" {
		if dialWS != "" {
			fmt.Fprintln(os.Stderr, "[agent] both --dial-ws and --dial-http given; using --dial-http")
		}
		return serveHTTP(dialHTTP, token, agentID, ws, roots)
	}
	if dialWS != "" {
		return dialAndServe(dialWS, token, agentID, ws, roots)
	}
	a := newAgent(ws, token, agentID, &stdioWriter{w: os.Stdout}, roots...)
	return a.serveStdio(os.Stdin)
}
