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
    // Shift-click anchor (files mode)
    lastClickA: -1,
    lastClickB: -1,
    // Shift-click anchor (docker mode)
    lastClickDockerA: -1,
    lastClickDockerB: -1,
    // Dir size load token (cancels stale du results on navigation)
    panelTokenA: 0,
    panelTokenB: 0,
};

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
    await initColResize();

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
            const alias = BK.srv.alias;
            // 연결 확인: 서버가 꺼진 경우 선택을 초기 상태로 되돌림
            try {
                const res = await execSSH(BK.srv, 'echo __CONN_OK__');
                if (!(res.stdOut || '').includes('__CONN_OK__')) throw new Error(res.stdErr || t('misc.noResponse'));
            } catch (e) {
                BK.srv = null;
                document.getElementById('selectBk').value = '';
                editBk.disabled = true;
                dotBk.className = 'conn-dot';
                bkUpdateState();
                toast(t('toast.connFail', { alias }), 'err');
                setStatus(t('status.connFail', { alias }));
                return;
            }
            await bkCheckMount();
            dotBk.className = 'conn-dot ok';
            setStatus(t('status.connected', { alias }));
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
