package main

import (
	"reflect"
	"testing"
)

func TestFindStrayPIDsFromPS(t *testing.T) {
	self := "/Users/alice/.waw/bin/waw-remote-agent"
	psOut := `
  100 /Users/alice/.waw/bin/waw-remote-agent --daemon --workspace /Users/alice/ws --token t
  101 /Users/alice/.waw/bin/waw-remote-agent --daemon-worker --workspace /Users/alice/ws --token t
  102 /Users/alice/.waw/bin/waw-remote-agent --workspace /Users/alice/ws --token t
  103 /Users/alice/.waw/bin/waw-remote-agent --daemon --agent-id pod-b
  104 /usr/bin/ssh example.com
  105 /Users/alice/.waw/bin/waw-remote-agent-other --workspace /tmp
`
	got := findStrayPIDsFromPS(psOut, self, 100)
	want := []int{101, 102}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("findStrayPIDsFromPS() = %v, want %v", got, want)
	}
}

func TestFindStrayPIDsFromPSWithSpacesInPath(t *testing.T) {
	self := "/Users/alice/Library/Application Support/waw/extras/bin/waw-remote-agent"
	psOut := `
  200 /Users/alice/Library/Application Support/waw/extras/bin/waw-remote-agent --daemon --workspace /tmp
  201 /Users/alice/Library/Application Support/waw/extras/bin/waw-remote-agent --daemon-worker --workspace /tmp
  202 /Users/alice/Library/Application Support/waw/extras/bin/waw-remote-agent
`
	got := findStrayPIDsFromPS(psOut, self, 200)
	want := []int{201, 202}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("findStrayPIDsFromPS(spaces) = %v, want %v", got, want)
	}
}
