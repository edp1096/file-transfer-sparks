"use strict";

// One keyboard cursor per list. Selection stays in the existing application models.
// Names, rather than row indices, keep the cursor and range anchor stable after sorting.
const ListNavigation = (() => {
    const lists = new Map();
    const visible = el => !!el?.getClientRects().length;
    const modalOpen = () => !!document.querySelector('.modal-overlay.open');
    const editing = target => !!target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]');

    function attach(id, options) {
        if (lists.has(id)) return lists.get(id);
        const el = document.getElementById(id);
        const state = { cursor: null, anchor: null, context: null, rangeBase: null, rangeAdd: false, loading: false, index: 0 };
        const remembered = new Map();
        let scrollOnFocus = true;
        el.tabIndex = 0;
        el.setAttribute('role', 'listbox');
        el.setAttribute('aria-multiselectable', 'true');
        el.setAttribute('aria-describedby', 'keyboardListHint');
        const rows = () => [...el.querySelectorAll('[data-name]')];
        const keys = () => rows().map(row => row.dataset.name);
        const clearRange = () => { state.rangeBase = null; };
        function context() {
            const next = options.context();
            if (state.context === next) return;
            if (state.context !== null) remembered.set(state.context, state.cursor);
            if (remembered.size > 128) remembered.delete(remembered.keys().next().value);
            state.context = next;
            state.loading = false; state.index = 0; el.removeAttribute('aria-busy');
            state.cursor = remembered.get(next) ?? null;
            state.anchor = null;
            clearRange();
            options.setSelection(new Set());
        }
        function paint(scroll = false) {
            const selected = options.selection();
            let active;
            rows().forEach((row, index) => {
                const key = row.dataset.name, checked = selected.has(key);
                row.id = `${id}-row-${index}`;
                row.setAttribute('role', 'option');
                row.setAttribute('aria-selected', String(checked));
                row.setAttribute('aria-label', key);
                row.classList.toggle('selected', checked);
                row.classList.toggle('keyboard-cursor', state.cursor === key);
                const checkbox = row.querySelector('input[type="checkbox"]');
                if (checkbox) {
                    checkbox.checked = checked;
                    checkbox.tabIndex = -1;
                    checkbox.setAttribute('aria-hidden', 'true');
                }
                if (state.cursor === key) { active = row; state.index = index; }
            });
            if (active && !state.loading) el.setAttribute('aria-activedescendant', active.id);
            else el.removeAttribute('aria-activedescendant');
            el.setAttribute('aria-label', options.label());
            if (options.all) {
                const all = document.getElementById(options.all);
                const count = rows().length;
                all.checked = count > 0 && selected.size === count;
                all.indeterminate = selected.size > 0 && selected.size < count;
                all.disabled = state.loading || options.locked() || !count;
            }
            // Scroll only the list, accounting for the application's CSS zoom transform.
            if (scroll && active && document.activeElement === el) {
                const listRect = el.getBoundingClientRect(), rect = active.getBoundingClientRect();
                const scale = listRect.height / (el.offsetHeight || 1) || 1;
                if (rect.top < listRect.top) el.scrollTop -= (listRect.top - rect.top) / scale;
                else if (rect.bottom > listRect.bottom) el.scrollTop += (rect.bottom - listRect.bottom) / scale;
            }
            options.changed();
        }
        function sync(scroll = document.activeElement === el) {
            context();
            const order = keys(), available = new Set(order);
            options.setSelection(new Set([...options.selection()].filter(key => available.has(key))));
            if (state.rangeBase) state.rangeBase = new Set([...state.rangeBase].filter(key => available.has(key)));
            if (!state.loading) {
                if (!available.has(state.cursor)) state.cursor = order.find(key => options.selection().has(key)) ?? order[Math.min(state.index, order.length - 1)] ?? null;
                if (!available.has(state.anchor)) { state.anchor = state.cursor; clearRange(); }
            }
            paint(scroll);
        }
        function select(key, { shift = false, additive = false, toggle = false } = {}) {
            const order = keys();
            if (!order.includes(key) || state.loading || options.locked()) return;
            let selected = new Set(options.selection());
            if (shift) {
                if (!order.includes(state.anchor)) state.anchor = state.cursor ?? key;
                if (state.rangeBase === null || state.rangeAdd !== additive) {
                    state.rangeBase = additive ? new Set(selected) : new Set();
                    state.rangeAdd = additive;
                }
                selected = new Set(state.rangeBase);
                const a = order.indexOf(state.anchor), b = order.indexOf(key);
                for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(order[i]);
            } else {
                clearRange(); state.anchor = key;
                if (toggle) { if (selected.has(key)) selected.delete(key); else selected.add(key); }
                else selected = new Set([key]);
            }
            options.setSelection(selected);
        }
        function focus(scroll = true) {
            if (!visible(el) || modalOpen()) return;
            sync(false);
            scrollOnFocus = scroll;
            el.focus({ preventScroll: true });
            scrollOnFocus = true;
            paint(scroll);
        }
        function all(checked) {
            if (state.loading || options.locked()) { paint(); return; }
            clearRange(); state.anchor = state.cursor;
            options.setSelection(new Set(checked ? keys() : [])); paint();
        }
        const api = {
            el, state, sync, focus, all,
            beginLoad() { context(); state.loading = true; state.anchor = state.cursor; clearRange(); el.setAttribute('aria-busy', 'true'); el.removeAttribute('aria-activedescendant'); },
            finishLoad() { state.loading = false; el.removeAttribute('aria-busy'); sync(); },
            setCursor(key) { state.cursor = key; state.anchor = key; clearRange(); },
        };
        lists.set(id, api);
        el.addEventListener('focus', () => { sync(false); paint(scrollOnFocus); options.focused?.(); });
        // Keep native checkbox focus out of the Tab order; the model owns selection.
        el.addEventListener('mousedown', event => {
            if (event.button !== 0 || modalOpen() || editing(event.target)) return;
            event.preventDefault(); focus(false);
        });
        el.addEventListener('click', event => {
            if (modalOpen() || state.loading || editing(event.target)) return;
            const row = event.target.closest('[data-name]');
            focus(false);
            if (!row || !el.contains(row)) { all(false); return; }
            const key = row.dataset.name;
            select(key, { shift: event.shiftKey, additive: event.ctrlKey || event.metaKey,
                toggle: event.ctrlKey || event.metaKey || event.target.matches('input[type="checkbox"]') });
            state.cursor = key; paint();
        });
        el.addEventListener('dblclick', event => {
            if (event.target.matches('input') || event.ctrlKey || event.metaKey || event.shiftKey || state.loading || options.locked() || modalOpen()) return;
            const row = event.target.closest('[data-name]');
            if (row && el.contains(row)) options.open?.(row.dataset.name);
        });
        el.addEventListener('keydown', event => {
            if (editing(event.target) || modalOpen() || event.altKey) return;
            const ctrl = event.ctrlKey || event.metaKey;
            const space = event.code === 'Space' || event.key === ' ';
            if (event.isComposing && !(ctrl && space)) return;
            const key = event.key;
            const selectAll = ctrl && (event.code === 'KeyA' || key.toLowerCase() === 'a');
            if (key === 'ArrowLeft' || key === 'ArrowRight') {
                event.preventDefault(); event.stopPropagation();
                lists.get(key === 'ArrowLeft' ? options.left : options.right)?.focus(); return;
            }
            const movement = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key);
            if (!movement && !space && key !== 'Escape' && !selectAll && !['Enter', 'Backspace', 'Delete'].includes(key)) return;
            event.preventDefault(); event.stopPropagation();
            if (state.loading) return;
            if (key === 'Escape' || (selectAll && event.shiftKey)) { all(false); return; }
            if (selectAll) { all(true); return; }
            if (movement) {
                const order = keys(); if (!order.length) return;
                const index = order.indexOf(state.cursor), down = key === 'ArrowDown' || key === 'PageDown';
                let next = index < 0 ? (down ? 0 : order.length - 1) : index + (down ? 1 : -1);
                if (key === 'Home') next = 0;
                else if (key === 'End') next = order.length - 1;
                else if (key === 'PageDown' || key === 'PageUp') {
                    const rowHeight = rows()[Math.max(0, index)]?.offsetHeight || 26;
                    next = Math.max(0, index) + (down ? 1 : -1) * Math.max(1, Math.floor(el.clientHeight / rowHeight) - 1);
                }
                const target = order[Math.max(0, Math.min(order.length - 1, next))];
                if (!ctrl || event.shiftKey) select(target, { shift: event.shiftKey, additive: ctrl });
                else clearRange();
                state.cursor = target; paint(true); return;
            }
            if (event.repeat || options.locked()) return;
            if (space && state.cursor !== null) {
                select(state.cursor, { shift: event.shiftKey, additive: ctrl, toggle: !event.shiftKey }); paint();
            } else if (!ctrl && !event.shiftKey) {
                if (key === 'Enter' && state.cursor !== null) options.open?.(state.cursor);
                else if (key === 'Backspace') options.parent?.();
                else if (key === 'Delete' && options.selection().size) options.remove?.();
            }
        });
        return api;
    }
    return { attach, get: id => lists.get(id), visible, editing, modalOpen };
})();
