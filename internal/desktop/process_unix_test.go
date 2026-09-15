//go:build !windows

package desktop

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCancelKillsShellChildren(t *testing.T) {
	a := testApp(t)
	ws := dial(t, a)
	marker := filepath.Join(a.root, "unexpected")
	// The delayed write detects a surviving shell child, not just the parent PID.
	shell := fmt.Sprintf("(sleep 1; echo survived > '%s') & echo ready; wait", marker)
	m := rpc(t, ws, 1, "spawn", map[string]any{"command": command{Shell: shell}})
	pid := m["result"].(map[string]any)["id"]
	read(t, ws) // shell has launched its background child
	send(t, ws, 2, "kill", map[string]any{"id": pid})
	for {
		m = read(t, ws)
		if m["id"] == float64(2) {
			break
		}
	}
	time.Sleep(1200 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("shell child survived cancellation", err)
	}
}
