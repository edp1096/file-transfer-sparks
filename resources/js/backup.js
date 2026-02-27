"use strict";

// ============================================================
// BACKUP / RESTORE
// ============================================================
const BK = {
    srv: null,
    subTab: 'docker',   // 'docker' | 'hf' | 'gguf'
    items: [],          // server-side items (for Backup)
    bkupItems: [],      // SSD backup items (for Restore)
    busy: false,
    mounted: false,     // SSD mount state (tracked to enable auto-load)
    lastClickItems: -1, // shift-click anchor for server list
    lastClickBkup: -1,  // shift-click anchor for backup list
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
    noSsd.style.display = 'none';
    content.style.display = '';

    const hasSsd = !!(BK.srv.ssdDevice || BK.srv.ssdMount);
    mountBar.style.display = hasSsd ? '' : 'none';

    bkRenderList();
    bkRenderBkupList();
    if (!hasSsd) bkRenderBkupPlaceholder(t('backup.noSsdConfig'));
}

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
    if (!BK.srv || !BK.srv.ssdMount) { el.textContent = ''; return; }
    try {
        const res = await execSSH(BK.srv,
            `df -h ${bq(BK.srv.ssdMount)} 2>/dev/null | awk 'NR==2{print $3 "/" $2 " (" $5 " " $4 " free)"}'`);
        const info = (res.stdOut || '').trim();
        el.textContent = info ? '\u2014 ' + info : '';
    } catch (_) {
        el.textContent = '';
    }
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

    BK.mounted = mounted;

    if (mounted) {
        dot.className = 'conn-dot ok';
        label.textContent = t('backup.mounted') + (BK.srv?.ssdMount ? ' (' + BK.srv.ssdMount + ')' : '');
        mountBtn.style.display = 'none';
        mountBtn.disabled = false;
        unmountBtn.style.display = '';
        unmountBtn.disabled = false;
        bkFetchDiskInfo();
    } else {
        dot.className = 'conn-dot err';
        label.textContent = t('backup.notMounted') + (BK.srv?.ssdMount ? ' (' + BK.srv.ssdMount + ')' : '');
        mountBtn.style.display = '';
        mountBtn.disabled = false;
        unmountBtn.style.display = 'none';
        unmountBtn.disabled = false;
        const el = document.getElementById('bkDiskInfo');
        if (el) el.textContent = '';
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
        bkLoadBackupList();   // auto-load SSD backup list after mount
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
        const errMsg = (res.stdErr || '').trim();
        if (errMsg) bkLog(errMsg, 'warn');
        if (res.exitCode !== 0) {
            const msg = errMsg || 'umount failed';
            bkLog(t('backup.unmountFail', { msg }), 'err');
            toast(t('backup.unmountFail', { msg: msg.slice(0, 80) }), 'err');
            await bkCheckMount();
            return;
        }
        await bkCheckMount();
        BK.bkupItems = [];
        bkRenderBkupList();
        bkRenderBkupPlaceholder(t('backup.noItems'));
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
        bkRenderPlaceholder('⚠ ' + (e.message || String(e)));
    } finally {
        document.getElementById('btnBkLoad').disabled = false;
        bkRenderList();
    }
    bkFetchServerDiskInfo();
}

async function bkListDocker() {
    // docker images --format "{{.Repository}}:{{.Tag}}\t{{.Size}}"
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
    // mkdir -p so the path exists even on first run
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(BK.srv.hfHubPath)}`)
        : `mkdir -p ${bq(BK.srv.hfHubPath)}`);
    // du -sh for size info, tab-separated: size\tpath
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
    // mkdir -p so the path exists even on first run
    await execSSH(BK.srv, BK.srv.useSudo
        ? wrapSudo(BK.srv, `mkdir -p ${bq(BK.srv.ggufPath)}`)
        : `mkdir -p ${bq(BK.srv.ggufPath)}`);
    // du -sh for size info on .gguf files, tab-separated
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
    if (!BK.srv.ssdMount) { toast(t('backup.noMountPoint'), 'warn'); return; }

    if (!confirm(t('confirm.bkDeleteBkup', { count: sel.length }))) return;

    bkSetBusy(true);
    bkLog('=== Delete backup started ===', 'ok');

    try {
        for (const item of sel) {
            let filePath;
            if (BK.subTab === 'docker') {
                filePath = BK.srv.ssdMount + '/docker_backup/' + item.name;
            } else if (BK.subTab === 'hf') {
                filePath = BK.srv.ssdMount + '/huggingface_backup/' + item.name + '.tar';
            } else {
                filePath = BK.srv.ssdMount + '/gguf_backup/' + item.name;
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
    const backupDir = BK.srv.ssdMount + '/docker_backup';
    const mkdirCmd = `mkdir -p ${bq(backupDir)}`;
    const mkdirRes = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, mkdirCmd) : mkdirCmd);
    if (mkdirRes.stdErr && mkdirRes.stdErr.trim()) bkLog(mkdirRes.stdErr.trim(), 'warn');

    for (const item of sel) {
        if (!BK.busy) break;
        const fname = item.name.replace(/[/:]/g, '_') + '.tar';
        const outPath = backupDir + '/' + fname;
        bkLog('Backing up: ' + item.name + '  →  ' + fname);
        const testDkBk = `test -f ${bq(outPath)} && echo __SKIP__ || echo __RUN__`;
        const chk = await execSSH(BK.srv, BK.srv.useSudo ? wrapSudo(BK.srv, testDkBk) : testDkBk);
        if ((chk.stdOut || '').includes('__SKIP__')) {
            bkLog('  skip (already exists): ' + fname, 'warn');
            continue;
        }
        if (BK.srv.useSudo) {
            // sudo bash -c '...' so both docker and file write run under root
            const res = await execSSH(BK.srv, wrapSudo(BK.srv, `docker save ${bq(item.name)} > ${bq(outPath)}`));
            if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        } else {
            const res = await execSSH(BK.srv, `docker save -o ${bq(outPath)} ${bq(item.name)}`);
            if (res.stdErr && res.stdErr.trim()) bkLog(res.stdErr.trim(), 'warn');
        }
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
        // Extract original image name from manifest.json inside tar
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
            // sudo bash -c '...' so both file read and docker load run under root
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
    const backupDir = BK.srv.ssdMount + '/huggingface_backup';
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
    const backupDir = BK.srv.ssdMount + '/gguf_backup';
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
    if (!BK.srv.ssdMount) { toast(t('backup.noMountPoint'), 'warn'); return; }

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
        bkRenderBkupPlaceholder('⚠ ' + (e.message || String(e)));
        document.getElementById('btnBkLoadBkup').disabled = false;
        return;
    }

    document.getElementById('btnBkLoadBkup').disabled = false;
    bkRenderBkupList();
}

async function bkListDockerBackups() {
    const dir = BK.srv.ssdMount + '/docker_backup';
    // du -sh with size info, tab-separated
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
    const dir = BK.srv.ssdMount + '/huggingface_backup';
    // List model names (strip .tar extension) with sizes
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
    const dir = BK.srv.ssdMount + '/gguf_backup';
    // du -sh with size info on .gguf files
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
    if (btn) btn.textContent = collapsed ? '▲' : '▼';
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
    // Auto-load on tab switch
    if (BK.srv) {
        bkLoadList();
        if (BK.mounted) bkLoadBackupList();
    }
}
