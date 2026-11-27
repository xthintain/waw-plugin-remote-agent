package main

/**
 * Background jobs: the "cmd::task" half of the remote tool surface.
 *
 * `exec` is request/response — a command that outlives the call either blocks
 * the conversation or gets killed at the deadline. A job is the same command
 * started detached, with its output written to two log files the host reads at
 * its own pace. That is what lets a remote-bound conversation put a build in the
 * background and be woken when it finishes, exactly like a local one.
 *
 * The job belongs to THIS worker process: when the worker goes away (control
 * plane shutdown, daemon idle-stop, crash) its children go with it. The daemon
 * keeps the worker alive across short control-plane gaps, which is the case that
 * matters for a long build.
 */

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

const (
	jobStateRunning = "running"
	jobStateDone    = "done"
	jobStateFailed  = "failed"
	jobStateKilled  = "killed"

	jobOutputDefaultBytes = 64 << 10
	jobOutputMaxBytes     = 512 << 10
)

type job struct {
	id        string
	command   string
	cwd       string
	pid       int
	outPath   string
	errPath   string
	startedAt time.Time

	cmd     *exec.Cmd
	outFile *os.File
	errFile *os.File

	mu       sync.Mutex
	state    string
	exitCode int
	endedAt  time.Time
}

var jobSeq uint64

func (j *job) snapshot() map[string]interface{} {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := map[string]interface{}{
		"jobId":     j.id,
		"command":   j.command,
		"cwd":       j.cwd,
		"pid":       j.pid,
		"state":     j.state,
		"exitCode":  j.exitCode,
		"startedAt": j.startedAt.UTC().Format(time.RFC3339Nano),
	}
	if !j.endedAt.IsZero() {
		out["endedAt"] = j.endedAt.UTC().Format(time.RFC3339Nano)
		out["durationMs"] = j.endedAt.Sub(j.startedAt).Milliseconds()
	}
	return out
}

func (a *agent) ensureJobDir() (string, error) {
	a.jobMu.Lock()
	dir := a.jobDir
	a.jobMu.Unlock()
	if dir != "" {
		return dir, nil
	}
	dir = filepath.Join(os.TempDir(), "waw-remote-agent", fmt.Sprintf("pid-%d", os.Getpid()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	a.jobMu.Lock()
	a.jobDir = dir
	a.jobMu.Unlock()
	return dir, nil
}

func (a *agent) handleJobStart(req request) {
	var p jobStartParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "bad params"})
		return
	}
	cmdLine := p.Command
	if cmdLine == "" {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "command required"})
		return
	}
	cwd := a.workspace
	if p.Cwd != "" {
		resolved, err := a.resolveInside(p.Cwd)
		if err != nil {
			_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
			return
		}
		cwd = resolved
	}

	a.jobMu.Lock()
	running := 0
	for _, j := range a.jobs {
		j.mu.Lock()
		state := j.state
		j.mu.Unlock()
		if state == jobStateRunning {
			running++
		}
	}
	limit := a.jobLimit
	a.jobMu.Unlock()
	if limit > 0 && running >= limit {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: fmt.Sprintf("too many running jobs (limit %d); kill one first", limit)})
		return
	}

	dir, err := a.ensureJobDir()
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	id := fmt.Sprintf("job-%d-%d", time.Now().UnixNano(), atomic.AddUint64(&jobSeq, 1))
	outPath := filepath.Join(dir, id+".out")
	errPath := filepath.Join(dir, id+".err")
	outFile, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	errFile, err := os.OpenFile(errPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		_ = outFile.Close()
		_ = os.Remove(outPath)
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}

	cmd := exec.Command(a.shell, "-lc", cmdLine)
	cmd.Dir = cwd
	cmd.Stdout = outFile
	cmd.Stderr = errFile
	configureProcess(cmd)
	if err := cmd.Start(); err != nil {
		_ = outFile.Close()
		_ = errFile.Close()
		_ = os.Remove(outPath)
		_ = os.Remove(errPath)
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}

	j := &job{
		id:        id,
		command:   cmdLine,
		cwd:       cwd,
		pid:       cmd.Process.Pid,
		outPath:   outPath,
		errPath:   errPath,
		startedAt: time.Now(),
		cmd:       cmd,
		outFile:   outFile,
		errFile:   errFile,
		state:     jobStateRunning,
		exitCode:  -1,
	}
	a.jobMu.Lock()
	a.jobs[id] = j
	a.jobMu.Unlock()

	go func() {
		waitErr := cmd.Wait()
		_ = outFile.Close()
		_ = errFile.Close()
		j.mu.Lock()
		j.endedAt = time.Now()
		if j.state == jobStateKilled {
			j.exitCode = -1
		} else if waitErr == nil {
			j.state = jobStateDone
			j.exitCode = 0
		} else {
			j.state = jobStateFailed
			j.exitCode = exitCodeOf(waitErr)
		}
		finalState := j.state
		finalCode := j.exitCode
		j.mu.Unlock()
		logInfoEvent("jobs", "job.exit", map[string]interface{}{
			"jobId":    j.id,
			"pid":      j.pid,
			"state":    finalState,
			"exitCode": finalCode,
		})
	}()

	logInfoEvent("jobs", "job.start", map[string]interface{}{
		"jobId": id,
		"pid":   j.pid,
		"cwd":   cwd,
	})
	_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]interface{}{
		"jobId":     id,
		"pid":       j.pid,
		"cwd":       cwd,
		"startedAt": j.startedAt.UTC().Format(time.RFC3339Nano),
	}})
}

func (a *agent) handleJobStatus(req request) {
	var p jobIDParams
	if err := json.Unmarshal(req.Params, &p); err != nil || p.JobID == "" {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "jobId required"})
		return
	}
	j := a.findJob(p.JobID)
	if j == nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "unknown job: " + p.JobID})
		return
	}
	_ = a.writeResponse(response{ID: req.ID, OK: true, Result: j.snapshot()})
}

func (a *agent) handleJobOutput(req request) {
	var p jobOutputParams
	if err := json.Unmarshal(req.Params, &p); err != nil || p.JobID == "" {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "jobId required"})
		return
	}
	j := a.findJob(p.JobID)
	if j == nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "unknown job: " + p.JobID})
		return
	}
	max := p.MaxBytes
	if max <= 0 {
		max = jobOutputDefaultBytes
	}
	if max > jobOutputMaxBytes {
		max = jobOutputMaxBytes
	}
	stdout, outNext, err := readRange(j.outPath, p.OutOffset, max)
	if err != nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	remaining := max - len(stdout)
	if remaining < 0 {
		remaining = 0
	}
	stderr := ""
	errNext := p.ErrOffset
	if remaining > 0 {
		stderr, errNext, err = readRange(j.errPath, p.ErrOffset, remaining)
		if err != nil {
			_ = a.writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
			return
		}
	}
	snap := j.snapshot()
	result := map[string]interface{}{
		"stdout":   stdout,
		"stderr":   stderr,
		"outNext":  outNext,
		"errNext":  errNext,
		"state":    snap["state"],
		"exitCode": snap["exitCode"],
	}
	_ = a.writeResponse(response{ID: req.ID, OK: true, Result: result})
}

func (a *agent) handleJobKill(req request) {
	var p jobIDParams
	if err := json.Unmarshal(req.Params, &p); err != nil || p.JobID == "" {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "jobId required"})
		return
	}
	j := a.findJob(p.JobID)
	if j == nil {
		_ = a.writeResponse(response{ID: req.ID, OK: false, Error: "unknown job: " + p.JobID})
		return
	}
	j.mu.Lock()
	already := j.state != jobStateRunning
	j.mu.Unlock()
	if already {
		_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]interface{}{
			"jobId": p.JobID,
			"state": j.snapshot()["state"],
		}})
		return
	}
	j.mu.Lock()
	j.state = jobStateKilled
	j.mu.Unlock()
	killProcessTree(j.cmd)
	logInfoEvent("jobs", "job.kill", map[string]interface{}{
		"jobId": p.JobID,
		"pid":   j.pid,
	})
	_ = a.writeResponse(response{ID: req.ID, OK: true, Result: map[string]interface{}{
		"jobId": p.JobID,
		"state": jobStateKilled,
	}})
}

func (a *agent) killAllJobs() {
	a.jobMu.Lock()
	jobs := make([]*job, 0, len(a.jobs))
	for _, j := range a.jobs {
		jobs = append(jobs, j)
	}
	a.jobMu.Unlock()
	for _, j := range jobs {
		j.mu.Lock()
		running := j.state == jobStateRunning
		if running {
			j.state = jobStateKilled
		}
		j.mu.Unlock()
		if running {
			killProcessTree(j.cmd)
		}
	}
}

func (a *agent) findJob(id string) *job {
	a.jobMu.Lock()
	defer a.jobMu.Unlock()
	return a.jobs[id]
}

/** Read at most max bytes from offset. A missing file is empty, not an error. */
func readRange(path string, offset int64, max int) (string, int64, error) {
	if max <= 0 {
		return "", offset, nil
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", offset, nil
		}
		return "", offset, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", offset, err
	}
	if offset < 0 {
		offset = 0
	}
	if offset > st.Size() {
		offset = st.Size()
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return "", offset, err
	}
	buf := make([]byte, max)
	n, readErr := f.Read(buf)
	if readErr != nil && readErr != io.EOF {
		return "", offset, readErr
	}
	return string(buf[:n]), offset + int64(n), nil
}
