//go:build linux

package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// killStrayRemoteAgents scans /proc and stops every process of the same binary
// that is not a daemon. Direct children are already handled by stopWorker.
func killStrayRemoteAgents(self string) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	// `self` is the path the daemon was started as and may itself be a link
	// (nix store, /usr/local/bin, a symlinked workspace); /proc/<pid>/exe is the
	// resolved image. Compare both forms so neither spelling misses the other.
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
