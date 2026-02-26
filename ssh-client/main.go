package main // import "ssh-client"

import (
	"flag"
	"fmt"
	"os"
)

var (
	user     = flag.String("l", "", "login_name")
	password = flag.String("passwd", "", "password")
	port     = flag.Int("p", 22, "port")
	keyfile  = flag.String("i", "", "private key")
	b64cmd   = flag.String("b64cmd", "", "base64-encoded remote command (avoids shell metachar issues on Windows)")
)

func main() {
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}

	err := openSession()
	if err != nil {
		fmt.Println(err)
	}
}
