//go:build windows

package main

import (
	"errors"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

/**
 * A job runs in its own console-less process, and killing it must reach the
 * children too — `powershell -Command 'npm run build'` leaves the compiler
 * running if only PowerShell is killed.
 */
func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

/**
 * `/T` walks the process tree, `/F` forces it. `cmd.Process.Kill` is the
 * fallback for when taskkill itself is missing or already lost the race.
 *
 * A Job Object would be the tidier primitive; it needs the process created
 * suspended and assigned before it runs, which `exec.Cmd` does not expose.
 */
func killProcessTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	_ = cmd.Process.Kill()
}

func terminateProcess(cmd *exec.Cmd) {
	killProcessTree(cmd)
}

/**
 * A timed-out `exec` must not leave the model's command running. Go's default
 * Cancel kills only the direct child (PowerShell), so replace it with the tree
 * kill and give taskkill a moment before Wait gives up on the pipes.
 */
func armCancel(cmd *exec.Cmd) {
	cmd.Cancel = func() error {
		killProcessTree(cmd)
		return nil
	}
	cmd.WaitDelay = 2 * time.Second
}

func exitCodeOf(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}
