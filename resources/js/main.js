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
    masterKey: null, editId: null,
    // Docker panel mode
    panelModeA: 'files',   // 'files' | 'docker'
    panelModeB: 'files',
    dockerA: [],           // [{name, meta}]
    dockerB: [],
    // Column sort state
    sortA: { col: 'name', dir: 1 },  // dir: 1=asc, -1=desc
    sortB: { col: 'name', dir: 1 },
    // Shift-click anchor
    lastClickA: -1,
    lastClickB: -1,
    // Dir size load token (cancels stale du results on navigation)
    panelTokenA: 0,
    panelTokenB: 0,
};

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
// DISK INFO
// ============================================================
async function loadPanelDiskInfo(side) {
    const srv = side === 'A' ? S.srvA : S.srvB;
    const path = side === 'A' ? S.pathA : S.pathB;
    const el = document.getElementById('diskInfo' + side);
    if (!el || !srv || !path) { if (el) el.textContent = ''; return; }
    try {
        const res = await execSSH(srv,
            `df -h ${bq(path)} 2>/dev/null | awk 'NR==2{print $3 "/" $2 " (" $5 " " $4 " free) \u2014 " $6}'`);
        el.textContent = (res.stdOut || '').trim();
    } catch (_) {
        el.textContent = '';
    }
}

// ============================================================
// UI — FILE PANELS
// ============================================================
async function loadDirSizes(side, tok) {
    const srv = side === 'A' ? S.srvA : S.srvB;
    const path = side === 'A' ? S.pathA : S.pathB;
    const files = side === 'A' ? S.filesA : S.filesB;
    const dirs = files.filter(f => f.isDir && !f.isLink);
    if (!dirs.length || !srv) return;

    const paths = dirs.map(f => bq(joinPath(path, f.name))).join(' ');
    try {
        const res = await execSSH(srv, `du -sb ${paths} 2>/dev/null`);
        if (tok !== (side === 'A' ? S.panelTokenA : S.panelTokenB)) return; // navigated away
        const sizeMap = {};
        for (const line of (res.stdOut || '').split('\n')) {
            const tab = line.indexOf('\t');
            if (tab < 0) continue;
            const bytes = parseInt(line.substring(0, tab).trim());
            const name = line.substring(tab + 1).trim().split('/').pop();
            if (name && !isNaN(bytes)) sizeMap[name] = bytes;
        }
        // Update file entries in-place so sort and display both use the same data
        files.forEach(f => {
            if (f.isDir && sizeMap[f.name] != null) {
                f.size = sizeMap[f.name];
                f.dirSizeLoaded = true;
            }
        });
        renderList(side); // re-render: re-sorts if sort.col==='size', updates display
    } catch (_) {}
}

async function loadPanel(side) {
    const mode = side === 'A' ? S.panelModeA : S.panelModeB;
    if (mode === 'docker') {
        await loadDockerImages(side);
        return;
    }

    const srv = side === 'A' ? S.srvA : S.srvB;
    const path = side === 'A' ? S.pathA : S.pathB;
    const listEl = document.getElementById('list' + side);

    if (!srv || !path) {
        listEl.innerHTML = '<div class="panel-state"><div class="state-icon">🖥</div><div class="state-msg">' + escHtml(t('panel.selectServer')) + '</div></div>';
        return;
    }
    if (side === 'A') { S.selA.clear(); S.lastClickA = -1; } else { S.selB.clear(); S.lastClickB = -1; }
    document.getElementById('chkAll' + side).checked = false;
    listEl.innerHTML = '<div class="panel-state"><div class="state-icon">⟳</div><div class="state-msg">' + escHtml(t('panel.loading')) + '</div></div>';

    try {
        const files = await listRemote(srv, path);
        if (side === 'A') S.filesA = files; else S.filesB = files;
        renderList(side);
        updateSelInfo();
        const tok = side === 'A' ? ++S.panelTokenA : ++S.panelTokenB;
        loadDirSizes(side, tok); // fire-and-forget
    } catch (e) {
        listEl.innerHTML = `<div class="panel-state err"><div class="state-icon">⚠</div><div class="state-msg">${escHtml(e.message || String(e))}</div></div>`;
    }
}

function sortFiles(files, sort) {
    return [...files].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        let cmp = 0;
        if (sort.col === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
        else if (sort.col === 'size') cmp = (a.size || 0) - (b.size || 0);
        else if (sort.col === 'mtime') cmp = (a.mtime || 0) - (b.mtime || 0);
        return cmp * sort.dir;
    });
}

function updateSortHeader(side) {
    const header = document.getElementById('listHeader' + side);
    if (!header) return;
    const sort = side === 'A' ? S.sortA : S.sortB;
    header.querySelectorAll('.col-sort').forEach(el => {
        if (el.dataset.col === sort.col) el.setAttribute('data-sort', sort.dir === 1 ? 'asc' : 'desc');
        else el.removeAttribute('data-sort');
    });
}

function renderList(side) {
    const files = side === 'A' ? S.filesA : S.filesB;
    const sel = side === 'A' ? S.selA : S.selB;
    const sort = side === 'A' ? S.sortA : S.sortB;
    const listEl = document.getElementById('list' + side);

    if (!files.length) {
        listEl.innerHTML = '<div class="panel-state"><div class="state-msg" style="color:var(--text3)">' + escHtml(t('panel.emptyDir')) + '</div></div>';
        return;
    }
    const sorted = sortFiles(files, sort);
    listEl.innerHTML = sorted.map((f, idx) => {
        const icon = f.isLink ? '🔗' : f.isDir ? '📁' : fileIcon(f.name);
        const cls = 'file-row' + (f.isDir ? ' is-dir' : '') + (f.isLink ? ' is-link' : '') + (sel.has(f.name) ? ' selected' : '');
        return `<div class="${cls}" data-name="${escHtml(f.name)}" data-isdir="${f.isDir ? 1 : 0}" data-idx="${idx}">
      <input type="checkbox" ${sel.has(f.name) ? 'checked' : ''}>
      <div class="file-name-cell"><span class="file-icon">${icon}</span><span class="file-name-text" title="${escHtml(f.name)}">${escHtml(f.name)}</span></div>
      <div class="file-size-cell">${f.isDir ? (f.dirSizeLoaded ? fmtBytes(f.size) : '<span class="dir-sz-pending">…</span>') : fmtBytes(f.size)}</div>
      <div class="file-mtime-cell">${fmtMtime(f.mtime)}</div>
    </div>`;
    }).join('');
}

function attachPanelHandlers(side) {
    const listEl = document.getElementById('list' + side);

    // Click: toggle / shift-range select
    listEl.addEventListener('click', e => {
        const row = e.target.closest('.file-row');
        if (!row) return;
        const name = row.dataset.name;
        const idx = parseInt(row.dataset.idx);
        const sel = side === 'A' ? S.selA : S.selB;
        const chk = row.querySelector('input[type="checkbox"]');
        const lastClick = side === 'A' ? S.lastClickA : S.lastClickB;

        if (e.shiftKey && lastClick >= 0) {
            // Range select from anchor to current
            const files = side === 'A' ? S.filesA : S.filesB;
            const sort = side === 'A' ? S.sortA : S.sortB;
            const sorted = sortFiles(files, sort);
            const lo = Math.min(idx, lastClick), hi = Math.max(idx, lastClick);
            for (let i = lo; i <= hi; i++) sel.add(sorted[i].name);
            renderList(side);
        } else {
            if (side === 'A') S.lastClickA = idx; else S.lastClickB = idx;
            if (e.target === chk) {
                if (chk.checked) sel.add(name); else sel.delete(name);
            } else {
                if (sel.has(name)) { sel.delete(name); chk.checked = false; }
                else { sel.add(name); chk.checked = true; }
            }
            if (sel.has(name)) row.classList.add('selected'); else row.classList.remove('selected');
        }
        updateSelInfo();
    });

    // Double-click: navigate into directory (files mode only)
    listEl.addEventListener('dblclick', e => {
        const row = e.target.closest('.file-row');
        if (!row || row.dataset.isdir !== '1') return;
        const mode = side === 'A' ? S.panelModeA : S.panelModeB;
        if (mode !== 'files') return;
        const newPath = joinPath(side === 'A' ? S.pathA : S.pathB, row.dataset.name);
        if (side === 'A') S.pathA = newPath; else S.pathB = newPath;
        document.getElementById('path' + side).value = newPath;
        loadPanel(side);
        loadPanelDiskInfo(side);
    });
}

// ============================================================
// DOCKER MODE
// ============================================================
function toggleDockerMode(side) {
    const srv = side === 'A' ? S.srvA : S.srvB;
    if (!srv) return;

    const currentMode = side === 'A' ? S.panelModeA : S.panelModeB;
    const newMode = currentMode === 'docker' ? 'files' : 'docker';
    if (side === 'A') S.panelModeA = newMode; else S.panelModeB = newMode;

    const btn = document.getElementById('btnDocker' + side);
    const upBtn = document.getElementById('btnUp' + side);
    const pathEl = document.getElementById('path' + side);

    if (newMode === 'docker') {
        btn.classList.add('docker-active');
        btn.title = t('panel.filesMode');
        upBtn.disabled = true;
        pathEl.disabled = true;
        if (side === 'A') S.selA.clear(); else S.selB.clear();
        loadDockerImages(side);
    } else {
        btn.classList.remove('docker-active');
        btn.title = t('panel.dockerMode');
        upBtn.disabled = !srv;
        pathEl.disabled = false;
        if (side === 'A') S.selA.clear(); else S.selB.clear();
        loadPanel(side);
    }
    updateSelInfo();
}

async function loadDockerImages(side) {
    const srv = side === 'A' ? S.srvA : S.srvB;
    const listEl = document.getElementById('list' + side);

    if (!srv) {
        listEl.innerHTML = '<div class="panel-state"><div class="state-icon">🖥</div><div class="state-msg">' + escHtml(t('panel.selectServer')) + '</div></div>';
        return;
    }

    listEl.innerHTML = '<div class="panel-state"><div class="state-icon">⟳</div><div class="state-msg">' + escHtml(t('panel.loading')) + '</div></div>';

    try {
        const res = await execSSH(srv,
            `docker images --format "{{.Repository}}:{{.Tag}}\\t{{.Size}}" 2>&1`);
        const out = (res.stdOut || '').trim();
        const images = out ? out.split('\n').filter(Boolean).map(line => {
            const parts = line.split('\t');
            return { name: parts[0].trim(), meta: parts[1] ? parts[1].trim() : '' };
        }) : [];

        if (side === 'A') S.dockerA = images; else S.dockerB = images;
        renderDockerList(side);
        updateSelInfo();
    } catch (e) {
        listEl.innerHTML = `<div class="panel-state err"><div class="state-icon">⚠</div><div class="state-msg">${escHtml(e.message || String(e))}</div></div>`;
    }
}

function renderDockerList(side) {
    const images = side === 'A' ? S.dockerA : S.dockerB;
    const sel = side === 'A' ? S.selA : S.selB;
    const listEl = document.getElementById('list' + side);

    if (!images.length) {
        listEl.innerHTML = '<div class="panel-state"><div class="state-msg" style="color:var(--text3)">' + escHtml(t('panel.emptyDir')) + '</div></div>';
        return;
    }

    listEl.innerHTML = images.map((img, idx) => {
        const selected = sel.has(img.name);
        return `<div class="bk-row${selected ? ' selected' : ''}" data-docker-idx="${idx}" data-name="${escHtml(img.name)}">
          <input type="checkbox"${selected ? ' checked' : ''}>
          <span class="bk-row-name" title="${escHtml(img.name)}">🐳 ${escHtml(img.name)}</span>
          ${img.meta ? `<span class="bk-row-meta">${escHtml(img.meta)}</span>` : ''}
        </div>`;
    }).join('');

    listEl.querySelectorAll('.bk-row').forEach(row => {
        row.addEventListener('click', e => {
            const name = row.dataset.name;
            const sel = side === 'A' ? S.selA : S.selB;
            const chk = row.querySelector('input[type="checkbox"]');
            if (e.target === chk) {
                if (chk.checked) sel.add(name); else sel.delete(name);
            } else {
                if (sel.has(name)) { sel.delete(name); chk.checked = false; }
                else { sel.add(name); chk.checked = true; }
            }
            if (sel.has(name)) row.classList.add('selected'); else row.classList.remove('selected');
            updateSelInfo();
        });
    });
}

async function startDockerTransfer(dir) {
    const srcSrv = dir === 'AB' ? S.srvA : S.srvB;
    const dstSrv = dir === 'AB' ? S.srvB : S.srvA;
    const sel = dir === 'AB' ? S.selA : S.selB;

    if (!srcSrv || !dstSrv) { toast(t('toast.selectBothServers'), 'warn'); return; }
    if (sel.size === 0) { toast(t('toast.selectDockerImages'), 'warn'); return; }

    const images = [...sel];
    S.busy = true;
    S.tDir = dir;
    S.tPort = Math.floor(Math.random() * (PORT_MAX - PORT_MIN)) + PORT_MIN;
    S.senderExitCode = null;
    S.recvExitCode = null;
    updateTransferBtns();

    try {
        // Step 1: Estimate uncompressed size via docker inspect
        setStatus(t('status.calcSize'));
        const inspectRes = await execSSH(srcSrv,
            `docker inspect --format='{{.Size}}' ${images.map(bq).join(' ')} 2>/dev/null | awk '{s+=$1}END{print s+0}'`);
        S.tBytes = parseInt((inspectRes.stdOut || '0').trim()) || 0;

        // Step 2: Check pv availability
        setStatus(t('status.checkEnv'));
        const hasPv = await checkPv(srcSrv);
        if (!hasPv) toast(t('toast.noPv'), 'warn');

        showProgress(dir, S.tBytes, hasPv);
        S.tStart = Date.now();

        // Kill any stale nc listener on receiver
        try { await execSSH(dstSrv, `pkill -f "nc -l.*${S.tPort}" 2>/dev/null || true`); } catch (_) { }
        await sleep(400);

        // Step 3: Start receiver — nc | docker load  (images go into /var/lib/docker automatically)
        // docker commands never use sudo; user must be in docker group
        setStatus(t('status.recvWait', { alias: dstSrv.alias }));
        const recvCmd = buildSSH(dstSrv, `nc -l ${S.tPort} | docker load`);
        const recvProc = await Neutralino.os.spawnProcess(recvCmd);
        S.recvPid = recvProc.id;

        await sleep(1200);

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
        const sendProc = await Neutralino.os.spawnProcess(sendCmd);
        S.senderPid = sendProc.id;

    } catch (e) {
        onTransferError(String(e.message || e));
    }
}

// ============================================================
// DELETE
// ============================================================
async function deleteSelected(side) {
    const srv = side === 'A' ? S.srvA : S.srvB;
    const path = side === 'A' ? S.pathA : S.pathB;
    const mode = side === 'A' ? S.panelModeA : S.panelModeB;
    const sel = side === 'A' ? S.selA : S.selB;
    if (!srv || sel.size === 0) return;

    const names = [...sel];

    if (mode === 'docker') {
        // Docker mode: docker rmi — never wrap with sudo; user must be in docker group
        if (!confirm(t('confirm.dockerRmi', { count: names.length, alias: srv.alias }))) return;
        setStatus(t('status.deleting'));
        try {
            const cmd = `docker rmi ${names.map(bq).join(' ')}`;
            const res = await execSSH(srv, cmd);
            if (res.exitCode !== 0) {
                // stdOut may carry daemon errors; stdErr may have sudo/other noise — prefer stdOut
                const errOut = (res.stdOut || res.stdErr || '').trim();
                toast(t('toast.deleteFail', { msg: errOut.slice(0, 100) }), 'err');
            } else {
                toast(t('toast.deleteSuccess', { count: names.length }), 'ok');
            }
        } catch (e) {
            toast(t('toast.deleteFail', { msg: e.message || String(e) }), 'err');
        }
        await loadDockerImages(side);
    } else {
        // Files mode: rm -rf
        if (!path) return;
        if (!confirm(t('confirm.deleteFiles', { count: names.length, path }))) return;
        setStatus(t('status.deleting'));
        try {
            const quoted = names.map(n => bq(joinPath(path, n))).join(' ');
            const cmd = `rm -rf ${quoted}`;
            const wrapped = srv.useSudo ? wrapSudo(srv, cmd) : cmd;
            const res = await execSSH(srv, wrapped);
            if (res.exitCode !== 0) {
                const errOut = (res.stdErr || res.stdOut || '').trim();
                toast(t('toast.deleteFail', { msg: errOut.slice(0, 80) }), 'err');
            } else {
                toast(t('toast.deleteSuccess', { count: names.length }), 'ok');
            }
        } catch (e) {
            toast(t('toast.deleteFail', { msg: e.message || String(e) }), 'err');
        }
        await loadPanel(side);
    }
    setStatus(t('status.readyHint'));
}

// ============================================================
// UI — SERVER SELECTS
// ============================================================
function syncSelectDisabled() {
    const sa = document.getElementById('selectA');
    const sb = document.getElementById('selectB');
    sa.querySelectorAll('option').forEach(o => o.disabled = false);
    sb.querySelectorAll('option').forEach(o => o.disabled = false);
    if (sb.value) { const o = sa.querySelector(`option[value="${sb.value}"]`); if (o) o.disabled = true; }
    if (sa.value) { const o = sb.querySelector(`option[value="${sa.value}"]`); if (o) o.disabled = true; }
}

function populateSelects() {
    const opts = '<option value="">' + escHtml(t('sel.serverSelect')) + '</option>' +
        S.servers.map(s => `<option value="${s.id}">${escHtml(s.alias)}</option>`).join('');
    const sa = document.getElementById('selectA'), sb = document.getElementById('selectB');
    const pa = sa.value, pb = sb.value;
    sa.innerHTML = opts; sb.innerHTML = opts;
    sa.value = pa; sb.value = pb;
    syncSelectDisabled();
    populateBkSelect();
}

async function onSelectServer(side) {
    const id = parseInt(document.getElementById('select' + side).value);
    const srv = S.servers.find(s => s.id === id) || null;

    if (side === 'A') { S.srvA = srv; S.pathA = null; S.filesA = []; S.selA.clear(); S.panelModeA = 'files'; S.dockerA = []; }
    else { S.srvB = srv; S.pathB = null; S.filesB = []; S.selB.clear(); S.panelModeB = 'files'; S.dockerB = []; }
    syncSelectDisabled();

    const dot = document.getElementById('dot' + side);
    const editBtn = document.getElementById('btnEdit' + side);
    const upBtn = document.getElementById('btnUp' + side);
    const refBtn = document.getElementById('btnRefresh' + side);
    const pathEl = document.getElementById('path' + side);
    const listEl = document.getElementById('list' + side);
    const dockerBtn = document.getElementById('btnDocker' + side);

    editBtn.disabled = !srv;
    dockerBtn.disabled = !srv;
    // Reset docker mode button state
    dockerBtn.classList.remove('docker-active');
    dockerBtn.title = t('panel.dockerMode');
    pathEl.disabled = false;
    updateTransferBtns();

    if (!srv) {
        dot.className = 'conn-dot';
        upBtn.disabled = refBtn.disabled = true;
        pathEl.value = '';
        listEl.innerHTML = '<div class="panel-state"><div class="state-icon">🖥</div><div class="state-msg">' + escHtml(t('panel.selectServer')) + '</div></div>';
        const diskEl = document.getElementById('diskInfo' + side);
        if (diskEl) diskEl.textContent = '';
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
        loadPanelDiskInfo(side);   // fire-and-forget
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
    const bothSrvs = S.srvA && S.srvB && !S.busy;
    // Files mode needs a destination path; Docker mode does not (docker load handles storage)
    const canAtoB = bothSrvs && S.selA.size > 0 &&
        (S.panelModeA === 'docker' || (S.pathA && S.pathB));
    const canBtoA = bothSrvs && S.selB.size > 0 &&
        (S.panelModeB === 'docker' || (S.pathA && S.pathB));
    document.getElementById('btnAtoB').disabled = !canAtoB;
    document.getElementById('btnBtoA').disabled = !canBtoA;
}

function updateSelInfo() {
    const parts = [];
    if (S.selA.size > 0) parts.push(t('sel.selected', { side: 'A', count: S.selA.size }));
    if (S.selB.size > 0) parts.push(t('sel.selected', { side: 'B', count: S.selB.size }));
    document.getElementById('selInfo').textContent = parts.join('   ');
    updateTransferBtns();
    // Enable delete buttons only when something is selected and not busy
    const delA = document.getElementById('btnDeleteA');
    const delB = document.getElementById('btnDeleteB');
    if (delA) delA.disabled = S.busy || S.selA.size === 0 || !S.srvA;
    if (delB) delB.disabled = S.busy || S.selB.size === 0 || !S.srvB;
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

function onSelectAll(side, checked) {
    const mode = side === 'A' ? S.panelModeA : S.panelModeB;
    if (mode === 'docker') {
        const images = side === 'A' ? S.dockerA : S.dockerB;
        const sel = side === 'A' ? S.selA : S.selB;
        sel.clear();
        if (checked) images.forEach(img => sel.add(img.name));
        renderDockerList(side);
    } else {
        const files = side === 'A' ? S.filesA : S.filesB;
        const sel = side === 'A' ? S.selA : S.selB;
        sel.clear();
        if (checked) files.forEach(f => sel.add(f.name));
        renderList(side);
    }
    updateSelInfo();
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
        if (S.panelModeA === 'docker' && S.dockerA.length) renderDockerList('A');
        if (S.panelModeB === 'docker' && S.dockerB.length) renderDockerList('B');
        updateSelInfo();
        if (!S.busy) setStatus(t('status.readyHint'));
    };

    populateSelects();

    // Restore saved sort state
    try {
        const saved = JSON.parse(await Neutralino.storage.getData('panelSort'));
        if (saved?.A?.col) { S.sortA.col = saved.A.col; S.sortA.dir = saved.A.dir === -1 ? -1 : 1; }
        if (saved?.B?.col) { S.sortB.col = saved.B.col; S.sortB.dir = saved.B.dir === -1 ? -1 : 1; }
        updateSortHeader('A'); updateSortHeader('B');
    } catch {}

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

    // ── Column sort headers ───────────────────────────────────
    const SORT_KEY = 'panelSort';
    async function saveSortState() {
        try { await Neutralino.storage.setData(SORT_KEY, JSON.stringify({ A: S.sortA, B: S.sortB })); } catch {}
    }
    ['A', 'B'].forEach(side => {
        document.getElementById('listHeader' + side).querySelectorAll('.col-wrap').forEach(wrap => {
            wrap.addEventListener('click', e => {
                if (e.target.classList.contains('col-resize-handle')) return;
                const sortEl = wrap.querySelector('.col-sort');
                if (!sortEl) return;
                const sort = side === 'A' ? S.sortA : S.sortB;
                if (sort.col === sortEl.dataset.col) sort.dir = -sort.dir;
                else { sort.col = sortEl.dataset.col; sort.dir = 1; }
                renderList(side);
                updateSortHeader(side);
                saveSortState();
            });
        });
        updateSortHeader(side);
    });

    // ── Column resize ─────────────────────────────────────────
    (function () {
        const COL_KEY = 'colWidths';
        const root = document.documentElement;
        function applyColWidths(w) {
            if (w.name != null) root.style.setProperty('--col-w-name', Math.max(60, w.name) + 'px');
            if (w.size != null) root.style.setProperty('--col-w-size', Math.max(40, w.size) + 'px');
            if (w.mtime != null) root.style.setProperty('--col-w-mtime', Math.max(60, w.mtime) + 'px');
        }
        function measureText(el) {
            const style = getComputedStyle(el);
            const canvas = measureText._canvas || (measureText._canvas = document.createElement('canvas'));
            const ctx = canvas.getContext('2d');
            ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            return ctx.measureText(el.textContent).width;
        }
        async function autoFitCol(col) {
            const PAD = 16; // horizontal padding per cell
            let max = 0;
            // measure header
            const hdr = document.querySelector(`.col-sort[data-col="${col}"]`);
            if (hdr) max = Math.max(max, measureText(hdr) + PAD + 12); // +12 for sort arrow space
            if (col === 'name') {
                document.querySelectorAll('.file-name-text').forEach(el => {
                    max = Math.max(max, measureText(el) + 36 + PAD); // 36 = icon(20) + gap(16)
                });
                applyColWidths({ name: max });
            } else if (col === 'size') {
                document.querySelectorAll('.file-size-cell').forEach(el => {
                    max = Math.max(max, measureText(el) + PAD);
                });
                applyColWidths({ size: max });
            } else if (col === 'mtime') {
                document.querySelectorAll('.file-mtime-cell').forEach(el => {
                    max = Math.max(max, measureText(el) + PAD);
                });
                applyColWidths({ mtime: max });
            }
            const w = {
                name: parseInt(root.style.getPropertyValue('--col-w-name')) || null,
                size: parseInt(root.style.getPropertyValue('--col-w-size')) || 72,
                mtime: parseInt(root.style.getPropertyValue('--col-w-mtime')) || 140
            };
            try { await Neutralino.storage.setData(COL_KEY, JSON.stringify(w)); } catch {}
        }
        Neutralino.events.on('ready', async () => {
            try { applyColWidths(JSON.parse(await Neutralino.storage.getData(COL_KEY))); } catch {}
        });
        // Sync horizontal scroll: body → header
        ['A', 'B'].forEach(side => {
            const header = document.getElementById('listHeader' + side);
            const body = document.getElementById('list' + side);
            body.addEventListener('scroll', () => { header.scrollLeft = body.scrollLeft; });
        });
        document.querySelectorAll('.col-resize-handle').forEach(handle => {
            handle.addEventListener('dblclick', e => {
                e.preventDefault(); e.stopPropagation();
                autoFitCol(handle.dataset.resize);
            });
            handle.addEventListener('mousedown', e => {
                e.preventDefault(); e.stopPropagation();
                const startX = e.clientX;
                const resizeCol = handle.dataset.resize;
                // Capture actual rendered width of name col (may be 1fr before first resize)
                const nameEl = document.querySelector('.list-header .col-wrap');
                const startName = resizeCol === 'name'
                    ? (parseInt(root.style.getPropertyValue('--col-w-name')) || (nameEl ? nameEl.offsetWidth : 160))
                    : null;
                const startSize = parseInt(root.style.getPropertyValue('--col-w-size')) || 72;
                const startMtime = parseInt(root.style.getPropertyValue('--col-w-mtime')) || 140;
                handle.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                function onMove(mv) {
                    const d = mv.clientX - startX;
                    if (resizeCol === 'name') applyColWidths({ name: startName + d, size: startSize, mtime: startMtime });
                    else applyColWidths({ name: startName, size: startSize + d, mtime: startMtime });
                }
                async function onUp() {
                    handle.classList.remove('dragging');
                    document.body.style.cursor = ''; document.body.style.userSelect = '';
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    const w = {
                        name: parseInt(root.style.getPropertyValue('--col-w-name')) || null,
                        size: parseInt(root.style.getPropertyValue('--col-w-size')) || 72,
                        mtime: parseInt(root.style.getPropertyValue('--col-w-mtime')) || 140
                    };
                    try { await Neutralino.storage.setData(COL_KEY, JSON.stringify(w)); } catch {}
                }
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
    })();

    // Docker mode buttons
    document.getElementById('btnDockerA').onclick = () => toggleDockerMode('A');
    document.getElementById('btnDockerB').onclick = () => toggleDockerMode('B');

    // Delete buttons
    document.getElementById('btnDeleteA').onclick = () => deleteSelected('A');
    document.getElementById('btnDeleteB').onclick = () => deleteSelected('B');

    // Toolbar
    document.getElementById('btnUpA').onclick = () => {
        if (!S.srvA || S.panelModeA === 'docker') return;
        S.pathA = parentPath(S.pathA);
        document.getElementById('pathA').value = S.pathA;
        loadPanel('A');
        loadPanelDiskInfo('A');
    };
    document.getElementById('btnUpB').onclick = () => {
        if (!S.srvB || S.panelModeB === 'docker') return;
        S.pathB = parentPath(S.pathB);
        document.getElementById('pathB').value = S.pathB;
        loadPanel('B');
        loadPanelDiskInfo('B');
    };
    document.getElementById('btnRefreshA').onclick = () => { loadPanel('A'); loadPanelDiskInfo('A'); };
    document.getElementById('btnRefreshB').onclick = () => { loadPanel('B'); loadPanelDiskInfo('B'); };

    // Path input: navigate on Enter
    document.getElementById('pathA').onkeydown = e => {
        if (e.key === 'Enter' && S.srvA && S.panelModeA === 'files') {
            S.pathA = e.target.value.trim() || S.pathA;
            loadPanel('A');
            loadPanelDiskInfo('A');
        }
    };
    document.getElementById('pathB').onkeydown = e => {
        if (e.key === 'Enter' && S.srvB && S.panelModeB === 'files') {
            S.pathB = e.target.value.trim() || S.pathB;
            loadPanel('B');
            loadPanelDiskInfo('B');
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
        BK.bkupItems = [];
        BK.mounted = false;
        const dotBk = document.getElementById('dotBk');
        const editBk = document.getElementById('btnEditBk');
        dotBk.className = 'conn-dot' + (BK.srv ? ' loading' : '');
        editBk.disabled = !BK.srv;
        bkUpdateState();
        if (BK.srv) {
            await bkCheckMount();
            dotBk.className = 'conn-dot ok';
            // Auto-load server list; backup list loads only if SSD is mounted
            bkLoadList();
            if (BK.mounted) bkLoadBackupList();
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
