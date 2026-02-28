"use strict";

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
    if (side === 'A') S.lastClickDockerA = -1; else S.lastClickDockerB = -1;

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
            const idx = parseInt(row.dataset.dockerIdx);
            const name = row.dataset.name;
            const sel = side === 'A' ? S.selA : S.selB;
            const chk = row.querySelector('input[type="checkbox"]');
            const lastClick = side === 'A' ? S.lastClickDockerA : S.lastClickDockerB;

            if (e.shiftKey && lastClick >= 0) {
                const imgs = side === 'A' ? S.dockerA : S.dockerB;
                const lo = Math.min(idx, lastClick), hi = Math.max(idx, lastClick);
                for (let i = lo; i <= hi; i++) sel.add(imgs[i].name);
                renderDockerList(side);
            } else {
                if (side === 'A') S.lastClickDockerA = idx; else S.lastClickDockerB = idx;
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
    });
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
        loadPanelDiskInfo(side);
    }
    setStatus(t('status.readyHint'));
}

// ============================================================
// SELECT ALL
// ============================================================
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
// COLUMN RESIZE
// ============================================================
async function initColResize() {
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

    // Load saved column widths
    try { applyColWidths(JSON.parse(await Neutralino.storage.getData(COL_KEY))); } catch {}

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
}
