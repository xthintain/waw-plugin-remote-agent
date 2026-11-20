package main

// The HTTP transport is the TUI host's side of the remote plane; these cases pin
// the wire contract it has to match:
//
//	POST /remote/agents/register   {type,agentId,token,workspace,hostname}
//	GET  /remote/agents/poll       -> {ok, requests:[{id,method,token,params}]}
//	POST /remote/agents/reply      {agentId,token,responses:[{id,ok,result|error}]}
//
// A fake hub keeps the test in-process; the real routes are covered from the
// TypeScript side (`tui/src/host/remote-routes.test.ts`).

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type fakeHub struct {
	mu sync.Mutex

	registered map[string]string // agentId -> token
	queue      map[string][]remoteRequest
	replies    []response
	authHeader string
	polls      int

	replyCh chan struct{}
}

func newFakeHub() *fakeHub {
	return &fakeHub{
		registered: make(map[string]string),
		queue:      make(map[string][]remoteRequest),
		replyCh:    make(chan struct{}, 16),
	}
}

func (h *fakeHub) enqueue(agentID string, req remoteRequest) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.queue[agentID] = append(h.queue[agentID], req)
}

func (h *fakeHub) register(t *testing.T) (base string, stop func()) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		if auth := r.Header.Get("Authorization"); auth != "" {
			h.authHeader = auth
		}
		h.mu.Unlock()

		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/remote/agents/register":
			var hello helloMsg
			body, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(body, &hello); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			h.mu.Lock()
			h.registered[hello.AgentID] = hello.Token
			h.mu.Unlock()
			writeJSON(w, map[string]interface{}{"ok": true})

		case r.Method == http.MethodGet && r.URL.Path == "/remote/agents/poll":
			agentID := r.URL.Query().Get("agentId")
			h.mu.Lock()
			_, known := h.registered[agentID]
			var batch []remoteRequest
			if known && len(h.queue[agentID]) > 0 {
				batch = h.queue[agentID]
				h.queue[agentID] = nil
			}
			h.polls++
			h.mu.Unlock()
			if !known {
				w.WriteHeader(http.StatusNotFound)
				writeJSON(w, map[string]interface{}{"ok": false, "code": "offline"})
				return
			}
			if len(batch) == 0 {
				// 真 hub 会挂住到 wait 到期；这里短睡即可，避免测试空转。
				time.Sleep(20 * time.Millisecond)
			}
			writeJSON(w, map[string]interface{}{"ok": true, "requests": batch})

		case r.Method == http.MethodPost && r.URL.Path == "/remote/agents/reply":
			var body struct {
				AgentID   string     `json:"agentId"`
				Token     string     `json:"token"`
				Responses []response `json:"responses"`
			}
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &body); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			h.mu.Lock()
			h.replies = append(h.replies, body.Responses...)
			h.mu.Unlock()
			writeJSON(w, map[string]interface{}{
				"ok": true, "accepted": len(body.Responses), "rejected": 0,
			})
			h.replyCh <- struct{}{}

		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	return srv.URL, srv.Close
}

func writeJSON(w http.ResponseWriter, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func (h *fakeHub) awaitReply(t *testing.T) response {
	t.Helper()
	select {
	case <-h.replyCh:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for a reply")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.replies) == 0 {
		t.Fatal("reply arrived with no responses")
	}
	return h.replies[len(h.replies)-1]
}

func startTransport(t *testing.T, hub *fakeHub, agentID, token string) *httpTransport {
	t.Helper()
	base, stop := hub.register(t)
	t.Cleanup(stop)
	tr, err := newHTTPTransport(base, token, agentID, "/srv/app")
	if err != nil {
		t.Fatalf("newHTTPTransport: %v", err)
	}
	if err := tr.register(); err != nil {
		t.Fatalf("register: %v", err)
	}
	tr.start()
	t.Cleanup(tr.close)
	return tr
}

func TestHTTPTransportRegistersAnnouncesAndPolls(t *testing.T) {
	hub := newFakeHub()
	tr := startTransport(t, hub, "pod-a", "tok-a")

	hub.mu.Lock()
	got := hub.registered["pod-a"]
	auth := hub.authHeader
	hub.mu.Unlock()
	if got != "tok-a" {
		t.Fatalf("registered token = %q, want tok-a", got)
	}
	if auth != "Bearer tok-a" {
		t.Fatalf("Authorization = %q, want Bearer tok-a", auth)
	}

	hub.enqueue("pod-a", remoteRequest{
		ID: "r1", Method: "ping", Token: "tok-a",
		Params: json.RawMessage(`{"n":1}`),
	})
	frame, err := tr.nextFrame()
	if err != nil {
		t.Fatalf("nextFrame: %v", err)
	}
	var req request
	if err := json.Unmarshal(frame, &req); err != nil {
		t.Fatalf("frame is not a request: %v", err)
	}
	if req.ID != "r1" || req.Method != "ping" || req.Token != "tok-a" {
		t.Fatalf("unexpected request: %+v", req)
	}
	if string(req.Params) != `{"n":1}` {
		t.Fatalf("params lost in translation: %s", req.Params)
	}
}

func TestHTTPTransportAnswersThroughTheAgent(t *testing.T) {
	hub := newFakeHub()
	tr := startTransport(t, hub, "pod-a", "tok-a")
	a := newAgent("/srv/app", "tok-a", "pod-a", tr)

	a.handle(request{ID: "r1", Method: "ping", Token: "tok-a"})

	resp := hub.awaitReply(t)
	if !resp.OK || resp.ID != "r1" {
		t.Fatalf("unexpected reply: %+v", resp)
	}
	result, ok := resp.Result.(map[string]interface{})
	if !ok || result["pong"] != "ok" {
		t.Fatalf("ping result = %#v", resp.Result)
	}
}

func TestHTTPTransportServesABatch(t *testing.T) {
	hub := newFakeHub()
	tr := startTransport(t, hub, "pod-a", "tok-a")
	hub.enqueue("pod-a", remoteRequest{ID: "a", Method: "ping", Token: "tok-a"})
	hub.enqueue("pod-a", remoteRequest{ID: "b", Method: "ping", Token: "tok-a"})

	first, err := tr.nextFrame()
	if err != nil {
		t.Fatalf("first nextFrame: %v", err)
	}
	second, err := tr.nextFrame()
	if err != nil {
		t.Fatalf("second nextFrame: %v", err)
	}
	var r1, r2 request
	_ = json.Unmarshal(first, &r1)
	_ = json.Unmarshal(second, &r2)
	if r1.ID != "a" || r2.ID != "b" {
		t.Fatalf("batch order changed: %q then %q", r1.ID, r2.ID)
	}
}

func TestHTTPTransportReportsOfflineWhenHostForgotUs(t *testing.T) {
	hub := newFakeHub()
	base, stop := hub.register(t)
	defer stop()
	// 不注册，模拟 host 重启后状态清空。
	tr, err := newHTTPTransport(base, "tok-a", "ghost", "/srv/app")
	if err != nil {
		t.Fatalf("newHTTPTransport: %v", err)
	}
	defer tr.close()

	if _, err := tr.nextFrame(); !errors.Is(err, errOffline) {
		t.Fatalf("nextFrame err = %v, want errOffline", err)
	}
}

func TestHTTPTransportCloseUnblocksNextFrame(t *testing.T) {
	hub := newFakeHub()
	tr := startTransport(t, hub, "pod-a", "tok-a")
	done := make(chan error, 1)
	go func() {
		_, err := tr.nextFrame()
		done <- err
	}()
	time.Sleep(30 * time.Millisecond)
	tr.close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("nextFrame returned no error after close")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("close did not unblock nextFrame")
	}
}

func TestNewHTTPTransportRejectsWebSocketURL(t *testing.T) {
	if _, err := newHTTPTransport("ws://127.0.0.1:5191", "t", "a", "/w"); err == nil {
		t.Fatal("ws:// should be refused by --dial-http")
	}
	if _, err := newHTTPTransport("not a url", "t", "a", "/w"); err == nil {
		t.Fatal("a non-URL should be refused")
	}
}
