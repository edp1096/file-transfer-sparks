"use strict";

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
