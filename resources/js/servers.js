"use strict";

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
        const ping = await execSSH(srv, 'echo __CONN_OK__');
        if (!(ping.stdOut || '').includes('__CONN_OK__')) throw new Error((ping.stdErr || t('misc.noResponse')).trim().slice(0, 120));
        const home = await getHomeDir(srv);
        if (side === 'A') S.pathA = home; else S.pathB = home;
        pathEl.value = home;
        upBtn.disabled = refBtn.disabled = false;
        dot.className = 'conn-dot ok';
        setStatus(t('status.connected', { alias: srv.alias }));
        await loadPanel(side);
        loadPanelDiskInfo(side);   // fire-and-forget
    } catch (e) {
        const alias = srv.alias;
        setStatus(t('status.connFail', { alias }));
        toast(t('toast.connFail', { alias }), 'err');
        // 연결 실패: 서버 선택을 초기 상태로 되돌림
        document.getElementById('select' + side).value = '';
        if (side === 'A') { S.srvA = null; S.pathA = null; S.filesA = []; S.selA.clear(); S.panelModeA = 'files'; S.dockerA = []; }
        else { S.srvB = null; S.pathB = null; S.filesB = []; S.selB.clear(); S.panelModeB = 'files'; S.dockerB = []; }
        syncSelectDisabled();
        dot.className = 'conn-dot';
        editBtn.disabled = true;
        dockerBtn.disabled = true;
        dockerBtn.classList.remove('docker-active');
        dockerBtn.title = t('panel.dockerMode');
        upBtn.disabled = true;
        refBtn.disabled = true;
        pathEl.value = '';
        listEl.innerHTML = '<div class="panel-state"><div class="state-icon">🖥</div><div class="state-msg">' + escHtml(t('panel.selectServer')) + '</div></div>';
        const diskEl = document.getElementById('diskInfo' + side);
        if (diskEl) diskEl.textContent = '';
        updateTransferBtns();
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
// BACKUP SERVER SELECT
// ============================================================
function populateBkSelect() {
    const sel = document.getElementById('selectBk');
    const prev = sel.value;
    sel.innerHTML = '<option value="">' + escHtml(t('sel.serverSelect')) + '</option>' +
        S.servers.map(s => `<option value="${s.id}">${escHtml(s.alias)}</option>`).join('');
    sel.value = prev;
}
