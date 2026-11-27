//go:build darwin

package main

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// killStrayRemoteAgents does what the Linux version reads from /proc: macOS has
// no procfs, so it asks `ps` which processes run this binary and keeps the ones
// without --daemon. Direct children are already handled by stopWorker.
func killStrayRemoteAgents(self string) {
	out, err := exec.Command("/bin/ps", "-axo", "pid=,command=").Output()
	if err != nil {
		return
	}
	for _, pid := range findStrayPIDsFromPS(string(out), self, os.Getpid()) {
		p, err := os.FindProcess(pid)
		if err != nil {
			continue
		}
		_ = p.Signal(syscall.SIGTERM)
		go func(p *os.Process) {
			time.Sleep(2 * time.Second)
			_ = p.Kill()
		}(p)
	}
}
