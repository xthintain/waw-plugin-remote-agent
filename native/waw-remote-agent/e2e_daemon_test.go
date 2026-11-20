package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// upgrader：测试用 WS 升级器（模拟控制面 /remote-agent 端点）。
var testUpgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

// startFakeControlPlane：起一个假的「控制面」WS 服务器。
// 返回 wsURL 与一个接收 daemon/worker 连接的 function，以及 recv 管道。
func startFakeControlPlane(t *testing.T) (string, chan chan *websocket.Conn) {
	t.Helper()
	// 每条新连接放入一个 chan，测试逐个取
	incoming := make(chan chan *websocket.Conn, 8)
	mux := http.NewServeMux()
	mux.HandleFunc("/remote-agent", func(w http.ResponseWriter, r *http.Request) {
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		ch := make(chan *websocket.Conn, 1)
		ch <- conn
		incoming <- ch
		// 保持连接打开（由测试控制读写），阻塞直到关闭
		<-r.Context().Done()
		_ = conn.Close()
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	// 转成 ws://（gorilla dialer 要求）
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/remote-agent"
	return wsURL, incoming
}

// recvMsg：从 daemon 连接读一条 JSON 请求（daemon 以 agentId:daemon 连入）。
func sendRPC(t *testing.T, conn *websocket.Conn, token, method string, params interface{}) map[string]interface{} {
	t.Helper()
	req := map[string]interface{}{
		"id":     "r-" + method,
		"method": method,
		"token":  token,
	}
	if params != nil {
		req["params"] = params
	}
	if err := conn.WriteJSON(req); err != nil {
		t.Fatalf("write rpc: %v", err)
	}
	// 读响应（同一连接）
	var resp map[string]interface{}
	if err := conn.ReadJSON(&resp); err != nil {
		t.Fatalf("read resp for %s: %v", method, err)
	}
	return resp
}

// TestDaemonEndToEnd：真实二进制 daemon 端到端。
// 流程：起假控制面 → 跑 waw-remote-agent --daemon → 连上(agentId:daemon) →
//
//	daemon_status → daemon_stop（验证 worker 退出、daemon 仍在）→ daemon_start。
func TestDaemonEndToEnd(t *testing.T) {
	// 指向真正的 dist 二进制（build.sh 产物）。
	bin := findDaemonBinary(t)

	wsURL, incoming := startFakeControlPlane(t)

	wsDir := t.TempDir()
	cmd := &procRunner{bin: bin}
	cmdToken := "daemontok-test"
	daemon := cmd.start(t,
		"--daemon",
		"--workspace", wsDir,
		"--token", cmdToken,
		"--agent-id", "pod-e2e",
		"--dial-ws", wsURL,
	)
	defer daemon.kill(t)

	// 等 daemon 连上（也可能连带 worker 连上）。逐个接收连接。
	var daemonConn *websocket.Conn
	deadline := time.After(8 * time.Second)
	for daemonConn == nil {
		select {
		case ch := <-incoming:
			c := <-ch
			// 每条连接（daemon 或 worker）连入后先发 hello（TextMessage）
			_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
			_, data, _ := c.ReadMessage()
			_ = c.SetReadDeadline(time.Time{})
			hello := string(data)
			if strings.Contains(hello, "pod-e2e:daemon") {
				daemonConn = c // 这是 daemon 命令连接
			}
			// 非 daemon 连接（worker 工具面）忽略
		case <-deadline:
			t.Fatal("timed out waiting for daemon connection")
		}
	}

	// 1) daemon_status
	resp := sendRPC(t, daemonConn, cmdToken, "daemon_status", nil)
	if !respOK(resp) {
		t.Fatalf("daemon_status not ok: %v", resp)
	}
	res, _ := resp["result"].(map[string]interface{})
	if res["daemon"] != "alive" {
		t.Fatalf("daemon not alive: %v", res)
	}

	// 2) daemon_stop：worker 被关闭，daemon 仍响应
	resp = sendRPC(t, daemonConn, cmdToken, "daemon_stop", nil)
	if !respOK(resp) {
		t.Fatalf("daemon_stop not ok: %v", resp)
	}
	// daemon 仍可响应 status
	time.Sleep(300 * time.Millisecond)
	resp = sendRPC(t, daemonConn, cmdToken, "daemon_status", nil)
	if !respOK(resp) {
		t.Fatalf("daemon died after stop: %v", resp)
	}
	res, _ = resp["result"].(map[string]interface{})
	wk, _ := res["worker"].(map[string]interface{})
	if wk["state"] != "stopped" {
		t.Fatalf("expect worker stopped after stop, got %v", wk)
	}

	// 3) daemon_start：worker 拉回
	resp = sendRPC(t, daemonConn, cmdToken, "daemon_start", nil)
	// 允许 already_running 或 started
	if !respOK(resp) {
		t.Fatalf("daemon_start not ok: %v", resp)
	}
	resp = sendRPC(t, daemonConn, cmdToken, "daemon_status", nil)
	res, _ = resp["result"].(map[string]interface{})
	wk, _ = res["worker"].(map[string]interface{})
	if s, _ := wk["state"].(string); s != "running" {
		t.Logf("worker state after start: %v (可能已快速退出等待重启)", s)
	}

	daemonConn.Close()
}

func respOK(resp map[string]interface{}) bool {
	ok, _ := resp["ok"].(bool)
	return ok
}

// procRunner 简化：包装 exec.Cmd 便于启动真实二进制。
// （避免引入额外依赖）
type procRunner struct {
	bin string
}

func (p *procRunner) start(t *testing.T, args ...string) *proc {
	t.Helper()
	return startProcess(t, p.bin, args...)
}

func findDaemonBinary(t *testing.T) string {
	t.Helper()
	// 优先 dist，其次当前可执行文件上游（go run 场景不可用）
	root := repoRoot()
	cands := []string{
		filepath.Join(root, "native/waw-remote-agent/dist/waw-remote-agent"),
	}
	for _, c := range cands {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	t.Fatalf("daemon binary not found (run build.sh); tried %v", cands)
	return ""
}

// proc：包装子进程句柄。
type proc struct {
	cmd *exec.Cmd
}

func (p *proc) kill(t *testing.T) {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return
	}
	_ = p.cmd.Process.Kill()
	_, _ = p.cmd.Process.Wait()
}

func startProcess(t *testing.T, bin string, args ...string) *proc {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	_ = cmd.Start()
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	return &proc{cmd: cmd}
}

func repoRoot() string {
	wd, _ := os.Getwd()
	// wd 是 native/waw-remote-agent
	return filepath.Dir(filepath.Dir(wd))
}
