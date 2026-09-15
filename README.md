# File Transfer for DGX Sparks

Transfer files, folders and Docker images between two DGX Sparks, or back up and
restore Docker images, Hugging Face models and GGUF models on external SSDs.

The application runs a local Go HTTP/WebSocket server and opens Chrome, Chromium
or Edge in app mode. HTML/CSS/JavaScript are embedded in the executable.

## Run

Extract a release archive and run `./file-transfer-sparks` (Windows:
`file-transfer-sparks.exe`). Keep `ssh-client` / `ssh-client.exe` beside it.
Install Chrome, Chromium or Edge on the computer running the application.
Use `--browser /path/to/chrome` to select a browser explicitly.

Remote machines need `tar`, `nc` and preferably `pv`. Docker operations require
the SSH user to belong to the `docker` group. Agent/private-key authentication
uses the local OpenSSH `ssh` executable; password authentication uses the bundled
SSH client. Custom command templates run through the local system shell.

## Settings and upgrades

Settings are portable and stored beside the executable: `servers.enc` and
`.storage/`. Copy both from an existing installation into the new executable's
directory to retain server credentials, theme, language, zoom and panel settings.
Their existing encryption and storage formats are preserved. An unreadable server
file stops initialization rather than silently replacing the saved servers.
The browser profile is temporary; settings survive profile cleanup.

Window size and position are saved in `.storage/window.neustorage`. The desktop's
window manager may override requested positions (especially on Wayland).
Closing the app terminates its local command processes. Reloading the UI also
stops local processes, so finish or cancel transfers before reloading. Remote
commands can outlive a disconnected SSH session; use the transfer Cancel action
while connected to clean up the receiving listener.

## Build

Go 1.24 or later is required. Node 22+ and Chrome are needed for UI tests only. On Linux, the UI integration
test also uses local `tar` and `nc` for an isolated file-transfer round trip.

```sh
make                 # builds both executables in bin/
(cd bin && ./file-transfer-sparks)  # run the application
make test            # Go tests, including process lifecycle tests
make test-ui         # isolated headless Chrome integration tests
make dist            # Windows x64, Linux x64 and Linux ARM64 archives
```

Without Make: `go run ./tools/build` or `go run ./tools/build -dist`.
The build and packaging tools use Go only.

For development, `go run . --data-dir "$PWD" --no-browser` prints a local launch
URL. Its fragment is a per-run access token; open that full URL in Chrome.
The API listens only on 127.0.0.1 and checks the launch token and browser origin.
`--data-dir` also determines the working directory for relative SSH client paths.
