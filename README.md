File/folder transfer via QSFP for 2 DGX Sparks

You can copy or backup/restore docker images, models to another DGX Spark or external storage


## Run
```sh
./file-transfer-sparks
```


## Requirements

* utils - tar, nc, pv
* Make sure user in `docker` group
```sh
sudo usermod -aG docker $USER
```


## Build

```sh
neu update
make
```