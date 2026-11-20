package main

import (
	"strings"
	"testing"
	"time"
)

func jobResult(t *testing.T, resp response) map[string]interface{} {
	t.Helper()
	if !resp.OK {
		t.Fatalf("rpc failed: %+v", resp)
	}
	out, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("result type %T", resp.Result)
	}
	return out
}

func waitJobState(t *testing.T, h *rpcHarness, id, want string) map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out := jobResult(t, h.call("s", "job_status", map[string]string{"jobId": id}))
		if out["state"] == want {
			return out
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("job %s never reached %s", id, want)
	return nil
}

func TestJobRunsInBackgroundAndReportsOutput(t *testing.T) {
	h := startRPC(t, t.TempDir())
	start := jobResult(t, h.call("1", "job_start", map[string]string{
		"command": "printf 'built\\n'",
	}))
	id, _ := start["jobId"].(string)
	if id == "" {
		t.Fatalf("no jobId: %+v", start)
	}
	out := waitJobState(t, h, id, jobStateDone)
	if code, _ := out["exitCode"].(float64); code != 0 {
		t.Fatalf("exitCode=%v", out["exitCode"])
	}

	reads := jobResult(t, h.call("2", "job_output", map[string]interface{}{
		"jobId": id,
	}))
	stdout, _ := reads["stdout"].(string)
	if !strings.Contains(stdout, "built") {
		t.Fatalf("stdout=%q", stdout)
	}
	if reads["state"] != jobStateDone {
		t.Fatalf("state=%v", reads["state"])
	}
}

func TestJobKillStopsTheProcessGroup(t *testing.T) {
	h := startRPC(t, t.TempDir())
	start := jobResult(t, h.call("1", "job_start", map[string]string{
		"command": "sleep 30",
	}))
	id, _ := start["jobId"].(string)
	if id == "" {
		t.Fatalf("no jobId: %+v", start)
	}
	waitJobState(t, h, id, jobStateRunning)
	res := jobResult(t, h.call("2", "job_kill", map[string]string{"jobId": id}))
	if res["state"] != jobStateKilled {
		t.Fatalf("kill state=%v", res["state"])
	}
	waitJobState(t, h, id, jobStateKilled)
}

func TestJobStartRefusesCwdOutsideRoots(t *testing.T) {
	dir := t.TempDir()
	h := startRPC(t, dir)
	resp := h.call("1", "job_start", map[string]string{
		"command": "pwd",
		"cwd":     dir + "/..",
	})
	if resp.OK {
		t.Fatalf("expected cwd jail error, got %+v", resp)
	}
}

func TestPingAdvertisesWorkerMethods(t *testing.T) {
	h := startRPC(t, t.TempDir())
	out := jobResult(t, h.call("1", "ping", map[string]string{}))
	if out["protocolVersion"].(float64) != float64(protocolVersion) {
		t.Fatalf("protocolVersion=%v", out["protocolVersion"])
	}
	methods, _ := out["methods"].([]interface{})
	seen := map[string]bool{}
	for _, m := range methods {
		seen[m.(string)] = true
	}
	for _, want := range []string{"exec", "read_file", "job_start", "job_output"} {
		if !seen[want] {
			t.Fatalf("ping methods missing %s: %v", want, methods)
		}
	}
	// The removed duplicates must not come back without a caller update.
	for _, gone := range []string{"mkdir", "move"} {
		if seen[gone] {
			t.Fatalf("ping still advertises removed method %s", gone)
		}
	}
}
