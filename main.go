package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"file-transfer-sparks/internal/desktop"
)

//go:embed resources
var resources embed.FS
var version = "0.0.15"

func main() {
	if err := run(); err != nil {
		desktop.ReportError(err)
		os.Exit(1)
	}
}

func run() error {
	noBrowser := flag.Bool("no-browser", false, "serve without launching a browser (development/testing)")
	dataDir := flag.String("data-dir", "", "settings and SSH client directory (default: executable directory)")
	browser := flag.String("browser", "", "Chrome, Chromium or Edge executable")
	flag.Parse()
	if *dataDir == "" {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		*dataDir = filepath.Dir(executable)
	}
	root, err := filepath.Abs(*dataDir)
	if err != nil {
		return err
	}
	assets, err := fs.Sub(resources, "resources")
	if err != nil {
		return err
	}
	app, err := desktop.Start(root, version, assets)
	if err != nil {
		return err
	}
	defer app.Close()
	if *noBrowser {
		fmt.Println(app.URL())
	} else if err := app.OpenBrowser(*browser); err != nil {
		return err
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case <-signals:
	case <-app.Done():
	}
	return nil
}
