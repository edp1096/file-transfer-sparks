Transfer files and Docker images between DGX Sparks; back up and restore data on external SSDs.

## Usage

* Requirements
    - Local: Chrome, Chromium, or Edge
    - Remote: `tar`, `nc` (`pv` optional)
* Run: `./file-transfer-sparks`
* SSH account in the `docker` group
    - `sudo usermod -aG docker "$USER"`

## Build

Go 1.24+, Node 22+, Chrome

```sh
make
```
