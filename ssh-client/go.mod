module ssh-client

go 1.24.0

toolchain go1.24.2

require (
	github.com/mattn/go-tty v0.0.7
	golang.org/x/crypto v0.47.0
)

require (
	github.com/mattn/go-isatty v0.0.20 // indirect
	golang.org/x/sys v0.40.0 // indirect
)

replace github.com/mattn/go-tty => github.com/edp1096/go-tty v0.0.0-20240427140603-5244c02fcc96
