.PHONY: all build test test-ui dist clean release

VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo 0.0.14)

all: build

build:
	go run ./tools/build -version "$(VERSION)"

test:
	go test -race ./...
	cd ssh-client && go test ./...

test-ui: build
	node tools/test-desktop-ui.mjs

dist:
	go run ./tools/build -dist -version "$(VERSION)"

release:
	go run ./tools/build -release "$(V)" -description "$(DESC)"

clean:
	go run ./tools/build -clean
