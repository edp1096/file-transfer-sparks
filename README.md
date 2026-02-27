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

* Requirements - Node >= 22.22, Go >= 1.24
```sh
neu update
make
```