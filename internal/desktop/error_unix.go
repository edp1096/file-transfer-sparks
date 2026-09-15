//go:build !windows

package desktop

import (
	"fmt"
	"os"
)

func ReportError(err error) { fmt.Fprintln(os.Stderr, err) }
