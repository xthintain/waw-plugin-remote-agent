package main

import (
	"strconv"
	"strings"
)

// findStrayPIDsFromPS parses `ps -axo pid=,command=` output (macOS/BSD format:
// "PID COMMAND…", one process per line) and returns the PIDs that run the same
// executable as self without `--daemon`.
//
// The command column is free text that ps does not quote, and an installed path
// may contain spaces ("Application Support"), so matching tries the known
// spellings of the path as an exact prefix and only then compares the real path
// of the first word.
func findStrayPIDsFromPS(psOutput, self string, selfPID int) []int {
	if strings.TrimSpace(self) == "" {
		return nil
	}
	realSelf := realPath(self)
	var pids []int
	for _, line := range strings.Split(psOutput, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		sep := strings.IndexAny(trimmed, " \t")
		if sep <= 0 {
			continue
		}
		pid, err := strconv.Atoi(trimmed[:sep])
		if err != nil || pid <= 0 || pid == selfPID {
			continue
		}
		cmdLine := strings.TrimSpace(trimmed[sep+1:])
		if cmdLine == "" {
			continue
		}
		rest, matched := matchExecutablePrefix(cmdLine, self, realSelf)
		if !matched {
			continue
		}
		isDaemon := false
		for _, arg := range strings.Fields(rest) {
			if arg == "--daemon" {
				isDaemon = true
				break
			}
		}
		if isDaemon {
			continue
		}
		pids = append(pids, pid)
	}
	return pids
}

// matchExecutablePrefix reports whether cmdLine starts by running one of the
// given spellings of the executable, and returns the arguments after it.
func matchExecutablePrefix(cmdLine, self, realSelf string) (string, bool) {
	for _, target := range []string{self, realSelf} {
		if target == "" {
			continue
		}
		if cmdLine == target {
			return "", true
		}
		if strings.HasPrefix(cmdLine, target+" ") || strings.HasPrefix(cmdLine, target+"\t") {
			return strings.TrimSpace(cmdLine[len(target):]), true
		}
	}
	fields := strings.Fields(cmdLine)
	if len(fields) == 0 {
		return "", false
	}
	if realPath(fields[0]) == realSelf {
		return strings.Join(fields[1:], " "), true
	}
	return "", false
}
