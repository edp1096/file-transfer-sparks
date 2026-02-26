"use strict";

// ============================================================
// STATE
// ============================================================
const PORT_MIN = 20000, PORT_MAX = 29000;

const S = {
    servers: [], srvA: null, srvB: null,
    pathA: null, pathB: null,
    filesA: [], filesB: [],
    selA: new Set(), selB: new Set(),
    busy: false, senderPid: null, recvPid: null,
    senderExitCode: null, recvExitCode: null,
    tPort: null, tDir: null, tBytes: 0, tStart: 0,
    progressTimer: null,
    masterKey: null, editId: null
};

// ============================================================
// CRYPTO  (Web Crypto API, AES-256-GCM, no external deps)
// ============================================================
async function initMasterKey() {
    // Use machine identity as salt so the encrypted file is tied to this machine
    let salt = 'DGXTransfer-salt-default';
    try {
        const u = await Neutralino.os.getEnv('USERNAME');
        const c = await Neutralino.os.getEnv('COMPUTERNAME');
        if (u || c) salt = 'DGXTransfer-' + (u || 'u') + '-' + (c || 'c');
    } catch (_) { }

    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        'raw', enc.encode('DGXTransfer-AES-GCM-v1'), 'PBKDF2', false, ['deriveKey']
    );
    S.masterKey = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
        baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
}

async function aesEncrypt(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, S.masterKey, new TextEncoder().encode(text)
    );
    const buf = new Uint8Array(12 + ct.byteLength);
    buf.set(iv);
    buf.set(new Uint8Array(ct), 12);
    return btoa(String.fromCharCode(...buf));
}

async function aesDecrypt(b64) {
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dec = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buf.slice(0, 12) }, S.masterKey, buf.slice(12)
    );
    return new TextDecoder().decode(dec);
}

// ============================================================
// STORAGE  — portable: saved next to the executable as servers.enc
// NL_PATH is the app root directory provided by Neutralinojs runtime
// ============================================================
function storePath() {
    // NL_PATH ends without separator; append platform separator + filename
    const sep = NL_OS === 'Windows' ? '\\' : '/';
    return NL_PATH + sep + 'servers.enc';
}

async function loadServers() {
    try {
        const raw = await Neutralino.filesystem.readFile(storePath());
        return JSON.parse(await aesDecrypt(raw.trim()));
    } catch (_) {
        // File missing or first run — return empty list
        return [];
    }
}

async function saveServers() {
    try {
        await Neutralino.filesystem.writeFile(storePath(), await aesEncrypt(JSON.stringify(S.servers)));
    } catch (e) {
        toast(t('toast.saveFail', { msg: e.message }), 'err');
    }
}

// ============================================================
// SSH COMMAND BUILDER
// ============================================================
function sshPrefix(srv) {
    const opts = `-o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=30 -p ${srv.port}`;
    if (srv.authType === 'KEY') {
        // Normalize backslashes so OpenSSH on Windows accepts the path
        const kp = srv.keyPath.replace(/\\/g, '/');
        return `ssh ${opts} -i "${kp}"`;
    }
    // AGENT: rely on system SSH agent, no extra flags needed
    return `ssh ${opts}`;
}

// Encode remote command as base64 so Windows cmd.exe / PowerShell
// cannot interpret shell metacharacters ( | & > < ( ) $ ` etc.)
// Base64 alphabet [A-Za-z0-9+/=] contains no cmd.exe special chars.
function b64cmd(remoteCmd) {
    return btoa(unescape(encodeURIComponent(remoteCmd)));
}

function buildSSH(srv, remoteCmd) {
    if (srv.authType === 'PASSWORD') {
        // Use -b64cmd flag: base64-encoded command bypasses all Windows shell quoting issues
        const bin = srv.clientPath || (NL_OS === 'Windows' ? '.\\ssh-client.exe' : './ssh-client');
        return `${bin} -l ${srv.username} -passwd ${srv.credential || ''} -p ${srv.port} -b64cmd ${b64cmd(remoteCmd)} ${srv.sshHost}`;
    }

    if (srv.authType === 'CUSTOM') {
        // Full command template — placeholders replaced verbatim:
        //   {USERNAME} {PASSWD} {PORT} {HOST} {CMD}
        const escaped = remoteCmd.replace(/"/g, '\\"');
        return (srv.customPrefix || '')
            .replace('{USERNAME}', srv.username)
            .replace('{PASSWD}', srv.credential || '')
            .replace('{PORT}', String(srv.port))
            .replace('{HOST}', srv.sshHost)
            .replace('{CMD}', `"${escaped}"`);
    }

    // Standard SSH — AGENT or KEY
    const escaped = remoteCmd.replace(/"/g, '\\"');
    return `${sshPrefix(srv)} ${srv.username}@${srv.sshHost} "${escaped}"`;
}

// Wrap a remote command with sudo. Uses the login password via echo | sudo -S.
// For sender (tar reads files): echo passwd | sudo -S tar ... | pv | nc
// For receiver (tar writes files): echo passwd | sudo -S bash -c "nc | tar"
function wrapSudo(srv, cmd) {
    const passwd = String(srv.credential || '').replace(/'/g, "'\\''");
    return `echo '${passwd}' | sudo -S bash -c ${bq(cmd)}`;
}

// Shell-safe single-quote wrap for remote bash arguments
function bq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

async function execSSH(srv, cmd) {
    return Neutralino.os.execCommand(buildSSH(srv, cmd));
}

// ============================================================
// TEST HELPERS
// ============================================================

// Build a temporary server object from current modal form values
function buildTmpSrv() {
    const authType = document.querySelector('input[name="authType"]:checked')?.value || 'AGENT';
    return {
        sshHost: document.getElementById('fSshHost').value.trim(),
        qsfpHost: document.getElementById('fQsfpHost').value.trim(),
        username: document.getElementById('fUsername').value.trim(),
        port: parseInt(document.getElementById('fPort').value) || 22,
        authType,
        useSudo: document.getElementById("fUseSudo").checked,
        keyPath: document.getElementById('fKeyPath').value.trim(),
        clientPath: document.getElementById('fClientPath').value.trim(),
        customPrefix: document.getElementById('fPrefix').value.trim(),
        // credential source differs by type
        credential: authType === 'CUSTOM'
            ? document.getElementById('fCredCustom').value
            : document.getElementById('fCred').value
    };
}

// Scan for external SSD devices via lsblk -J
async function scanSsdDevices() {
    const srv = buildTmpSrv();
    if (!srv.sshHost || !srv.username) { toast(t('toast.enterHostUser'), 'warn'); return; }

    const btn = document.getElementById('btnScanSsd');
    const resultEl = document.getElementById('scanResult');
    btn.disabled = true;
    resultEl.style.display = 'none';

    try {
        // lsblk -J -o NAME,TYPE,SIZE,MOUNTPOINT — filter sd* (non-NVMe removable)
        const res = await execSSH(srv, "lsblk -J -o NAME,TYPE,SIZE,MOUNTPOINT 2>/dev/null");
        const json = JSON.parse((res.stdOut || '').trim());
        const blockdevices = json.blockdevices || [];

        // Collect sd* partitions or whole disks (not nvme)
        const candidates = [];
        for (const dev of blockdevices) {
            if (!dev.name.startsWith('sd')) continue;
            if (dev.children && dev.children.length > 0) {
                for (const part of dev.children) {
                    candidates.push({ name: '/dev/' + part.name, size: part.size, mount: part.mountpoint || '' });
                }
            } else {
                candidates.push({ name: '/dev/' + dev.name, size: dev.size, mount: dev.mountpoint || '' });
            }
        }

        resultEl.style.display = '';
        if (candidates.length === 0) {
            resultEl.innerHTML = `<div class="scan-no-ssd">⚠ ${escHtml(t('backup.scanNoSsd'))}</div>`;
        } else {
            const opts = candidates.map(c =>
                `<option value="${escHtml(c.name)}">${escHtml(c.name)}  ${escHtml(c.size)}${c.mount ? '  [' + escHtml(c.mount) + ']' : ''}</option>`
            ).join('');
            resultEl.innerHTML =
                `<select id="scanSelect">${opts}</select>` +
                `<button class="btn btn-sm btn-primary" id="btnScanUse" style="align-self:flex-start">${escHtml(t('modal.ssdScan'))} ✓</button>`;
            document.getElementById('btnScanUse').onclick = () => {
                const sel = document.getElementById('scanSelect');
                if (sel) {
                    document.getElementById('fSsdDevice').value = sel.value;
                    resultEl.style.display = 'none';
                }
            };
        }
    } catch (e) {
        resultEl.style.display = '';
        resultEl.innerHTML = `<div class="scan-no-ssd">✗ ${escHtml(t('backup.scanFail', { msg: e.message || String(e) }))}</div>`;
    } finally {
        btn.disabled = false;
    }
}

// Render test result rows into #testResult
function renderTestRows(rows) {
    const el = document.getElementById('testResult');
    el.innerHTML = rows.map(r =>
        `<div class="tr-row tr-${r.state}">
      <span class="tr-icon"></span>
      <span class="tr-label">${escHtml(r.label)}</span>
      <span class="tr-val">${escHtml(r.val || '')}</span>
    </div>`
    ).join('');
    el.classList.add('visible');
}

async function runSSHTest() {
    const srv = buildTmpSrv();
    if (!srv.sshHost || !srv.username) { toast(t('toast.enterHostUser'), 'warn'); return; }

    const rows = [{ state: 'pending', label: t('test.sshConn'), val: srv.username + '@' + srv.sshHost + ':' + srv.port }];
    renderTestRows(rows);
    disableTestBtns(true);

    try {
        const res = await execSSH(srv, 'echo __DGX_OK__');
        const ok = (res.stdOut || '').includes('__DGX_OK__');
        rows[0] = { state: ok ? 'ok' : 'err', label: t('test.sshConn'), val: ok ? t('test.success') : (res.stdErr || t('test.fail')).trim().slice(0, 60) };
    } catch (e) {
        rows[0] = { state: 'err', label: t('test.sshConn'), val: String(e.message || e).slice(0, 80) };
    }

    renderTestRows(rows);
    disableTestBtns(false);
}

async function runToolsTest() {
    const srv = buildTmpSrv();
    if (!srv.sshHost || !srv.username) { toast(t('toast.enterHostUser'), 'warn'); return; }

    // Initial pending state for all checks
    const rows = [
        { state: 'pending', label: t('test.sshConn'), val: srv.username + '@' + srv.sshHost },
        { state: 'pending', label: t('test.tar'), val: '' },
        { state: 'pending', label: t('test.pv'), val: '' },
        { state: 'pending', label: t('test.nc'), val: '' }
    ];
    renderTestRows(rows);
    disableTestBtns(true);

    // Single SSH call: check all tools at once to minimize round-trips
    // Output format:  SSH_OK\ntar:<path>\npv:<path>\nnc:<path>
    const checkCmd = [
        "echo SSH_OK",
        "echo 'tar:'$(command -v tar 2>/dev/null || echo MISSING)",
        "echo 'pv:'$(command -v pv  2>/dev/null || echo MISSING)",
        "echo 'nc:'$(command -v nc  2>/dev/null || echo MISSING)"
    ].join(' && ');

    try {
        const res = await execSSH(srv, checkCmd);
        const out = res.stdOut || '';
        const lines = out.split('\n').map(l => l.trim()).filter(Boolean);

        // Parse SSH connectivity
        rows[0].state = lines.includes('SSH_OK') ? 'ok' : 'err';
        rows[0].val = rows[0].state === 'ok' ? t('test.success') : (res.stdErr || t('test.fail')).slice(0, 60);

        if (rows[0].state === 'ok') {
            // Parse each tool line  (format: "tar:/usr/bin/tar" or "tar:MISSING")
            for (const line of lines) {
                const [key, ...rest] = line.split(':');
                const val = rest.join(':').trim();
                const idx = { tar: 1, pv: 2, nc: 3 }[key];
                if (idx === undefined) continue;
                if (val === 'MISSING' || !val) {
                    rows[idx] = { state: 'err', label: rows[idx].label, val: t('test.notInstalled') };
                } else {
                    rows[idx] = { state: 'ok', label: rows[idx].label, val: val };
                }
            }
        } else {
            // SSH failed — mark tools as unknown
            rows[1].state = rows[2].state = rows[3].state = 'err';
            rows[1].val = rows[2].val = rows[3].val = t('test.sshFailCannotCheck');
        }
    } catch (e) {
        rows[0] = { state: 'err', label: t('test.sshConn'), val: String(e.message || e).slice(0, 80) };
        rows[1].state = rows[2].state = rows[3].state = 'err';
        rows[1].val = rows[2].val = rows[3].val = t('test.sshFailCannotCheck');
    }

    renderTestRows(rows);
    disableTestBtns(false);
}

function disableTestBtns(disabled) {
    document.getElementById('btnTestSSH').disabled = disabled;
    document.getElementById('btnTestTools').disabled = disabled;
    document.getElementById('btnModalSave').disabled = disabled;
}

// ============================================================
// FILE LISTING
// ============================================================
function parseLs(output) {
    const entries = [];
    for (const line of output.split('\n')) {
        if (!line.trim() || line.startsWith('total ')) continue;
        // ls -la --time-style=+%s : permissions links owner group size unixtimestamp name
        const m = line.match(/^([dl\-scbp][rwxsStTl\-]+)\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const [, perms, size, mtime, rawName] = m;
        const isLink = perms[0] === 'l';
        const isDir = perms[0] === 'd';
        const name = isLink ? rawName.split(' -> ')[0].trim() : rawName;
        if (name === '.' || name === '..') continue;
        entries.push({ name, isDir, isLink, size: parseInt(size) || 0, mtime: parseInt(mtime) || 0 });
    }
    entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return entries;
}

async function listRemote(srv, path) {
    const res = await execSSH(srv, `ls -la --time-style=+%s ${bq(path)} 2>&1`);
    const out = res.stdOut || '';
    if (!out.trim()) {
        throw new Error((res.stdErr || t('misc.noResponse')).trim().slice(0, 120));
    }
    return parseLs(out);
}

async function getHomeDir(srv) {
    const res = await execSSH(srv, 'echo $HOME');
    return (res.stdOut || '').trim() || '/home/' + srv.username;
}

async function getTransferSize(srv, paths) {
    const q = paths.map(bq).join(' ');
    const res = await execSSH(srv, `du -sb ${q} 2>/dev/null | awk '{s+=$1}END{print s+0}'`);
    return parseInt((res.stdOut || '0').trim()) || 0;
}

// ============================================================
// TRANSFER ENGINE
// ============================================================
async function checkPv(srv) {
    // Returns true if pv is available on the remote server
    try {
        const res = await execSSH(srv, 'command -v pv >/dev/null 2>&1 && echo HAS_PV || echo NO_PV');
        return (res.stdOut || '').includes('HAS_PV');
    } catch (_) {
        return false;
    }
}

async function startTransfer(dir) {
    if (S.busy) return;
    const srcSrv = dir === 'AB' ? S.srvA : S.srvB;
    const dstSrv = dir === 'AB' ? S.srvB : S.srvA;
    const srcPath = dir === 'AB' ? S.pathA : S.pathB;
    const dstPath = dir === 'AB' ? S.pathB : S.pathA;
    const sel = dir === 'AB' ? S.selA : S.selB;

    if (!srcSrv || !dstSrv) { toast(t('toast.selectBothServers'), 'warn'); return; }
    if (!srcPath || !dstPath) { toast(t('toast.bothPathsNeeded'), 'warn'); return; }
    if (sel.size === 0) { toast(t('toast.selectFiles'), 'warn'); return; }

    S.busy = true;
    S.tDir = dir;
    S.tPort = Math.floor(Math.random() * (PORT_MAX - PORT_MIN)) + PORT_MIN;
    S.senderExitCode = null;
    S.recvExitCode = null;
    updateTransferBtns();

    try {
        setStatus(t('status.calcSize'));
        // Only filenames — srcPath is the base directory
        const fileNames = [...sel];
        const quotedNames = fileNames.map(bq).join(' ');

        // For size calc: still use full paths
        const srcPaths = fileNames.map(n => joinPath(srcPath, n));
        S.tBytes = await getTransferSize(srcSrv, srcPaths);

        // Check if pv is available on the source server
        setStatus(t('status.checkEnv'));
        const hasPv = await checkPv(srcSrv);
        if (!hasPv) toast(t('toast.noPv'), 'warn');

        showProgress(dir, S.tBytes, hasPv);
        S.tStart = Date.now();

        // Kill any stale nc listener on receiver from a previous failed run
        try { await execSSH(dstSrv, `pkill -f "nc -l.*${S.tPort}" 2>/dev/null || true`); } catch (_) { }
        await sleep(400);

        // Step 1: Start receiver
        // useSudo: wrap tar with sudo using login password.
        // plain: classic nc | tar pipe.
        setStatus(t('status.recvWait', { alias: dstSrv.alias }));
        let recvInner = `mkdir -p ${bq(dstPath)} && nc -l ${S.tPort} | tar -xf - -C ${bq(dstPath)}`;
        if (dstSrv.useSudo) recvInner = wrapSudo(dstSrv, recvInner);
        const recvCmd = buildSSH(dstSrv, recvInner);
        const recvProc = await Neutralino.os.spawnProcess(recvCmd);
        S.recvPid = recvProc.id;

        // Step 2: Give receiver time to bind the nc port before sender connects.
        // tmpfile mode: nc just needs to open the port (fast).
        // pipe mode: same.
        await sleep(1200);

        // Step 3: Start sender
        setStatus(t('status.transferring', { src: srcSrv.alias, dst: dstSrv.alias }));
        const tarCmd = `tar -C ${bq(srcPath)} -cf - ${quotedNames}`;
        let sendPipeline;
        if (hasPv) {
            sendPipeline = `${tarCmd} | pv -n -s ${S.tBytes} | nc -q 1 ${dstSrv.qsfpHost} ${S.tPort}`;
        } else {
            sendPipeline = `${tarCmd} | nc -q 1 ${dstSrv.qsfpHost} ${S.tPort}`;
            startIndeterminateProgress();
        }

        if (srcSrv.useSudo) sendPipeline = wrapSudo(srcSrv, sendPipeline);
        const sendCmd = buildSSH(srcSrv, sendPipeline);
        const sendProc = await Neutralino.os.spawnProcess(sendCmd);
        S.senderPid = sendProc.id;

    } catch (e) {
        onTransferError(String(e.message || e));
    }
}

async function cancelTransfer() {
    if (!S.busy) return;
    setStatus(t('status.cancelling'));
    // Terminate spawned SSH processes on the Windows side
    try { if (S.senderPid !== null) await Neutralino.os.updateSpawnedProcess(S.senderPid, 'exit', ''); } catch (_) { }
    try { if (S.recvPid !== null) await Neutralino.os.updateSpawnedProcess(S.recvPid, 'exit', ''); } catch (_) { }
    // Also kill the nc listener on the receiver server
    const dstSrv = S.tDir === 'AB' ? S.srvB : S.srvA;
    if (dstSrv && S.tPort) {
        try { await execSSH(dstSrv, `pkill -f "nc -l.*${S.tPort}" 2>/dev/null || true`); } catch (_) { }
    }
    resetTransfer();
    hideProgress();
    setStatus(t('status.cancelled'));
    toast(t('toast.transferCancelled'), 'warn');
}

function onTransferError(msg) {
    resetTransfer(); hideProgress();
    setStatus(t('status.transferError', { msg }));
    toast(t('toast.error', { msg }), 'err');
}

function resetTransfer() {
    S.busy = false; S.senderPid = null; S.recvPid = null;
    S.senderExitCode = null; S.recvExitCode = null;
    S.tPort = null; S.tDir = null; S.tBytes = 0; S.tStart = 0;
    if (S.progressTimer) { clearInterval(S.progressTimer); S.progressTimer = null; }
    updateTransferBtns();
}

// ============================================================
// SPAWN PROCESS EVENT — pv writes percent integers to stderr
// ============================================================
Neutralino.events.on('spawnedProcess', evt => {
    const { id, action, data } = evt.detail;

    if (id === S.senderPid) {
        if (action === 'stdErr') {
            // pv -n outputs one integer per line (0-100) to stderr
            for (const line of data.split('\n')) {
                const p = parseInt(line.trim());
                if (!isNaN(p) && p >= 0 && p <= 100) updateProgressUI(p);
            }
        }
        if (action === 'exit') {
            S.senderExitCode = parseInt(data);
            console.log('[send] exit code:', S.senderExitCode);
            checkBothDone();
        }
    }

    if (id === S.recvPid) {
        if (action === 'stdErr') {
            // Show recv stderr in status bar to surface sudo/tar errors
            const msg = (data || '').trim();
            if (msg) {
                console.warn('[recv stderr]', msg);
                setStatus('[recv] ' + msg.slice(0, 120));
            }
        }
        if (action === 'exit') {
            S.recvExitCode = parseInt(data);
            console.log('[recv] exit code:', S.recvExitCode);
            checkBothDone();
        }
    }
});

// Declare success only when BOTH sender and receiver have exited.
function checkBothDone() {
    const senderDone = S.senderExitCode !== null;
    const recvDone = S.recvExitCode !== null;
    if (!senderDone || !recvDone) return;

    const ok = S.senderExitCode === 0 && S.recvExitCode === 0;
    const fill = document.getElementById('progressFill');
    if (ok) {
        fill.style.width = '100%';
        fill.className = 'progress-fill done';
        document.getElementById('progressPct').textContent = '100%';
        document.getElementById('progressEta').textContent = t('progress.etaDone');
        setStatus(t('status.transferDone'));
        toast(t('toast.transferDone'), 'ok');
        setTimeout(() => loadPanel(S.tDir === 'AB' ? 'B' : 'A'), 600);
    } else {
        fill.className = 'progress-fill error';
        const msg = t('status.transferFail', { sendCode: S.senderExitCode, recvCode: S.recvExitCode });
        setStatus(msg);
        toast(msg, 'err');
    }
    setTimeout(() => { hideProgress(); resetTransfer(); }, 4000);
}

// ============================================================
// UI — PROGRESS BAR
// ============================================================
function showProgress(dir, totalBytes, hasPv) {
    const src = dir === 'AB' ? S.srvA : S.srvB;
    const dst = dir === 'AB' ? S.srvB : S.srvA;
    document.getElementById('progressTitle').textContent =
        src.alias + '  \u2192  ' + dst.alias + '   (' + fmtBytes(totalBytes) + ' ' + t('progress.total') + ')';
    document.getElementById('progressPct').textContent = hasPv ? '0%' : '--';
    document.getElementById('progressSpeed').textContent = '-- B/s';
    document.getElementById('progressEta').textContent = 'ETA: --';
    const fill = document.getElementById('progressFill');
    fill.style.width = '0%';
    fill.className = hasPv ? 'progress-fill' : 'progress-fill indeterminate';
    document.getElementById('progressSection').classList.add('visible');
}

// Indeterminate mode: pulse the fill bar every second to show activity
function startIndeterminateProgress() {
    if (S.progressTimer) clearInterval(S.progressTimer);
    let tick = 0;
    S.progressTimer = setInterval(() => {
        tick++;
        const elapsed = (Date.now() - S.tStart) / 1000;
        document.getElementById('progressEta').textContent = fmtTime(elapsed) + ' ' + t('progress.elapsed');
        // Oscillate width so the bar visually shows activity
        const w = 30 + 30 * Math.sin(tick * 0.4);
        document.getElementById('progressFill').style.width = w + '%';
    }, 800);
}

function hideProgress() { document.getElementById('progressSection').classList.remove('visible'); }

function updateProgressUI(pct) {
    const elapsed = (Date.now() - S.tStart) / 1000;
    const done = S.tBytes * pct / 100;
    const speed = elapsed > 0.1 ? done / elapsed : 0;
    const eta = speed > 0 && pct < 100 ? (S.tBytes - done) / speed : 0;
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressPct').textContent = pct + '%';
    document.getElementById('progressSpeed').textContent = fmtBytes(speed) + '/s';
    document.getElementById('progressEta').textContent = 'ETA: ' + fmtTime(eta);
}

// ============================================================
// UI — FILE PANELS
// ============================================================
async function loadPanel(side) {
    const srv = side === 'A' ? S.srvA : S.srvB;
    const path = side === 'A' ? S.pathA : S.pathB;
    const listEl = document.getElementById('list' + side);

    if (!srv || !path) {
        listEl.innerHTML = '<div class="panel-state"><div class="state-icon">🖥</div><div class="state-msg">' + escHtml(t('panel.selectServer')) + '</div></div>';
        return;
    }
    if (side === 'A') S.selA.clear(); else S.selB.clear();
    document.getElementById('chkAll' + side).checked = false;
    listEl.innerHTML = '<div class="panel-state"><div class="state-icon">⟳</div><div class="state-msg">' + escHtml(t('panel.loading')) + '</div></div>';

    try {
        const files = await listRemote(srv, path);
        if (side === 'A') S.filesA = files; else S.filesB = files;
        renderList(side);
        updateSelInfo();
    } catch (e) {
        listEl.innerHTML = `<div class="panel-state err"><div class="state-icon">⚠</div><div class="state-msg">${escHtml(e.message || String(e))}</div></div>`;
    }
}

function renderList(side) {
    const files = side === 'A' ? S.filesA : S.filesB;
    const sel = side === 'A' ? S.selA : S.selB;
    const listEl = document.getElementById('list' + side);

    if (!files.length) {
        listEl.innerHTML = '<div class="panel-state"><div class="state-msg" style="color:var(--text3)">' + escHtml(t('panel.emptyDir')) + '</div></div>';
        return;
    }
    listEl.innerHTML = files.map(f => {
        const icon = f.isLink ? '🔗' : f.isDir ? '📁' : fileIcon(f.name);
        const cls = 'file-row' + (f.isDir ? ' is-dir' : '') + (f.isLink ? ' is-link' : '') + (sel.has(f.name) ? ' selected' : '');
        return `<div class="${cls}" data-name="${escHtml(f.name)}" data-isdir="${f.isDir ? 1 : 0}">
      <input type="checkbox" ${sel.has(f.name) ? 'checked' : ''}>
      <div class="file-name-cell"><span class="file-icon">${icon}</span><span class="file-name-text" title="${escHtml(f.name)}">${escHtml(f.name)}</span></div>
      <div class="file-size-cell">${f.isDir ? '' : fmtBytes(f.size)}</div>
      <div class="file-mtime-cell">${fmtMtime(f.mtime)}</div>
    </div>`;
    }).join('');
}

function attachPanelHandlers(side) {
    const listEl = document.getElementById('list' + side);

    // Click: toggle checkbox / selection state
    listEl.addEventListener('click', e => {
        const row = e.target.closest('.file-row');
        if (!row) return;
        const name = row.dataset.name;
        const sel = side === 'A' ? S.selA : S.selB;
        const chk = row.querySelector('input[type="checkbox"]');

        if (e.target === chk) {
            if (chk.checked) sel.add(name); else sel.delete(name);
        } else {
            // Clicking anywhere else on the row toggles selection
            if (sel.has(name)) { sel.delete(name); chk.checked = false; }
            else { sel.add(name); chk.checked = true; }
        }
        if (sel.has(name)) row.classList.add('selected'); else row.classList.remove('selected');
        updateSelInfo();
    });

    // Double-click: navigate into directory
    listEl.addEventListener('dblclick', e => {
        const row = e.target.closest('.file-row');
        if (!row || row.dataset.isdir !== '1') return;
        const newPath = joinPath(side === 'A' ? S.pathA : S.pathB, row.dataset.name);
        if (side === 'A') S.pathA = newPath; else S.pathB = newPath;
        document.getElementById('path' + side).value = newPath;
        loadPanel(side);
    });
}

// ============================================================
// UI — SERVER SELECTS
// ============================================================
function populateSelects() {
    const opts = '<option value="">' + escHtml(t('sel.serverSelect')) + '</option>' +
        S.servers.map(s => `<option value="${s.id}">${escHtml(s.alias)}</option>`).join('');
    const sa = document.getElementById('selectA'), sb = document.getElementById('selectB');
    const pa = sa.value, pb = sb.value;
    sa.innerHTML = opts; sb.innerHTML = opts;
    sa.value = pa; sb.value = pb;
    populateBkSelect();
}

async function onSelectServer(side) {
    const id = parseInt(document.getElementById('select' + side).value);
    const srv = S.servers.find(s => s.id === id) || null;

    if (side === 'A') { S.srvA = srv; S.pathA = null; S.filesA = []; S.selA.clear(); }
    else { S.srvB = srv; S.pathB = null; S.filesB = []; S.selB.clear(); }

    const dot = document.getElementById('dot' + side);
    const editBtn = document.getElementById('btnEdit' + side);
    const upBtn = document.getElementById('btnUp' + side);
    const refBtn = document.getElementById('btnRefresh' + side);
    const pathEl = document.getElementById('path' + side);
    const listEl = document.getElementById('list' + side);

    editBtn.disabled = !srv;
    updateTransferBtns();

    if (!srv) {
        dot.className = 'conn-dot';
        upBtn.disabled = refBtn.disabled = true;
        pathEl.value = '';
        listEl.innerHTML = '<div class="panel-state"><div class="state-icon">🖥</div><div class="state-msg">' + escHtml(t('panel.selectServer')) + '</div></div>';
        setStatus(t('status.ready'));
        return;
    }

    dot.className = 'conn-dot loading';
    setStatus(t('status.connecting', { alias: srv.alias }));
    listEl.innerHTML = '<div class="panel-state"><div class="state-icon">⟳</div><div class="state-msg">' + escHtml(t('panel.connecting')) + '</div></div>';

    try {
        const home = await getHomeDir(srv);
        if (side === 'A') S.pathA = home; else S.pathB = home;
        pathEl.value = home;
        upBtn.disabled = refBtn.disabled = false;
        dot.className = 'conn-dot ok';
        setStatus(t('status.connected', { alias: srv.alias }));
        await loadPanel(side);
    } catch (e) {
        dot.className = 'conn-dot err';
        listEl.innerHTML = `<div class="panel-state err"><div class="state-icon">⚠</div><div class="state-msg">${escHtml(t('misc.connFailed'))}<br><span style="font-size:11px;color:var(--text3)">${escHtml(e.message || String(e))}</span></div></div>`;
        setStatus(t('status.connFail', { alias: srv.alias }));
        toast(t('toast.connFail', { alias: srv.alias }), 'err');
    }
}

// ============================================================
// UI — SERVER MODAL
// ============================================================
function openModal(editId) {
    S.editId = editId || null;
    const srv = editId ? S.servers.find(s => s.id === editId) : null;

    document.getElementById('modalTitle').textContent = srv ? t('modal.editServer') : t('modal.addServer');
    document.getElementById('fAlias').value = srv?.alias || '';
    document.getElementById('fSshHost').value = srv?.sshHost || '';
    document.getElementById('fQsfpHost').value = srv?.qsfpHost || '';
    document.getElementById('fUsername').value = srv?.username || '';
    document.getElementById('fPort').value = srv?.port || 22;
    document.getElementById('fKeyPath').value = srv?.keyPath || '';
    document.getElementById('fClientPath').value = srv?.clientPath || (NL_OS === 'Windows' ? '.\\ssh-client.exe' : './ssh-client');
    document.getElementById('fPrefix').value = srv?.customPrefix || '';
    document.getElementById('fUseSudo').checked = srv?.useSudo || false;
    document.getElementById('fSsdDevice').value = srv?.ssdDevice || '';
    document.getElementById('fSsdMount').value = srv?.ssdMount || '';
    document.getElementById('fHfHubPath').value = srv?.hfHubPath || '';
    document.getElementById('fGgufPath').value = srv?.ggufPath || '';
    document.getElementById('scanResult').style.display = 'none';
    // populate correct credential field by auth type
    const savedType = srv?.authType || 'AGENT';
    if (savedType === 'CUSTOM') {
        document.getElementById('fCredCustom').value = srv?.credential || '';
        document.getElementById('fCred').value = '';
    } else {
        document.getElementById('fCred').value = srv?.credential || '';
        document.getElementById('fCredCustom').value = '';
    }
    document.getElementById('btnDelServer').style.display = srv ? '' : 'none';

    // Clear previous test results
    const tr = document.getElementById('testResult');
    tr.innerHTML = ''; tr.classList.remove('visible');

    document.querySelector(`input[name="authType"][value="${savedType}"]`).checked = true;
    updateAuthGroups();
    disableTestBtns(false);

    document.getElementById('serverModal').classList.add('open');
    setTimeout(() => document.getElementById('fAlias').focus(), 50);
}

function closeModal() { document.getElementById('serverModal').classList.remove('open'); }

function updateAuthGroups() {
    const atype = document.querySelector('input[name="authType"]:checked')?.value;
    document.getElementById('grpKey').style.display = atype === 'KEY' ? '' : 'none';
    document.getElementById('grpPassword').style.display = atype === 'PASSWORD' ? '' : 'none';
    document.getElementById('grpCustom').style.display = atype === 'CUSTOM' ? '' : 'none';
}

async function saveServer() {
    const alias = document.getElementById('fAlias').value.trim();
    const sshHost = document.getElementById('fSshHost').value.trim();
    const qsfpHost = document.getElementById('fQsfpHost').value.trim();
    const username = document.getElementById('fUsername').value.trim();
    const port = parseInt(document.getElementById('fPort').value) || 22;
    const authType = document.querySelector('input[name="authType"]:checked')?.value || 'AGENT';
    const useSudo = document.getElementById('fUseSudo').checked;
    const keyPath = document.getElementById('fKeyPath').value.trim();
    const clientPath = document.getElementById('fClientPath').value.trim();
    const prefix = document.getElementById('fPrefix').value.trim();
    // credential source differs by type
    const cred = authType === 'CUSTOM'
        ? document.getElementById('fCredCustom').value
        : document.getElementById('fCred').value;

    if (!alias || !sshHost || !qsfpHost || !username) {
        toast(t('toast.requiredFields'), 'warn');
        return;
    }

    const ssdDevice = document.getElementById('fSsdDevice').value.trim();
    const ssdMount = document.getElementById('fSsdMount').value.trim();
    const hfHubPath = document.getElementById('fHfHubPath').value.trim();
    const ggufPath = document.getElementById('fGgufPath').value.trim();

    const srv = {
        id: S.editId || Date.now(),
        alias, sshHost, qsfpHost, username, port, authType, useSudo,
        keyPath: authType === 'KEY' ? keyPath : '',
        clientPath: authType === 'PASSWORD' ? clientPath : '',
        customPrefix: authType === 'CUSTOM' ? prefix : '',
        credential: (authType === 'PASSWORD' || authType === 'CUSTOM') ? cred : '',
        ssdDevice, ssdMount, hfHubPath, ggufPath
    };

    if (S.editId) {
        const i = S.servers.findIndex(s => s.id === S.editId);
        if (i >= 0) S.servers[i] = srv;
        // Keep active panel references up to date
        if (S.srvA?.id === S.editId) S.srvA = srv;
        if (S.srvB?.id === S.editId) S.srvB = srv;
    } else {
        S.servers.push(srv);
    }

    await saveServers();
    populateSelects();
    closeModal();
    toast(t('toast.saved', { alias }), 'ok');
}

async function deleteServer() {
    if (!S.editId) return;
    const srv = S.servers.find(s => s.id === S.editId);
    if (!confirm(t('confirm.deleteServer', { alias: srv?.alias || 'server' }))) return;

    S.servers = S.servers.filter(s => s.id !== S.editId);
    await saveServers();

    if (S.srvA?.id === S.editId) { S.srvA = null; document.getElementById('selectA').value = ''; await onSelectServer('A'); }
    if (S.srvB?.id === S.editId) { S.srvB = null; document.getElementById('selectB').value = ''; await onSelectServer('B'); }

    populateSelects();
    closeModal();
    toast(t('toast.serverDeleted'), 'ok');
}

// ============================================================
// UI HELPERS
// ============================================================
function updateTransferBtns() {
    const ok = S.srvA && S.srvB && !S.busy;
    document.getElementById('btnAtoB').disabled = !(ok && S.selA.size > 0);
    document.getElementById('btnBtoA').disabled = !(ok && S.selB.size > 0);
}

function updateSelInfo() {
    const parts = [];
    if (S.selA.size > 0) parts.push(t('sel.selected', { side: 'A', count: S.selA.size }));
    if (S.selB.size > 0) parts.push(t('sel.selected', { side: 'B', count: S.selB.size }));
    document.getElementById('selInfo').textContent = parts.join('   ');
    updateTransferBtns();
}

function setStatus(msg) { document.getElementById('statusText').textContent = msg; }

let _tt = null;
function toast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show' + (type ? ' t-' + type : '');
    clearTimeout(_tt);
    _tt = setTimeout(() => { el.className = ''; }, 3500);
}

// ============================================================
// UTILITY
// ============================================================
function fmtBytes(b) {
    if (!b || b < 0) return '0 B';
    const K = 1024, u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(b) / Math.log(K)), u.length - 1);
    return (b / K ** i).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
}

function fmtTime(s) {
    if (!isFinite(s) || s <= 0) return '--';
    if (s < 60) return t('time.sec', { s: Math.round(s) });
    if (s < 3600) return t('time.minSec', { m: Math.floor(s / 60), s: Math.round(s % 60) });
    return t('time.hourMin', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
}

function fmtMtime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function joinPath(base, name) {
    if (!base || base === '/') return '/' + name;
    return base.replace(/\/+$/, '') + '/' + name;
}

function parentPath(p) {
    if (!p || p === '/') return '/';
    const trimmed = p.replace(/\/+$/, '');
    const i = trimmed.lastIndexOf('/');
    return i <= 0 ? '/' : trimmed.slice(0, i);
}

function escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ({
        py: '🐍', js: '📜', ts: '📜', json: '📋', yaml: '📋', yml: '📋', toml: '📋', cfg: '📋',
        txt: '📄', md: '📝', pdf: '📕',
        zip: '📦', tar: '📦', gz: '📦', bz2: '📦', xz: '📦', zst: '📦',
        mp4: '🎬', mkv: '🎬', avi: '🎬', mp3: '🎵', wav: '🎵',
        png: '🖼', jpg: '🖼', jpeg: '🖼', webp: '🖼',
        sh: '⚙', bash: '⚙',
        csv: '📊', xlsx: '📊',
        pt: '🧠', pth: '🧠', ckpt: '🧠', safetensors: '🧠',
        h5: '🔬', hdf5: '🔬', npz: '🔬', npy: '🔬',
        c: '💻', cpp: '💻', cu: '💻'
    })[ext] || '📄';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function onSelectAll(side, checked) {
    const files = side === 'A' ? S.filesA : S.filesB;
    const sel = side === 'A' ? S.selA : S.selB;
    sel.clear();
    if (checked) files.forEach(f => sel.add(f.name));
    renderList(side);
    updateSelInfo();
}

// ============================================================
// BACKUP / RESTORE
// ============================================================
const BK = {
    srv: null,
    subTab: 'docker',   // 'docker' | 'hf' | 'gguf'
    items: [],          // server-side items (for Backup)
    bkupItems: [],      // SSD backup items (for Restore)
    busy: false,
};

function bkLog(msg, cls) {
    const el = document.getElementById('bkLog');
    if (!el) return;
    const line = document.createElement('div');
    line.className = 'bk-log-line' + (cls ? ' ' + cls : '');
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
}

function bkLogClear() {
    const el = document.getElementById('bkLog');
    if (el) el.innerHTML = '';
}

function bkUpdateState() {
    const noServer = document.getElementById('bkStateNoServer');
    const noSsd = document.getElementById('bkStateNoSsd');
    const content = document.getElementById('bkContent');
    const mountBar = document.getElementById('bkMountBar');

    if (!BK.srv) {
        noServer.style.display = '';
        noSsd.style.display = 'none';
        content.style.display = 'none';
        mountBar.style.display = 'none';
        BK.items = [];
        BK.bkupItems = [];
        return;
    }

    noServer.style.display = 'none';
    const hasSsd = !!(BK.srv.ssdDevice || BK.srv.ssdMount);
    if (!hasSsd) {
        noSsd.style.display = '';
        content.style.display = 'none';
        mountBar.style.display = 'none';
        return;
    }

    noSsd.style.display = 'none';
    content.style.display = '';
    mountBar.style.display = '';
    bkRenderList();
    bkRenderBkupList();
}

async function bkCheckMount() {
    if (!BK.srv) return;
    const mp = BK.srv.ssdMount;
    if (!mp) { bkSetMountUI(false); return; }

    bkSetMountChecking();
    try {
        // Use distinct tokens that don't contain each other as substrings
        const res = await execSSH(BK.srv,
            `mountpoint -q ${bq(mp)} 2>/dev/null && echo __MNT_YES__ || echo __MNT_NO__`);
        bkSetMountUI((res.stdOut || '').includes('__MNT_YES__'));
    } catch (_) {
        bkSetMountUI(false);
    }
}

function bkSetMountChecking() {
    document.getElementById('dotMount').className = 'conn-dot loading';
    document.getElementById('bkMountLabel').textContent = t('backup.checking');
    document.getElementById('btnMount').disabled = true;
    document.getElementById('btnUnmount').disabled = true;
}

function bkSetMountUI(mounted) {
    const dot = document.getElementById('dotMount');
    const label = document.getElementById('bkMountLabel');
    const mountBtn = document.getElementById('btnMount');
    const unmountBtn = document.getElementById('btnUnmount');

    if (mounted) {
        dot.className = 'conn-dot ok';
        label.textContent = t('backup.mounted') + (BK.srv?.ssdMount ? ' (' + BK.srv.ssdMount + ')' : '');
        mountBtn.style.display = 'none';
        mountBtn.disabled = false;
        unmountBtn.style.display = '';
        unmountBtn.disabled = false;
    } else {
        dot.className = 'conn-dot err';
        label.textContent = t('backup.notMounted') + (BK.srv?.ssdMount ? ' (' + BK.srv.ssdMount + ')' : '');
        mountBtn.style.display = '';
        mountBtn.disabled = false;
        unmountBtn.style.display = 'none';
        unmountBtn.disabled = false;
    }
}

async function bkMount() {
    if (!BK.srv) return;
    if (!BK.srv.ssdDevice) { toast(t('backup.noSsdDevice'), 'warn'); return; }
    if (!BK.srv.ssdMount) { toast(t('backup.noMountPoint'), 'warn'); return; }

    bkSetMountChecking();
    bkLog('$ mount ' + BK.srv.ssdDevice + ' ' + BK.srv.ssdMount);
    try {
        const cmd = `mkdir -p ${bq(BK.srv.ssdMount)} && sudo mount ${bq(BK.srv.ssdDevice)} ${bq(BK.srv.ssdMount)}`;
        const wrapped = BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd;
        const res = await execSSH(BK.srv, wrapped);
        if ((res.stdErr || '').trim()) bkLog(res.stdErr.trim(), 'warn');
        await bkCheckMount();
        bkLog(t('backup.mountSuccess', { point: BK.srv.ssdMount }), 'ok');
        toast(t('backup.mountSuccess', { point: BK.srv.ssdMount }), 'ok');
    } catch (e) {
        bkLog(t('backup.mountFail', { msg: e.message || String(e) }), 'err');
        toast(t('backup.mountFail', { msg: e.message || String(e) }), 'err');
        bkSetMountUI(false);
    }
}

async function bkUnmount() {
    if (!BK.srv) return;
    if (!BK.srv.ssdMount) { toast(t('backup.noMountPoint'), 'warn'); return; }

    bkSetMountChecking();
    bkLog('$ umount ' + BK.srv.ssdMount);
    try {
        const cmd = `sudo umount ${bq(BK.srv.ssdMount)}`;
        const wrapped = BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd;
        const res = await execSSH(BK.srv, wrapped);
        if ((res.stdErr || '').trim()) bkLog(res.stdErr.trim(), 'warn');
        await bkCheckMount();
        BK.bkupItems = [];
        bkRenderBkupList();
        bkLog(t('backup.unmountSuccess', { point: BK.srv.ssdMount }), 'ok');
        toast(t('backup.unmountSuccess', { point: BK.srv.ssdMount }), 'ok');
    } catch (e) {
        bkLog(t('backup.unmountFail', { msg: e.message || String(e) }), 'err');
        toast(t('backup.unmountFail', { msg: e.message || String(e) }), 'err');
        bkSetMountUI(true);
    }
}

// ── Item listing ────────────────────────────────────────────

async function bkLoadList() {
    if (!BK.srv) return;
    document.getElementById('btnBkLoad').disabled = true;
    bkRenderPlaceholder(t('backup.loading'));
    BK.items = [];

    try {
        if (BK.subTab === 'docker') {
            BK.items = await bkListDocker();
        } else if (BK.subTab === 'hf') {
            BK.items = await bkListHF();
        } else {
            BK.items = await bkListGGUF();
        }
    } catch (e) {
        bkLog('Load error: ' + (e.message || String(e)), 'err');
        bkRenderPlaceholder('⚠ ' + (e.message || String(e)));
    } finally {
        document.getElementById('btnBkLoad').disabled = false;
        bkRenderList();
    }
}

async function bkListDocker() {
    // docker images --format "{{.Repository}}:{{.Tag}}\t{{.Size}}"
    const res = await execSSH(BK.srv,
        `docker images --format "{{.Repository}}:{{.Tag}}\\t{{.Size}}" 2>&1`);
    const out = (res.stdOut || '').trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
        const [name, size] = line.split('\t');
        return { name: name.trim(), meta: size ? size.trim() : '', selected: false };
    });
}

async function bkListHF() {
    if (!BK.srv.hfHubPath) throw new Error(t('backup.noHfPath'));
    // mkdir -p so the path exists even on first run
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(BK.srv.hfHubPath)}`)
        : `mkdir -p ${bq(BK.srv.hfHubPath)}`);
    const res = await execSSH(BK.srv,
        `ls -1 ${bq(BK.srv.hfHubPath)} 2>/dev/null || true`);
    const out = (res.stdOut || '').trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(name => ({ name: name.trim(), meta: '', selected: false }));
}

async function bkListGGUF() {
    if (!BK.srv.ggufPath) throw new Error(t('backup.noGgufPath'));
    // mkdir -p so the path exists even on first run
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(BK.srv.ggufPath)}`)
        : `mkdir -p ${bq(BK.srv.ggufPath)}`);
    const res = await execSSH(BK.srv,
        `ls -1 ${bq(BK.srv.ggufPath)} 2>/dev/null | grep -i '\\.gguf$' || true`);
    const out = (res.stdOut || '').trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(name => ({ name: name.trim(), meta: '', selected: false }));
}

function bkRenderList() {
    const el = document.getElementById('bkList');
    if (!el) return;
    if (!BK.items.length) {
        bkRenderPlaceholder(t('backup.noItems'));
        bkUpdateActionBtns();
        return;
    }
    el.innerHTML = BK.items.map((item, idx) =>
        `<div class="bk-row${item.selected ? ' selected' : ''}" data-idx="${idx}">
          <input type="checkbox"${item.selected ? ' checked' : ''}>
          <span class="bk-row-name" title="${escHtml(item.name)}">${escHtml(item.name)}</span>
          ${item.meta ? `<span class="bk-row-meta">${escHtml(item.meta)}</span>` : ''}
        </div>`
    ).join('');

    el.querySelectorAll('.bk-row').forEach(row => {
        row.addEventListener('click', e => {
            const idx = parseInt(row.dataset.idx);
            const chk = row.querySelector('input[type="checkbox"]');
            if (e.target === chk) {
                BK.items[idx].selected = chk.checked;
            } else {
                BK.items[idx].selected = !BK.items[idx].selected;
                chk.checked = BK.items[idx].selected;
            }
            if (BK.items[idx].selected) row.classList.add('selected');
            else row.classList.remove('selected');
            bkUpdateActionBtns();
        });
    });
    bkUpdateActionBtns();
}

function bkRenderPlaceholder(msg) {
    const el = document.getElementById('bkList');
    if (el) el.innerHTML = `<div class="panel-state"><div class="state-msg" style="color:var(--text3)">${escHtml(msg)}</div></div>`;
}

function bkUpdateActionBtns() {
    const hasSel = BK.items.some(i => i.selected);
    const hasBkupSel = BK.bkupItems.some(i => i.selected);
    const backupBtn = document.getElementById('btnBkBackup');
    const restoreBtn = document.getElementById('btnBkRestore');
    if (backupBtn) backupBtn.disabled = !hasSel || BK.busy;
    if (restoreBtn) restoreBtn.disabled = !hasBkupSel || BK.busy;
}

// ── Backup / Restore execution ──────────────────────────────

function bkSetBusy(busy) {
    BK.busy = busy;
    document.getElementById('btnBkLoad').disabled = busy;
    document.getElementById('btnBkLoadBkup').disabled = busy;
    document.getElementById('btnBkCancel').style.display = busy ? '' : 'none';
    bkUpdateActionBtns();
}

async function bkRunBackup() {
    if (BK.busy || !BK.srv) return;
    const sel = BK.items.filter(i => i.selected);
    if (!sel.length) { toast(t('backup.selectItems'), 'warn'); return; }
    if (!BK.srv.ssdMount) { toast(t('backup.noMountPoint'), 'warn'); return; }

    // Verify SSD is mounted
    try {
        const chk = await execSSH(BK.srv, `mountpoint -q ${bq(BK.srv.ssdMount)} && echo MOUNTED || echo NOT_MOUNTED`);
        if (!(chk.stdOut || '').includes('MOUNTED')) {
            toast(t('backup.ssdNotMounted'), 'warn');
            return;
        }
    } catch (_) { }

    bkSetBusy(true);
    bkLog('=== Backup started ===', 'ok');

    try {
        if (BK.subTab === 'docker') {
            await bkBackupDocker(sel);
        } else if (BK.subTab === 'hf') {
            await bkBackupHF(sel);
        } else {
            await bkBackupGGUF(sel);
        }
        bkLog('=== Backup complete ===', 'ok');
        toast(t('backup.backupDone'), 'ok');
    } catch (e) {
        bkLog('Error: ' + (e.message || String(e)), 'err');
        toast(t('backup.opFail', { msg: e.message || String(e) }), 'err');
    } finally {
        bkSetBusy(false);
    }
}

async function bkRunRestore() {
    if (BK.busy || !BK.srv) return;
    const sel = BK.bkupItems.filter(i => i.selected);
    if (!sel.length) { toast(t('backup.selectItems'), 'warn'); return; }
    if (!BK.srv.ssdMount) { toast(t('backup.noMountPoint'), 'warn'); return; }

    try {
        const chk = await execSSH(BK.srv, `mountpoint -q ${bq(BK.srv.ssdMount)} && echo MOUNTED || echo NOT_MOUNTED`);
        if (!(chk.stdOut || '').includes('MOUNTED')) {
            toast(t('backup.ssdNotMounted'), 'warn');
            return;
        }
    } catch (_) { }

    bkSetBusy(true);
    bkLog('=== Restore started ===', 'ok');

    try {
        if (BK.subTab === 'docker') {
            await bkRestoreDocker(sel);
        } else if (BK.subTab === 'hf') {
            await bkRestoreHF(sel);
        } else {
            await bkRestoreGGUF(sel);
        }
        bkLog('=== Restore complete ===', 'ok');
        toast(t('backup.restoreDone'), 'ok');
    } catch (e) {
        bkLog('Error: ' + (e.message || String(e)), 'err');
        toast(t('backup.opFail', { msg: e.message || String(e) }), 'err');
    } finally {
        bkSetBusy(false);
    }
}

// ── Docker backup/restore ────────────────────────────────────

// ── Docker backup/restore ────────────────────────────────────

async function bkBackupDocker(sel) {
    const backupDir = BK.srv.ssdMount + '/docker_backup';
    const mkdirCmd = `mkdir -p ${bq(backupDir)}`;
    const mkdirRes = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, mkdirCmd) : mkdirCmd);
    if (mkdirRes.stdErr && mkdirRes.stdErr.trim()) bkLog(mkdirRes.stdErr.trim(), 'warn');

    for (const item of sel) {
        if (!BK.busy) break;
        const fname = item.name.replace(/[/:]/g, '_') + '.tar';
        const outPath = backupDir + '/' + fname;
        bkLog('Backing up: ' + item.name + '  →  ' + fname);
        const cmd = `docker save -o ${bq(outPath)} ${bq(item.name)}`;
        const wrapped = BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd;
        const res = await execSSH(BK.srv, wrapped);
        if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        bkLog('  done: ' + item.name, 'ok');
    }
}

// sel is from BK.bkupItems — item.name is the .tar filename (e.g. ubuntu_latest.tar)
async function bkRestoreDocker(sel) {
    const backupDir = BK.srv.ssdMount + '/docker_backup';
    for (const item of sel) {
        if (!BK.busy) break;
        const tarPath = backupDir + '/' + item.name;
        bkLog('Restoring: ' + item.name);
        const cmd = `docker load -i ${bq(tarPath)}`;
        const wrapped = BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd;
        const res = await execSSH(BK.srv, wrapped);
        if (res.stdOut && res.stdOut.trim()) bkLog(res.stdOut.trim());
        if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        bkLog('  done: ' + item.name, 'ok');
    }
}

// ── HF model backup/restore ──────────────────────────────────

async function bkBackupHF(sel) {
    if (!BK.srv.hfHubPath) throw new Error(t('backup.noHfPath'));
    const backupDir = BK.srv.ssdMount + '/huggingface_backup';
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(backupDir)}`)
        : `mkdir -p ${bq(backupDir)}`);

    for (const item of sel) {
        if (!BK.busy) break;
        const tarPath = backupDir + '/' + item.name + '.tar';
        bkLog('Backing up: ' + item.name);
        const chk = await execSSH(BK.srv, `test -f ${bq(tarPath)} && echo EXISTS || echo NEW`);
        if ((chk.stdOut || '').includes('EXISTS')) {
            bkLog('  skip (already exists): ' + item.name, 'warn');
            continue;
        }
        const cmd = `tar -cf ${bq(tarPath)} -C ${bq(BK.srv.hfHubPath)} ${bq(item.name)}`;
        const res = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd);
        if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        bkLog('  done: ' + item.name, 'ok');
    }
}

// sel is from BK.bkupItems — item.name is the model name (without .tar)
async function bkRestoreHF(sel) {
    if (!BK.srv.hfHubPath) throw new Error(t('backup.noHfPath'));
    const backupDir = BK.srv.ssdMount + '/huggingface_backup';
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(BK.srv.hfHubPath)}`)
        : `mkdir -p ${bq(BK.srv.hfHubPath)}`);

    for (const item of sel) {
        if (!BK.busy) break;
        const tarPath = backupDir + '/' + item.name + '.tar';
        const destDir = BK.srv.hfHubPath + '/' + item.name;
        bkLog('Restoring: ' + item.name);
        const chk = await execSSH(BK.srv, `test -d ${bq(destDir)} && echo EXISTS || echo NEW`);
        if ((chk.stdOut || '').includes('EXISTS')) {
            bkLog('  skip (already exists): ' + item.name, 'warn');
            continue;
        }
        const cmd = `tar -xf ${bq(tarPath)} -C ${bq(BK.srv.hfHubPath)}`;
        const res = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd);
        if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        bkLog('  done: ' + item.name, 'ok');
    }
}

// ── GGUF backup/restore ──────────────────────────────────────

async function bkBackupGGUF(sel) {
    if (!BK.srv.ggufPath) throw new Error(t('backup.noGgufPath'));
    const backupDir = BK.srv.ssdMount + '/gguf_backup';
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(backupDir)}`)
        : `mkdir -p ${bq(backupDir)}`);

    for (const item of sel) {
        if (!BK.busy) break;
        const src = BK.srv.ggufPath + '/' + item.name;
        const dst = backupDir + '/' + item.name;
        bkLog('Backing up: ' + item.name);
        const chk = await execSSH(BK.srv, `test -f ${bq(dst)} && echo EXISTS || echo NEW`);
        if ((chk.stdOut || '').includes('EXISTS')) {
            bkLog('  skip (already exists): ' + item.name, 'warn');
            continue;
        }
        const res = await execSSH(BK.srv, BK.srv.useSudo
            ? wrapSudo(BK.srv, `cp ${bq(src)} ${bq(dst)}`)
            : `cp ${bq(src)} ${bq(dst)}`);
        if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        bkLog('  done: ' + item.name, 'ok');
    }
}

// sel is from BK.bkupItems — item.name is the .gguf filename
async function bkRestoreGGUF(sel) {
    if (!BK.srv.ggufPath) throw new Error(t('backup.noGgufPath'));
    const backupDir = BK.srv.ssdMount + '/gguf_backup';
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(BK.srv.ggufPath)}`)
        : `mkdir -p ${bq(BK.srv.ggufPath)}`);

    for (const item of sel) {
        if (!BK.busy) break;
        const src = backupDir + '/' + item.name;
        const dst = BK.srv.ggufPath + '/' + item.name;
        bkLog('Restoring: ' + item.name);
        const chk = await execSSH(BK.srv, `test -f ${bq(dst)} && echo EXISTS || echo NEW`);
        if ((chk.stdOut || '').includes('EXISTS')) {
            bkLog('  skip (already exists): ' + item.name, 'warn');
            continue;
        }
        const res = await execSSH(BK.srv, BK.srv.useSudo
            ? wrapSudo(BK.srv, `cp ${bq(src)} ${bq(dst)}`)
            : `cp ${bq(src)} ${bq(dst)}`);
        if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        bkLog('  done: ' + item.name, 'ok');
    }
}

// ── SSD backup list loaders (for Restore panel) ──────────────

async function bkLoadBackupList() {
    if (!BK.srv) return;
    if (!BK.srv.ssdMount) { toast(t('backup.noMountPoint'), 'warn'); return; }

    document.getElementById('btnBkLoadBkup').disabled = true;
    bkRenderBkupPlaceholder(t('backup.loading'));
    BK.bkupItems = [];

    try {
        if (BK.subTab === 'docker') {
            BK.bkupItems = await bkListDockerBackups();
        } else if (BK.subTab === 'hf') {
            BK.bkupItems = await bkListHFBackups();
        } else {
            BK.bkupItems = await bkListGGUFBackups();
        }
    } catch (e) {
        bkLog('Load backups error: ' + (e.message || String(e)), 'err');
        bkRenderBkupPlaceholder('⚠ ' + (e.message || String(e)));
        document.getElementById('btnBkLoadBkup').disabled = false;
        return;
    }

    document.getElementById('btnBkLoadBkup').disabled = false;
    bkRenderBkupList();
}

async function bkListDockerBackups() {
    const dir = BK.srv.ssdMount + '/docker_backup';
    const res = await execSSH(BK.srv, `ls -1 ${bq(dir)} 2>/dev/null | grep '\\.tar$' || true`);
    return (res.stdOut || '').trim().split('\n').filter(Boolean)
        .map(name => ({ name: name.trim(), meta: '', selected: false }));
}

async function bkListHFBackups() {
    const dir = BK.srv.ssdMount + '/huggingface_backup';
    // List model names (strip .tar extension)
    const res = await execSSH(BK.srv,
        `ls -1 ${bq(dir)} 2>/dev/null | grep '\\.tar$' | sed 's/\\.tar$//' || true`);
    return (res.stdOut || '').trim().split('\n').filter(Boolean)
        .map(name => ({ name: name.trim(), meta: '', selected: false }));
}

async function bkListGGUFBackups() {
    const dir = BK.srv.ssdMount + '/gguf_backup';
    const res = await execSSH(BK.srv, `ls -1 ${bq(dir)} 2>/dev/null | grep -i '\\.gguf$' || true`);
    return (res.stdOut || '').trim().split('\n').filter(Boolean)
        .map(name => ({ name: name.trim(), meta: '', selected: false }));
}

function bkRenderBkupList() {
    const el = document.getElementById('bkBkupList');
    if (!el) return;
    if (!BK.bkupItems.length) {
        bkRenderBkupPlaceholder(t('backup.noItems'));
        bkUpdateActionBtns();
        return;
    }
    el.innerHTML = BK.bkupItems.map((item, idx) =>
        `<div class="bk-row${item.selected ? ' selected' : ''}" data-bkup-idx="${idx}">
          <input type="checkbox"${item.selected ? ' checked' : ''}>
          <span class="bk-row-name" title="${escHtml(item.name)}">${escHtml(item.name)}</span>
          ${item.meta ? `<span class="bk-row-meta">${escHtml(item.meta)}</span>` : ''}
        </div>`
    ).join('');

    el.querySelectorAll('.bk-row').forEach(row => {
        row.addEventListener('click', e => {
            const idx = parseInt(row.dataset.bkupIdx);
            const chk = row.querySelector('input[type="checkbox"]');
            if (e.target === chk) {
                BK.bkupItems[idx].selected = chk.checked;
            } else {
                BK.bkupItems[idx].selected = !BK.bkupItems[idx].selected;
                chk.checked = BK.bkupItems[idx].selected;
            }
            if (BK.bkupItems[idx].selected) row.classList.add('selected');
            else row.classList.remove('selected');
            bkUpdateActionBtns();
        });
    });
    bkUpdateActionBtns();
}

function bkRenderBkupPlaceholder(msg) {
    const el = document.getElementById('bkBkupList');
    if (el) el.innerHTML = `<div class="panel-state"><div class="state-msg" style="color:var(--text3)">${escHtml(msg)}</div></div>`;
}

// ── Sub-tab switch ───────────────────────────────────────────
function bkSwitchSubTab(tab) {
    if (BK.subTab === tab) return;   // 같은 탭 재클릭 시 목록 유지
    BK.subTab = tab;
    BK.items = [];
    BK.bkupItems = [];
    ['docker', 'hf', 'gguf'].forEach(name => {
        const btn = document.getElementById('bkTab' + name.charAt(0).toUpperCase() + name.slice(1));
        if (btn) btn.classList.toggle('active', name === tab);
    });
    bkRenderList();
    bkRenderBkupList();
}

// ============================================================
// INIT
// ============================================================
Neutralino.init();

Neutralino.events.on('ready', async () => {
    await initMasterKey();
    S.servers = await loadServers();

    // Initialize i18n — load saved language, apply to DOM
    await initI18n();

    // Language switcher
    document.getElementById('langSelect').onchange = async (e) => {
        await setLang(e.target.value);
        // Re-render dynamic content that uses t()
        populateSelects();
        if (S.filesA.length) renderList('A');
        if (S.filesB.length) renderList('B');
        updateSelInfo();
        if (!S.busy) setStatus(t('status.readyHint'));
    };

    populateSelects();

    attachPanelHandlers('A');
    attachPanelHandlers('B');

    // Header
    document.getElementById('btnAddServer').onclick = () => openModal(null);
    document.getElementById('btnEditA').onclick = () => S.srvA && openModal(S.srvA.id);
    document.getElementById('btnEditB').onclick = () => S.srvB && openModal(S.srvB.id);

    // Server selects
    document.getElementById('selectA').onchange = () => onSelectServer('A');
    document.getElementById('selectB').onchange = () => onSelectServer('B');

    // Transfer
    document.getElementById('btnAtoB').onclick = () => startTransfer('AB');
    document.getElementById('btnBtoA').onclick = () => startTransfer('BA');
    document.getElementById('btnCancel').onclick = cancelTransfer;

    // Toolbar
    document.getElementById('btnUpA').onclick = () => {
        if (!S.srvA) return;
        S.pathA = parentPath(S.pathA);
        document.getElementById('pathA').value = S.pathA;
        loadPanel('A');
    };
    document.getElementById('btnUpB').onclick = () => {
        if (!S.srvB) return;
        S.pathB = parentPath(S.pathB);
        document.getElementById('pathB').value = S.pathB;
        loadPanel('B');
    };
    document.getElementById('btnRefreshA').onclick = () => loadPanel('A');
    document.getElementById('btnRefreshB').onclick = () => loadPanel('B');

    // Path input: navigate on Enter
    document.getElementById('pathA').onkeydown = e => {
        if (e.key === 'Enter' && S.srvA) {
            S.pathA = e.target.value.trim() || S.pathA;
            loadPanel('A');
        }
    };
    document.getElementById('pathB').onkeydown = e => {
        if (e.key === 'Enter' && S.srvB) {
            S.pathB = e.target.value.trim() || S.pathB;
            loadPanel('B');
        }
    };

    // Select-all
    document.getElementById('chkAllA').onchange = e => onSelectAll('A', e.target.checked);
    document.getElementById('chkAllB').onchange = e => onSelectAll('B', e.target.checked);

    // Modal auth radio
    document.querySelectorAll('input[name="authType"]').forEach(r => r.onchange = updateAuthGroups);

    // Modal buttons
    document.getElementById('btnModalCancel').onclick = closeModal;
    document.getElementById('btnModalSave').onclick = saveServer;
    document.getElementById('btnDelServer').onclick = deleteServer;
    document.getElementById('btnTestSSH').onclick = runSSHTest;
    document.getElementById('btnTestTools').onclick = runToolsTest;

    // Close modal when clicking the dark overlay
    document.getElementById('serverModal').onclick = e => {
        if (e.target === document.getElementById('serverModal')) closeModal();
    };

    // ESC closes modal
    window.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    // ── Tab switching ──────────────────────────────────────────
    document.getElementById('tabFileTransfer').onclick = () => switchTab('file');
    document.getElementById('tabBackup').onclick = () => switchTab('backup');

    // ── Scan SSD button ───────────────────────────────────────
    document.getElementById('btnScanSsd').onclick = scanSsdDevices;

    // ── Backup tab server select ──────────────────────────────
    document.getElementById('selectBk').onchange = async () => {
        const id = parseInt(document.getElementById('selectBk').value);
        BK.srv = S.servers.find(s => s.id === id) || null;
        BK.items = [];
        const dotBk = document.getElementById('dotBk');
        const editBk = document.getElementById('btnEditBk');
        dotBk.className = 'conn-dot' + (BK.srv ? ' loading' : '');
        editBk.disabled = !BK.srv;
        bkUpdateState();
        if (BK.srv) {
            await bkCheckMount();
            dotBk.className = 'conn-dot ok';
        }
    };
    document.getElementById('btnEditBk').onclick = () => BK.srv && openModal(BK.srv.id);

    // ── Mount controls ────────────────────────────────────────
    document.getElementById('btnMount').onclick = bkMount;
    document.getElementById('btnUnmount').onclick = bkUnmount;

    // ── Backup actions ────────────────────────────────────────
    document.getElementById('btnBkLoad').onclick = bkLoadList;
    document.getElementById('btnBkLoadBkup').onclick = bkLoadBackupList;
    document.getElementById('btnBkBackup').onclick = bkRunBackup;
    document.getElementById('btnBkRestore').onclick = bkRunRestore;
    document.getElementById('btnBkCancel').onclick = () => {
        BK.busy = false;
        bkLog('Cancelled', 'warn');
        bkSetBusy(false);
    };
    document.getElementById('btnBkClearLog').onclick = bkLogClear;

    // ── Backup sub-tabs ───────────────────────────────────────
    document.getElementById('bkTabDocker').onclick = () => bkSwitchSubTab('docker');
    document.getElementById('bkTabHF').onclick = () => bkSwitchSubTab('hf');
    document.getElementById('bkTabGGUF').onclick = () => bkSwitchSubTab('gguf');

    // ── Log panel resize handle ───────────────────────────────
    (function () {
        const handle = document.getElementById('bkResizeHandle');
        const logPanel = document.getElementById('bkBottomLog');
        if (!handle || !logPanel) return;
        let startY = 0, startH = 0;

        handle.addEventListener('mousedown', e => {
            startY = e.clientY;
            startH = logPanel.offsetHeight;
            handle.classList.add('dragging');
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';

            function onMove(e) {
                const delta = startY - e.clientY;   // drag up → bigger
                const newH = Math.min(Math.max(startH + delta, 48), 480);
                logPanel.style.height = newH + 'px';
            }
            function onUp() {
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            }
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
    })();

    setStatus(t('status.readyHint'));
});

// ── Tab visibility helper ────────────────────────────────────
function switchTab(tab) {
    const isFile = tab === 'file';
    document.getElementById('tabFileTransfer').classList.toggle('active', isFile);
    document.getElementById('tabBackup').classList.toggle('active', !isFile);
    document.getElementById('headerTransfer').style.display = isFile ? '' : 'none';
    document.getElementById('headerBackup').style.display = isFile ? 'none' : '';
    document.getElementById('main').style.display = isFile ? '' : 'none';
    document.getElementById('backupPanel').style.display = isFile ? 'none' : '';
    document.getElementById('progressSection').style.display = isFile ? '' : 'none';
    if (!isFile) {
        // Sync backup server select with server list
        populateBkSelect();
    }
}

function populateBkSelect() {
    const sel = document.getElementById('selectBk');
    const prev = sel.value;
    sel.innerHTML = '<option value="">' + escHtml(t('sel.serverSelect')) + '</option>' +
        S.servers.map(s => `<option value="${s.id}">${escHtml(s.alias)}</option>`).join('');
    sel.value = prev;
}
