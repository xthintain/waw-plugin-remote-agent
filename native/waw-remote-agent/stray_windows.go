//go:build windows

package main

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

// A Job Object with KILL_ON_JOB_CLOSE is the Windows primitive that makes a
// worker die with its daemon even when the daemon is force-killed: the OS
// closes the job handle on process death and terminates every member. Go's
// exec.Cmd does not expose the suspended-launch sequence, so the worker is
// started normally and then assigned to the job; the tasklist sweep below is
// the fallback when assignment is refused (for example when the worker already
// belongs to an outer job).
const (
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x2000

	processTerminate = 0x0001
	processSetQuota  = 0x0100
)

type jobBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	_                       uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	_                       uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobIOCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobExtendedLimitInformation struct {
	BasicLimitInformation jobBasicLimitInformation
	IoInfo                jobIOCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procOpenProcess              = kernel32.NewProc("OpenProcess")

	workerJobOnce sync.Once
	workerJob     syscall.Handle
)

func workerJobHandle() syscall.Handle {
	workerJobOnce.Do(func() {
		handle, _, _ := procCreateJobObjectW.Call(0, 0)
		if handle == 0 {
			return
		}
		info := jobExtendedLimitInformation{}
		info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
		ok, _, _ := procSetInformationJobObject.Call(
			handle,
			jobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)),
			unsafe.Sizeof(info),
		)
		if ok == 0 {
			_ = syscall.CloseHandle(syscall.Handle(handle))
			return
		}
		workerJob = syscall.Handle(handle)
	})
	return workerJob
}

// attachWorkerToJob puts one freshly started worker into the daemon's job.
func attachWorkerToJob(pid int) {
	job := workerJobHandle()
	if job == 0 || pid <= 0 {
		return
	}
	handle, _, _ := procOpenProcess.Call(processSetQuota|processTerminate, 0, uintptr(pid))
	if handle == 0 {
		return
	}
	defer syscall.CloseHandle(syscall.Handle(handle))
	_, _, _ = procAssignProcessToJobObject.Call(uintptr(job), handle)
}

type agentProcess struct {
	PID int
	Exe string
	Cmd string
}

// killStrayRemoteAgents reaps leftover workers of this binary. Without /proc,
// the process list comes from CIM and is filtered by executable path and
// command line, so a concurrent daemon (which must stay resident) is skipped.
func killStrayRemoteAgents(self string) {
	for _, pid := range strayProcessIDs(self, os.Getpid(), listAgentProcesses) {
		_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
	}
}

func strayProcessIDs(self string, selfPID int, list func(string) []agentProcess) []int {
	var out []int
	for _, proc := range list(self) {
		if proc.PID <= 0 || proc.PID == selfPID {
			continue
		}
		if !sameExecutable(self, proc.Exe) {
			continue
		}
		// An unreadable command line is not proof of a worker; leave it alone
		// rather than risk killing a resident daemon.
		if proc.Cmd == "" || isDaemonCommandLine(proc.Cmd) {
			continue
		}
		out = append(out, proc.PID)
	}
	return out
}

// psUTF8Output forces Windows PowerShell 5.1 to write UTF-8 even when stdout is
// a redirected pipe with no console. Without it the console/ANSI code page is
// used, so a non-ASCII executable path arrives as "??" (or CP936 bytes) while
// self came from os.Executable as UTF-8; sameExecutable then never matches and
// the CIM sweep misses leftover workers.
const psUTF8Output = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; `

func powerShellCommand(script string) *exec.Cmd {
	return exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", psUTF8Output+script)
}

func listAgentProcesses(string) []agentProcess {
	script := `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { "$($_.ProcessId)` +
		"\t" + `$($_.ExecutablePath)` + "\t" + `$($_.CommandLine)" }`
	out, err := powerShellCommand(script).Output()
	if err != nil {
		return nil
	}
	return parseAgentProcesses(string(out))
}

func parseAgentProcesses(output string) []agentProcess {
	var out []agentProcess
	scanner := bufio.NewScanner(strings.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), "\t", 3)
		if len(parts) < 2 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			continue
		}
		proc := agentProcess{PID: pid, Exe: strings.TrimSpace(parts[1])}
		if len(parts) == 3 {
			proc.Cmd = strings.TrimSpace(parts[2])
		}
		out = append(out, proc)
	}
	return out
}

func sameExecutable(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func isDaemonCommandLine(cmd string) bool {
	for _, arg := range strings.Fields(cmd) {
		if strings.Trim(arg, `"`) == "--daemon" {
			return true
		}
	}
	return false
}
