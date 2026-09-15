package desktop

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"
)

func testApp(t *testing.T) *App {
	t.Helper()
	a, err := Start(t.TempDir(), "test", fstest.MapFS{"index.html": {Data: []byte("<html>test</html>")}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	return a
}
func dial(t *testing.T, a *App) *websocket.Conn {
	t.Helper()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(a.origin, "http")+"/api/ws?token="+a.token, http.Header{"Origin": {a.origin}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Close() })
	return ws
}
func read(t *testing.T, ws *websocket.Conn) map[string]any {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(10 * time.Second))
	var m map[string]any
	if err := ws.ReadJSON(&m); err != nil {
		t.Fatal(err)
	}
	return m
}
func send(t *testing.T, ws *websocket.Conn, id int, method string, p any) {
	t.Helper()
	if err := ws.WriteJSON(map[string]any{"id": id, "method": method, "params": p}); err != nil {
		t.Fatal(err)
	}
}
func rpc(t *testing.T, ws *websocket.Conn, id int, method string, p any) map[string]any {
	t.Helper()
	send(t, ws, id, method, p)
	m := read(t, ws)
	if m["id"] != float64(id) {
		t.Fatalf("expected reply %d, got %v", id, m)
	}
	return m
}
func TestAuthorization(t *testing.T) {
	a := testApp(t)
	for _, tc := range []struct{ origin, token string }{{"http://evil.example", a.token}, {a.origin, "bad"}, {"", a.token}} {
		ws, res, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(a.origin, "http")+"/api/ws?token="+tc.token, http.Header{"Origin": {tc.origin}})
		if ws != nil {
			ws.Close()
		}
		if err == nil || res.StatusCode != 403 {
			t.Fatalf("unauthorized connection accepted: %v", err)
		}
	}
	req, _ := http.NewRequest("GET", a.origin, nil)
	req.Host = "evil.example"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal(res.Status)
	}
	ws := dial(t, a)
	m := rpc(t, ws, 1, "config", map[string]any{})
	if m["error"] != nil {
		t.Fatal(m)
	}
}
func TestStorageCompatibilityAndRestrictions(t *testing.T) {
	a := testApp(t)
	ws := dial(t, a)
	dir := filepath.Join(a.root, ".storage")
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, "lang.neustorage"), []byte("ko"), 0600)
	m := rpc(t, ws, 1, "storage.get", map[string]string{"key": "lang"})
	if m["result"] != "ko" {
		t.Fatal(m)
	}
	for i, key := range []string{"../outside", "a/b", "", strings.Repeat("a", 51)} {
		m = rpc(t, ws, i+2, "storage.set", map[string]string{"key": key, "data": "bad"})
		if m["error"] == nil {
			t.Fatal("unsafe key accepted", key)
		}
	}
	m = rpc(t, ws, 10, "servers.read", map[string]string{})
	if m["code"] != "NOT_FOUND" {
		t.Fatal(m)
	}
	// Opaque encrypted content must round-trip unchanged and replacement must work.
	for i, value := range []string{"encrypted-old", "encrypted-new"} {
		m = rpc(t, ws, 11+i, "servers.write", map[string]string{"data": value})
		if m["error"] != nil {
			t.Fatal(m)
		}
		b, err := os.ReadFile(filepath.Join(a.root, "servers.enc"))
		if err != nil || string(b) != value {
			t.Fatal(string(b), err)
		}
	}
	m = rpc(t, ws, 20, "env", map[string]string{"name": "PATH"})
	if m["error"] == nil {
		t.Fatal("unrestricted environment")
	}
	m = rpc(t, ws, 21, "storage.set", map[string]string{"key": "window", "data": `{"width":1234,"height":700}`})
	if m["error"] != nil {
		t.Fatal(m)
	}
}
func helperCommand(t *testing.T, mode string, args ...string) command {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return command{Executable: executable, Args: append([]string{"-test.run=TestProcessHelper", "--", mode}, args...)}
}
func TestProcessHelper(t *testing.T) {
	var args []string
	for i, arg := range os.Args {
		if arg == "--" {
			args = os.Args[i+1:]
			break
		}
	}
	if len(args) == 0 {
		return
	}
	switch args[0] {
	case "instant":
		fmt.Print("hello 한글\n")
		fmt.Fprint(os.Stderr, "42\n")
		os.Exit(7)
	case "args":
		json.NewEncoder(os.Stdout).Encode(args[1:])
		os.Exit(0)
	case "wait":
		fmt.Println(os.Getpid())
		time.Sleep(60 * time.Second)
		os.Exit(0)
	}
	os.Exit(2)
}
func TestExecuteArgumentBoundariesAndFailure(t *testing.T) {
	a := testApp(t)
	ws := dial(t, a)
	args := []string{"password with spaces & $HOME `echo wrong`", `C:\Program Files\key`, "한글\nsecond line"}
	m := rpc(t, ws, 1, "exec", map[string]any{"command": helperCommand(t, "args", args...)})
	if m["error"] != nil {
		t.Fatal(m)
	}
	result := m["result"].(map[string]any)
	var got []string
	if err := json.Unmarshal([]byte(result["stdOut"].(string)), &got); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got) != fmt.Sprint(args) {
		t.Fatalf("args changed: %#v", got)
	}
	m = rpc(t, ws, 2, "exec", map[string]any{"command": helperCommand(t, "instant")})
	result = m["result"].(map[string]any)
	if result["exitCode"] != float64(7) || result["stdErr"] != "42\n" || result["stdOut"] != "hello 한글\n" {
		t.Fatal(m)
	}
	m = rpc(t, ws, 3, "spawn", map[string]any{"command": command{Executable: filepath.Join(a.root, "missing")}})
	if m["error"] == nil {
		t.Fatal(m)
	}
}
func TestSpawnEventOrderingAndCancellation(t *testing.T) {
	a := testApp(t)
	ws := dial(t, a)
	for i := 1; i <= 20; i++ {
		m := rpc(t, ws, i, "spawn", map[string]any{"command": helperCommand(t, "instant")})
		if m["error"] != nil {
			t.Fatal(m)
		}
		pid := m["result"].(map[string]any)["id"]
		out, stderr := "", ""
		for {
			m = read(t, ws)
			d := m["detail"].(map[string]any)
			if d["id"] != pid {
				t.Fatal(m)
			}
			switch d["action"] {
			case "stdOut":
				out += d["data"].(string)
			case "stdErr":
				stderr += d["data"].(string)
			case "exit":
				if d["data"] != "7" || out != "hello 한글\n" || stderr != "42\n" {
					t.Fatal(m, out, stderr)
				}
				goto next
			}
		}
	next:
	}
	m := rpc(t, ws, 30, "spawn", map[string]any{"command": helperCommand(t, "wait")})
	pid := m["result"].(map[string]any)["id"]
	read(t, ws) // helper reports that it started
	send(t, ws, 31, "kill", map[string]any{"id": pid})
	exit, reply := false, false
	for !exit || !reply {
		m = read(t, ws)
		if m["event"] == "spawnedProcess" {
			d := m["detail"].(map[string]any)
			if d["action"] == "exit" {
				exit = true
				if d["data"] == "0" {
					t.Fatal("cancelled process succeeded")
				}
			}
		} else if m["id"] == float64(31) {
			reply = true
		}
	}
}
func TestCloseWaitsForProcesses(t *testing.T) {
	a := testApp(t)
	ws := dial(t, a)
	rpc(t, ws, 1, "spawn", map[string]any{"command": helperCommand(t, "wait")})
	read(t, ws)
	a.mu.Lock()
	var c *client
	for item := range a.clients {
		c = item
	}
	a.mu.Unlock()
	a.Close()
	select {
	case <-c.finished:
	default:
		t.Fatal("Close returned before process cleanup")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.processes) != 0 {
		t.Fatal("processes remain")
	}
}

func TestPreferenceWriteOrder(t *testing.T) {
	a := testApp(t)
	ws := dial(t, a)
	for i := 1; i <= 30; i++ {
		send(t, ws, i, "storage.set", map[string]string{"key": "appZoom", "data": fmt.Sprint(i)})
	}
	for i := 1; i <= 30; i++ {
		m := read(t, ws)
		if m["id"] != float64(i) || m["error"] != nil {
			t.Fatal(m)
		}
	}
	m := rpc(t, ws, 31, "storage.get", map[string]string{"key": "appZoom"})
	if m["result"] != "30" {
		t.Fatal(m)
	}
}
