Simple file & folder transfer tool for 2 DGX Sparks

You can copy or backup/restore docker images, models to another DGX Spark or external storage


## Run
```sh
./file-transfer-sparks
```


## Requirements

* tar, nc, pv
* Set user in `docker` group
```sh
sudo usermod -aG docker $USER
newgrp docker
```


## Build

* Requirements - Neutralinojs >= 6.5, Node >= 22.22, Go >= 1.24
```sh
neu update
make
```


## Trouble shooting

* Freeze on Orange PI 5 plus / JoshuaRiek's Ubuntu rockchip
    * See [run.sh](run.sh) or run below
```sh
WEBKIT_DISABLE_COMPOSITING_MODE=1 ./file-transfer-sparks &
```
