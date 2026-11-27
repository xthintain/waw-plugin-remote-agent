//go:build !linux && !darwin && !windows

package main

// killStrayRemoteAgents is a no-op where neither procfs nor a BSD `ps` layout is
// assumed: the daemon's own children are already handled by stopWorker, and this
// build has no process table it knows how to read. Windows has its own sweep
// (stray_windows.go).
func killStrayRemoteAgents(_ string) {}
