// Build and package using Go only, including on Windows. No global Go settings or module edits.
package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	dist := flag.Bool("dist", false, "build Windows x64, Linux x64 and Linux ARM64 archives")
	clean := flag.Bool("clean", false, "remove generated application binaries and archives")
	version := flag.String("version", "0.0.15", "application version")
	release := flag.String("release", "", "create and push release tag")
	description := flag.String("description", "", "release tag description")
	flag.Parse()
	if *clean {
		// Settings live beside binaries. Remove generated files, preserving user data.
		paths := []string{"bin/file-transfer-sparks", "bin/file-transfer-sparks.exe", "bin/ssh-client", "bin/ssh-client.exe", ".tmp/desktop-ui.png", ".tmp/keyboard-ui.png"}
		for _, target := range []string{"win_x64", "linux_x64", "linux_arm64"} {
			dir := "dist/file-transfer-sparks-" + target
			paths = append(paths, dir+".zip", dir+".tar.gz")
		}
		for _, path := range paths {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		return nil
	}
	if *release != "" {
		if !strings.HasPrefix(*release, "v") || *description == "" {
			return fmt.Errorf("usage: make release V=v1.2.3 DESC=description")
		}
		cmd := exec.Command("git", "status", "--porcelain")
		b, err := cmd.Output()
		if err != nil {
			return err
		}
		if len(b) > 0 {
			return fmt.Errorf("commit changes before creating a release")
		}
		if err = command("", nil, "git", "tag", "-a", *release, "-m", *description); err != nil {
			return err
		}
		return command("", nil, "git", "push", "origin", "HEAD", "refs/tags/"+*release)
	}
	targets := [][2]string{{runtime.GOOS, runtime.GOARCH}}
	if *dist {
		targets = [][2]string{{"windows", "amd64"}, {"linux", "amd64"}, {"linux", "arm64"}}
	}
	for _, target := range targets {
		platform, arch := target[0], target[1]
		dir := "bin"
		output := ""
		if *dist {
			labelOS, labelArch := platform, arch
			if platform == "windows" {
				labelOS = "win"
			}
			if arch == "amd64" {
				labelArch = "x64"
			}
			output = filepath.Join("dist", "file-transfer-sparks-"+labelOS+"_"+labelArch)
			if err := os.MkdirAll("dist", 0755); err != nil {
				return err
			}
			var err error
			dir, err = os.MkdirTemp("", "sparks-package-*")
			if err != nil {
				return err
			}
			defer os.RemoveAll(dir)
		}
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
		absolute, err := filepath.Abs(dir)
		if err != nil {
			return err
		}
		ext := ""
		if platform == "windows" {
			ext = ".exe"
		}
		env := append(os.Environ(), "GOOS="+platform, "GOARCH="+arch, "CGO_ENABLED=0")
		for _, module := range []string{"ssh-client", "."} {
			name := "ssh-client"
			flags := "-s -w"
			if module == "." {
				name = "file-transfer-sparks"
				flags += " -X main.version=" + strings.TrimPrefix(*version, "v")
				if platform == "windows" {
					flags += " -H=windowsgui"
				}
			}
			if err := command(module, env, "go", "build", "-trimpath", "-ldflags", flags, "-o", filepath.Join(absolute, name+ext), "."); err != nil {
				return err
			}
		}
		if *dist {
			if err := archive(dir, output, platform, ext); err != nil {
				return err
			}
		}
	}
	return nil
}
func command(dir string, env []string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	if env != nil {
		cmd.Env = env
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
func archive(dir, output, platform, ext string) (err error) {
	name := output + ".tar.gz"
	if platform == "windows" {
		name = output + ".zip"
	}
	f, err := os.Create(name)
	if err != nil {
		return err
	}
	defer func() {
		if e := f.Close(); err == nil {
			err = e
		}
	}()
	var add func(string, os.FileInfo, io.Reader) error
	var finish func() error
	if platform == "windows" {
		z := zip.NewWriter(f)
		add = func(name string, info os.FileInfo, r io.Reader) error {
			h, e := zip.FileInfoHeader(info)
			if e != nil {
				return e
			}
			h.Name = name
			h.Method = zip.Deflate
			w, e := z.CreateHeader(h)
			if e != nil {
				return e
			}
			_, e = io.Copy(w, r)
			return e
		}
		finish = z.Close
	} else {
		gz := gzip.NewWriter(f)
		tw := tar.NewWriter(gz)
		add = func(name string, info os.FileInfo, r io.Reader) error {
			h, e := tar.FileInfoHeader(info, "")
			if e != nil {
				return e
			}
			h.Name = name
			if e = tw.WriteHeader(h); e != nil {
				return e
			}
			_, e = io.Copy(tw, r)
			return e
		}
		finish = func() error {
			e := tw.Close()
			e2 := gz.Close()
			if e != nil {
				return e
			}
			return e2
		}
	}
	for _, item := range []string{"file-transfer-sparks" + ext, "ssh-client" + ext, "README.md", "LICENSE"} {
		path := filepath.Join(dir, item)
		if item == "README.md" || item == "LICENSE" {
			path = item
		}
		input, e := os.Open(path)
		if e != nil {
			return e
		}
		info, e := input.Stat()
		if e == nil {
			e = add(item, info, input)
		}
		input.Close()
		if e != nil {
			return e
		}
	}
	if err = finish(); err != nil {
		return err
	}
	fmt.Println(name)
	return nil
}
