DGX Spark 간 파일·Docker 이미지 전송과 외장 SSD 백업·복원 도구.

## 사용법

* 필요
    - 로컬: Chrome, Chromium 또는 Edge
    - 원격: `tar`, `nc` (`pv` 선택)
* 실행: `./file-transfer-sparks`
* SSH 계정 `docker` 그룹
    - `sudo usermod -aG docker "$USER"`

## 빌드

Go 1.24+, Node 22+, Chrome

```sh
make
```
