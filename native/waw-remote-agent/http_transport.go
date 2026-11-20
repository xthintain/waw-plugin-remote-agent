package main

// HTTP long-poll transport: the TUI host's control plane.
//
// The web plane has the agent reverse-connect a WebSocket. The TUI host is an
// ordinary HTTP server, so the same addressing (`agentId` + per-agent token) is
// carried over three calls instead:
//
//	POST /remote/agents/register   once, and again whenever a poll says we are gone
//	GET  /remote/agents/poll       blocks until work or the wait expires
//	POST /remote/agents/reply      answers, one request per call
//
// Responses are sent by a background goroutine so a tool call's handler can
// return immediately, exactly as the WS writer does. A transport failure stops
// the sender and surfaces from nextFrame, which ends the serve loop; the caller
// (daemon supervisor, or the process itself) decides whether to reconnect.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	httpPollWaitMs   = 25000
	httpPollTimeout  = httpPollWaitMs*time.Millisecond + 15*time.Second
	httpReplyTimeout = 20 * time.Second
	httpRegisterTime = 15 * time.Second
	httpMaxBodyBytes = 32 << 20
)

var (
	errTransportClosed = errors.New("http transport closed")
)

// remoteRequest mirrors the hub's request shape. `request` alone would do, but
// the hub's JSON is the wire contract and naming it keeps the two sides honest.
type remoteRequest struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Token  string          `json:"token"`
	Params json.RawMessage `json:"params"`
}

type pollReply struct {
	OK       bool            `json:"ok"`
	Requests []remoteRequest `json:"requests"`
	Message  string          `json:"message,omitempty"`
}

type httpTransport struct {
	base      string
	token     string
	agentID   string
	workspace string
	hostname  string

	client *http.Client

	mu     sync.Mutex
	frames []remoteRequest

	out      chan []byte
	closed   chan struct{}
	closeOne sync.Once
	reason   error
	reasonMu sync.Mutex
}

func newHTTPTransport(base, token, agentID, workspace string) (*httpTransport, error) {
	raw := strings.TrimRight(strings.TrimSpace(base), "/")
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("bad --dial-http URL %q (want http://host:port)", base)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("--dial-http wants http(s), got %q", u.Scheme)
	}
	host, _ := os.Hostname()
	return &httpTransport{
		base:      raw,
		token:     token,
		agentID:   agentID,
		workspace: workspace,
		hostname:  host,
		client:    &http.Client{},
		out:       make(chan []byte, 128),
		closed:    make(chan struct{}),
	}, nil
}

// register announces this agent (or refreshes a session the host forgot).
func (t *httpTransport) register() error {
	body, _ := json.Marshal(helloMsg{
		Type:      "hello",
		AgentID:   t.agentID,
		Token:     t.token,
		Workspace: t.workspace,
		Hostname:  t.hostname,
	})
	ctx, cancel := context.WithTimeout(context.Background(), httpRegisterTime)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.base+"/remote/agents/register", bytes.NewReader(body))
	if err != nil {
		return err
	}
	t.setHeaders(req)
	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("register: %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	return nil
}

// start launches the reply sender. Call it after register.
func (t *httpTransport) start() {
	go t.sendLoop()
}

// nextFrame blocks for the next request and returns it as the same JSON frame
// the WS and stdio planes deliver (serveReader does not know the difference).
func (t *httpTransport) nextFrame() ([]byte, error) {
	for {
		select {
		case <-t.closed:
			return nil, t.closeReason()
		default:
		}
		t.mu.Lock()
		if len(t.frames) > 0 {
			req := t.frames[0]
			t.frames = t.frames[1:]
			t.mu.Unlock()
			return json.Marshal(req)
		}
		t.mu.Unlock()

		batch, err := t.pollOnce()
		if err != nil {
			// Includes errOffline (404): the caller's reconnect loop registers a
			// fresh transport, which is what restores a forgotten session.
			return nil, err
		}
		if len(batch) > 0 {
			t.mu.Lock()
			t.frames = append(t.frames, batch...)
			t.mu.Unlock()
		}
	}
}

// WriteFrame implements frameWriter: handlers call this and never block on HTTP.
func (t *httpTransport) WriteFrame(payload []byte) error {
	frame := append([]byte(nil), payload...)
	select {
	case t.out <- frame:
		return nil
	case <-t.closed:
		return t.closeReason()
	}
}

// close stops the sender. Idempotent; the daemon calls it after every session.
func (t *httpTransport) close() {
	t.closeOne.Do(func() {
		close(t.closed)
	})
}

// closeReason is what a caller should report after the transport ends.
func (t *httpTransport) closeReason() error {
	t.reasonMu.Lock()
	defer t.reasonMu.Unlock()
	if t.reason != nil {
		return t.reason
	}
	return errTransportClosed
}

func (t *httpTransport) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	if t.token != "" {
		// With WAW_TUI_REMOTE_HUB_TOKEN set on the host, the agent's --token is
		// that same value: one secret, not two.
		req.Header.Set("Authorization", "Bearer "+t.token)
	}
}

var errOffline = errors.New("remote agent offline")

func (t *httpTransport) pollOnce() ([]remoteRequest, error) {
	ctx, cancel := context.WithTimeout(context.Background(), httpPollTimeout)
	defer cancel()
	q := url.Values{}
	q.Set("agentId", t.agentID)
	q.Set("token", t.token)
	q.Set("wait", fmt.Sprint(httpPollWaitMs))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.base+"/remote/agents/poll?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	t.setHeaders(req)
	resp, err := t.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, errOffline
	}
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("poll: %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	var parsed pollReply
	if err := json.NewDecoder(io.LimitReader(resp.Body, httpMaxBodyBytes)).Decode(&parsed); err != nil {
		return nil, err
	}
	return parsed.Requests, nil
}

func (t *httpTransport) sendLoop() {
	for {
		select {
		case <-t.closed:
			return
		case frame := <-t.out:
			if err := t.sendResponses([][]byte{frame}); err != nil {
				t.reasonMu.Lock()
				if t.reason == nil {
					t.reason = err
				}
				t.reasonMu.Unlock()
				t.close()
				return
			}
		}
	}
}

func (t *httpTransport) sendResponses(frames [][]byte) error {
	responses := make([]json.RawMessage, 0, len(frames))
	for _, frame := range frames {
		responses = append(responses, json.RawMessage(frame))
	}
	body, err := json.Marshal(map[string]interface{}{
		"agentId":   t.agentID,
		"token":     t.token,
		"responses": responses,
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), httpReplyTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.base+"/remote/agents/reply", bytes.NewReader(body))
	if err != nil {
		return err
	}
	t.setHeaders(req)
	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("reply: %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return nil
}

// serveHTTP: worker over long poll. Reconnects like the daemon's supervisor so a
// host restart does not require restarting the agent, unless shutdown was asked.
func serveHTTP(base, token, agentID, workspace string, roots []string) error {
	backoff := time.Second
	for {
		tr, err := newHTTPTransport(base, token, agentID, workspace)
		if err != nil {
			return err
		}
		if err := tr.register(); err != nil {
			tr.close()
			fmt.Fprintf(os.Stderr, "[agent] control plane unavailable: %v\n", err)
			time.Sleep(backoff)
			backoff = growBackoff(backoff)
			continue
		}
		backoff = time.Second
		tr.start()
		a := newAgent(workspace, token, agentID, tr, roots...)
		err = a.serveReader(tr.nextFrame)
		tr.close()
		if err == nil {
			return nil
		}
		fmt.Fprintf(os.Stderr, "[agent] control plane disconnected: %v\n", err)
		time.Sleep(backoff)
	}
}

func growBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > 30*time.Second {
		return 30 * time.Second
	}
	return next
}
