package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// decodeLast parses the single response a direct handler call wrote.
func decodeLast(t *testing.T, out *bytes.Buffer) response {
	t.Helper()
	raw := out.Bytes()
	if len(raw) < 5 {
		t.Fatalf("no frame written (len=%d)", len(raw))
	}
	n := binary.BigEndian.Uint32(raw[:4])
	var resp response
	if err := json.Unmarshal(raw[4:4+n], &resp); err != nil {
		t.Fatalf("bad frame: %v", err)
	}
	return resp
}

func directAgent(t *testing.T, workspace string, roots ...string) (*agent, *bytes.Buffer) {
	t.Helper()
	out := &bytes.Buffer{}
	return newAgent(workspace, "t", "id", &stdioWriter{w: out}, roots...), out
}

// A fence that only cleans paths is not a fence: a symlink INSIDE an allowed
// root can point anywhere, and writes through it land outside.
func TestResolveInsideRejectsSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	a, _ := directAgent(t, root)

	if _, err := a.resolveInside(filepath.Join("escape", "secret.txt")); err == nil {
		t.Fatal("a symlink pointing outside the root must be rejected")
	}
	// A symlink that stays inside is still usable.
	inside := filepath.Join(root, "real")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(inside, filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := a.resolveInside(filepath.Join("alias", "ok.txt")); err != nil {
		t.Fatalf("in-root symlink should resolve: %v", err)
	}
}

// `--root` names a place the agent may WORK IN. It must not be deletable:
// remove used to guard only --workspace, so `rm -r` on an extra root wiped the
// whole tree the operator exposed.
func TestRemoveRefusesEveryConfiguredRoot(t *testing.T) {
	ws := t.TempDir()
	extra := t.TempDir()
	keep := filepath.Join(extra, "keep.txt")
	if err := os.WriteFile(keep, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	a, out := directAgent(t, ws, extra)

	params, _ := json.Marshal(removeParams{Path: extra, Recursive: true})
	a.handleRemove(request{ID: "1", Params: params})
	resp := decodeLast(t, out)
	if resp.OK {
		t.Fatal("removing a configured root must be refused")
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("the root was deleted: %v", err)
	}

	// A normal file inside the root is still removable.
	out.Reset()
	victim := filepath.Join(extra, "victim.txt")
	if err := os.WriteFile(victim, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	params, _ = json.Marshal(removeParams{Path: victim})
	a.handleRemove(request{ID: "2", Params: params})
	if resp = decodeLast(t, out); !resp.OK {
		t.Fatalf("file removal failed: %s", resp.Error)
	}
}

// exec.CommandContext kills the process on deadline, so the error is also an
// *exec.ExitError. Classifying it first reported OK:true with exitCode -1.
func TestExecTimeoutIsReportedAsTimeout(t *testing.T) {
	a, out := directAgent(t, t.TempDir())
	params, _ := json.Marshal(execParams{Command: "sleep 5", TimeoutMs: 50})
	a.handleExec(request{ID: "1", Params: params})
	resp := decodeLast(t, out)
	if resp.OK {
		t.Fatal("a timed-out command must not be reported as success")
	}
	if resp.Error != "timeout" {
		t.Fatalf("error=%q, want timeout", resp.Error)
	}
}

var _ = io.Discard
