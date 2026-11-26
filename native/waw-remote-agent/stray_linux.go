//go:build linux

package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// killStrayRemoteAgents：Linux 下扫描 /proc，杀掉同一 binary 的所有非 daemon 进程。
func killStrayRemoteAgents(self string) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	realSelf := realPath(self)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		exe, err := os.Readlink("/proc/" + entry.Name() + "/exe")
		if err != nil || (exe != self && realPath(exe) != realSelf) {
			continue
		}
		raw, err := os.ReadFile("/proc/" + entry.Name() + "/cmdline")
		if err != nil {
			continue
		}
		isDaemon := false
		for _, arg := range strings.Split(string(raw), "\x00") {
			if arg == "--daemon" {
				isDaemon = true
				break
			}
		}
		// 守护进程常驻负责唤醒；其余（worker / stdio / 遗留进程）都回收。
		if isDaemon {
			continue
		}
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
