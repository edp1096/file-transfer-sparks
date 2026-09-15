# File Transfer for DGX Sparks

DGX Spark 간 파일·Docker 이미지 전송과 외장 SSD 모델 백업/복원 도구입니다.
Go 서버가 Chrome/Chromium/Edge를 앱 창으로 직접 실행합니다.

- 빌드: `make` → `bin/`에 실행 파일 2개 생성
- 실행: `cd bin && ./file-transfer-sparks`
- 배포: `make dist`
- 기존 설정 이전: `servers.enc`와 `.storage/`를 새 실행 파일 옆에 복사

요구 사항과 검증 방법은 [README.md](README.md)를 참고하세요.
