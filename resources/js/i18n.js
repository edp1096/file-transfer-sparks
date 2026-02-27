"use strict";

// ============================================================
// i18n — Single-file translation engine + EN/KO dictionaries
// No build tools, no async loading, no race conditions.
// ============================================================

const _LANGS = {
  en: {
    // Header
    "header.transferAtoB": "Transfer A \u2192 B",
    "header.transferBtoA": "Transfer B \u2192 A",
    "header.editServer": "Edit server",
    "header.addServer": "Add server",

    // Panel
    "panel.parentDir": "Parent directory",
    "panel.pathPlaceholder": "Path...",
    "panel.refresh": "Refresh",
    "panel.selectAll": "Select all",
    "panel.name": "Name",
    "panel.size": "Size",
    "panel.modified": "Modified",
    "panel.selectServer": "Select a server above",
    "panel.loading": "Loading...",
    "panel.connecting": "Connecting...",
    "panel.emptyDir": "Empty directory",
    "panel.dockerMode": "Docker Images",
    "panel.filesMode": "File Browser",
    "panel.delete": "Delete selected",

    // Progress
    "progress.transferring": "Transferring...",
    "progress.cancel": "Cancel",
    "progress.total": "total",
    "progress.elapsed": "elapsed",
    "progress.etaDone": "ETA: Done",

    // Status
    "status.ready": "Ready",
    "status.readyHint": "Ready \u2014 Press + to add a server",
    "status.calcSize": "Calculating transfer size...",
    "status.checkEnv": "Checking remote environment...",
    "status.recvWait": "Waiting for receiver on {alias}...",
    "status.transferring": "{src} \u2192 {dst} transferring...",
    "status.deleting": "Deleting...",
    "status.cancelling": "Cancelling transfer...",
    "status.cancelled": "Transfer cancelled",
    "status.transferError": "Transfer error: {msg}",
    "status.transferDone": "Transfer complete \u2713",
    "status.transferFail": "Transfer failed \u2014 send:{sendCode} recv:{recvCode}",
    "status.connecting": "{alias} connecting...",
    "status.connected": "{alias} connected",
    "status.connFail": "{alias} connection failed",

    // Toast
    "toast.selectDockerImages": "Select Docker images to transfer",
    "toast.deleteSuccess": "Deleted {count} item(s)",
    "toast.deleteFail": "Delete failed: {msg}",
    "toast.saveFail": "Save failed: {msg}",
    "toast.enterHostUser": "Enter host and username first",
    "toast.selectBothServers": "Select both servers",
    "toast.bothPathsNeeded": "Both paths are required",
    "toast.selectFiles": "Select files/folders to transfer",
    "toast.noPv": "pv not found \u2014 transferring without progress",
    "toast.transferCancelled": "Transfer cancelled",
    "toast.error": "Error: {msg}",
    "toast.transferDone": "Transfer complete!",
    "toast.requiredFields": "Fill in all required fields (alias, SSH host, QSFP host, username)",
    "toast.saved": "\"{alias}\" saved",
    "toast.serverDeleted": "Server deleted",
    "toast.connFail": "{alias} unreachable",

    // Modal
    "modal.addServer": "Add Server",
    "modal.editServer": "Edit Server",
    "modal.alias": "Alias",
    "modal.aliasPlaceholder": "e.g. DGX-Spark-A",
    "modal.sshHost": "SSH Host (management network)",
    "modal.port": "Port",
    "modal.qsfpHost": "QSFP Host (high-speed transfer)",
    "modal.qsfpNote": "High-speed interface IP for file data \u2014 nc (netcat) connects directly to this address, not SSH",
    "modal.useSudo": "Use sudo for transfers",
    "modal.sudoNote": "When checked, tar commands run with <code style=\"color:var(--accent)\">sudo</code>. Login password is used as sudo password.",
    "modal.username": "Username",
    "modal.authType": "Authentication",
    "modal.authAgent": "SSH Agent",
    "modal.authKey": "Private key (-i)",
    "modal.authPassword": "Password",
    "modal.authCustom": "Custom client",
    "modal.keyPath": "Private key path",
    "modal.keyPathPlaceholder": "C:\\Users\\user\\.ssh\\id_rsa",
    "modal.clientPath": "SSH client path",
    "modal.clientPathPlaceholder": ".\\ssh-client.exe",
    "modal.clientPathNote": "Path to a client that supports password auth. Relative paths are based on app location.",
    "modal.password": "Password",
    "modal.cmdTemplate": "Command template",
    "modal.cmdTemplatePlaceholder": ".\\ssh-client.exe -l {USERNAME} -passwd {PASSWD} -p {PORT} {HOST} {CMD}",
    "modal.templateNote": "Available placeholders:<br><code style=\"color:var(--accent)\">{USERNAME}</code> username &nbsp;<code style=\"color:var(--accent)\">{PASSWD}</code> password &nbsp;<code style=\"color:var(--accent)\">{PORT}</code> port &nbsp;<code style=\"color:var(--accent)\">{HOST}</code> SSH host &nbsp;<code style=\"color:var(--accent)\">{CMD}</code> remote command<br><code style=\"color:var(--text2)\">.\\ssh-client.exe -l {USERNAME} -passwd {PASSWD} -p {PORT} {HOST} {CMD}</code>",
    "modal.customPassword": "Password <span style=\"color:var(--text3);font-weight:400\">(optional \u2014 when using {PASSWD})</span>",
    "modal.delete": "Delete",
    "modal.cancel": "Cancel",
    "modal.save": "Save",

    // Test
    "test.sshTest": "SSH Test",
    "test.toolsTest": "Tools Test",
    "test.sshTestTitle": "Test SSH connection",
    "test.toolsTestTitle": "Check tar / pv / nc installation",
    "test.sshConn": "SSH Connection",
    "test.success": "Success",
    "test.fail": "Failed",
    "test.tar": "tar (archive)",
    "test.pv": "pv  (progress meter)",
    "test.nc": "nc  (netcat transfer)",
    "test.notInstalled": "Not installed",
    "test.sshFailCannotCheck": "Cannot check \u2014 SSH failed",

    // Selection info
    "sel.serverSelect": "-- Select server --",
    "sel.selected": "{side}: {count} selected",

    // Confirm
    "confirm.deleteServer": "Delete \"{alias}\"?",
    "confirm.deleteFiles": "Delete {count} item(s) from {path}?",
    "confirm.dockerRmi": "Remove {count} Docker image(s) from {alias}?",

    // Time
    "time.sec": "{s}s",
    "time.minSec": "{m}m {s}s",
    "time.hourMin": "{h}h {m}m",

    // Misc
    "misc.noResponse": "No response",
    "misc.connFailed": "Connection failed",

    // Tabs
    "tab.fileTransfer": "File Transfer",
    "tab.backup": "Backup & Restore",

    // Modal — SSD section
    "modal.ssdSection": "External SSD & Backup Settings",
    "modal.ssdDevice": "Device",
    "modal.ssdDevicePlaceholder": "e.g. /dev/sda1",
    "modal.ssdMountPoint": "Mount Point",
    "modal.ssdMountPlaceholder": "e.g. /mnt/ssd_t5",
    "modal.ssdScan": "Scan",
    "modal.hfHubPath": "HF Hub Path",
    "modal.hfHubPathPlaceholder": "e.g. /home/ubuntu/.cache/huggingface/hub",
    "modal.ggufPath": "GGUF Path",
    "modal.ggufPathPlaceholder": "e.g. /home/ubuntu/gguf_models",

    // Backup tab — server/mount
    "backup.selectServer": "Select a server to use backup & restore",
    "backup.noSsdConfig": "No SSD configured for this server. Edit the server to add SSD settings.",
    "backup.mountStatus": "SSD Mount",
    "backup.mounted": "Mounted",
    "backup.notMounted": "Not mounted",
    "backup.mount": "Mount",
    "backup.unmount": "Unmount",
    "backup.checkMount": "Check",
    "backup.mounting": "Mounting...",
    "backup.unmounting": "Unmounting...",
    "backup.checking": "Checking...",
    "backup.mountSuccess": "Mounted: {point}",
    "backup.unmountSuccess": "Unmounted: {point}",
    "backup.mountFail": "Mount failed: {msg}",
    "backup.unmountFail": "Unmount failed: {msg}",
    "backup.noSsdDevice": "No SSD device configured",
    "backup.noMountPoint": "No mount point configured",
    "backup.scanNoSsd": "No external SSD found (only NVMe detected)",
    "backup.scanFail": "Scan failed: {msg}",

    // Backup tab — sub-tabs
    "backup.tabDocker": "Docker Images",
    "backup.tabHF": "HF Models",
    "backup.tabGGUF": "GGUF",

    // Backup tab — actions
    "backup.sourcePanel": "Server",
    "backup.destPanel": "SSD Backup",
    "backup.loadList": "↻",
    "backup.loadBackups": "↻",
    "backup.backup": "Backup",
    "backup.backupArrow": "Backup \u2192",
    "backup.restoreArrow": "\u2190 Restore",
    "backup.restore": "Restore",
    "backup.cancel": "Cancel",
    "backup.loading": "Loading...",
    "backup.noItems": "No items found",
    "backup.selectItems": "Select items to backup / restore",
    "backup.backupRunning": "Backup in progress...",
    "backup.restoreRunning": "Restore in progress...",
    "backup.backupDone": "Backup complete",
    "backup.restoreDone": "Restore complete",
    "backup.opFail": "Operation failed: {msg}",
    "backup.noHfPath": "HF Hub path not configured",
    "backup.noGgufPath": "GGUF path not configured",
    "backup.clearLog": "Clear",
    "backup.ssdNotMounted": "SSD is not mounted. Mount it first.",
  },

  ko: {
    // Header
    "header.transferAtoB": "A \u2192 B \uc804\uc1a1",
    "header.transferBtoA": "B \u2192 A \uc804\uc1a1",
    "header.editServer": "\uc11c\ubc84 \ud3b8\uc9d1",
    "header.addServer": "\uc11c\ubc84 \ucd94\uac00",

    // Panel
    "panel.parentDir": "\uc0c1\uc704 \ud3f4\ub354",
    "panel.pathPlaceholder": "\uacbd\ub85c...",
    "panel.refresh": "\uc0c8\ub85c\uace0\uce68",
    "panel.selectAll": "\uc804\uccb4 \uc120\ud0dd",
    "panel.name": "\uc774\ub984",
    "panel.size": "\ud06c\uae30",
    "panel.modified": "\uc218\uc815\uc77c",
    "panel.selectServer": "\uc704\uc5d0\uc11c \uc11c\ubc84\ub97c \uc120\ud0dd\ud558\uc138\uc694",
    "panel.loading": "\ub85c\ub529 \uc911...",
    "panel.connecting": "\uc5f0\uacb0 \uc911...",
    "panel.emptyDir": "\ube48 \ub514\ub809\ud1a0\ub9ac",
    "panel.dockerMode": "Docker \uc774\ubbf8\uc9c0",
    "panel.filesMode": "\ud30c\uc77c \ud0d0\uc0c9\uae30",
    "panel.delete": "\uc120\ud0dd \uc0ad\uc81c",

    // Progress
    "progress.transferring": "\uc804\uc1a1 \uc911...",
    "progress.cancel": "\uc911\ub2e8",
    "progress.total": "\uc804\uccb4",
    "progress.elapsed": "\uacbd\uacfc",
    "progress.etaDone": "ETA: \uc644\ub8cc",

    // Status
    "status.ready": "\uc900\ube44",
    "status.readyHint": "\uc900\ube44  \u2014  \uc11c\ubc84\ub97c \ucd94\uac00\ud558\ub824\uba74 \uff0b \ubc84\ud2bc\uc744 \ub204\ub974\uc138\uc694",
    "status.calcSize": "\uc804\uc1a1 \ud06c\uae30 \uacc4\uc0b0 \uc911...",
    "status.checkEnv": "\uc6d0\uaca9 \ud658\uacbd \ud655\uc778 \uc911...",
    "status.recvWait": "{alias}\uc5d0\uc11c \uc218\uc2e0 \ub300\uae30...",
    "status.transferring": "{src} \u2192 {dst} \uc804\uc1a1 \uc911...",
    "status.deleting": "\uc0ad\uc81c \uc911...",
    "status.cancelling": "\uc804\uc1a1 \ucde8\uc18c \uc911...",
    "status.cancelled": "\uc804\uc1a1 \ucde8\uc18c\ub428",
    "status.transferError": "\uc804\uc1a1 \uc624\ub958: {msg}",
    "status.transferDone": "\uc804\uc1a1 \uc644\ub8cc \u2713",
    "status.transferFail": "\uc804\uc1a1 \uc2e4\ud328 \u2014 send:{sendCode} recv:{recvCode}",
    "status.connecting": "{alias} \uc5f0\uacb0 \uc911...",
    "status.connected": "{alias} \uc5f0\uacb0\ub428",
    "status.connFail": "{alias} \uc5f0\uacb0 \uc2e4\ud328",

    // Toast
    "toast.selectDockerImages": "\uc804\uc1a1\ud560 Docker \uc774\ubbf8\uc9c0\ub97c \uc120\ud0dd\ud558\uc138\uc694",
    "toast.deleteSuccess": "{count}\uac1c \ud56d\ubaa9 \uc0ad\uc81c\ub428",
    "toast.deleteFail": "\uc0ad\uc81c \uc2e4\ud328: {msg}",
    "toast.saveFail": "\uc800\uc7a5 \uc2e4\ud328: {msg}",
    "toast.enterHostUser": "\ud638\uc2a4\ud2b8\uc640 \uc0ac\uc6a9\uc790\uba85\uc744 \uba3c\uc800 \uc785\ub825\ud558\uc138\uc694",
    "toast.selectBothServers": "\uc591\ucabd \uc11c\ubc84\ub97c \ubaa8\ub450 \uc120\ud0dd\ud558\uc138\uc694",
    "toast.bothPathsNeeded": "\uc591\ucabd \uacbd\ub85c\uac00 \ud544\uc694\ud569\ub2c8\ub2e4",
    "toast.selectFiles": "\uc804\uc1a1\ud560 \ud30c\uc77c/\ud3f4\ub354\ub97c \uc120\ud0dd\ud558\uc138\uc694",
    "toast.noPv": "pv \uc5c6\uc74c \u2014 \uc9c4\ud589\ub960 \ubbf8\uc9c0\uc6d0 \ubaa8\ub4dc\ub85c \uc804\uc1a1\ud569\ub2c8\ub2e4",
    "toast.transferCancelled": "\uc804\uc1a1\uc774 \ucde8\uc18c\ub418\uc5c8\uc2b5\ub2c8\ub2e4",
    "toast.error": "\uc624\ub958: {msg}",
    "toast.transferDone": "\uc804\uc1a1 \uc644\ub8cc!",
    "toast.requiredFields": "\ud544\uc218 \ud56d\ubaa9\uc744 \ubaa8\ub450 \uc785\ub825\ud558\uc138\uc694 (\ubcc4\uce6d, SSH \ud638\uc2a4\ud2b8, QSFP \ud638\uc2a4\ud2b8, \uc0ac\uc6a9\uc790\uba85)",
    "toast.saved": "\"{alias}\" \uc800\uc7a5\ub428",
    "toast.serverDeleted": "\uc11c\ubc84 \uc0ad\uc81c\ub428",
    "toast.connFail": "{alias} \uc5f0\uacb0 \ubd88\uac00",

    // Modal
    "modal.addServer": "\uc11c\ubc84 \ucd94\uac00",
    "modal.editServer": "\uc11c\ubc84 \ud3b8\uc9d1",
    "modal.alias": "\ubcc4\uce6d",
    "modal.aliasPlaceholder": "\uc608: DGX-Spark-A",
    "modal.sshHost": "SSH \ud638\uc2a4\ud2b8 (\uad00\ub9ac\ub9dd)",
    "modal.port": "\ud3ec\ud2b8",
    "modal.qsfpHost": "QSFP \ud638\uc2a4\ud2b8 (\uace0\uc18d \uc804\uc1a1\ub9dd)",
    "modal.qsfpNote": "\ud30c\uc77c \ub370\uc774\ud130\uac00 \uc624\uac00\ub294 \uace0\uc18d \uc778\ud130\ud398\uc774\uc2a4 IP \u2014 SSH\uac00 \uc544\ub2cc nc(netcat)\uc774 \uc774 \uc8fc\uc18c\ub85c \uc9c1\uc811 \uc5f0\uacb0\ub429\ub2c8\ub2e4",
    "modal.useSudo": "\uc804\uc1a1 \uc2dc sudo \uc0ac\uc6a9",
    "modal.sudoNote": "\uccb4\ud06c\ud558\uba74 tar \uba85\ub839\uc744 <code style=\"color:var(--accent)\">sudo</code>\ub85c \uc2e4\ud589\ud569\ub2c8\ub2e4. \ub85c\uadf8\uc778 \ube44\ubc00\ubc88\ud638\uac00 sudo \ube44\ubc00\ubc88\ud638\ub85c \uc0ac\uc6a9\ub429\ub2c8\ub2e4.",
    "modal.username": "\uc0ac\uc6a9\uc790\uba85",
    "modal.authType": "\uc778\uc99d \ubc29\uc2dd",
    "modal.authAgent": "SSH Agent",
    "modal.authKey": "\uac1c\uc778\ud0a4 (-i)",
    "modal.authPassword": "\ube44\ubc00\ubc88\ud638",
    "modal.authCustom": "\ucee4\uc2a4\ud140 \ud074\ub77c\uc774\uc5b8\ud2b8",
    "modal.keyPath": "\uac1c\uc778\ud0a4 \uacbd\ub85c",
    "modal.keyPathPlaceholder": "C:\\Users\\user\\.ssh\\id_rsa",
    "modal.clientPath": "SSH \ud074\ub77c\uc774\uc5b8\ud2b8 \uacbd\ub85c",
    "modal.clientPathPlaceholder": ".\\ssh-client.exe",
    "modal.clientPathNote": "\ube44\ubc00\ubc88\ud638 \uc778\uc99d\uc744 \uc9c0\uc6d0\ud558\ub294 \ud074\ub77c\uc774\uc5b8\ud2b8 \uacbd\ub85c. \uc0c1\ub300\uacbd\ub85c\ub294 \uc571 \uc2e4\ud589 \uc704\uce58 \uae30\uc900.",
    "modal.password": "\ube44\ubc00\ubc88\ud638",
    "modal.cmdTemplate": "\ucee4\ub9e8\ub4dc \ud15c\ud50c\ub9bf",
    "modal.cmdTemplatePlaceholder": ".\\ssh-client.exe -l {USERNAME} -passwd {PASSWD} -p {PORT} {HOST} {CMD}",
    "modal.templateNote": "\uc0ac\uc6a9 \uac00\ub2a5\ud55c \ud50c\ub808\uc774\uc2a4\ud640\ub354:<br><code style=\"color:var(--accent)\">{USERNAME}</code> \uc0ac\uc6a9\uc790\uba85 &nbsp;<code style=\"color:var(--accent)\">{PASSWD}</code> \ube44\ubc00\ubc88\ud638 &nbsp;<code style=\"color:var(--accent)\">{PORT}</code> \ud3ec\ud2b8 &nbsp;<code style=\"color:var(--accent)\">{HOST}</code> SSH \ud638\uc2a4\ud2b8 &nbsp;<code style=\"color:var(--accent)\">{CMD}</code> \uc6d0\uaca9 \uba85\ub839<br><code style=\"color:var(--text2)\">.\\ssh-client.exe -l {USERNAME} -passwd {PASSWD} -p {PORT} {HOST} {CMD}</code>",
    "modal.customPassword": "\ube44\ubc00\ubc88\ud638 <span style=\"color:var(--text3);font-weight:400\">(\uc120\ud0dd \u2014 {PASSWD} \uc0ac\uc6a9 \uc2dc)</span>",
    "modal.delete": "\uc0ad\uc81c",
    "modal.cancel": "\ucde8\uc18c",
    "modal.save": "\uc800\uc7a5",

    // Test
    "test.sshTest": "SSH \ud14c\uc2a4\ud2b8",
    "test.toolsTest": "\ub3c4\uad6c \ud14c\uc2a4\ud2b8",
    "test.sshTestTitle": "SSH \uc5f0\uacb0 \ud655\uc778",
    "test.toolsTestTitle": "tar / pv / nc \uc124\uce58 \ud655\uc778",
    "test.sshConn": "SSH \uc5f0\uacb0",
    "test.success": "\uc131\uacf5",
    "test.fail": "\uc2e4\ud328",
    "test.tar": "tar (\uc544\uce74\uc774\ube0c)",
    "test.pv": "pv  (\uc9c4\ud589\ub960 \uce21\uc815)",
    "test.nc": "nc  (netcat \uc804\uc1a1)",
    "test.notInstalled": "\uc124\uce58 \uc548 \ub428",
    "test.sshFailCannotCheck": "SSH \uc2e4\ud328\ub85c \ud655\uc778 \ubd88\uac00",

    // Selection info
    "sel.serverSelect": "-- \uc11c\ubc84 \uc120\ud0dd --",
    "sel.selected": "{side}: {count}\uac1c \uc120\ud0dd",

    // Confirm
    "confirm.deleteServer": "\"{alias}\"\ub97c \uc0ad\uc81c\ud558\uc2dc\uaca0\uc2b5\ub2c8\uae4c?",
    "confirm.deleteFiles": "{path} \uc5d0\uc11c {count}\uac1c \ud56d\ubaa9\uc744 \uc0ad\uc81c\ud558\uc2dc\uaca0\uc2b5\ub2c8\uae4c?",
    "confirm.dockerRmi": "{alias} \uc5d0\uc11c Docker \uc774\ubbf8\uc9c0 {count}\uac1c\ub97c \uc0ad\uc81c\ud558\uc2dc\uaca0\uc2b5\ub2c8\uae4c?",

    // Time
    "time.sec": "{s}\ucd08",
    "time.minSec": "{m}\ubd84 {s}\ucd08",
    "time.hourMin": "{h}\uc2dc\uac04 {m}\ubd84",

    // Misc
    "misc.noResponse": "\uc751\ub2f5 \uc5c6\uc74c",
    "misc.connFailed": "\uc5f0\uacb0 \uc2e4\ud328",

    // Tabs
    "tab.fileTransfer": "\ud30c\uc77c \uc804\uc1a1",
    "tab.backup": "\ubc31\uc5c5 & \ubcf5\uc6d0",

    // Modal — SSD section
    "modal.ssdSection": "\uc678\uc7a5 SSD & \ubc31\uc5c5 \uc124\uc815",
    "modal.ssdDevice": "\ub514\ubc14\uc774\uc2a4",
    "modal.ssdDevicePlaceholder": "\uc608: /dev/sda1",
    "modal.ssdMountPoint": "\ub9c8\uc6b4\ud2b8 \ud3ec\uc778\ud2b8",
    "modal.ssdMountPlaceholder": "\uc608: /mnt/ssd_t5",
    "modal.ssdScan": "\uc2a4\uce94",
    "modal.hfHubPath": "HF Hub \uacbd\ub85c",
    "modal.hfHubPathPlaceholder": "\uc608: /home/ubuntu/.cache/huggingface/hub",
    "modal.ggufPath": "GGUF \uacbd\ub85c",
    "modal.ggufPathPlaceholder": "\uc608: /home/ubuntu/gguf_models",

    // Backup tab — server/mount
    "backup.selectServer": "\ubc31\uc5c5\u00b7\ubcf5\uc6d0\ud560 \uc11c\ubc84\ub97c \uc120\ud0dd\ud558\uc138\uc694",
    "backup.noSsdConfig": "\uc774 \uc11c\ubc84\uc5d0 SSD \uc124\uc815\uc774 \uc5c6\uc2b5\ub2c8\ub2e4. \uc11c\ubc84\ub97c \ud3b8\uc9d1\ud574\uc11c SSD \uc124\uc815\uc744 \ucd94\uac00\ud558\uc138\uc694.",
    "backup.mountStatus": "SSD \ub9c8\uc6b4\ud2b8",
    "backup.mounted": "\ub9c8\uc6b4\ud2b8\ub428",
    "backup.notMounted": "\ub9c8\uc6b4\ud2b8 \uc548\ub428",
    "backup.mount": "\ub9c8\uc6b4\ud2b8",
    "backup.unmount": "\uc5b8\ub9c8\uc6b4\ud2b8",
    "backup.checkMount": "\ud655\uc778",
    "backup.mounting": "\ub9c8\uc6b4\ud2b8 \uc911...",
    "backup.unmounting": "\uc5b8\ub9c8\uc6b4\ud2b8 \uc911...",
    "backup.checking": "\ud655\uc778 \uc911...",
    "backup.mountSuccess": "\ub9c8\uc6b4\ud2b8 \uc644\ub8cc: {point}",
    "backup.unmountSuccess": "\uc5b8\ub9c8\uc6b4\ud2b8 \uc644\ub8cc: {point}",
    "backup.mountFail": "\ub9c8\uc6b4\ud2b8 \uc2e4\ud328: {msg}",
    "backup.unmountFail": "\uc5b8\ub9c8\uc6b4\ud2b8 \uc2e4\ud328: {msg}",
    "backup.noSsdDevice": "SSD \ub514\ubc14\uc774\uc2a4 \uc124\uc815 \uc5c6\uc74c",
    "backup.noMountPoint": "\ub9c8\uc6b4\ud2b8 \ud3ec\uc778\ud2b8 \uc124\uc815 \uc5c6\uc74c",
    "backup.scanNoSsd": "\uc678\uc7a5 SSD \uc5c6\uc74c (NVMe\ub9cc \uac10\uc9c0\ub428)",
    "backup.scanFail": "\uc2a4\uce94 \uc2e4\ud328: {msg}",

    // Backup tab — sub-tabs
    "backup.tabDocker": "Docker \uc774\ubbf8\uc9c0",
    "backup.tabHF": "HF \ubaa8\ub378",
    "backup.tabGGUF": "GGUF",

    // Backup tab — actions
    "backup.sourcePanel": "\uc11c\ubc84",
    "backup.destPanel": "SSD \ubc31\uc5c5",
    "backup.loadList": "↻",
    "backup.loadBackups": "↻",
    "backup.backup": "\ubc31\uc5c5",
    "backup.backupArrow": "\ubc31\uc5c5 \u2192",
    "backup.restoreArrow": "\u2190 \ubcf5\uc6d0",
    "backup.restore": "\ubcf5\uc6d0",
    "backup.cancel": "\ucde8\uc18c",
    "backup.loading": "\ub85c\ub529 \uc911...",
    "backup.noItems": "\ud56d\ubaa9 \uc5c6\uc74c",
    "backup.selectItems": "\ubc31\uc5c5/\ubcf5\uc6d0\ud560 \ud56d\ubaa9\uc744 \uc120\ud0dd\ud558\uc138\uc694",
    "backup.backupRunning": "\ubc31\uc5c5 \uc911...",
    "backup.restoreRunning": "\ubcf5\uc6d0 \uc911...",
    "backup.backupDone": "\ubc31\uc5c5 \uc644\ub8cc",
    "backup.restoreDone": "\ubcf5\uc6d0 \uc644\ub8cc",
    "backup.opFail": "\uc791\uc5c5 \uc2e4\ud328: {msg}",
    "backup.noHfPath": "HF Hub \uacbd\ub85c \uc124\uc815 \uc5c6\uc74c",
    "backup.noGgufPath": "GGUF \uacbd\ub85c \uc124\uc815 \uc5c6\uc74c",
    "backup.clearLog": "\uc9c0\uc6b0\uae30",
    "backup.ssdNotMounted": "SSD\uac00 \ub9c8\uc6b4\ud2b8\ub418\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4. \uba3c\uc800 \ub9c8\uc6b4\ud2b8 \ud558\uc138\uc694.",
  }
};

let _currentLang = 'en';

/**
 * Translate a key with optional {placeholder} substitution.
 * Fallback chain: current lang -> 'en' -> raw key.
 */
function t(key, params) {
  let str = (_LANGS[_currentLang] && _LANGS[_currentLang][key])
         || (_LANGS.en && _LANGS.en[key])
         || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), v);
    }
  }
  return str;
}

/** Get current language code */
function getLang() { return _currentLang; }

/**
 * Switch language, apply to DOM, persist to Neutralino.storage.
 */
async function setLang(lang) {
  if (!_LANGS[lang]) return;
  _currentLang = lang;
  document.documentElement.lang = lang;
  applyI18n();
  try {
    await Neutralino.storage.setData('lang', lang);
  } catch (_) { }
}

/**
 * Initialize i18n: load persisted language, apply to DOM.
 */
async function initI18n() {
  let hasSaved = false;
  try {
    const saved = await Neutralino.storage.getData('lang');
    if (saved && _LANGS[saved]) { _currentLang = saved; hasSaved = true; }
  } catch (_) {}

  if (!hasSaved) {
    // 첫 실행 — OS/브라우저 로케일에서 기본 언어 감지
    // navigator.language 예: 'ko-KR', 'en-US', 'zh-CN', 'ja-JP'
    const primary = (navigator.language || 'en').split('-')[0].toLowerCase();
    _currentLang = _LANGS[primary] ? primary : 'en';
  }

  document.documentElement.lang = _currentLang;
  const sel = document.getElementById('langSelect');
  if (sel) sel.value = _currentLang;
  applyI18n();
}

/**
 * Apply translations to all DOM elements with data-i18n* attributes.
 * Idempotent — safe to call repeatedly after DOM changes.
 */
function applyI18n() {
  // data-i18n="key" → textContent
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  // data-i18n-html="key" → innerHTML (for strings containing HTML tags)
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  // data-i18n-placeholder="key" → placeholder attribute
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  // data-i18n-title="key" → title attribute
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });

  // Sync lang switcher if present
  const langSelect = document.getElementById('langSelect');
  if (langSelect) langSelect.value = _currentLang;
}
