// Package stats collects concurrent traffic counters and prints them on a timer.
package stats

import (
	"fmt"
	"sync/atomic"
	"time"
)

type Stats struct {
	sent      atomic.Int64
	approved  atomic.Int64
	declined  atomic.Int64
	timeouts  atomic.Int64
	errors    atomic.Int64
	latSumMs  atomic.Int64 // sum of latencies for approved+declined replies
	latCount  atomic.Int64
	startTime time.Time
}

func New() *Stats {
	return &Stats{startTime: time.Now()}
}

func (s *Stats) RecordSent()     { s.sent.Add(1) }
func (s *Stats) RecordTimeout()  { s.timeouts.Add(1) }
func (s *Stats) RecordError()    { s.errors.Add(1) }

func (s *Stats) RecordReply(approved bool, latencyMs int64) {
	if approved {
		s.approved.Add(1)
	} else {
		s.declined.Add(1)
	}
	s.latSumMs.Add(latencyMs)
	s.latCount.Add(1)
}

// Report prints a periodic snapshot. windowSec is the interval since last call.
func (s *Stats) Report(windowSec float64) {
	sent := s.sent.Swap(0)
	appr := s.approved.Swap(0)
	decl := s.declined.Swap(0)
	tmo := s.timeouts.Swap(0)
	errs := s.errors.Swap(0)
	latSum := s.latSumMs.Swap(0)
	latCnt := s.latCount.Swap(0)

	var avgLat float64
	if latCnt > 0 {
		avgLat = float64(latSum) / float64(latCnt)
	}
	tps := float64(sent) / windowSec

	fmt.Printf("[stats %6.0fs] sent=%-4d tps=%5.1f  approved=%-4d declined=%-4d timeout=%-3d err=%-3d  avgLatency=%6.1fms\n",
		time.Since(s.startTime).Seconds(), sent, tps, appr, decl, tmo, errs, avgLat)
}
