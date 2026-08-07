// Package rest publishes payments to the Solace broker over REST request-reply.
package rest

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/solacese/pos-load-simulator/internal/config"
)

type Client struct {
	baseURI  string
	username string
	password string
	waitMs   int
	http     *http.Client
}

// Reply is the outcome of a single request-reply publish.
type Reply struct {
	Approved  bool
	Status    string // final status from the reply event (cleared/invalid/rejected/fraud)
	TimedOut  bool
	LatencyMs int64
	Err       error
}

func New(cfg *config.Config) *Client {
	waitMs := cfg.Solace.Rest.RequestTimeoutMs
	if waitMs == 0 {
		waitMs = 30000
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: !cfg.Solace.Rest.TLSVerify},
	}
	return &Client{
		baseURI:  cfg.Solace.Rest.URI,
		username: cfg.Solace.Rest.Username,
		password: cfg.Solace.Rest.Password,
		waitMs:   waitMs,
		http: &http.Client{
			Transport: transport,
			Timeout:   time.Duration(waitMs+5000) * time.Millisecond,
		},
	}
}

// Publish POSTs the event to /TOPIC/<topic> and blocks for the reply.
func (c *Client) Publish(topic string, event any) Reply {
	body, _ := json.Marshal(event)
	url := fmt.Sprintf("%s/TOPIC/%s", c.baseURI, topic)

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return Reply{Err: err}
	}
	req.SetBasicAuth(c.username, c.password)
	req.Header.Set("Content-Type", "application/json")
	// This header turns the publish into a blocking request-reply.
	req.Header.Set("Solace-Reply-Wait-Time-In-ms", strconv.Itoa(c.waitMs))

	start := time.Now()
	resp, err := c.http.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return Reply{Err: err, LatencyMs: latency}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if len(bytes.TrimSpace(raw)) == 0 {
		return Reply{TimedOut: true, LatencyMs: latency}
	}
	var replyEvent struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(raw, &replyEvent); err != nil {
		return Reply{Err: fmt.Errorf("bad reply: %s", string(raw)), LatencyMs: latency}
	}
	return Reply{
		Approved:  replyEvent.Status == "cleared",
		Status:    replyEvent.Status,
		LatencyMs: latency,
	}
}
