//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
)

/** Windows has no process groups here; the shell's children outlive a kill. */
func configureProcess(_ *exec.Cmd) {}

func killProcessTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
}

func terminateProcess(p *os.Process) {
	if p == nil {
		return
	}
	// Windows does not support SIGTERM; kill immediately instead of waiting for fallback.
	_ = p.Kill()
}

func exitCodeOf(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}
