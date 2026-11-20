package main

import (
	"bytes"
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

// fakeWriter：捕获 daemon 写出的帧。
type fakeWriter struct {
	buf bytes.Buffer
}

func (f *fakeWriter) WriteFrame(payload []byte) error {
	_, err := f.buf.Write(payload)
	return err
}

// newTestDaemon：构造一个使用 fakeWriter 的 daemon（不连真实 WS、不派真实 worker 进程）。
func newTestDaemon(t *testing.T, cfg daemonConfig) (*daemon, *fakeWriter) {
	t.Helper()
	w := &fakeWriter{}
	d := &daemon{
		cfg:           cfg,
		daemonAgentID: cfg.agentID + ":daemon",
		frames:        w,
		state:         workerStopped,
		cancels:       make(map[string]context.CancelFunc),
	}
	return d, w
}

func callRPC(t *testing.T, d *daemon, method string) map[string]interface{} {
	t.Helper()
	req := request{ID: "1", Method: method, Token: d.cfg.token}
	if err := d.handleDaemonRPC(req); err != nil {
		t.Fatalf("handleDaemonRPC(%s): %v", method, err)
	}
	var resp response
	b := d.frames.(*fakeWriter).buf.Bytes()
	if err := json.Unmarshal(b, &resp); err != nil {
		t.Fatalf("unmarshal resp: %v", err)
	}
	// 复位 buffer
	d.frames.(*fakeWriter).buf.Reset()
	if !resp.OK {
		t.Fatalf("method %s not ok: %s", method, resp.Error)
	}
	m, _ := resp.Result.(map[string]interface{})
	return m
}

func TestDaemonStatusAlive(t *testing.T) {
	d, _ := newTestDaemon(t, daemonConfig{agentID: "pod-a", token: "tok"})
	d.state = workerStopped

	res := callRPC(t, d, "daemon_status")
	if res["agentId"] != "pod-a:daemon" {
		t.Errorf("agentId=%v", res["agentId"])
	}
	if res["daemon"] != "alive" {
		t.Errorf("daemon=%v", res["daemon"])
	}
	wk, _ := res["worker"].(map[string]interface{})
	if wk == nil || wk["state"] != "stopped" {
		t.Errorf("worker state=%v", wk)
	}
}

func TestDaemonStopSetsStopped(t *testing.T) {
	d, _ := newTestDaemon(t, daemonConfig{agentID: "pod-a", token: "tok"})
	d.state = workerRunning
	d.stopWorker()
	// stop 后状态应为 stopped，且 stopRequested=true（不再自启）
	if d.state != workerStopped {
		t.Errorf("state=%s", d.state)
	}
	if !d.stopRequested {
		t.Errorf("stopRequested should be true")
	}
}

func TestDaemonStartRestartDispatch(t *testing.T) {
	d, _ := newTestDaemon(t, daemonConfig{agentID: "pod-a", token: "tok"})
	d.state = workerStopped
	d.stopRequested = true

	res := callRPC(t, d, "daemon_start")
	// 这里没有真二进制 worker，startWorker 会失败；但分派不应 panic。
	// 断言会返回或 error；这里只验证「能处理且不崩」，error 分支返回 !ok。
	_ = res
	// 再次确认 restart 可被handle（不 panic）
	callRPCSafe(t, d, "daemon_restart")
	callRPCSafe(t, d, "daemon_stop")
}

// callRPC 的一个不要求 ok 的变体，用于异常路径。
func callRPCSafe(t *testing.T, d *daemon, method string) {
	t.Helper()
	req := request{ID: "1", Method: method, Token: d.cfg.token}
	if err := d.handleDaemonRPC(req); err != nil {
		t.Fatalf("handle: %v", err)
	}
	d.frames.(*fakeWriter).buf.Reset()
}

// 控制面不在线时不派生 worker；连上后才唤醒。
func TestDaemonWakesWorkerOnlyWhenConnected(t *testing.T) {
	d, _ := newTestDaemon(t, daemonConfig{agentID: "pod-a", token: "tok"})
	d.idleTimeout = time.Minute
	starts := 0
	d.startWorkerFn = func(string) error {
		starts++
		return nil
	}

	// 未连控制面时没有 worker（daemon 启动即等待）。
	if d.state != workerStopped {
		t.Fatalf("initial state=%s", d.state)
	}
	if starts != 0 {
		t.Fatalf("worker must not start before connect (starts=%d)", starts)
	}

	d.onControlPlaneConnected("/tmp/self")
	if starts != 1 || d.state != workerRunning {
		t.Fatalf("expected one wake, starts=%d state=%s", starts, d.state)
	}
	// 已在运行：重连不重复拉起。
	d.onControlPlaneConnected("/tmp/self")
	if starts != 1 {
		t.Fatalf("worker restarted on reconnect (starts=%d)", starts)
	}
}

// 断开后经过 idleTimeout，停止 worker 并清理残留，daemon 保留。
func TestDaemonIdleTimeoutStopsWorkers(t *testing.T) {
	d, _ := newTestDaemon(t, daemonConfig{agentID: "pod-a", token: "tok"})
	d.idleTimeout = 30 * time.Millisecond
	var strays atomic.Int32
	d.killStraysFn = func() { strays.Add(1) }
	d.state = workerRunning

	d.onControlPlaneDisconnected()
	time.Sleep(120 * time.Millisecond)

	d.mu.Lock()
	state := d.state
	stopRequested := d.stopRequested
	d.mu.Unlock()
	if state != workerStopped {
		t.Fatalf("state=%s, want stopped", state)
	}
	if !stopRequested {
		t.Fatalf("stopRequested should be true after idle reclaim")
	}
	if got := strays.Load(); got != 1 {
		t.Fatalf("stray sweep runs=%d, want 1", got)
	}
}

// 宽限期内重连：取消回收，worker 保持运行，不重启。
func TestDaemonReconnectCancelsIdleReclaim(t *testing.T) {
	d, _ := newTestDaemon(t, daemonConfig{agentID: "pod-a", token: "tok"})
	d.idleTimeout = 40 * time.Millisecond
	starts := 0
	d.startWorkerFn = func(string) error {
		starts++
		return nil
	}
	d.state = workerRunning

	d.onControlPlaneDisconnected()
	d.onControlPlaneConnected("/tmp/self")
	time.Sleep(120 * time.Millisecond)

	d.mu.Lock()
	state := d.state
	d.mu.Unlock()
	if state != workerRunning {
		t.Fatalf("state=%s, want running", state)
	}
	if starts != 0 {
		t.Fatalf("reconnect must not restart a live worker (starts=%d)", starts)
	}
}

// 显式 daemon_stop 的意图跨重连保持：重连不自动唤醒。
func TestDaemonUserStopSurvivesReconnect(t *testing.T) {
	d, _ := newTestDaemon(t, daemonConfig{agentID: "pod-a", token: "tok"})
	d.idleTimeout = time.Minute
	starts := 0
	d.startWorkerFn = func(string) error {
		starts++
		return nil
	}
	d.userStopped = true
	d.state = workerStopped

	d.onControlPlaneConnected("/tmp/self")
	if starts != 0 {
		t.Fatalf("explicitly stopped worker was woken (starts=%d)", starts)
	}

	// daemon_start 清除用户停止意图。
	callRPC(t, d, "daemon_start")
	if starts != 1 || d.userStopped {
		t.Fatalf("daemon_start did not wake worker (starts=%d userStopped=%v)", starts, d.userStopped)
	}
}
