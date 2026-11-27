//go:build windows

package main

import (
	"errors"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestStrayProcessIDsSkipsSelfDaemonOtherImagesAndUnknowns(t *testing.T) {
	self := `C:\tools\waw-remote-agent.exe`
	procs := []agentProcess{
		{PID: 10, Exe: self, Cmd: `C:\tools\waw-remote-agent.exe --daemon-worker --agent-id a`},
		{PID: 11, Exe: `c:\TOOLS\WAW-REMOTE-AGENT.EXE`, Cmd: `C:\tools\waw-remote-agent.exe --daemon --agent-id a`},
		{PID: 12, Exe: self, Cmd: ""},
		{PID: 13, Exe: `C:\other\waw-remote-agent.exe`, Cmd: `--daemon-worker`},
		{PID: 14, Exe: self, Cmd: `C:\tools\waw-remote-agent.exe --daemon-worker --agent-id b`},
		{PID: 99, Exe: self, Cmd: `C:\tools\waw-remote-agent.exe --daemon-worker`},
	}
	got := strayProcessIDs(self, 99, func(string) []agentProcess { return procs })
	want := []int{10, 14}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stray pids = %v, want %v", got, want)
	}
}

func TestParseAgentProcessesReadsTabSeparatedCIMOutput(t *testing.T) {
	output := "10\tC:\\a\\waw-remote-agent.exe\tC:\\a\\waw-remote-agent.exe --daemon-worker\r\n" +
		"garbage line\n" +
		"11\tC:\\a\\waw-remote-agent.exe\n"
	procs := parseAgentProcesses(output)
	if len(procs) != 2 {
		t.Fatalf("procs = %+v", procs)
	}
	if procs[0].PID != 10 || procs[0].Exe != `C:\a\waw-remote-agent.exe` ||
		procs[0].Cmd != `C:\a\waw-remote-agent.exe --daemon-worker` {
		t.Fatalf("first proc = %+v", procs[0])
	}
	if procs[1].PID != 11 || procs[1].Cmd != "" {
		t.Fatalf("second proc = %+v", procs[1])
	}
}

// Windows PowerShell 5.1 picks the console/ANSI code page when stdout is a
// redirected pipe. A non-ASCII executable path (e.g. C:\Users\张三\...\exe)
// then arrives as "??" or CP936 bytes while self came from os.Executable as
// UTF-8, so sameExecutable never matches and leftover workers are never reaped.
// The shared command helper must force UTF-8 output.
func TestPowerShellCommandKeepsNonASCIIPathsAsUTF8(t *testing.T) {
	const exe = `C:\Users\张三\waw-remote-agent.exe`
	out, err := powerShellCommand(`Write-Output '` + exe + `'`).Output()
	if errors.Is(err, exec.ErrNotFound) {
		t.Skip("powershell.exe is not available")
	}
	if err != nil {
		t.Fatalf("powershell: %v", err)
	}
	if !utf8.Valid(out) {
		t.Fatalf("powershell output is not valid UTF-8: % x", out)
	}
	if got := strings.TrimSpace(string(out)); got != exe {
		t.Fatalf("output = %q, want %q", got, exe)
	}
	procs := parseAgentProcesses("42\t" + exe + "\t" + exe + " --daemon-worker\n")
	if len(procs) != 1 || !sameExecutable(exe, procs[0].Exe) {
		t.Fatalf("parsed non-ASCII path does not match: %+v", procs)
	}
}

// A zero handle means the job was never created, i.e. a force-killed daemon
// would leave its worker running. This exercises the raw syscall layout.
func TestWorkerJobHandleIsCreated(t *testing.T) {
	if handle := workerJobHandle(); handle == 0 {
		t.Fatal("could not create a KILL_ON_JOB_CLOSE job object")
	}
}
