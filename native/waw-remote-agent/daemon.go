package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// daemonConfig：daemon 启动参数（由 main 传入）。
type daemonConfig struct {
	workspace string
	roots     []string
	token     string
	agentID   string
	// dialWS / dialHTTP：二选一。WS 是 web 平台的逆连方式；HTTP 长轮询是 TUI host。
	// 两者都为空时 daemon 拒绝启动（没有控制面就无从唤醒 worker）。
	dialWS   string
	dialHTTP string
	// idleStop：控制面断开后，多久关闭全部 worker（保留 daemon）。默认 30m。
	idleStop time.Duration
}

// controlPlane：把两种传输收敛成「读一帧 + 写一帧 + 关闭」。
//
// daemon 的 RPC 分发、worker 唤醒、空闲回收都只依赖这三个动作，因此 WS 逆连与
// HTTP 长轮询在 supervisor 里是同一条代码路径。
type controlPlane struct {
	read  func() ([]byte, error)
	write frameWriter
	close func()
}

// defaultIdleStop：WAW 关闭后保留 worker 的宽限期。
const defaultIdleStop = 30 * time.Minute

// workerState：worker 子进程状态。
type workerState string

const (
	workerRunning  workerState = "running"
	workerStopped  workerState = "stopped"
	workerStarting workerState = "starting"
)

// daemonStatus：daemon_status RPC 返回体。
type daemonStatus struct {
	Daemon  string             `json:"daemon"`
	AgentID string             `json:"agentId"`
	Worker  workerStatusDetail `json:"worker"`
}

type workerStatusDetail struct {
	State workerState `json:"state"`
	PID   int         `json:"pid,omitempty"`
}

type daemonParams struct {
	// 预留：可传额外参数（如 restart 延迟）
	DelayMs int `json:"delayMs,omitempty"`
}

// daemon：常驻 supervisor。自身连控制面（agentId:daemon），派生子进程 worker。
type daemon struct {
	cfg           daemonConfig
	daemonAgentID string

	mu            sync.Mutex
	workerCmd     *exec.Cmd
	workerPID     int
	workerDone    chan struct{}
	state         workerState
	stopRequested bool // 不自动重启（空闲回收或显式 stop）
	userStopped   bool // 显式 daemon_stop：跨重连也保持停止
	idleTimer     *time.Timer
	idleTimeout   time.Duration

	// 测试注入：默认走真实进程。
	startWorkerFn func(self string) error
	killStraysFn  func()

	cancels map[string]context.CancelFunc
	frames  frameWriter
}

// synthFrameWriter：daemon 用 WS 连接写响应。
type synthFrameWriter struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (w *synthFrameWriter) WriteFrame(payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.WriteMessage(websocket.BinaryMessage, payload)
}

func runDaemon(cfg daemonConfig) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if cfg.dialWS == "" && cfg.dialHTTP == "" {
		return fmt.Errorf("daemon requires --dial-ws or --dial-http")
	}
	idle := cfg.idleStop
	if idle <= 0 {
		idle = defaultIdleStop
	}
	d := &daemon{
		cfg:           cfg,
		daemonAgentID: cfg.agentID + ":daemon",
		state:         workerStopped,
		idleTimeout:   idle,
		cancels:       make(map[string]context.CancelFunc),
	}

	// 常驻重连控制面。WAW 未启动时只等待，绝不派生 worker；断线后 worker 保留
	// idleTimeout 宽限期，到期再由 daemon 统一回收（daemon 自身常驻负责唤醒）。
	return d.superviseControlPlane(self)
}

// superviseControlPlane：控制面重连循环（daemon 的唯一阻塞点）。
func (d *daemon) superviseControlPlane(self string) error {
	backoff := time.Second
	for {
		cp, err := d.dialControlPlane()
		if err != nil {
			// WAW 不在线：保持 daemon 常驻，worker 不启动也不重试拉起。
			fmt.Fprintf(os.Stderr, "[daemon] control plane unavailable: %v; worker stays stopped\n", err)
			time.Sleep(backoff)
			if backoff < 30*time.Second {
				backoff *= 2
				if backoff > 30*time.Second {
					backoff = 30 * time.Second
				}
			}
			continue
		}
		backoff = time.Second
		d.frames = cp.write
		d.onControlPlaneConnected(self)
		err = d.serveControlPlane(cp.read)
		cp.close()
		d.onControlPlaneDisconnected()
		if err != nil {
			fmt.Fprintf(os.Stderr, "[daemon] control plane disconnected: %v\n", err)
		}
	}
}

// dialControlPlane：按配置选传输。HTTP 传输在这里完成注册，所以「连上」的含义
// 对两种传输一致：注册成功且首帧可读。
func (d *daemon) dialControlPlane() (*controlPlane, error) {
	if d.cfg.dialHTTP != "" {
		tr, err := newHTTPTransport(d.cfg.dialHTTP, d.cfg.token, d.daemonAgentID, d.cfg.workspace)
		if err != nil {
			return nil, err
		}
		if err := tr.register(); err != nil {
			tr.close()
			return nil, err
		}
		tr.start()
		return &controlPlane{read: tr.nextFrame, write: tr, close: tr.close}, nil
	}
	conn, err := dialDaemonWS(d.cfg.dialWS, d.cfg.token, d.daemonAgentID, d.cfg.workspace)
	if err != nil {
		return nil, err
	}
	return &controlPlane{
		read:  wsReadFn(conn),
		write: &synthFrameWriter{conn: conn},
		close: func() { _ = conn.Close() },
	}, nil
}

// wsReadFn：把 WS 连接包装成逐帧读取。控制面若误发「长度前缀 + JSON」整包，这里
// 与 worker 侧一样做兼容拆包。
func wsReadFn(conn *websocket.Conn) func() ([]byte, error) {
	return func() ([]byte, error) {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return nil, err
		}
		if mt != websocket.BinaryMessage && mt != websocket.TextMessage {
			return nil, fmt.Errorf("unexpected ws message type %d", mt)
		}
		return unwrapWSPayload(data), nil
	}
}

// onControlPlaneConnected：取消回收计时，并唤醒 worker（显式 stop 的除外）。
func (d *daemon) onControlPlaneConnected(self string) {
	d.mu.Lock()
	if d.idleTimer != nil {
		d.idleTimer.Stop()
		d.idleTimer = nil
	}
	if !d.userStopped {
		// 控制面回来了：允许 worker 在退出后自动重启。
		d.stopRequested = false
	}
	userStopped := d.userStopped
	active := d.workerCmd != nil || d.state == workerRunning || d.state == workerStarting
	d.mu.Unlock()
	if userStopped || active {
		return
	}
	if err := d.startWorker(self); err != nil {
		fmt.Fprintf(os.Stderr, "[daemon] wake worker failed: %v\n", err)
	}
}

// onControlPlaneDisconnected：起 30 分钟回收计时；期间不重启 worker。
func (d *daemon) onControlPlaneDisconnected() {
	d.mu.Lock()
	// WAW 不在线时 worker 即使退出也不许自动拉起——否则会变成 500ms 一次的重启循环。
	d.stopRequested = true
	if d.idleTimeout <= 0 {
		d.mu.Unlock()
		return
	}
	if d.idleTimer != nil {
		d.idleTimer.Stop()
	}
	d.idleTimer = time.AfterFunc(d.idleTimeout, d.reclaimIdleWorkers)
	d.mu.Unlock()
	fmt.Fprintf(
		os.Stderr,
		"[daemon] control plane disconnected; workers will stop in %s (daemon stays)\n",
		d.idleTimeout,
	)
}

// reclaimIdleWorkers：宽限期结束，关闭所有 worker，只保留 daemon。
func (d *daemon) reclaimIdleWorkers() {
	d.mu.Lock()
	d.idleTimer = nil
	d.mu.Unlock()
	fmt.Fprintln(os.Stderr, "[daemon] idle timeout: stopping all workers, daemon stays resident")
	d.stopWorker()
	d.killStrayWorkers()
}

// killStrayWorkers：清掉同一 binary 的其它 agent 进程（worker / 历史遗留），保留 daemon。
func (d *daemon) killStrayWorkers() {
	if d.killStraysFn != nil {
		d.killStraysFn()
		return
	}
	self, err := os.Executable()
	if err != nil {
		return
	}
	killStrayRemoteAgents(self)
}

// killStrayRemoteAgents：Linux 下扫描 /proc，杀掉同一 binary 的所有非 daemon 进程。
// 其它平台找不到 /proc 时静默跳过（直接子进程已由 stopWorker 处理）。
func killStrayRemoteAgents(self string) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		exe, err := os.Readlink("/proc/" + entry.Name() + "/exe")
		if err != nil || exe != self {
			continue
		}
		raw, err := os.ReadFile("/proc/" + entry.Name() + "/cmdline")
		if err != nil {
			continue
		}
		isDaemon := false
		for _, arg := range strings.Split(string(raw), "\x00") {
			if arg == "--daemon" {
				isDaemon = true
				break
			}
		}
		// 守护进程常驻负责唤醒；其余（worker / stdio / 遗留进程）都回收。
		if isDaemon {
			continue
		}
		p, err := os.FindProcess(pid)
		if err != nil {
			continue
		}
		_ = p.Signal(syscall.SIGTERM)
		go func(p *os.Process) {
			time.Sleep(2 * time.Second)
			_ = p.Kill()
		}(p)
	}
}

func dialDaemonWS(wsURL, token, agentID, workspace string) (*websocket.Conn, error) {
	u, err := url.Parse(wsURL)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("token", token)
	q.Set("agentId", agentID)
	u.RawQuery = q.Encode()

	conn, _, err := websocket.DefaultDialer.Dial(u.String(), http.Header{})
	if err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	hello, _ := json.Marshal(helloMsg{
		Type:      "hello",
		AgentID:   agentID,
		Token:     token,
		Workspace: workspace,
		Hostname:  host,
	})
	if err := conn.WriteMessage(websocket.TextMessage, hello); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

// startWorker：派生 worker 子进程（同一 binary, --daemon-worker）。
func (d *daemon) startWorker(self string) error {
	if d.startWorkerFn != nil {
		if err := d.startWorkerFn(self); err != nil {
			return err
		}
		d.mu.Lock()
		d.state = workerRunning
		d.stopRequested = false
		d.workerDone = make(chan struct{})
		d.mu.Unlock()
		return nil
	}
	args := []string{
		"--daemon-worker",
		"--workspace", d.cfg.workspace,
		"--token", d.cfg.token,
		"--agent-id", d.cfg.agentID,
	}
	for _, root := range d.cfg.roots {
		args = append(args, "--root", root)
	}
	// worker 与控制面用同一种传输，否则 daemon 与 worker 会各自连一个平面。
	if d.cfg.dialHTTP != "" {
		args = append(args, "--dial-http", d.cfg.dialHTTP)
	} else {
		args = append(args, "--dial-ws", d.cfg.dialWS)
	}
	cmd := exec.Command(self, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	d.mu.Lock()
	d.workerCmd = cmd
	d.workerPID = cmd.Process.Pid
	d.workerDone = done
	d.state = workerRunning
	d.stopRequested = false
	d.mu.Unlock()
	go d.superviseWorker(cmd, done)
	return nil
}

// superviseWorker：等待 worker 退出；非显式停止则自动重启。
func (d *daemon) superviseWorker(cmd *exec.Cmd, done chan struct{}) {
	err := cmd.Wait()
	close(done)
	d.mu.Lock()
	current := d.workerCmd == cmd
	restart := !d.stopRequested && current && d.state != workerStopped
	if current {
		d.workerCmd = nil
		d.workerPID = 0
		d.workerDone = nil
	}
	if restart {
		d.state = workerStarting
	} else if current {
		d.state = workerStopped
	}
	d.mu.Unlock()

	if restart {
		time.Sleep(500 * time.Millisecond)
		self, _ := os.Executable()
		if rErr := d.startWorker(self); rErr != nil {
			d.mu.Lock()
			d.state = workerStopped
			d.mu.Unlock()
		}
	}
	_ = err
}

// stopWorker：显式停止 worker（保留 daemon）。
func (d *daemon) stopWorker() bool {
	d.mu.Lock()
	cmd := d.workerCmd
	done := d.workerDone
	d.state = workerStopped
	d.stopRequested = true
	d.workerPID = 0
	d.mu.Unlock()

	if cmd != nil && cmd.Process != nil {
		// 先 SIGTERM，随后 SIGKILL 兜底
		_ = cmd.Process.Signal(syscall.SIGTERM)
		go func(p *os.Process, done chan struct{}) {
			if done != nil {
				select {
				case <-done:
					return
				case <-time.After(2 * time.Second):
				}
			} else {
				time.Sleep(2 * time.Second)
			}
			_ = p.Kill()
		}(cmd.Process, done)
	}
	return true
}

// serveControlPlane：daemon 的命令服务，复用帧协议（WS / HTTP 共用）。
func (d *daemon) serveControlPlane(readFn func() ([]byte, error)) error {
	return serveReaderLoop(readFn, func(frame []byte) error {
		var req request
		if err := json.Unmarshal(frame, &req); err != nil {
			q := "invalid json"
			return d.writeResp(response{ID: "", OK: false, Error: q})
		}
		if strings.TrimSpace(req.Method) == "" {
			return nil
		}
		if req.Token != d.cfg.token {
			return d.writeResp(response{ID: req.ID, OK: false, Error: "unauthorized"})
		}
		return d.handleDaemonRPC(req)
	})
}

func serveReaderLoop(readFn func() ([]byte, error), handleFn func([]byte) error) error {
	for {
		frame, err := readFn()
		if err != nil {
			return err
		}
		if err := handleFn(frame); err != nil {
			return err
		}
	}
}

func (d *daemon) writeResp(resp response) error {
	b, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	return d.frames.WriteFrame(b)
}

func (d *daemon) handleDaemonRPC(req request) error {
	switch req.Method {
	case "daemon_status":
		d.mu.Lock()
		st := daemonStatus{
			Daemon:  "alive",
			AgentID: d.daemonAgentID,
			Worker:  workerStatusDetail{State: d.state, PID: d.workerPID},
		}
		d.mu.Unlock()
		return d.writeResp(response{ID: req.ID, OK: true, Result: st})
	case "daemon_stop":
		d.mu.Lock()
		d.userStopped = true
		d.mu.Unlock()
		d.stopWorker()
		return d.writeResp(response{ID: req.ID, OK: true, Result: map[string]string{"worker": "stopped"}})
	case "daemon_start":
		d.mu.Lock()
		d.userStopped = false
		already := d.workerCmd != nil && d.state == workerRunning
		d.mu.Unlock()
		if already {
			return d.writeResp(response{ID: req.ID, OK: true, Result: map[string]string{"worker": "already_running"}})
		}
		self, err := os.Executable()
		if err != nil {
			return d.writeResp(response{ID: req.ID, OK: false, Error: err.Error()})
		}
		if err := d.startWorker(self); err != nil {
			return d.writeResp(response{ID: req.ID, OK: false, Error: err.Error()})
		}
		return d.writeResp(response{ID: req.ID, OK: true, Result: map[string]string{"worker": "started"}})
	case "daemon_restart":
		d.mu.Lock()
		d.userStopped = false
		d.mu.Unlock()
		d.stopWorker()
		self, err := os.Executable()
		if err != nil {
			return d.writeResp(response{ID: req.ID, OK: false, Error: err.Error()})
		}
		time.Sleep(200 * time.Millisecond)
		if err := d.startWorker(self); err != nil {
			return d.writeResp(response{ID: req.ID, OK: false, Error: err.Error()})
		}
		return d.writeResp(response{ID: req.ID, OK: true, Result: map[string]string{"worker": "restarted"}})
	case "ping":
		return d.writeResp(response{ID: req.ID, OK: true, Result: map[string]string{"pong": "daemon", "agentId": d.daemonAgentID}})
	default:
		return d.writeResp(response{ID: req.ID, OK: false, Error: "unknown method"})
	}
}
