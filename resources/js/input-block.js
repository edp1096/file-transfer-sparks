// ── Browser default key/wheel overrides (desktop app) ─────────────────────

// Ctrl+휠 브라우저 기본 확대·축소 차단
document.addEventListener('wheel', e => {
    if (e.ctrlKey) e.preventDefault();
}, { passive: false });

// F5 / Ctrl+R 새로고침 차단
document.addEventListener('keydown', e => {
    if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) e.preventDefault();
});

// 우클릭 컨텍스트 메뉴 차단
document.addEventListener('contextmenu', e => e.preventDefault());
