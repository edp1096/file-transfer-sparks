package desktop

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

type command struct {
	Executable string   `json:"executable"`
	Args       []string `json:"args"`
	Shell      string   `json:"shell"`
}
type process struct {
	id          int
	cancel      context.CancelFunc
	ready, done chan struct{}
}

func (c *client) command(ctx context.Context, spec command) (*exec.Cmd, error) {
	var cmd *exec.Cmd
	if spec.Shell != "" {
		if spec.Executable != "" {
			return nil, fmt.Errorf("ambiguous command")
		}
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", spec.Shell)
		} else {
			cmd = exec.CommandContext(ctx, "/bin/sh", "-c", spec.Shell)
		}
	} else {
		if spec.Executable == "" {
			return nil, fmt.Errorf("missing executable")
		}
		binary := spec.Executable
		if binary == "ssh-client" || binary == "ssh-client.exe" {
			candidate := filepath.Join(c.app.root, binary)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				binary = candidate
			}
		}
		if !filepath.IsAbs(binary) && (filepath.Dir(binary) != "." || binary[0] == '.') {
			binary = filepath.Join(c.app.root, binary)
		}
		cmd = exec.CommandContext(ctx, binary, spec.Args...)
	}
	cmd.Dir = c.app.root
	configureProcess(cmd)
	cmd.WaitDelay = 2 * time.Second
	return cmd, nil
}
func (c *client) execute(spec command) (any, error) {
	cmd, err := c.command(c.ctx, spec)
	if err != nil {
		return nil, err
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if cmd.ProcessState == nil {
		return nil, err
	}
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		return nil, err
	}
	return map[string]any{"stdOut": stdout.String(), "stdErr": stderr.String(), "exitCode": cmd.ProcessState.ExitCode(), "pid": cmd.Process.Pid}, nil
}
func (c *client) spawn(spec command) (*process, error) {
	ctx, cancel := context.WithCancel(c.ctx)
	cmd, err := c.command(ctx, spec)
	if err != nil {
		cancel()
		return nil, err
	}
	c.mu.Lock()
	c.nextID++
	p := &process{id: c.nextID, cancel: cancel, ready: make(chan struct{}), done: make(chan struct{})}
	c.mu.Unlock()
	stdout := &eventWriter{c: c, p: p, action: "stdOut"}
	stderr := &eventWriter{c: c, p: p, action: "stdErr"}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err = cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	c.mu.Lock()
	c.processes[p.id] = p
	c.mu.Unlock()
	c.workers.Add(1)
	go func() {
		defer c.workers.Done()
		defer close(p.done)
		defer cancel()
		err := cmd.Wait()
		code := cmd.ProcessState.ExitCode()
		if err != nil && code == 0 {
			code = 1
		}
		<-p.ready
		stdout.flush()
		stderr.flush()
		c.send(map[string]any{"event": "spawnedProcess", "detail": map[string]any{"id": p.id, "action": "exit", "data": fmt.Sprint(code)}})
		c.mu.Lock()
		delete(c.processes, p.id)
		c.mu.Unlock()
	}()
	return p, nil
}

type eventWriter struct {
	c      *client
	p      *process
	action string
	buffer []byte
}

func (w *eventWriter) Write(b []byte) (int, error) {
	w.buffer = append(w.buffer, b...)
	// Line buffering preserves pv percentages and multibyte text across pipe reads.
	end := bytes.LastIndexByte(w.buffer, '\n') + 1
	if end == 0 && len(w.buffer) > 32768 {
		end = len(w.buffer)
	}
	if end > 0 {
		if err := w.emit(w.buffer[:end]); err != nil {
			return 0, err
		}
		w.buffer = append(w.buffer[:0], w.buffer[end:]...)
	}
	return len(b), nil
}
func (w *eventWriter) flush() {
	if len(w.buffer) > 0 {
		w.emit(w.buffer)
		w.buffer = nil
	}
}
func (w *eventWriter) emit(b []byte) error {
	select {
	case <-w.p.ready:
	case <-w.c.ctx.Done():
		return w.c.ctx.Err()
	}
	return w.c.send(map[string]any{"event": "spawnedProcess", "detail": map[string]any{"id": w.p.id, "action": w.action, "data": string(b)}})
}
