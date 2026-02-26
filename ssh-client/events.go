package main

import (
	"fmt"
	"io"

	gotty "github.com/mattn/go-tty"
	"golang.org/x/crypto/ssh"
)

// func clearBuffer(tty *gotty.TTY) {
// 	// Clear tty buffer
// 	for {
// 		_, _ = tty.ReadRune()
// 		if !tty.Buffered() {
// 			break
// 		}
// 	}
// }

func setResizeControl(sess *ssh.Session, tty *gotty.TTY, pw io.WriteCloser, w, h int) {
	go func() {
		for ws := range tty.SIGWINCH() {
			w, h = ws.W, ws.H

			// Update remote terminal size
			sess.WindowChange(h, w)

			// Send Ctrl+L to refresh display on remote
			pw.Write([]byte{12})
		}
	}()
}

func setEventControl(pw io.WriteCloser, tty *gotty.TTY) {
	go func() {
		var b []byte
		for {
			r, err := tty.ReadRune()
			if err != nil {
				fmt.Println("tty.ReadRune:", err)
			}

			if r == rune(0) {
				continue
			}

			b = append(b, []byte(string(r))...)

			if !tty.Buffered() {
				switch string(b) {
				case string([]byte{27, 91, 72}): // Home
					b = []byte("\x1b[1~")
				case string([]byte{27, 91, 70}): // End
					b = []byte("\x1b[4~")
				}

				pw.Write(b)

				b = nil
				continue
			}
		}
	}()
}
