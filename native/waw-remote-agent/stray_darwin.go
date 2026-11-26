//go:build darwin

package main

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// killStrayRemoteAgents：macOS 无 /proc，通过 ps 扫描同一 binary 的非 daemon 进程并回收。
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
