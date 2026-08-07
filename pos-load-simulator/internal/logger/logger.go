// Package logger is a tiny dependency-free leveled logger for the simulator,
// matching the POS Sol Terminal's logger.
//
// Levels (most → least severe):  error < warn < info < debug
// A message is printed only if its level is at or below the configured level,
// e.g. level "info" prints error+warn+info but not debug.
//
// Because a fleet of terminals logs concurrently, output is serialized with a
// mutex. Context is passed as alternating key/value pairs and rendered as
// compact key=value tokens.
package logger

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

type Level int

const (
	LevelError Level = iota
	LevelWarn
	LevelInfo
	LevelDebug
)

var names = map[string]Level{
	"error": LevelError, "warn": LevelWarn, "info": LevelInfo, "debug": LevelDebug,
}
var labels = map[Level]string{
	LevelError: "ERROR", LevelWarn: "WARN ", LevelInfo: "INFO ", LevelDebug: "DEBUG",
}
var colors = map[Level]string{
	LevelError: "\x1b[31m", LevelWarn: "\x1b[33m", LevelInfo: "\x1b[36m", LevelDebug: "\x1b[90m",
}

const reset = "\x1b[0m"

var (
	threshold = LevelInfo
	useColor  = isCharDevice(os.Stdout)
	mu        sync.Mutex
)

// Configure sets the active level from a config string, returning the resolved
// name (falls back to "info" on an unknown value).
func Configure(level string) string {
	key := strings.ToLower(strings.TrimSpace(level))
	if l, ok := names[key]; ok {
		threshold = l
		return key
	}
	threshold = LevelInfo
	emit(LevelWarn, fmt.Sprintf("unknown logLevel %q, defaulting to \"info\"", level))
	return "info"
}

func Error(msg string, kv ...any) { emit(LevelError, msg, kv...) }
func Warn(msg string, kv ...any)  { emit(LevelWarn, msg, kv...) }
func Info(msg string, kv ...any)  { emit(LevelInfo, msg, kv...) }
func Debug(msg string, kv ...any) { emit(LevelDebug, msg, kv...) }

func emit(l Level, msg string, kv ...any) {
	if l > threshold {
		return
	}
	ts := time.Now().Format(time.RFC3339)
	tag := labels[l]
	if useColor {
		tag = colors[l] + tag + reset
	}
	line := fmt.Sprintf("%s %s %s", ts, tag, msg)
	if len(kv) > 0 {
		line += " " + formatKV(kv)
	}
	mu.Lock()
	defer mu.Unlock()
	if l == LevelError {
		fmt.Fprintln(os.Stderr, line)
	} else {
		fmt.Fprintln(os.Stdout, line)
	}
}

// formatKV renders alternating key/value pairs as "key=value".
func formatKV(kv []any) string {
	var b strings.Builder
	for i := 0; i+1 < len(kv); i += 2 {
		if i > 0 {
			b.WriteByte(' ')
		}
		fmt.Fprintf(&b, "%v=%v", kv[i], kv[i+1])
	}
	return b.String()
}

func isCharDevice(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}
