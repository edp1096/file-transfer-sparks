"use strict";

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

async function checkDockerDiskSpace(srv) {
    // Returns available bytes on the filesystem containing /var/lib/docker.
    // Falls back to / if /var/lib/docker does not exist yet.
    // Returns 0 if the check fails (caller should skip the guard).
    try {
        const res = await execSSH(srv,
            `df -PB1 /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}' || df -PB1 / | awk 'NR==2{print $4}'`);
        return parseInt((res.stdOut || '0').trim()) || 0;
    } catch (_) {
        return 0;
    }
}

// Each transfer owns its process IDs. Cancellation during preparation must never
// start a sender later or overwrite the state of a subsequent transfer.
function beginTransferRun(dir) {
    const run = { cancelled: false, pids: new Set(), dir, port: null, receiver: dir === 'AB' ? S.srvB : S.srvA };
    S.transferRun = run;
    return run;
}
function assertTransferRun(run) {
    if (run.cancelled || S.transferRun !== run) throw new Error('Transfer cancelled');
}
async function transferStep(run, operation) {
    assertTransferRun(run);
    const result = await operation();
    assertTransferRun(run);
    return result;
}
async function spawnTransferProcess(run, command) {
    assertTransferRun(run);
    const proc = await Desktop.os.spawnProcess(command);
    if (run.cancelled || S.transferRun !== run) {
        await Desktop.os.updateSpawnedProcess(proc.id);
        throw new Error('Transfer cancelled');
    }
    run.pids.add(proc.id);
    return proc;
}
async function stopTransferRun(run) {
    if (!run) return;
    run.cancelled = true;
    await Promise.all([...run.pids].map(id => Desktop.os.updateSpawnedProcess(id).catch(() => {})));
    const dstSrv = run.receiver;
    if (dstSrv && run.port) {
        try { await execSSH(dstSrv, `pkill -f "nc -l.*${run.port}" 2>/dev/null || true`); } catch (_) {}
    }
}

async function startTransfer(dir) {
    if (S.busy) return;

    // Docker mode check
    const srcMode = dir === 'AB' ? S.panelModeA : S.panelModeB;
    if (srcMode === 'docker') {
        await startDockerTransfer(dir);
        return;
    }

    const srcSrv = dir === 'AB' ? S.srvA : S.srvB;
    const dstSrv = dir === 'AB' ? S.srvB : S.srvA;
    const srcPath = dir === 'AB' ? S.pathA : S.pathB;
    const dstPath = dir === 'AB' ? S.pathB : S.pathA;
    const sel = dir === 'AB' ? S.selA : S.selB;

    if (!srcSrv || !dstSrv) { toast(t('toast.selectBothServers'), 'warn'); return; }
    if (!srcPath || !dstPath) { toast(t('toast.bothPathsNeeded'), 'warn'); return; }
    if (sel.size === 0) { toast(t('toast.selectFiles'), 'warn'); return; }

    const run = beginTransferRun(dir);
    S.busy = true;
    S.tDir = dir;
    S.tPort = Math.floor(Math.random() * (PORT_MAX - PORT_MIN)) + PORT_MIN;
    run.port = S.tPort;
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
        S.tBytes = await transferStep(run, () => getTransferSize(srcSrv, srcPaths));

        // Check if pv is available on the source server
        setStatus(t('status.checkEnv'));
        const hasPv = await transferStep(run, () => checkPv(srcSrv));
        if (!hasPv) toast(t('toast.noPv'), 'warn');

        showProgress(dir, S.tBytes, hasPv);
        S.tStart = Date.now();

        // Kill any stale nc listener on receiver from a previous failed run
        try { await execSSH(dstSrv, `pkill -f "nc -l.*${S.tPort}" 2>/dev/null || true`); } catch (_) { }
        await transferStep(run, () => sleep(400));

        // Step 1: Start receiver
        // useSudo: wrap tar with sudo using login password.
        // plain: classic nc | tar pipe.
        setStatus(t('status.recvWait', { alias: dstSrv.alias }));
        let recvInner = `mkdir -p ${bq(dstPath)} && nc -l ${S.tPort} | tar -xf - -C ${bq(dstPath)}`;
        if (dstSrv.useSudo) recvInner = wrapSudo(dstSrv, recvInner);
        const recvCmd = buildSSH(dstSrv, recvInner);
        const recvProc = await spawnTransferProcess(run, recvCmd);
        S.recvPid = recvProc.id;

        // Step 2: Give receiver time to bind the nc port before sender connects.
        await transferStep(run, () => sleep(1200));

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
        const sendProc = await spawnTransferProcess(run, sendCmd);
        S.senderPid = sendProc.id;

    } catch (e) {
        if (!run.cancelled && S.transferRun === run) await onTransferError(String(e.message || e));
    }
}

async function cancelTransfer() {
    if (!S.busy || S.transferRun?.cancelled) return;
    const run = S.transferRun;
    setStatus(t('status.cancelling'));
    await stopTransferRun(run);
    if (S.transferRun !== run) return;
    resetTransfer();
    hideProgress();
    setStatus(t('status.cancelled'));
    toast(t('toast.transferCancelled'), 'warn');
}

async function onTransferError(msg) {
    const run = S.transferRun;
    if (run?.cancelled) return;
    await stopTransferRun(run);
    if (S.transferRun !== run) return;
    resetTransfer(); hideProgress();
    setStatus(t('status.transferError', { msg }));
    toast(t('toast.error', { msg }), 'err');
}

function resetTransfer() {
    S.transferRun = null;
    S.busy = false; S.senderPid = null; S.recvPid = null;
    S.senderExitCode = null; S.recvExitCode = null;
    S.tPort = null; S.tDir = null; S.tBytes = 0; S.tStart = 0;
    if (S.progressTimer) { clearInterval(S.progressTimer); S.progressTimer = null; }
    updateTransferBtns();
}

// ============================================================
// SPAWN PROCESS EVENT — pv writes percent integers to stderr
// ============================================================
Desktop.events.on('spawnedProcess', evt => {
    const { id, action, data } = evt.detail;
    if (S.transferRun?.cancelled) return;

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
            if (S.senderExitCode !== 0) { onTransferError('Sender exited: ' + data); return; }
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
            if (S.recvExitCode !== 0) { onTransferError('Receiver exited: ' + data); return; }
            checkBothDone();
        }
    }
});

// Declare success only when BOTH sender and receiver have exited.
function checkBothDone() {
    const senderDone = S.senderExitCode !== null;
    const recvDone = S.recvExitCode !== null;
    if (!senderDone || !recvDone) return;

    const run = S.transferRun;
    const ok = S.senderExitCode === 0 && S.recvExitCode === 0;
    const fill = document.getElementById('progressFill');
    if (ok) {
        fill.style.width = '100%';
        fill.className = 'progress-fill done';
        document.getElementById('progressPct').textContent = '100%';
        document.getElementById('progressEta').textContent = t('progress.etaDone');
        setStatus(t('status.transferDone'));
        toast(t('toast.transferDone'), 'ok');
        setTimeout(() => { if (S.transferRun === run) loadPanel(run.dir === 'AB' ? 'B' : 'A'); }, 600);
    } else {
        fill.className = 'progress-fill error';
        const msg = t('status.transferFail', { sendCode: S.senderExitCode, recvCode: S.recvExitCode });
        setStatus(msg);
        toast(msg, 'err');
    }
    setTimeout(() => { if (S.transferRun === run) { hideProgress(); resetTransfer(); } }, 4000);
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
// UTILITY (shared)
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// DOCKER TRANSFER
// ============================================================
async function startDockerTransfer(dir) {
    if (S.busy) return;
    const srcSrv = dir === 'AB' ? S.srvA : S.srvB;
    const dstSrv = dir === 'AB' ? S.srvB : S.srvA;
    const sel = dir === 'AB' ? S.selA : S.selB;

    if (!srcSrv || !dstSrv) { toast(t('toast.selectBothServers'), 'warn'); return; }
    if (sel.size === 0) { toast(t('toast.selectDockerImages'), 'warn'); return; }

    const images = [...sel];
    const run = beginTransferRun(dir);
    S.busy = true;
    S.tDir = dir;
    S.tPort = Math.floor(Math.random() * (PORT_MAX - PORT_MIN)) + PORT_MIN;
    run.port = S.tPort;
    S.senderExitCode = null;
    S.recvExitCode = null;
    updateTransferBtns();

    try {
        // Step 1: Estimate uncompressed size via docker inspect
        setStatus(t('status.calcSize'));
        const inspectRes = await transferStep(run, () => execSSH(srcSrv,
            `docker inspect --format='{{.Size}}' ${images.map(bq).join(' ')} 2>/dev/null | awk '{s+=$1}END{print s+0}'`));
        S.tBytes = parseInt((inspectRes.stdOut || '0').trim()) || 0;

        // Step 1.5: Check available disk space on both sides
        // Sender needs ~1x image size (docker save writes to /var/lib/docker/tmp)
        // Receiver needs ~2x image size (docker load tmp + final image storage)
        if (S.tBytes > 0) {
            setStatus(t('status.checkSpace'));
            const [srcAvail, dstAvail] = await transferStep(run, () => Promise.all([
                checkDockerDiskSpace(srcSrv),
                checkDockerDiskSpace(dstSrv)
            ]));
            if (srcAvail > 0 && srcAvail < S.tBytes) {
                resetTransfer(); hideProgress(); setStatus(t('status.ready'));
                toast(t('toast.dockerNoSpaceSrc', { alias: srcSrv.alias, need: fmtBytes(S.tBytes), avail: fmtBytes(srcAvail) }), 'err');
                return;
            }
            if (dstAvail > 0 && dstAvail < S.tBytes * 2) {
                resetTransfer(); hideProgress(); setStatus(t('status.ready'));
                toast(t('toast.dockerNoSpaceDst', { alias: dstSrv.alias, need: fmtBytes(S.tBytes * 2), avail: fmtBytes(dstAvail) }), 'err');
                return;
            }
        }

        // Step 2: Check pv availability
        setStatus(t('status.checkEnv'));
        const hasPv = await transferStep(run, () => checkPv(srcSrv));
        if (!hasPv) toast(t('toast.noPv'), 'warn');

        showProgress(dir, S.tBytes, hasPv);
        S.tStart = Date.now();

        // Kill any stale nc listener on receiver
        try { await execSSH(dstSrv, `pkill -f "nc -l.*${S.tPort}" 2>/dev/null || true`); } catch (_) { }
        await transferStep(run, () => sleep(400));

        // Step 3: Start receiver — nc | docker load  (images go into /var/lib/docker automatically)
        // docker commands never use sudo; user must be in docker group
        setStatus(t('status.recvWait', { alias: dstSrv.alias }));
        const recvCmd = buildSSH(dstSrv, `nc -l ${S.tPort} | docker load`);
        const recvProc = await spawnTransferProcess(run, recvCmd);
        S.recvPid = recvProc.id;

        await transferStep(run, () => sleep(1200));

        // Step 4: Start sender — docker save | [pv] | nc
        setStatus(t('status.transferring', { src: srcSrv.alias, dst: dstSrv.alias }));
        const saveStream = `docker save ${images.map(bq).join(' ')}`;
        let sendPipeline;
        if (hasPv) {
            sendPipeline = `${saveStream} | pv -n -s ${S.tBytes} | nc -q 1 ${dstSrv.qsfpHost} ${S.tPort}`;
        } else {
            sendPipeline = `${saveStream} | nc -q 1 ${dstSrv.qsfpHost} ${S.tPort}`;
            startIndeterminateProgress();
        }
        const sendCmd = buildSSH(srcSrv, sendPipeline);
        const sendProc = await spawnTransferProcess(run, sendCmd);
        S.senderPid = sendProc.id;

    } catch (e) {
        if (!run.cancelled && S.transferRun === run) await onTransferError(String(e.message || e));
    }
}
