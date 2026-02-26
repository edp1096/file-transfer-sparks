package main

import (
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	gotty "github.com/mattn/go-tty"
	"golang.org/x/crypto/ssh"
)

func openSession() (err error) {
	config := &ssh.ClientConfig{
		User:            *user,
		Auth:            []ssh.AuthMethod{ssh.Password(*password)},
		Timeout:         5 * time.Second,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}

	if *keyfile != "" {
		signer, err := setSigner(*keyfile)
		if err != nil {
			panic(err)
		}
		config.Auth = []ssh.AuthMethod{ssh.PublicKeys(signer)}
	}

	hostport := fmt.Sprintf("%s:%d", flag.Arg(0), *port)
	conn, err := ssh.Dial("tcp", hostport, config)
	if err != nil {
		return fmt.Errorf("ssh.Dial %v: %v", hostport, err)
	}
	defer conn.Close()

	sess, err := conn.NewSession()
	if err != nil {
		return fmt.Errorf("conn.NewSession: %v", err)
	}
	defer sess.Close()

	// Resolve the remote command from either -b64cmd flag or positional args.
	// -b64cmd takes priority: the base64-encoded value contains no shell
	// metacharacters, so Windows cmd.exe / PowerShell cannot mangle it.
	remoteCmd := ""
	if *b64cmd != "" {
		decoded, decErr := base64.StdEncoding.DecodeString(*b64cmd)
		if decErr != nil {
			return fmt.Errorf("b64cmd decode: %v", decErr)
		}
		remoteCmd = string(decoded)
	} else if flag.NArg() > 1 {
		// Fallback: plain args after hostname joined by space
		remoteCmd = strings.Join(flag.Args()[1:], " ")
	}

	if remoteCmd != "" {
		// sess.Stdin = os.Stdin
		sess.Stdout = os.Stdout
		sess.Stderr = os.Stderr

		if err = sess.Run(remoteCmd); err != nil {
			// Propagate remote exit code to caller
			if exitErr, ok := err.(*ssh.ExitError); ok {
				os.Exit(exitErr.ExitStatus())
			}
			return fmt.Errorf("sess.Run: %v", err)
		}
		return nil
	}

	// Interactive shell mode (original behavior below)
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 115200,
		ssh.TTY_OP_OSPEED: 115200,
	}

	tty, err := gotty.Open()
	if err != nil {
		return fmt.Errorf("tty.Open: %v", err)
	}
	defer tty.Close()

	termType := "xterm-256color"
	w, h, err := tty.Size()
	if err != nil {
		w, h = 0, 0
	}

	clean, err := tty.Raw()
	if err != nil {
		log.Fatal(err)
	}
	defer clean()

	err = sess.RequestPty(termType, h, w, modes)
	if err != nil {
		// Fallback to basic xterm
		termType = "xterm"
		sess.Close()

		sess, err = conn.NewSession()
		if err != nil {
			return fmt.Errorf("conn.NewSession (fallback): %v", err)
		}
		defer sess.Close()

		err = sess.RequestPty(termType, h, w, modes)
		if err != nil {
			return fmt.Errorf("sess.RequestPty (fallback): %s", err)
		}
	}

	pw, err := sess.StdinPipe()
	if err != nil {
		return fmt.Errorf("sess.StdinPipe: %v", err)
	}
	sess.Stdout = os.Stdout
	sess.Stderr = os.Stderr

	err = sess.Shell()
	if err != nil {
		return fmt.Errorf("sess.Shell: %v", err)
	}

	setResizeControl(sess, tty, pw, w, h)
	setEventControl(pw, tty)

	sess.Wait()

	return nil
}
