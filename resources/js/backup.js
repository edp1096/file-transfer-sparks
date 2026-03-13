"use strict";

// ============================================================
// BACKUP / RESTORE — Multi-SSD support
// ============================================================
const BK = {
    srv: null,
    subTab: 'docker',   // 'docker' | 'hf' | 'gguf'
    items: [],          // server-side items (for Backup)
    bkupItems: [],      // SSD backup items (for Restore)
    busy: false,
    ssdStates: [],      // [{device, mount, alias, mounted}] per SSD
    activeSsdIdx: -1,   // index into ssdStates for backup/restore target
    lastClickItems: -1, // shift-click anchor for server list
    lastClickBkup: -1,  // shift-click anchor for backup list
};

// ── Helpers ──────────────────────────────────────────────────

/** Get the currently active SSD state object, or null */
function bkActiveSsd() {
    if (BK.activeSsdIdx < 0 || BK.activeSsdIdx >= BK.ssdStates.length) return null;
    return BK.ssdStates[BK.activeSsdIdx];
}

/** Get the mount path of the currently active SSD, or '' */
function bkActiveSsdMount() {
    const ssd = bkActiveSsd();
    return ssd ? ssd.mount : '';
}

// ── Logging ──────────────────────────────────────────────────

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

// ── State management ─────────────────────────────────────────

function bkUpdateState() {
    const noServer = document.getElementById('bkStateNoServer');
    const noSsd = document.getElementById('bkStateNoSsd');
    const content = document.getElementById('bkContent');
    const ssdBar = document.getElementById('bkSsdBar');

    if (!BK.srv) {
        noServer.style.display = '';
        noSsd.style.display = 'none';
        content.style.display = 'none';
        ssdBar.style.display = 'none';
        BK.items = [];
        BK.bkupItems = [];
        BK.ssdStates = [];
        BK.activeSsdIdx = -1;
        return;
    }

    noServer.style.display = 'none';
    noSsd.style.display = 'none';
    content.style.display = '';

    const hasSsd = BK.srv.ssds && BK.srv.ssds.length > 0;
    ssdBar.style.display = hasSsd ? '' : 'none';

    // Build ssdStates from server config
    BK.ssdStates = (BK.srv.ssds || []).map(s => ({
        device: s.device,
        mount: s.mount,
        alias: s.alias || '',
        mounted: false
    }));
    BK.activeSsdIdx = -1;

    bkRenderSsdChips();
    bkRenderList();
    bkRenderBkupList();
    if (!hasSsd) bkRenderBkupPlaceholder(t('backup.noSsdConfig'));
}

// ── SSD mount checking ───────────────────────────────────────

/** Check mount status of all SSDs in a single SSH call */
async function bkCheckAllMounts() {
    if (!BK.srv || !BK.ssdStates.length) return;

    // Set all chips to checking
    BK.ssdStates.forEach((_, idx) => bkSetSsdChipChecking(idx));

    try {
        // Build a single command that checks all mount points
        const checks = BK.ssdStates.map((s, i) =>
            `mountpoint -q ${bq(s.mount)} 2>/dev/null && echo "__SSD_${i}_YES__" || echo "__SSD_${i}_NO__"`
        ).join(' ; ');
        const res = await execSSH(BK.srv, checks);
        const out = res.stdOut || '';

        BK.ssdStates.forEach((s, i) => {
            s.mounted = out.includes(`__SSD_${i}_YES__`);
            bkSetSsdChipMountUI(i, s.mounted);
        });
    } catch (_) {
        BK.ssdStates.forEach((s, i) => {
            s.mounted = false;
            bkSetSsdChipMountUI(i, false);
        });
    }

    bkAutoSelectSsd();
    bkUpdateSsdSelect();
}

/** Mount a specific SSD by index */
async function bkMount(idx) {
    if (!BK.srv || idx < 0 || idx >= BK.ssdStates.length) return;
    const ssd = BK.ssdStates[idx];

    bkSetSsdChipChecking(idx);
    bkLog('$ mount ' + ssd.device + ' ' + ssd.mount);

    try {
        // Try primary mount point
        const cmd = `mkdir -p ${bq(ssd.mount)} && sudo mount ${bq(ssd.device)} ${bq(ssd.mount)}`;
        const wrapped = BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd;
        const res = await execSSH(BK.srv, wrapped);
        const errMsg = (res.stdErr || '').trim();

        if (res.exitCode !== 0 && errMsg) {
            // Fallback: try /mnt/ssd_<name>
            const devName = ssd.device.replace(/^\/dev\//, '');
            const fallbackMount = '/mnt/ssd_' + devName;
            bkLog('Primary mount failed, trying fallback: ' + fallbackMount, 'warn');
            const cmd2 = `mkdir -p ${bq(fallbackMount)} && sudo mount ${bq(ssd.device)} ${bq(fallbackMount)}`;
            const wrapped2 = BK.srv.useSudo ? wrapSudo(BK.srv, cmd2) : cmd2;
            const res2 = await execSSH(BK.srv, wrapped2);
            if (res2.exitCode === 0) {
                // Update mount point to fallback
                ssd.mount = fallbackMount;
                // Also update the server config
                const srvSsd = BK.srv.ssds[idx];
                if (srvSsd) srvSsd.mount = fallbackMount;
            } else {
                const err2 = (res2.stdErr || '').trim();
                if (err2) bkLog(err2, 'warn');
                bkLog(t('backup.mountFail', { msg: err2 || errMsg }), 'err');
                toast(t('backup.mountFail', { msg: (err2 || errMsg).slice(0, 80) }), 'err');
                bkSetSsdChipMountUI(idx, false);
                return;
            }
        } else if (errMsg) {
            bkLog(errMsg, 'warn');
        }

        // Verify mount
        const chk = await execSSH(BK.srv,
            `mountpoint -q ${bq(ssd.mount)} 2>/dev/null && echo __MNT_YES__ || echo __MNT_NO__`);
        ssd.mounted = (chk.stdOut || '').includes('__MNT_YES__');
        bkSetSsdChipMountUI(idx, ssd.mounted);

        if (ssd.mounted) {
            bkLog(t('backup.mountSuccess', { point: ssd.mount }), 'ok');
            toast(t('backup.mountSuccess', { point: ssd.mount }), 'ok');
            bkAutoSelectSsd();
            bkUpdateSsdSelect();
            bkFetchDiskInfo();
            bkLoadBackupList();
        }
    } catch (e) {
        bkLog(t('backup.mountFail', { msg: e.message || String(e) }), 'err');
        toast(t('backup.mountFail', { msg: e.message || String(e) }), 'err');
        bkSetSsdChipMountUI(idx, false);
    }
}

/** Unmount a specific SSD by index */
async function bkUnmount(idx) {
    if (!BK.srv || idx < 0 || idx >= BK.ssdStates.length) return;
    const ssd = BK.ssdStates[idx];

    bkSetSsdChipChecking(idx);
    bkLog('$ umount ' + ssd.mount);

    try {
        const cmd = `sudo umount ${bq(ssd.mount)}`;
        const wrapped = BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd;
        const res = await execSSH(BK.srv, wrapped);
        const errMsg = (res.stdErr || '').trim();
        if (errMsg) bkLog(errMsg, 'warn');

        if (res.exitCode !== 0) {
            const msg = errMsg || 'umount failed';
            bkLog(t('backup.unmountFail', { msg }), 'err');
            toast(t('backup.unmountFail', { msg: msg.slice(0, 80) }), 'err');
            // Re-check actual state
            const chk = await execSSH(BK.srv,
                `mountpoint -q ${bq(ssd.mount)} 2>/dev/null && echo __MNT_YES__ || echo __MNT_NO__`);
            ssd.mounted = (chk.stdOut || '').includes('__MNT_YES__');
            bkSetSsdChipMountUI(idx, ssd.mounted);
            return;
        }

        // rmdir cleanup (best-effort)
        try {
            await execSSH(BK.srv, BK.srv.useSudo
                ? wrapSudo(BK.srv, `rmdir ${bq(ssd.mount)} 2>/dev/null || true`)
                : `rmdir ${bq(ssd.mount)} 2>/dev/null || true`);
        } catch (_) {}

        ssd.mounted = false;
        bkSetSsdChipMountUI(idx, false);
        bkLog(t('backup.unmountSuccess', { point: ssd.mount }), 'ok');
        toast(t('backup.unmountSuccess', { point: ssd.mount }), 'ok');

        // If this was the active SSD, re-select
        if (BK.activeSsdIdx === idx) {
            BK.bkupItems = [];
            bkRenderBkupList();
            bkRenderBkupPlaceholder(t('backup.noItems'));
        }
        bkAutoSelectSsd();
        bkUpdateSsdSelect();
        const diskEl = document.getElementById('bkDiskInfo');
        if (diskEl) diskEl.textContent = '';
    } catch (e) {
        bkLog(t('backup.unmountFail', { msg: e.message || String(e) }), 'err');
        toast(t('backup.unmountFail', { msg: e.message || String(e) }), 'err');
        bkSetSsdChipMountUI(idx, ssd.mounted);
    }
}

/** Auto-select an active SSD: if only 1 mounted, select it; if multiple, keep current or select first */
function bkAutoSelectSsd() {
    const mountedIndices = BK.ssdStates
        .map((s, i) => s.mounted ? i : -1)
        .filter(i => i >= 0);

    if (mountedIndices.length === 0) {
        BK.activeSsdIdx = -1;
    } else if (mountedIndices.length === 1) {
        BK.activeSsdIdx = mountedIndices[0];
    } else {
        // Multiple mounted — keep current if still mounted, else first
        if (BK.activeSsdIdx >= 0 && BK.ssdStates[BK.activeSsdIdx]?.mounted) {
            // keep current
        } else {
            BK.activeSsdIdx = mountedIndices[0];
        }
    }
}

// ── SSD chip UI ──────────────────────────────────────────────

function bkRenderSsdChips() {
    const container = document.getElementById('bkSsdChips');
    if (!container) return;

    if (!BK.ssdStates.length) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = BK.ssdStates.map((ssd, idx) => {
        const label = ssd.alias || ssd.device;
        return `<div class="bk-ssd-chip" data-ssd-idx="${idx}">
          <div class="conn-dot" id="dotSsd${idx}"></div>
          <span class="ssd-chip-label">${escHtml(label)}</span>
          <button class="btn btn-sm btn-primary ssd-mount-btn" data-ssd-mount="${idx}" style="display:none">${escHtml(t('backup.mount'))}</button>
          <button class="btn btn-sm btn-danger ssd-unmount-btn" data-ssd-unmount="${idx}" style="display:none">${escHtml(t('backup.unmount'))}</button>
        </div>`;
    }).join('');

    // Bind mount/unmount buttons
    container.querySelectorAll('[data-ssd-mount]').forEach(btn => {
        btn.addEventListener('click', () => bkMount(parseInt(btn.dataset.ssdMount)));
    });
    container.querySelectorAll('[data-ssd-unmount]').forEach(btn => {
        btn.addEventListener('click', () => bkUnmount(parseInt(btn.dataset.ssdUnmount)));
    });
}

function bkSetSsdChipChecking(idx) {
    const dot = document.getElementById('dotSsd' + idx);
    if (dot) dot.className = 'conn-dot loading';
    const chip = document.querySelector(`.bk-ssd-chip[data-ssd-idx="${idx}"]`);
    if (chip) {
        const mountBtn = chip.querySelector('.ssd-mount-btn');
        const unmountBtn = chip.querySelector('.ssd-unmount-btn');
        if (mountBtn) mountBtn.disabled = true;
        if (unmountBtn) unmountBtn.disabled = true;
    }
}

function bkSetSsdChipMountUI(idx, mounted) {
    const dot = document.getElementById('dotSsd' + idx);
    if (dot) dot.className = 'conn-dot ' + (mounted ? 'ok' : 'err');
    const chip = document.querySelector(`.bk-ssd-chip[data-ssd-idx="${idx}"]`);
    if (chip) {
        const mountBtn = chip.querySelector('.ssd-mount-btn');
        const unmountBtn = chip.querySelector('.ssd-unmount-btn');
        if (mountBtn) {
            mountBtn.style.display = mounted ? 'none' : '';
            mountBtn.disabled = BK.busy;
        }
        if (unmountBtn) {
            unmountBtn.style.display = mounted ? '' : 'none';
            unmountBtn.disabled = BK.busy;
        }
    }
}

/** Show/hide the SSD select dropdown depending on how many are mounted */
function bkUpdateSsdSelect() {
    const sel = document.getElementById('bkSsdSelect');
    if (!sel) return;
    const mountedIndices = BK.ssdStates
        .map((s, i) => s.mounted ? i : -1)
        .filter(i => i >= 0);

    if (mountedIndices.length <= 1) {
        sel.style.display = 'none';
        return;
    }

    sel.style.display = '';
    sel.innerHTML = mountedIndices.map(i => {
        const s = BK.ssdStates[i];
        const label = s.alias || s.device;
        return `<option value="${i}"${i === BK.activeSsdIdx ? ' selected' : ''}>${escHtml(label)}</option>`;
    }).join('');
}

// ── Disk info ────────────────────────────────────────────────

async function bkFetchServerDiskInfo() {
    const el = document.getElementById('bkSrvDiskInfo');
    if (!el) return;
    if (!BK.srv) { el.textContent = ''; return; }

    let path;
    if (BK.subTab === 'docker') {
        path = '/';
    } else if (BK.subTab === 'hf') {
        path = BK.srv.hfHubPath || null;
    } else {
        path = BK.srv.ggufPath || null;
    }
    if (!path) { el.textContent = ''; return; }

    try {
        const res = await execSSH(BK.srv,
            `df -h ${bq(path)} 2>/dev/null | awk 'NR==2{print $3 "/" $2 " (" $5 " " $4 " free) \u2014 " $6}'`);
        el.textContent = (res.stdOut || '').trim();
    } catch (_) {
        el.textContent = '';
    }
}

async function bkFetchDiskInfo() {
    const el = document.getElementById('bkDiskInfo');
    if (!el) return;
    const mount = bkActiveSsdMount();
    if (!BK.srv || !mount) { el.textContent = ''; return; }
    try {
        const res = await execSSH(BK.srv,
            `df -h ${bq(mount)} 2>/dev/null | awk 'NR==2{print $3 "/" $2 " (" $5 " " $4 " free)"}'`);
        const info = (res.stdOut || '').trim();
        el.textContent = info ? '\u2014 ' + info : '';
    } catch (_) {
        el.textContent = '';
    }
}

// ── Item listing ────────────────────────────────────────────

async function bkLoadList() {
    if (!BK.srv) return;
    document.getElementById('btnBkLoad').disabled = true;
    bkRenderPlaceholder(t('backup.loading'));
    BK.items = [];
    BK.lastClickItems = -1;

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
        bkRenderPlaceholder('\u26a0 ' + (e.message || String(e)));
    } finally {
        document.getElementById('btnBkLoad').disabled = false;
        bkRenderList();
    }
    bkFetchServerDiskInfo();
}

async function bkListDocker() {
    const res = await execSSH(BK.srv,
        `docker images --format "{{.Repository}}:{{.Tag}}\\t{{.Size}}" 2>&1`);
    const out = (res.stdOut || '').trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return { name: parts[0].trim(), meta: parts[1] ? parts[1].trim() : '', selected: false };
    });
}

async function bkListHF() {
    if (!BK.srv.hfHubPath) throw new Error(t('backup.noHfPath'));
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(BK.srv.hfHubPath)}`)
        : `mkdir -p ${bq(BK.srv.hfHubPath)}`);
    const res = await execSSH(BK.srv,
        `du -sh ${bq(BK.srv.hfHubPath)}/* 2>/dev/null | awk '{split($2,a,"/"); print a[length(a)] "\\t" $1}' || true`);
    const out = (res.stdOut || '').trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return { name: parts[0].trim(), meta: parts[1] ? parts[1].trim() : '', selected: false };
    });
}

async function bkListGGUF() {
    if (!BK.srv.ggufPath) throw new Error(t('backup.noGgufPath'));
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(BK.srv.ggufPath)}`)
        : `mkdir -p ${bq(BK.srv.ggufPath)}`);
    const res = await execSSH(BK.srv,
        `du -sh ${bq(BK.srv.ggufPath)}/*.gguf 2>/dev/null | awk '{split($2,a,"/"); print a[length(a)] "\\t" $1}' || true`);
    const out = (res.stdOut || '').trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return { name: parts[0].trim(), meta: parts[1] ? parts[1].trim() : '', selected: false };
    });
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
            if (e.shiftKey && BK.lastClickItems >= 0) {
                const lo = Math.min(idx, BK.lastClickItems);
                const hi = Math.max(idx, BK.lastClickItems);
                for (let i = lo; i <= hi; i++) BK.items[i].selected = true;
                bkRenderList();
            } else {
                BK.lastClickItems = idx;
                if (e.target === chk) {
                    BK.items[idx].selected = chk.checked;
                } else {
                    BK.items[idx].selected = !BK.items[idx].selected;
                    chk.checked = BK.items[idx].selected;
                }
                if (BK.items[idx].selected) row.classList.add('selected');
                else row.classList.remove('selected');
            }
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
    const deleteBtn = document.getElementById('btnBkDelete');
    const deleteBkupBtn = document.getElementById('btnBkDeleteBkup');
    if (backupBtn) backupBtn.disabled = !hasSel || BK.busy;
    if (restoreBtn) restoreBtn.disabled = !hasBkupSel || BK.busy;
    if (deleteBtn) deleteBtn.disabled = !hasSel || BK.busy;
    if (deleteBkupBtn) deleteBkupBtn.disabled = !hasBkupSel || BK.busy;
}

// ── Backup / Restore execution ──────────────────────────────

function bkSetBusy(busy) {
    BK.busy = busy;
    document.getElementById('btnBkLoad').disabled = busy;
    document.getElementById('btnBkLoadBkup').disabled = busy;
    document.getElementById('btnBkCancel').style.display = busy ? '' : 'none';
    // Disable all SSD mount/unmount buttons + dropdown during busy
    BK.ssdStates.forEach((s, idx) => {
        const chip = document.querySelector(`.bk-ssd-chip[data-ssd-idx="${idx}"]`);
        if (chip) {
            const mountBtn = chip.querySelector('.ssd-mount-btn');
            const unmountBtn = chip.querySelector('.ssd-unmount-btn');
            if (mountBtn) mountBtn.disabled = busy;
            if (unmountBtn) unmountBtn.disabled = busy;
        }
    });
    const ssdSel = document.getElementById('bkSsdSelect');
    if (ssdSel) ssdSel.disabled = busy;
    bkUpdateActionBtns();
}

async function bkRunBackup() {
    if (BK.busy || !BK.srv) return;
    const sel = BK.items.filter(i => i.selected);
    if (!sel.length) { toast(t('backup.selectItems'), 'warn'); return; }
    const mount = bkActiveSsdMount();
    if (!mount) { toast(t('backup.ssdNotMounted'), 'warn'); return; }

    // Verify SSD is mounted
    try {
        const chk = await execSSH(BK.srv, `mountpoint -q ${bq(mount)} && echo MOUNTED || echo NOT_MOUNTED`);
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
        await bkLoadBackupList();
        bkFetchDiskInfo();
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
    const mount = bkActiveSsdMount();
    if (!mount) { toast(t('backup.ssdNotMounted'), 'warn'); return; }

    try {
        const chk = await execSSH(BK.srv, `mountpoint -q ${bq(mount)} && echo MOUNTED || echo NOT_MOUNTED`);
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
        await bkLoadList();
        bkFetchServerDiskInfo();
    } catch (e) {
        bkLog('Error: ' + (e.message || String(e)), 'err');
        toast(t('backup.opFail', { msg: e.message || String(e) }), 'err');
    } finally {
        bkSetBusy(false);
    }
}

// ── Delete server items ──────────────────────────────────────

async function bkRunDeleteServer() {
    if (BK.busy || !BK.srv) return;
    const sel = BK.items.filter(i => i.selected);
    if (!sel.length) { toast(t('backup.selectItems'), 'warn'); return; }

    const confirmMsg = BK.subTab === 'docker'
        ? t('confirm.dockerRmi', { count: sel.length, alias: BK.srv.alias })
        : t('confirm.bkDeleteSrv', { count: sel.length });
    if (!confirm(confirmMsg)) return;

    bkSetBusy(true);
    bkLog('=== Delete started ===', 'ok');

    try {
        if (BK.subTab === 'docker') {
            await bkDeleteServerDocker(sel);
        } else if (BK.subTab === 'hf') {
            await bkDeleteServerHF(sel);
        } else {
            await bkDeleteServerGGUF(sel);
        }
        bkLog('=== Delete complete ===', 'ok');
        toast(t('toast.deleteSuccess', { count: sel.length }), 'ok');
        await bkLoadList();
        bkFetchServerDiskInfo();
    } catch (e) {
        bkLog('Error: ' + (e.message || String(e)), 'err');
        toast(t('backup.opFail', { msg: e.message || String(e) }), 'err');
    } finally {
        bkSetBusy(false);
    }
}

async function bkDeleteServerDocker(sel) {
    for (const item of sel) {
        bkLog('Removing Docker image: ' + item.name);
        const res = await execSSH(BK.srv, `docker rmi ${bq(item.name)}`);
        if (res.stdOut && res.stdOut.trim()) bkLog(res.stdOut.trim());
        if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        bkLog('  done: ' + item.name, 'ok');
    }
}

async function bkDeleteServerHF(sel) {
    if (!BK.srv.hfHubPath) throw new Error(t('backup.noHfPath'));
    for (const item of sel) {
        bkLog('Deleting HF model: ' + item.name);
        const cmd = `rm -rf ${bq(BK.srv.hfHubPath + '/' + item.name)}`;
        const res = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd);
        if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        bkLog('  done: ' + item.name, 'ok');
    }
}

async function bkDeleteServerGGUF(sel) {
    if (!BK.srv.ggufPath) throw new Error(t('backup.noGgufPath'));
    for (const item of sel) {
        bkLog('Deleting GGUF: ' + item.name);
        const cmd = `rm ${bq(BK.srv.ggufPath + '/' + item.name)}`;
        const res = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd);
        if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        bkLog('  done: ' + item.name, 'ok');
    }
}

// ── Delete SSD backup items ──────────────────────────────────

async function bkRunDeleteBkup() {
    if (BK.busy || !BK.srv) return;
    const sel = BK.bkupItems.filter(i => i.selected);
    if (!sel.length) { toast(t('backup.selectItems'), 'warn'); return; }
    const mount = bkActiveSsdMount();
    if (!mount) { toast(t('backup.ssdNotMounted'), 'warn'); return; }

    if (!confirm(t('confirm.bkDeleteBkup', { count: sel.length }))) return;

    bkSetBusy(true);
    bkLog('=== Delete backup started ===', 'ok');

    try {
        for (const item of sel) {
            let filePath;
            if (BK.subTab === 'docker') {
                filePath = mount + '/docker_backup/' + item.name;
            } else if (BK.subTab === 'hf') {
                filePath = mount + '/huggingface_backup/' + item.name + '.tar';
            } else {
                filePath = mount + '/gguf_backup/' + item.name;
            }
            bkLog('Deleting backup: ' + item.name);
            const cmd = `rm ${bq(filePath)}`;
            const res = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd);
            if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
            bkLog('  done: ' + item.name, 'ok');
        }
        bkLog('=== Delete backup complete ===', 'ok');
        toast(t('toast.deleteSuccess', { count: sel.length }), 'ok');
        await bkLoadBackupList();
        bkFetchDiskInfo();
    } catch (e) {
        bkLog('Error: ' + (e.message || String(e)), 'err');
        toast(t('backup.opFail', { msg: e.message || String(e) }), 'err');
    } finally {
        bkSetBusy(false);
    }
}

// ── Docker backup/restore ────────────────────────────────────

async function bkBackupDocker(sel) {
    const mount = bkActiveSsdMount();
    const backupDir = mount + '/docker_backup';
    const mkdirCmd = `mkdir -p ${bq(backupDir)}`;
    const mkdirRes = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, mkdirCmd) : mkdirCmd);
    if (mkdirRes.stdErr && mkdirRes.stdErr.trim()) bkLog(mkdirRes.stdErr.trim(), 'warn');

    for (const item of sel) {
        if (!BK.busy) break;
        const fname = item.name.replace(/[/:]/g, '_') + '.tar';
        const outPath = backupDir + '/' + fname;
        bkLog('Backing up: ' + item.name + '  \u2192  ' + fname);
        const testDkBk = `test -f ${bq(outPath)} && echo __SKIP__ || echo __RUN__`;
        const chk = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, testDkBk) : testDkBk);
        if ((chk.stdOut || '').includes('__SKIP__')) {
            bkLog('  skip (already exists): ' + fname, 'warn');
            continue;
        }
        if (BK.srv.useSudo) {
            const res = await execSSH(BK.srv, wrapSudo(BK.srv, `docker save ${bq(item.name)} > ${bq(outPath)}`));
            if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        } else {
            const res = await execSSH(BK.srv, `docker save -o ${bq(outPath)} ${bq(item.name)}`);
            if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        }
        bkLog('  done: ' + item.name, 'ok');
    }
}

async function bkRestoreDocker(sel) {
    const mount = bkActiveSsdMount();
    const backupDir = mount + '/docker_backup';
    for (const item of sel) {
        if (!BK.busy) break;
        const tarPath = backupDir + '/' + item.name;
        bkLog('Restoring: ' + item.name);
        const manifestCmd = `tar xOf ${bq(tarPath)} manifest.json 2>/dev/null | grep -oP '(?<="RepoTags":\\[")[^"]+' | head -1`;
        const mRes = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, manifestCmd) : manifestCmd);
        const imageName = (mRes.stdOut || '').trim();
        if (imageName) {
            const testCmd = `docker images -q ${bq(imageName)} 2>/dev/null | grep -q . && echo __SKIP__ || echo __RUN__`;
            const chk = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, testCmd) : testCmd);
            if ((chk.stdOut || '').includes('__SKIP__')) {
                bkLog('  skip (already exists): ' + imageName, 'warn');
                continue;
            }
        }
        if (BK.srv.useSudo) {
            const res = await execSSH(BK.srv, wrapSudo(BK.srv, `docker load -i ${bq(tarPath)}`));
            if (res.stdOut && res.stdOut.trim()) bkLog(res.stdOut.trim());
            if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        } else {
            const res = await execSSH(BK.srv, `docker load -i ${bq(tarPath)}`);
            if (res.stdOut && res.stdOut.trim()) bkLog(res.stdOut.trim());
            if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        }
        bkLog('  done: ' + item.name, 'ok');
    }
}

// ── HF model backup/restore ──────────────────────────────────

async function bkBackupHF(sel) {
    if (!BK.srv.hfHubPath) throw new Error(t('backup.noHfPath'));
    const mount = bkActiveSsdMount();
    const backupDir = mount + '/huggingface_backup';
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(backupDir)}`)
        : `mkdir -p ${bq(backupDir)}`);

    for (const item of sel) {
        if (!BK.busy) break;
        const tarPath = backupDir + '/' + item.name + '.tar';
        bkLog('Backing up: ' + item.name);
        const testHFBk = `test -f ${bq(tarPath)} && echo __SKIP__ || echo __RUN__`;
        const chk = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, testHFBk) : testHFBk);
        if ((chk.stdOut || '').includes('__SKIP__')) {
            bkLog('  skip (already exists): ' + item.name, 'warn');
            continue;
        }
        const cmd = `tar -cf ${bq(tarPath)} -C ${bq(BK.srv.hfHubPath)} ${bq(item.name)}`;
        const res = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, cmd) : cmd);
        if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        bkLog('  done: ' + item.name, 'ok');
    }
}

async function bkRestoreHF(sel) {
    if (!BK.srv.hfHubPath) throw new Error(t('backup.noHfPath'));
    const mount = bkActiveSsdMount();
    const backupDir = mount + '/huggingface_backup';
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(BK.srv.hfHubPath)}`)
        : `mkdir -p ${bq(BK.srv.hfHubPath)}`);

    for (const item of sel) {
        if (!BK.busy) break;
        const tarPath = backupDir + '/' + item.name + '.tar';
        const destDir = BK.srv.hfHubPath + '/' + item.name;
        bkLog('Restoring: ' + item.name);
        const testHFRe = `test -d ${bq(destDir)} && echo __SKIP__ || echo __RUN__`;
        const chk = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, testHFRe) : testHFRe);
        if ((chk.stdOut || '').includes('__SKIP__')) {
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
    const mount = bkActiveSsdMount();
    const backupDir = mount + '/gguf_backup';
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(backupDir)}`)
        : `mkdir -p ${bq(backupDir)}`);

    for (const item of sel) {
        if (!BK.busy) break;
        const src = BK.srv.ggufPath + '/' + item.name;
        const dst = backupDir + '/' + item.name;
        bkLog('Backing up: ' + item.name);
        const testGGBk = `test -f ${bq(dst)} && echo __SKIP__ || echo __RUN__`;
        const chk = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, testGGBk) : testGGBk);
        if ((chk.stdOut || '').includes('__SKIP__')) {
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

async function bkRestoreGGUF(sel) {
    if (!BK.srv.ggufPath) throw new Error(t('backup.noGgufPath'));
    const mount = bkActiveSsdMount();
    const backupDir = mount + '/gguf_backup';
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(BK.srv.ggufPath)}`)
        : `mkdir -p ${bq(BK.srv.ggufPath)}`);

    for (const item of sel) {
        if (!BK.busy) break;
        const src = backupDir + '/' + item.name;
        const dst = BK.srv.ggufPath + '/' + item.name;
        bkLog('Restoring: ' + item.name);
        const testGGRe = `test -f ${bq(dst)} && echo __SKIP__ || echo __RUN__`;
        const chk = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, testGGRe) : testGGRe);
        if ((chk.stdOut || '').includes('__SKIP__')) {
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
    const mount = bkActiveSsdMount();
    if (!mount) { toast(t('backup.ssdNotMounted'), 'warn'); return; }

    document.getElementById('btnBkLoadBkup').disabled = true;
    bkRenderBkupPlaceholder(t('backup.loading'));
    BK.bkupItems = [];
    BK.lastClickBkup = -1;

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
        bkRenderBkupPlaceholder('\u26a0 ' + (e.message || String(e)));
        document.getElementById('btnBkLoadBkup').disabled = false;
        return;
    }

    document.getElementById('btnBkLoadBkup').disabled = false;
    bkRenderBkupList();
}

async function bkListDockerBackups() {
    const mount = bkActiveSsdMount();
    const dir = mount + '/docker_backup';
    const res = await execSSH(BK.srv,
        `du -sh ${bq(dir)}/*.tar 2>/dev/null | awk '{split($2,a,"/"); print a[length(a)] "\\t" $1}' || true`);
    const out = (res.stdOut || '').trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return { name: parts[0].trim(), meta: parts[1] ? parts[1].trim() : '', selected: false };
    });
}

async function bkListHFBackups() {
    const mount = bkActiveSsdMount();
    const dir = mount + '/huggingface_backup';
    const res = await execSSH(BK.srv,
        `du -sh ${bq(dir)}/*.tar 2>/dev/null | awk '{split($2,a,"/"); gsub(/\\.tar$/,"",a[length(a)]); print a[length(a)] "\\t" $1}' || true`);
    const out = (res.stdOut || '').trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return { name: parts[0].trim(), meta: parts[1] ? parts[1].trim() : '', selected: false };
    });
}

async function bkListGGUFBackups() {
    const mount = bkActiveSsdMount();
    const dir = mount + '/gguf_backup';
    const res = await execSSH(BK.srv,
        `du -sh ${bq(dir)}/*.gguf 2>/dev/null | awk '{split($2,a,"/"); print a[length(a)] "\\t" $1}' || true`);
    const out = (res.stdOut || '').trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return { name: parts[0].trim(), meta: parts[1] ? parts[1].trim() : '', selected: false };
    });
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
            if (e.shiftKey && BK.lastClickBkup >= 0) {
                const lo = Math.min(idx, BK.lastClickBkup);
                const hi = Math.max(idx, BK.lastClickBkup);
                for (let i = lo; i <= hi; i++) BK.bkupItems[i].selected = true;
                bkRenderBkupList();
            } else {
                BK.lastClickBkup = idx;
                if (e.target === chk) {
                    BK.bkupItems[idx].selected = chk.checked;
                } else {
                    BK.bkupItems[idx].selected = !BK.bkupItems[idx].selected;
                    chk.checked = BK.bkupItems[idx].selected;
                }
                if (BK.bkupItems[idx].selected) row.classList.add('selected');
                else row.classList.remove('selected');
            }
            bkUpdateActionBtns();
        });
    });
    bkUpdateActionBtns();
}

function bkRenderBkupPlaceholder(msg) {
    const el = document.getElementById('bkBkupList');
    if (el) el.innerHTML = `<div class="panel-state"><div class="state-msg" style="color:var(--text3)">${escHtml(msg)}</div></div>`;
}

// ── Log panel toggle ─────────────────────────────────────────
function bkLogSetCollapsed(collapsed) {
    const log = document.getElementById('bkBottomLog');
    const handle = document.getElementById('bkResizeHandle');
    const btn = document.getElementById('btnBkToggleLog');
    log.classList.toggle('log-collapsed', collapsed);
    if (handle) handle.style.display = collapsed ? 'none' : '';
    if (btn) btn.textContent = collapsed ? '\u25b2' : '\u25bc';
}

async function bkLogToggle() {
    const collapsed = !document.getElementById('bkBottomLog').classList.contains('log-collapsed');
    bkLogSetCollapsed(collapsed);
    try { await Neutralino.storage.setData('bkLogVisible', collapsed ? '0' : '1'); } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btnBkToggleLog').addEventListener('click', bkLogToggle);
    document.getElementById('btnBkDelete').addEventListener('click', bkRunDeleteServer);
    document.getElementById('btnBkDeleteBkup').addEventListener('click', bkRunDeleteBkup);
});

Neutralino.events.on('ready', async () => {
    try {
        const val = await Neutralino.storage.getData('bkLogVisible');
        bkLogSetCollapsed(val === '0');
    } catch {
        bkLogSetCollapsed(false);
    }
});

// ── Sub-tab switch ───────────────────────────────────────────
function bkSwitchSubTab(tab) {
    if (BK.subTab === tab) return;
    BK.subTab = tab;
    BK.items = [];
    BK.bkupItems = [];
    ['docker', 'hf', 'gguf'].forEach(name => {
        const btn = document.getElementById('bkTab' + name.charAt(0).toUpperCase() + name.slice(1));
        if (btn) btn.classList.toggle('active', name === tab);
    });
    bkRenderList();
    bkRenderBkupList();
    // Auto-load on tab switch
    if (BK.srv) {
        bkLoadList();
        if (bkActiveSsdMount()) bkLoadBackupList();
    }
}
