//go:build !windows

package main

import (
	"errors"
	"os/exec"
	"syscall"
)

/**
 * A job gets its own process group so `job_kill` reaches the children a build
 * spawned, not only the shell that launched them. Without it, killing a
 * `npm run build` leaves the compiler running and the task looks killed while
 * the CPU stays busy.
 */
func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	// Negative pid = the whole group. Fall back to the process itself when the
	// group has already gone (the race between exit and kill).
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
}

func exitCodeOf(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}
