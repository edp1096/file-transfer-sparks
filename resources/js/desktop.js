"use strict";

// Local Go service. The launch capability stays in this window's session storage;
// it is never written to application settings or included in HTTP resource URLs.
const Desktop = (() => {
    const handlers = new Map(), pending = new Map();
    let socket, sequence = 0, initialized = false;
    let token = location.hash.slice(1) || sessionStorage.getItem('desktopToken');
    if (token) sessionStorage.setItem('desktopToken', token);
    history.replaceState(null, '', location.pathname);
    const emit = (name, detail) => {
        for (const fn of handlers.get(name) || []) {
            Promise.resolve().then(() => fn({ detail })).catch(fatal);
        }
    };
    function fatal(error) {
        console.error(error);
        let box = document.getElementById('desktopError');
        if (!box) {
            box = document.createElement('div'); box.id = 'desktopError';
            box.setAttribute('role', 'alert');
            Object.assign(box.style, { position: 'fixed', inset: '0', zIndex: '100000', background: '#181b22', color: '#fff', padding: '48px', whiteSpace: 'pre-wrap' });
            document.body.appendChild(box);
        }
        box.textContent = 'Application connection failed / 앱 연결 오류\n\n' + (error.message || error) + '\n\nClose and reopen the application. / 앱을 닫고 다시 실행하세요.';
    }
    function call(method, params = {}) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Desktop service disconnected'));
        return new Promise((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
        });
    }
    const api = {
        platform: '',
        events: { on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); } },
        storage: {
            getData: key => call('storage.get', { key }),
            setData: (key, data) => call('storage.set', { key, data })
        },
        servers: { read: () => call('servers.read'), write: data => call('servers.write', { data }) },
        os: {
            getEnv: name => call('env', { name }),
            execCommand: command => call('exec', { command }),
            spawnProcess: command => call('spawn', { command }),
            updateSpawnedProcess: id => call('kill', { id }),
            open: () => call('openRepository')
        },
        app: { getConfig: () => call('config') },
        init() {
            if (initialized) return;
            initialized = true;
            const start = () => {
                if (!token) { fatal(new Error('Missing launch token')); return; }
                socket = new WebSocket(`ws://${location.host}/api/ws?token=${encodeURIComponent(token)}`);
                socket.onmessage = e => {
                    const message = JSON.parse(e.data);
                    if (message.event) { emit(message.event, message.detail); return; }
                    const waiter = pending.get(message.id);
                    if (!waiter) return;
                    pending.delete(message.id);
                    if (message.error) { const err = new Error(message.error); err.code = message.code; waiter.reject(err); }
                    else waiter.resolve(message.result);
                };
                socket.onopen = async () => {
                    try {
                        const config = await call('config'); api.platform = config.os;
                        emit('ready');
                        let last = '';
                        const saveWindow = () => {
                            const g = { width: outerWidth, height: outerHeight, x: screenX, y: screenY };
                            const raw = JSON.stringify(g);
                            if (g.width >= 320 && g.height >= 240 && raw !== last) {
                                last = raw; api.storage.setData('window', raw).catch(console.error);
                            }
                        };
                        setInterval(saveWindow, 1000);
                        window.addEventListener('resize', saveWindow);
                    } catch (err) { fatal(err); }
                };
                socket.onclose = () => {
                    const err = new Error('Desktop service disconnected; running local processes have been stopped.');
                    for (const p of pending.values()) p.reject(err);
                    pending.clear(); fatal(err);
                };
                window.addEventListener('beforeunload', event => {
                    if ((typeof S !== 'undefined' && S.busy) || (typeof BK !== 'undefined' && BK.busy)) {
                        event.preventDefault(); event.returnValue = '';
                    }
                });
            };
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
            else start();
        }
    };
    return api;
})();
