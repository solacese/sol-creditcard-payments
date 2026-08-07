// POS Load Simulator — a multi-threaded generator that mimics many POS
// terminals sending credit-card payments to the Solace broker over REST
// request-reply (topic prefix sale/received/v1). Traffic statistics are
// printed on a configurable interval.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/solacese/pos-load-simulator/internal/config"
	"github.com/solacese/pos-load-simulator/internal/logger"
	"github.com/solacese/pos-load-simulator/internal/rest"
	"github.com/solacese/pos-load-simulator/internal/simulator"
	"github.com/solacese/pos-load-simulator/internal/stats"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config error: %v\n", err)
		os.Exit(1)
	}

	ls := cfg.LoadSimulator
	activeLevel := logger.Configure(ls.LogLevel)

	fmt.Printf("\n  POS Load Simulator\n")
	fmt.Printf("  broker      : %s\n", cfg.Solace.Rest.URI)
	fmt.Printf("  terminals   : %d\n", ls.Terminals)
	fmt.Printf("  idle window : %d-%d ms\n", ls.IdleMinMs, ls.IdleMaxMs)
	fmt.Printf("  topic prefix: %s/{card}/{merchantType}/{merchantName}/{txnId}\n", ls.RestTopicPrefix)
	fmt.Printf("  log level   : %s\n", activeLevel)
	fmt.Printf("  stats every : %ds   (Ctrl-C to stop)\n\n", ls.StatsIntervalSec)

	client := rest.New(cfg)
	st := stats.New()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Fan out the fleet of virtual terminals.
	var wg sync.WaitGroup
	seed := time.Now().UnixNano()
	fleet := simulator.Fleet(cfg, client, st, seed)
	for _, term := range fleet {
		wg.Add(1)
		go func(t *simulator.Terminal) {
			defer wg.Done()
			t.Run(ctx)
		}(term)
	}
	logger.Info("simulator started", "terminals", len(fleet), "broker", cfg.Solace.Rest.URI)

	// Periodic stats reporter.
	interval := ls.StatsIntervalSec
	if interval <= 0 {
		interval = 5
	}
	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	for {
		select {
		case <-ticker.C:
			st.Report(float64(interval))
		case <-sig:
			logger.Info("shutting down — draining terminals")
			cancel()
			wg.Wait()
			st.Report(float64(interval))
			return
		}
	}
}
