package desktop

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type App struct {
	root, version, token, origin string
	server                       *http.Server
	mu                           sync.Mutex
	clients                      map[*client]bool
	storageMu                    sync.Mutex
	done                         chan struct{}
	once                         sync.Once
	browserStop                  func()
}
type request struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type client struct {
	app       *App
	ws        *websocket.Conn
	writeMu   sync.Mutex
	mu        sync.Mutex
	processes map[int]*process
	nextID    int
	ctx       context.Context
	cancel    context.CancelFunc
	workers   sync.WaitGroup
	finished  chan struct{}
}

func Start(root, version string, assets fs.FS) (*App, error) {
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	a := &App{root: root, version: version, token: hex.EncodeToString(token), origin: "http://" + listener.Addr().String(), clients: make(map[*client]bool), done: make(chan struct{})}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ws", a.connect)
	mux.Handle("/", http.FileServer(http.FS(assets)))
	a.server = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if "http://"+r.Host != a.origin {
			http.Error(w, "Invalid host", http.StatusForbidden)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		mux.ServeHTTP(w, r)
	}), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := a.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			a.once.Do(func() { close(a.done) })
		}
	}()
	return a, nil
}
func (a *App) URL() string           { return a.origin + "/#" + a.token }
func (a *App) Done() <-chan struct{} { return a.done }
func (a *App) Close() {
	a.once.Do(func() { close(a.done) })
	a.server.Close()
	a.mu.Lock()
	var finished []chan struct{}
	for c := range a.clients {
		finished = append(finished, c.finished)
		c.cancel()
		c.ws.Close()
	}
	stop := a.browserStop
	a.mu.Unlock()
	if stop != nil {
		stop()
	}
	for _, done := range finished {
		<-done
	}
}
func (a *App) connect(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != a.origin || subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(a.token)) != 1 {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}
	u := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == a.origin }}
	ws, err := u.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &client{app: a, ws: ws, ctx: ctx, cancel: cancel, processes: make(map[int]*process), finished: make(chan struct{})}
	a.mu.Lock()
	select {
	case <-a.done:
		a.mu.Unlock()
		cancel()
		ws.Close()
		return
	default:
	}
	a.clients[c] = true
	a.mu.Unlock()
	defer func() {
		cancel()
		ws.Close()
		c.workers.Wait()
		a.mu.Lock()
		delete(a.clients, c)
		a.mu.Unlock()
		close(c.finished)
	}()
	ws.SetReadLimit(8 << 20)
	ws.SetReadDeadline(time.Now().Add(45 * time.Second))
	ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(45 * time.Second)) })
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					ws.Close()
					return
				}
			}
		}
	}()
	for {
		var req request
		if err := ws.ReadJSON(&req); err != nil {
			return
		}
		// Preserve preference-write order while keeping long commands and cancellation concurrent.
		switch req.Method {
		case "exec", "spawn", "kill":
			c.workers.Add(1)
			go func() { defer c.workers.Done(); c.handle(req) }()
		default:
			c.handle(req)
		}
	}
}
func (c *client) send(value any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	err := c.ws.WriteJSON(value)
	if err != nil {
		c.cancel()
		c.ws.Close()
	}
	return err
}
func (c *client) reply(id int, result any, err error) {
	response := map[string]any{"id": id, "result": result}
	if err != nil {
		response["error"] = err.Error()
		if errors.Is(err, fs.ErrNotExist) {
			response["code"] = "NOT_FOUND"
		}
	}
	c.send(response)
}
func (c *client) handle(r request) {
	var p struct {
		Key     string  `json:"key"`
		Data    string  `json:"data"`
		Name    string  `json:"name"`
		Command command `json:"command"`
		ID      int     `json:"id"`
	}
	if err := json.Unmarshal(r.Params, &p); err != nil {
		c.reply(r.ID, nil, err)
		return
	}
	var result any
	var err error
	switch r.Method {
	case "config":
		platform := "Linux"
		if runtime.GOOS == "windows" {
			platform = "Windows"
		} else if runtime.GOOS == "darwin" {
			platform = "Darwin"
		}
		result = map[string]string{"version": c.app.version, "os": platform}
	case "env":
		if p.Name != "USERNAME" && p.Name != "COMPUTERNAME" {
			err = fmt.Errorf("unsupported environment key")
		} else {
			result = os.Getenv(p.Name)
		}
	case "storage.get":
		result, err = c.app.readStorage(p.Key)
	case "storage.set":
		err = c.app.writeStorage(p.Key, p.Data)
	case "servers.read":
		var b []byte
		b, err = os.ReadFile(filepath.Join(c.app.root, "servers.enc"))
		result = string(b)
	case "servers.write":
		c.app.storageMu.Lock()
		err = atomicWrite(filepath.Join(c.app.root, "servers.enc"), []byte(p.Data))
		c.app.storageMu.Unlock()
	case "exec":
		result, err = c.execute(p.Command)
	case "spawn":
		var proc *process
		proc, err = c.spawn(p.Command)
		if err == nil {
			// Publish the ID before any stdout/stderr/exit event, even for instant exits.
			c.reply(r.ID, map[string]int{"id": proc.id}, nil)
			close(proc.ready)
			return
		}
	case "kill":
		c.mu.Lock()
		proc := c.processes[p.ID]
		c.mu.Unlock()
		if proc != nil {
			proc.cancel()
			<-proc.done
		}
	case "openRepository":
		err = openRepository()
	default:
		err = fmt.Errorf("unknown method: %s", r.Method)
	}
	c.reply(r.ID, result, err)
}

var storageKey = regexp.MustCompile(`^[a-zA-Z_0-9-]{1,50}$`)

// Keep the existing portable buckets so upgrades retain language, theme, zoom and panel settings.
func (a *App) readStorage(key string) (string, error) {
	if !storageKey.MatchString(key) {
		return "", fmt.Errorf("invalid storage key")
	}
	a.storageMu.Lock()
	defer a.storageMu.Unlock()
	b, err := os.ReadFile(filepath.Join(a.root, ".storage", key+".neustorage"))
	return string(b), err
}
func (a *App) writeStorage(key, data string) error {
	if key == "window" {
		var g geometry
		if json.Unmarshal([]byte(data), &g) != nil || !g.valid() {
			return fmt.Errorf("invalid window geometry")
		}
	}
	if !storageKey.MatchString(key) {
		return fmt.Errorf("invalid storage key")
	}
	a.storageMu.Lock()
	defer a.storageMu.Unlock()
	dir := filepath.Join(a.root, ".storage")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(dir, key+".neustorage"), []byte(data))
}
func atomicWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".settings-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
