.PHONY: all dist ssh-client-dist neu-build package \
        pkg-win-x64 pkg-linux-x64 pkg-linux-arm64 clean release

SSH_DIR  := ssh-client
SSH_BIN  := $(SSH_DIR)/bin
DIST_DIR := dist/file-transfer-sparks
OUT_DIR  := dist

GIT_TAG  := $(shell git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
VERSION  := $(patsubst v%,%,$(GIT_TAG))

# ──────────────────────────────────────────────────────────────
all: dist

sync-version:
	@echo "[version] $(VERSION)"
	@node -e "\
	const fs=require('fs'), f='neutralino.config.json';\
	const d=JSON.parse(fs.readFileSync(f,'utf8'));\
	d.version='$(VERSION)';\
	fs.writeFileSync(f,JSON.stringify(d,null,2)+'\n');\
	console.log('  -> neutralino.config.json version: $(VERSION)');"

release:
	@node -e "\
	const v='$(V)',desc='$(DESC)';\
	if(!v){console.error('Usage: make release V=v1.2.3 DESC=\"description\"');process.exit(1);}\
	if(!desc){console.error('DESC is required. Usage: make release V=v1.2.3 DESC=\"description\"');process.exit(1);}\
	const fs=require('fs'),f='neutralino.config.json';\
	const d=JSON.parse(fs.readFileSync(f,'utf8'));\
	d.version=v.replace(/^v/,'');\
	fs.writeFileSync(f,JSON.stringify(d,null,2)+'\n');\
	console.log('[release] '+v+': neutralino.config.json updated');"
	git add neutralino.config.json
	-git commit -m "version $(V)"
	git tag -a $(V) -m "$(DESC)"
	git push origin HEAD --tags
	@echo "[release] done: $(V)"

dist: sync-version ssh-client-dist neu-build package

ssh-client-dist:
	$(MAKE) -C $(SSH_DIR) dist

neu-build:
	neu build

package: pkg-win-x64 pkg-linux-x64 pkg-linux-arm64

# ──────────────────────────────────────────────────────────────
ifeq ($(OS),Windows_NT)
# ── Windows (cmd.exe + 내장 tar, Win10 1803+) ────────────────

pkg-win-x64:
	@echo [pkg] win_x64
	@if exist "$(OUT_DIR)\tmp_win_x64" rmdir /S /Q "$(OUT_DIR)\tmp_win_x64"
	@md "$(OUT_DIR)\tmp_win_x64"
	@copy /Y "$(DIST_DIR)\file-transfer-sparks-win_x64.exe"            "$(OUT_DIR)\tmp_win_x64\file-transfer-sparks.exe" >NUL
	@copy /Y "$(SSH_BIN)\ssh-client_windows_amd64.exe"         "$(OUT_DIR)\tmp_win_x64\ssh-client.exe"   >NUL
	@copy /Y "$(DIST_DIR)\resources.neu"                       "$(OUT_DIR)\tmp_win_x64\resources.neu"    >NUL
	tar -acf "$(OUT_DIR)\file-transfer-sparks-win_x64.zip" -C "$(OUT_DIR)\tmp_win_x64" .
	@rmdir /S /Q "$(OUT_DIR)\tmp_win_x64"
	@echo   -^> dist\file-transfer-sparks-win_x64.zip

pkg-linux-x64:
	@echo [pkg] linux_x64
	@if exist "$(OUT_DIR)\tmp_linux_x64" rmdir /S /Q "$(OUT_DIR)\tmp_linux_x64"
	@md "$(OUT_DIR)\tmp_linux_x64"
	@copy /Y "$(DIST_DIR)\file-transfer-sparks-linux_x64"              "$(OUT_DIR)\tmp_linux_x64\file-transfer-sparks"   >NUL
	@copy /Y "$(SSH_BIN)\ssh-client_linux_amd64"               "$(OUT_DIR)\tmp_linux_x64\ssh-client"     >NUL
	@copy /Y "$(DIST_DIR)\resources.neu"                       "$(OUT_DIR)\tmp_linux_x64\resources.neu"  >NUL
	tar -czf "$(OUT_DIR)/file-transfer-sparks-linux_x64.tar.gz" -C "$(OUT_DIR)/tmp_linux_x64" .
	@rmdir /S /Q "$(OUT_DIR)\tmp_linux_x64"
	@echo   -^> dist\file-transfer-sparks-linux_x64.tar.gz

pkg-linux-arm64:
	@echo [pkg] linux_arm64
	@if exist "$(OUT_DIR)\tmp_linux_arm64" rmdir /S /Q "$(OUT_DIR)\tmp_linux_arm64"
	@md "$(OUT_DIR)\tmp_linux_arm64"
	@copy /Y "$(DIST_DIR)\file-transfer-sparks-linux_arm64"            "$(OUT_DIR)\tmp_linux_arm64\file-transfer-sparks"  >NUL
	@copy /Y "$(SSH_BIN)\ssh-client_linux_arm64"               "$(OUT_DIR)\tmp_linux_arm64\ssh-client"    >NUL
	@copy /Y "$(DIST_DIR)\resources.neu"                       "$(OUT_DIR)\tmp_linux_arm64\resources.neu" >NUL
	tar -czf "$(OUT_DIR)/file-transfer-sparks-linux_arm64.tar.gz" -C "$(OUT_DIR)/tmp_linux_arm64" .
	@rmdir /S /Q "$(OUT_DIR)\tmp_linux_arm64"
	@echo   -^> dist\file-transfer-sparks-linux_arm64.tar.gz

clean:
	$(MAKE) -C $(SSH_DIR) clean
	@if exist "$(OUT_DIR)" rmdir /S /Q "$(OUT_DIR)"

else
# ── Linux / macOS ─────────────────────────────────────────────

pkg-win-x64:
	@echo "[pkg] win_x64"
	@rm -rf $(OUT_DIR)/tmp_win_x64
	@mkdir -p $(OUT_DIR)/tmp_win_x64
	@cp $(DIST_DIR)/file-transfer-sparks-win_x64.exe    $(OUT_DIR)/tmp_win_x64/file-transfer-sparks.exe
	@cp $(SSH_BIN)/ssh-client_windows_amd64.exe $(OUT_DIR)/tmp_win_x64/ssh-client.exe
	@cp $(DIST_DIR)/resources.neu               $(OUT_DIR)/tmp_win_x64/resources.neu
	@zip -qj $(OUT_DIR)/file-transfer-sparks-win_x64.zip \
	    $(OUT_DIR)/tmp_win_x64/file-transfer-sparks.exe \
	    $(OUT_DIR)/tmp_win_x64/ssh-client.exe \
	    $(OUT_DIR)/tmp_win_x64/resources.neu
	@rm -rf $(OUT_DIR)/tmp_win_x64
	@echo "  -> dist/file-transfer-sparks-win_x64.zip"

pkg-linux-x64:
	@echo "[pkg] linux_x64"
	@rm -rf $(OUT_DIR)/tmp_linux_x64
	@mkdir -p $(OUT_DIR)/tmp_linux_x64
	@cp $(DIST_DIR)/file-transfer-sparks-linux_x64  $(OUT_DIR)/tmp_linux_x64/file-transfer-sparks
	@cp $(SSH_BIN)/ssh-client_linux_amd64   $(OUT_DIR)/tmp_linux_x64/ssh-client
	@cp $(DIST_DIR)/resources.neu           $(OUT_DIR)/tmp_linux_x64/resources.neu
	@chmod +x $(OUT_DIR)/tmp_linux_x64/file-transfer-sparks $(OUT_DIR)/tmp_linux_x64/ssh-client
	@tar -czf $(OUT_DIR)/file-transfer-sparks-linux_x64.tar.gz -C $(OUT_DIR)/tmp_linux_x64 .
	@rm -rf $(OUT_DIR)/tmp_linux_x64
	@echo "  -> dist/file-transfer-sparks-linux_x64.tar.gz"

pkg-linux-arm64:
	@echo "[pkg] linux_arm64"
	@rm -rf $(OUT_DIR)/tmp_linux_arm64
	@mkdir -p $(OUT_DIR)/tmp_linux_arm64
	@cp $(DIST_DIR)/file-transfer-sparks-linux_arm64 $(OUT_DIR)/tmp_linux_arm64/file-transfer-sparks
	@cp $(SSH_BIN)/ssh-client_linux_arm64    $(OUT_DIR)/tmp_linux_arm64/ssh-client
	@cp $(DIST_DIR)/resources.neu            $(OUT_DIR)/tmp_linux_arm64/resources.neu
	@chmod +x $(OUT_DIR)/tmp_linux_arm64/file-transfer-sparks $(OUT_DIR)/tmp_linux_arm64/ssh-client
	@tar -czf $(OUT_DIR)/file-transfer-sparks-linux_arm64.tar.gz -C $(OUT_DIR)/tmp_linux_arm64 .
	@rm -rf $(OUT_DIR)/tmp_linux_arm64
	@echo "  -> dist/file-transfer-sparks-linux_arm64.tar.gz"

clean:
	$(MAKE) -C $(SSH_DIR) clean
	@rm -rf $(OUT_DIR)

endif
