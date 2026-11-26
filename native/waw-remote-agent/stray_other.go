//go:build !linux && !darwin

package main

// killStrayRemoteAgents：Windows 等无 /proc 与 BSD ps 的平台静默跳过
// （直接子进程已由 stopWorker 处理）。
func killStrayRemoteAgents(_ string) {}
