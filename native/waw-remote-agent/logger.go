package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type logLevel int

const (
	logDebug logLevel = 10
	logInfo  logLevel = 20
	logWarn  logLevel = 30
	logError logLevel = 40
)

type structuredLogger struct {
	mu       sync.Mutex
	minLevel logLevel
	file     *os.File
}

var agentLog = &structuredLogger{
	minLevel: parseLogLevel(os.Getenv("WAW_REMOTE_AGENT_LOG_LEVEL")),
}

func parseLogLevel(raw string) logLevel {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug":
		return logDebug
	case "warn", "warning":
		return logWarn
	case "error":
		return logError
	default:
		return logInfo
	}
}

func (l logLevel) String() string {
	switch l {
	case logDebug:
		return "debug"
	case logWarn:
		return "warn"
	case logError:
		return "error"
	default:
		return "info"
	}
}

func configureAgentLogger(levelStr, filePath string) {
	agentLog.mu.Lock()
	defer agentLog.mu.Unlock()
	if strings.TrimSpace(levelStr) != "" {
		agentLog.minLevel = parseLogLevel(levelStr)
	}
	path := strings.TrimSpace(filePath)
	if path == "" {
		path = strings.TrimSpace(os.Getenv("WAW_REMOTE_AGENT_LOG_FILE"))
	}
	if agentLog.file != nil {
		_ = agentLog.file.Close()
		agentLog.file = nil
	}
	if path != "" && path != "off" && path != "none" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err == nil {
			if f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
				agentLog.file = f
			}
		}
	}
}

func isSensitiveLogKey(k string) bool {
	lower := strings.ToLower(k)
	return strings.Contains(lower, "token") ||
		strings.Contains(lower, "pass") ||
		strings.Contains(lower, "secret") ||
		strings.Contains(lower, "authorization")
}

func (s *structuredLogger) emit(level logLevel, component, event string, fields map[string]interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if level < s.minLevel {
		return
	}
	entry := map[string]interface{}{
		"ts":        time.Now().UTC().Format(time.RFC3339Nano),
		"level":     level.String(),
		"component": component,
		"event":     event,
		"pid":       os.Getpid(),
	}
	for k, v := range fields {
		if isSensitiveLogKey(k) {
			entry[k] = "[REDACTED]"
		} else {
			entry[k] = v
		}
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	line = append(line, '\n')
	// Never write logs to stdout — stdout is reserved for binary RPC frames.
	_, _ = os.Stderr.Write(line)
	if s.file != nil {
		_, _ = s.file.Write(line)
	}
}

func logInfoEvent(component, event string, fields map[string]interface{}) {
	agentLog.emit(logInfo, component, event, fields)
}

func logWarnEvent(component, event string, fields map[string]interface{}) {
	agentLog.emit(logWarn, component, event, fields)
}

func logErrorEvent(component, event string, fields map[string]interface{}) {
	agentLog.emit(logError, component, event, fields)
}

func logDebugEvent(component, event string, fields map[string]interface{}) {
	agentLog.emit(logDebug, component, event, fields)
}
