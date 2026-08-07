// Package simulator drives virtual POS terminals that generate random payments.
package simulator

import (
	"context"
	"fmt"
	"math/rand"
	"sort"
	"time"

	"github.com/solacese/pos-load-simulator/internal/config"
	"github.com/solacese/pos-load-simulator/internal/logger"
	"github.com/solacese/pos-load-simulator/internal/rest"
	"github.com/solacese/pos-load-simulator/internal/stats"
)

// PaymentEvent mirrors the shape produced by the POS Sol Terminal.
type PaymentEvent struct {
	TransactionID string   `json:"transactionId"`
	Status        string   `json:"status"`
	Amount        float64  `json:"amount"`
	Currency      string   `json:"currency"`
	MerchantID    string   `json:"merchantId"`
	Version       string   `json:"version"`
	CardType      string   `json:"cardType"`
	MerchantType  string   `json:"merchantType"`
	MerchantName  string   `json:"merchantName"`
	CardLast4     string   `json:"cardLast4"`
	Timestamp     string   `json:"timestamp"`
	History       []string `json:"history"`
}

// merchantPair is a flattened (type, name) option for fast random selection.
type merchantPair struct{ Type, Name string }

// Terminal is a single virtual POS device.
type Terminal struct {
	id         int
	cfg        *config.Config
	client     *rest.Client
	st         *stats.Stats
	rng        *rand.Rand
	prefix     string
	version    string
	pairs      []merchantPair
	currencies []string
}

func flattenMerchants(m map[string][]string) []merchantPair {
	var pairs []merchantPair
	for t, names := range m {
		for _, n := range names {
			pairs = append(pairs, merchantPair{t, n})
		}
	}
	return pairs
}

func currencyCodes(m map[string]string) []string {
	codes := make([]string, 0, len(m))
	for code := range m {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	return codes
}

// Run loops until ctx is cancelled: idle a random interval, then fire a payment.
func (t *Terminal) Run(ctx context.Context) {
	for {
		idle := t.cfg.LoadSimulator.IdleMinMs +
			t.rng.Intn(max(1, t.cfg.LoadSimulator.IdleMaxMs-t.cfg.LoadSimulator.IdleMinMs))
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(idle) * time.Millisecond):
		}
		t.fire()
	}
}

func (t *Terminal) fire() {
	pair := t.pairs[t.rng.Intn(len(t.pairs))]
	card := t.cfg.CardTypes[t.rng.Intn(len(t.cfg.CardTypes))]
	cur := t.currencies[t.rng.Intn(len(t.currencies))]
	txn := fmt.Sprintf("%07d", 1_000_000+t.rng.Intn(9_000_000))

	lo := t.cfg.LoadSimulator.AmountMin
	hi := t.cfg.LoadSimulator.AmountMax
	amount := lo + t.rng.Float64()*(hi-lo)

	event := PaymentEvent{
		TransactionID: txn,
		Status:        "received",
		Amount:        float64(int(amount*100)) / 100,
		Currency:      cur,
		MerchantID:    fmt.Sprintf("%s-%04d", pair.Name, t.rng.Intn(10000)),
		Version:       t.version,
		CardType:      card,
		MerchantType:  pair.Type,
		MerchantName:  pair.Name,
		CardLast4:     fmt.Sprintf("%04d", t.rng.Intn(10000)),
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		History:       []string{fmt.Sprintf("Sim-T%02d:received", t.id)},
	}

	// sale/received/v1/{cardType}/{merchantType}/{merchantName}/{txnId}
	topic := fmt.Sprintf("%s/%s/%s/%s/%s", t.prefix, card, pair.Type, pair.Name, txn)

	// SENT: outbound request-reply to the broker (per-txn, so debug level).
	t.st.RecordSent()
	logger.Debug("→ Solace REQUEST sent", "term", t.id, "txn", txn, "topic", topic,
		"amount", event.Amount, "currency", event.Currency)

	reply := t.client.Publish(topic, event)
	switch {
	case reply.Err != nil:
		t.st.RecordError()
		logger.Error("transport error", "term", t.id, "txn", txn, "error", reply.Err)
	case reply.TimedOut:
		t.st.RecordTimeout()
		logger.Warn("⏱ Solace TIMEOUT — no reply", "term", t.id, "txn", txn,
			"topic", topic, "latencyMs", reply.LatencyMs)
	case reply.Approved:
		t.st.RecordReply(true, reply.LatencyMs)
		// Approved is the common case under load → debug to keep info readable.
		logger.Debug("← Solace RESPONSE received: APPROVED", "term", t.id, "txn", txn,
			"finalStatus", reply.Status, "latencyMs", reply.LatencyMs)
	default:
		t.st.RecordReply(false, reply.LatencyMs)
		// Declines are the interesting minority → surface at info.
		logger.Info("← Solace RESPONSE received: DECLINED", "term", t.id, "txn", txn,
			"finalStatus", reply.Status, "latencyMs", reply.LatencyMs)
	}
}

// Fleet builds and returns the configured number of terminals.
func Fleet(cfg *config.Config, client *rest.Client, st *stats.Stats, seed int64) []*Terminal {
	pairs := flattenMerchants(cfg.Merchants)
	currencies := currencyCodes(cfg.Currencies)
	version := "v1"
	if parts := splitPrefix(cfg.LoadSimulator.RestTopicPrefix); len(parts) >= 3 {
		version = parts[2]
	}
	n := cfg.LoadSimulator.Terminals
	if n <= 0 {
		n = 1
	}
	terminals := make([]*Terminal, n)
	for i := 0; i < n; i++ {
		terminals[i] = &Terminal{
			id:         i + 1,
			cfg:        cfg,
			client:     client,
			st:         st,
			rng:        rand.New(rand.NewSource(seed + int64(i))),
			prefix:     cfg.LoadSimulator.RestTopicPrefix,
			version:    version,
			pairs:      pairs,
			currencies: currencies,
		}
	}
	return terminals
}

func splitPrefix(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == '/' {
			out = append(out, cur)
			cur = ""
		} else {
			cur += string(r)
		}
	}
	return append(out, cur)
}
