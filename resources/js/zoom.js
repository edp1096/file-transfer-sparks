// ── Theme ─────────────────────────────────────────────────────────────────
const THEME_KEY = 'appTheme';

function themeApply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('btnTheme');
    if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀';
}

async function themeToggle() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    themeApply(next);
    try { await Neutralino.storage.setData(THEME_KEY, next); } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btnTheme').addEventListener('click', themeToggle);
});

Neutralino.events.on('ready', async () => {
    const osDefault = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    try {
        const saved = await Neutralino.storage.getData(THEME_KEY);
        themeApply(saved || osDefault);
    } catch {
        themeApply(osDefault);
    }
});

// ── Zoom ──────────────────────────────────────────────────────────────────
const ZOOM = {
    level: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.1,
    key: 'appZoom'
};

function zoomApply() {
    const z = ZOOM.level;
    const body = document.body;
    if (z === 1.0) {
        body.style.transform = '';
        body.style.width = '';
        body.style.height = '';
    } else {
        body.style.transformOrigin = 'top left';
        body.style.transform = `scale(${z})`;
        // 뷰포트를 벗어나지 않도록 body 크기를 역수로 보정
        body.style.width = `${(100 / z).toFixed(4)}%`;
        body.style.height = `${(100 / z).toFixed(4)}vh`;
    }
    const el = document.getElementById('zoomLabel');
    if (el) el.textContent = Math.round(z * 100) + '%';
}

async function zoomSave() {
    try { await Neutralino.storage.setData(ZOOM.key, String(ZOOM.level)); } catch {}
}

function zoomIn() {
    ZOOM.level = Math.min(ZOOM.max, parseFloat((ZOOM.level + ZOOM.step).toFixed(1)));
    zoomApply(); zoomSave();
}

function zoomOut() {
    ZOOM.level = Math.max(ZOOM.min, parseFloat((ZOOM.level - ZOOM.step).toFixed(1)));
    zoomApply(); zoomSave();
}

function zoomReset() {
    ZOOM.level = 1.0;
    zoomApply(); zoomSave();
}

// 버튼 이벤트 등록
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btnZoomOut').addEventListener('click', zoomOut);
    document.getElementById('btnZoomIn').addEventListener('click', zoomIn);
    document.getElementById('btnZoomReset').addEventListener('click', zoomReset);
});

// Neutralino 준비 후 저장된 배율 복원
Neutralino.events.on('ready', async () => {
    try {
        const saved = await Neutralino.storage.getData(ZOOM.key);
        ZOOM.level = parseFloat(saved) || 1.0;
    } catch {
        ZOOM.level = 1.0;
    }
    zoomApply();
});
