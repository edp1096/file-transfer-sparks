"use strict";

function syncKeyboardTabs() {
    for (const selector of ['.tab-bar .tab-btn', '.bk-subtab-bar .bk-subtab']) {
        const bar = document.querySelector(selector)?.parentElement;
        if (bar) bar.setAttribute('aria-label', selector.startsWith('.tab-bar') ? t('keyboard.views') : t('keyboard.models'));
        document.querySelectorAll(selector).forEach(button => {
            const active = button.classList.contains('active');
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        });
    }
}

function initKeyboardNavigation() {
    const fileIDs = ['listA', 'listB'], backupIDs = ['bkList', 'bkBkupList'];
    let lastFile = 'listA', lastBackup = 'bkList';
    const activeIDs = () => ListNavigation.visible(document.getElementById('main')) ? fileIDs : backupIDs;
    const focusActiveList = () => {
        const preferred = activeIDs() === fileIDs ? lastFile : lastBackup;
        const target = [preferred, ...activeIDs()].map(id => ListNavigation.get(id)).find(nav => ListNavigation.visible(nav?.el));
        if (target) target.focus();
        else document.getElementById('selectBk').focus();
    };
    for (const id of [...fileIDs, ...backupIDs]) {
        const el = document.getElementById(id);
        el.addEventListener('focus', () => { if (fileIDs.includes(id)) lastFile = id; else lastBackup = id; });
        const panel = el.closest('.file-panel, .bk-list-pane');
        panel.addEventListener('keydown', event => {
            if (event.key !== 'ArrowDown' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ListNavigation.modalOpen() || !event.target.closest('button')) return;
            event.preventDefault(); ListNavigation.get(id).focus();
        });
    }
    for (const selector of ['.tab-bar', '.bk-subtab-bar']) {
        const bar = document.querySelector(selector);
        bar.setAttribute('role', 'tablist');
        bar.addEventListener('keydown', event => {
            if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ListNavigation.modalOpen()) return;
            const tabs = [...bar.querySelectorAll('button:not(:disabled)')];
            if (!tabs.includes(event.target)) return;
            if (event.key === 'ArrowDown') { event.preventDefault(); focusActiveList(); return; }
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = tabs.indexOf(event.target);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next].click(); tabs[next].focus();
        });
    }
    document.getElementById('header').addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ListNavigation.modalOpen() || !event.target.matches('button') || event.target.closest('.tab-bar')) return;
        event.preventDefault(); focusActiveList();
    });
    document.addEventListener('keydown', event => {
        if (event.isComposing || ListNavigation.modalOpen() || ListNavigation.editing(event.target) || event.altKey) return;
        const ctrl = event.ctrlKey || event.metaKey;
        if (ctrl && event.key === 'Tab') {
            event.preventDefault();
            if (event.repeat) return;
            switchTab(activeIDs() === fileIDs ? 'backup' : 'file');
            focusActiveList(); return;
        }
        if (event.key === 'F5' || (ctrl && (event.code === 'KeyR' || event.key.toLowerCase() === 'r'))) {
            event.preventDefault();
            if (event.repeat || event.shiftKey) return;
            if (activeIDs() === fileIDs) {
                if (!S.busy && !S.deleting) for (const side of ['A', 'B']) { loadPanel(side); loadPanelDiskInfo(side); }
            } else if (!BK.busy) {
                bkLoadList(); bkLoadBackupList();
            }
        }
    });
    // Dialogs retain keyboard focus and restore it to the invoking control/list.
    const returns = new Map();
    const modalElements = () => [...document.querySelectorAll('.modal-overlay.open')];
    const controls = modal => [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(ListNavigation.visible);
    const focusModal = modal => (controls(modal)[0] || modal).focus();
    document.querySelectorAll('.modal-overlay').forEach(modal => {
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.tabIndex = -1;
        const title = modal.querySelector('.modal-title, .about-name');
        if (title) { title.id ||= modal.id + 'Title'; modal.setAttribute('aria-labelledby', title.id); }
        new MutationObserver(() => {
            if (modal.classList.contains('open')) {
                if (!returns.has(modal)) { returns.set(modal, document.activeElement); focusModal(modal); }
            } else if (returns.has(modal)) {
                const previous = returns.get(modal); returns.delete(modal);
                if (!modalElements().length && previous?.isConnected && ListNavigation.visible(previous)) previous.focus({ preventScroll: true });
            }
        }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    });
    document.addEventListener('keydown', event => {
        const modal = modalElements().at(-1);
        if (!modal || event.isComposing) return;
        if (event.key === 'Escape') {
            event.preventDefault(); event.stopImmediatePropagation(); modal.classList.remove('open');
        } else if (event.key === 'Tab') {
            const items = controls(modal), index = items.indexOf(document.activeElement);
            event.preventDefault(); event.stopImmediatePropagation();
            if (!items.length) modal.focus();
            else items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length].focus();
        }
    }, true);
    document.addEventListener('focusin', event => {
        const modal = modalElements().at(-1);
        if (modal && !modal.contains(event.target)) focusModal(modal);
    });
    const help = document.getElementById('keyboardHelpModal');
    document.getElementById('btnKeyboardHelp').onclick = () => help.classList.add('open');
    document.getElementById('btnKeyboardHelpClose').onclick = () => help.classList.remove('open');
    help.onclick = event => { if (event.target === help) help.classList.remove('open'); };
    syncKeyboardTabs();
}
