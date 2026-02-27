Simple file & folder transfer tool for 2 DGX Sparks

You can copy or backup/restore docker images, models to another DGX Spark or external storage


## Run
```sh
./file-transfer-sparks
```


## Requirements

* tar, nc, pv are installed
* Set user in `docker` group
```sh
sudo usermod -aG docker $USER
newgrp docker
```


## Build

```sh
neu update
make
```