package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestResolveInsideFence(t *testing.T) {
	dir := t.TempDir()
	a := newAgent(dir, "t", "id", &stdioWriter{w: io.Discard})
	if _, err := a.resolveInside(filepath.Join(dir, "..", "outside")); err == nil {
		t.Fatal("expected fence error")
	}
	got, err := a.resolveInside("nested/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(dir, "nested", "file.txt")
	if got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestResolveInsideRootWorkspace(t *testing.T) {
	a := newAgent("/", "t", "id", &stdioWriter{w: io.Discard})
	got, err := a.resolveInside("/workspace")
	if err != nil {
		t.Fatal(err)
	}
	if got != "/workspace" {
		t.Fatalf("got %s", got)
	}
}

func TestFrameRoundtripPing(t *testing.T) {
	dir := t.TempDir()
	token := "tok"
	stdinR, stdinW := io.Pipe()
	var out bytes.Buffer
	a := newAgent(dir, token, "aid", &stdioWriter{w: &out})
	errCh := make(chan error, 1)
	go func() { errCh <- a.serveStdio(stdinR) }()

	req, _ := json.Marshal(request{ID: "1", Method: "ping", Token: token})
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(req)))
	_, _ = stdinW.Write(hdr[:])
	_, _ = stdinW.Write(req)

	deadline := time.Now().Add(2 * time.Second)
	for out.Len() < 5 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if out.Len() < 5 {
		t.Fatal("no frame")
	}
	n := binary.BigEndian.Uint32(out.Bytes()[:4])
	body := out.Bytes()[4 : 4+n]
	var resp response
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.OK || resp.ID != "1" {
		t.Fatalf("%+v", resp)
	}
	_ = stdinW.Close()
	select {
	case <-errCh:
	case <-time.After(time.Second):
	}
	_ = context.Background
}

func TestExecEcho(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("bash", "-lc", "echo hello-remote")
	cmd.Dir = dir
	stdout, stderr, err := runCapture(cmd)
	if err != nil {
		t.Fatal(err, stderr)
	}
	if stdout != "hello-remote\n" {
		t.Fatalf("stdout=%q", stdout)
	}
}

type rpcHarness struct {
	t      *testing.T
	token  string
	stdinW *io.PipeWriter
	out    *bytes.Buffer
	errCh  chan error
}

func startRPC(t *testing.T, workspace string) *rpcHarness {
	t.Helper()
	token := "tok"
	stdinR, stdinW := io.Pipe()
	var out bytes.Buffer
	a := newAgent(workspace, token, "aid", &stdioWriter{w: &out})
	errCh := make(chan error, 1)
	go func() { errCh <- a.serveStdio(stdinR) }()
	h := &rpcHarness{t: t, token: token, stdinW: stdinW, out: &out, errCh: errCh}
	t.Cleanup(func() {
		_ = stdinW.Close()
		select {
		case <-errCh:
		case <-time.After(time.Second):
		}
	})
	return h
}

func (h *rpcHarness) call(id, method string, params interface{}) response {
	h.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		h.t.Fatal(err)
	}
	req, err := json.Marshal(request{ID: id, Method: method, Token: h.token, Params: raw})
	if err != nil {
		h.t.Fatal(err)
	}
	start := h.out.Len()
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(req)))
	_, _ = h.stdinW.Write(hdr[:])
	_, _ = h.stdinW.Write(req)

	deadline := time.Now().Add(2 * time.Second)
	for h.out.Len() < start+5 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.out.Len() < start+5 {
		h.t.Fatal("no response frame")
	}
	buf := h.out.Bytes()[start:]
	n := binary.BigEndian.Uint32(buf[:4])
	for len(buf) < int(4+n) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
		buf = h.out.Bytes()[start:]
	}
	if len(buf) < int(4+n) {
		h.t.Fatal("incomplete response frame")
	}
	var resp response
	if err := json.Unmarshal(buf[4:4+n], &resp); err != nil {
		h.t.Fatal(err)
	}
	return resp
}

// `mkdir` and `move` are gone in protocol 5: exec expresses both exactly and a
// second implementation would be a second set of semantics. This pins that the
// remaining surface still covers the same work.
func TestFsRPC_ListExecRemove(t *testing.T) {
	dir := t.TempDir()
	h := startRPC(t, dir)

	resp := h.call("1", "exec", map[string]interface{}{
		"command": "mkdir -p nested/dir",
		"cwd":     dir,
	})
	if !resp.OK {
		t.Fatalf("exec mkdir: %+v", resp)
	}

	writePath := filepath.Join(dir, "nested", "dir", "a.txt")
	if err := writeFileForTest(writePath, "hello"); err != nil {
		t.Fatal(err)
	}

	resp = h.call("2", "list_dir", map[string]string{"path": "nested/dir"})
	if !resp.OK {
		t.Fatalf("list_dir: %+v", resp)
	}
	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("result type %T", resp.Result)
	}
	entries, _ := result["entries"].([]interface{})
	if len(entries) != 1 {
		t.Fatalf("entries=%v", entries)
	}

	resp = h.call("3", "exec", map[string]interface{}{
		"command": "mv -- nested/dir/a.txt nested/dir/b.txt",
		"cwd":     dir,
	})
	if !resp.OK {
		t.Fatalf("exec move: %+v", resp)
	}

	resp = h.call("4", "remove", map[string]interface{}{
		"path":      "nested/dir/b.txt",
		"recursive": false,
	})
	if !resp.OK {
		t.Fatalf("remove file: %+v", resp)
	}

	resp = h.call("5", "remove", map[string]interface{}{
		"path":      "nested",
		"recursive": true,
	})
	if !resp.OK {
		t.Fatalf("remove dir: %+v", resp)
	}
}

func TestFsRPC_JailAndRemoveRoot(t *testing.T) {
	dir := t.TempDir()
	h := startRPC(t, dir)

	resp := h.call("1", "list_dir", map[string]string{"path": filepath.Join(dir, "..")})
	if resp.OK {
		t.Fatalf("expected jail error, got %+v", resp)
	}

	resp = h.call("2", "exec", map[string]interface{}{
		"command": "pwd",
		"cwd":     filepath.Join(dir, ".."),
	})
	if resp.OK {
		t.Fatalf("expected exec cwd jail error, got %+v", resp)
	}

	resp = h.call("3", "remove", map[string]interface{}{"path": dir, "recursive": true})
	if resp.OK {
		t.Fatalf("expected workspace root remove reject, got %+v", resp)
	}
}

func writeFileForTest(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}
