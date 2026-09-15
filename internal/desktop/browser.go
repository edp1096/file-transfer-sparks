package desktop

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
)

type geometry struct {
	Width  int `json:"width"`
	Height int `json:"height"`
	X      int `json:"x"`
	Y      int `json:"y"`
}

func (g geometry) valid() bool {
	return g.Width >= 320 && g.Width <= 16384 && g.Height >= 240 && g.Height <= 16384 && g.X >= -65536 && g.X <= 65536 && g.Y >= -65536 && g.Y <= 65536
}
func findBrowser(explicit string) (string, error) {
	if explicit != "" {
		return exec.LookPath(explicit)
	}
	candidates := []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "msedge"}
	if runtime.GOOS == "windows" {
		for _, root := range []string{os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
			if root == "" {
				continue
			}
			for _, suffix := range []string{"Google/Chrome/Application/chrome.exe", "Chromium/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"} {
				candidates = append(candidates, filepath.Join(root, filepath.FromSlash(suffix)))
			}
		}
	} else if runtime.GOOS == "darwin" {
		candidates = append(candidates, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
	}
	for _, candidate := range candidates {
		if p, err := exec.LookPath(candidate); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("Chrome, Chromium or Edge is required; install one or pass --browser PATH")
}
func (a *App) OpenBrowser(explicit string) error {
	binary, err := findBrowser(explicit)
	if err != nil {
		return err
	}
	// Independent profile gives this app ownership of the process and avoids touching the user's browser profile.
	// User cache supports sandboxed Chromium packages that cannot access host /tmp.
	cache, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	if err = os.MkdirAll(cache, 0700); err != nil {
		return err
	}
	profile, err := os.MkdirTemp(cache, "file-transfer-sparks-")
	if err != nil {
		return err
	}
	// Disable translation in this app's isolated profile before the first page opens.
	defaults := filepath.Join(profile, "Default")
	if err = os.MkdirAll(defaults, 0700); err != nil {
		os.RemoveAll(profile)
		return err
	}
	if err = os.WriteFile(filepath.Join(defaults, "Preferences"), []byte(`{"translate":{"enabled":false}}`), 0600); err != nil {
		os.RemoveAll(profile)
		return err
	}
	g := geometry{Width: 1024, Height: 1088}
	if raw, e := a.readStorage("window"); e == nil {
		var saved geometry
		if json.Unmarshal([]byte(raw), &saved) == nil && saved.valid() {
			g = saved
		}
	}
	args := []string{"--user-data-dir=" + profile, "--app=" + a.URL(), fmt.Sprintf("--window-size=%d,%d", g.Width, g.Height), fmt.Sprintf("--window-position=%d,%d", g.X, g.Y), "--no-first-run", "--password-store=basic", "--no-default-browser-check", "--disable-background-mode", "--disable-extensions", "--disable-features=Translate,msEdgeTranslate", "--no-proxy-server"}
	cmd := exec.Command(binary, args...)
	if err = cmd.Start(); err != nil {
		os.RemoveAll(profile)
		return err
	}
	exited := make(chan struct{})
	var stopOnce sync.Once
	stop := func() { stopOnce.Do(func() { cmd.Process.Kill(); <-exited; os.RemoveAll(profile) }) }
	a.mu.Lock()
	a.browserStop = stop
	a.mu.Unlock()
	go func() { cmd.Wait(); close(exited); a.once.Do(func() { close(a.done) }) }()
	return nil
}
func openRepository() error {
	url := "https://github.com/edp1096/file-transfer-sparks"
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
