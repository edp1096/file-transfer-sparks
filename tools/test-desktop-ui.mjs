// Node 22+, Chrome/Chromium/Edge. Runs against the actual Go server in a temporary directory.
import assert from 'node:assert/strict';
import { runKeyboardChecks } from './keyboard-checks.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pbkdf2Sync, createCipheriv, randomBytes } from 'node:crypto';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sparks-desktop-ui-'));
const profile = path.join(temp, 'chrome');
const dataDir = path.join(temp, 'app data');
const binary = path.resolve('bin/file-transfer-sparks' + (process.platform === 'win32' ? '.exe' : ''));
let app, browser, socket, call, evaluate;
const errors = [];
const stop = async process => {
    if (!process || process.exitCode !== null || process.signalCode !== null) return;
    const exited = once(process, 'exit'); process.kill(); await exited;
};
const waitFor = async (fn, label, attempts = 100) => {
    for (let i = 0; i < attempts; i++) { if (await fn()) return; await delay(100); }
    throw new Error('Timed out: ' + label);
};
try {
    await fs.mkdir(path.join(dataDir, '.storage'), { recursive: true });
    for (const [key, value] of Object.entries({ lang: 'ko', appTheme: 'light', appZoom: '1.15', bkLogVisible: '0', panelSort: JSON.stringify({ A: { col: 'size', dir: -1 } }) })) {
        await fs.writeFile(path.join(dataDir, '.storage', key + '.neustorage'), value);
    }
    const servers = [{ id: 1, alias: '기존 Spark', sshHost: '127.0.0.1', qsfpHost: '127.0.0.1', port: 22, username: 'test', authType: 'PASSWORD', credential: 'space & $value "한글"', ssds: [] }];
    const u = process.env.USERNAME || '', c = process.env.COMPUTERNAME || '';
    const salt = u || c ? `DGXTransfer-${u || 'u'}-${c || 'c'}` : 'DGXTransfer-salt-default';
    const key = pbkdf2Sync('DGXTransfer-AES-GCM-v1', salt, 100000, 32, 'sha256');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify(servers)), cipher.final(), cipher.getAuthTag()]).toString('base64');
    await fs.writeFile(path.join(dataDir, 'servers.enc'), encrypted);
    app = spawn(binary, ['--no-browser', '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', appError = '';
    app.stdout.on('data', b => output += b); app.stderr.on('data', b => appError += b);
    await waitFor(() => output.includes('\n'), 'Go server startup: ' + appError);
    const url = output.trim().split('\n')[0];
    browser = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--window-size=1024,1088', '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let port;
    await waitFor(async () => { try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return port; } catch { return false; } }, 'Chrome startup');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await once(socket, 'open');
    let sequence = 0, loads = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
        const m = JSON.parse(event.data);
        if (m.method === 'Page.loadEventFired') loads++;
        if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    });
    call = async (method, params = {}) => {
        const id = ++sequence;
        let timer;
        try {
            const response = await Promise.race([
                new Promise(resolve => { pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(method + ' timed out')), 15000); })
            ]);
            assert.ok(!response.error, JSON.stringify(response.error));
            return response.result;
        } finally { clearTimeout(timer); pending.delete(id); }
    };
    evaluate = async expression => {
        const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value;
    };
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable');
    const reload = async () => { const before = loads; await call('Page.reload'); await waitFor(() => loads > before, 'page load'); };
    await call('Page.navigate', { url });
    await waitFor(() => evaluate(`typeof S !== 'undefined' && !!document.getElementById('btnAddServer').onclick`), 'UI initialization');
    assert.deepEqual(await evaluate(`({lang:document.documentElement.lang,theme:document.documentElement.dataset.theme,zoom:ZOOM.level,servers:S.servers,sort:S.sortA})`), {
        lang: 'ko', theme: 'light', zoom: 1.15, servers, sort: { col: 'size', dir: -1 }
    });
    assert.equal(await evaluate(`typeof Neutralino`), 'undefined');
    assert.equal(await evaluate(`location.hash`), '');
    await evaluate(`document.getElementById('btnAddServer').click()`);
    assert.equal(await evaluate(`document.getElementById('serverModal').classList.contains('open')`), true);
    await evaluate(`document.getElementById('fAlias').value='New Spark';document.getElementById('fSshHost').value='localhost';document.getElementById('fQsfpHost').value='127.0.0.1';document.getElementById('fUsername').value='test';saveServer()`);
    assert.equal(await evaluate('S.servers.length'), 2);
    await evaluate(`setLang('en')`); await evaluate('themeToggle()'); await evaluate('zoomIn(); zoomSave()');
    await evaluate(`document.getElementById('tabBackup').click();document.getElementById('bkTabGGUF').click()`);
    assert.equal(await evaluate('BK.subTab'), 'gguf');
    await evaluate(`document.getElementById('tabFileTransfer').click()`);

    // Execute argv through the real Go service (no local shell expansion).
    const args = ['space & $HOME `x` "한글"', 'C:\\Program Files\\key'];
    const result = await evaluate(`Desktop.os.execCommand(${JSON.stringify({ executable: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1))); console.error("stderr"); process.exitCode=7;', ...args] })})`);
    assert.deepEqual(JSON.parse(result.stdOut), args); assert.equal(result.stdErr, 'stderr\n'); assert.equal(result.exitCode, 7);
    const cmd = await evaluate(`buildSSH(S.servers[0], 'echo "$HOME" | cat')`);
    assert.equal(cmd.args[3], servers[0].credential);
    assert.equal(Buffer.from(cmd.args[7], 'base64').toString(), 'echo "$HOME" | cat');

    // Fast process exit must be observed after the spawn promise and all output.
    const command = { executable: process.execPath, args: ['-e', 'process.stdout.write("ok\\n"); process.stderr.write("42\\n");process.exitCode=9;'] };
    const events = await evaluate(`(async()=>{
        const order=[];let pid;
        const done=new Promise(resolve=>Desktop.events.on('spawnedProcess',e=>{if(e.detail.id===pid){order.push(e.detail);if(e.detail.action==='exit')resolve(order);}}));
        const p=await Desktop.os.spawnProcess(${JSON.stringify(command)});pid=p.id;order.push('started');return done;
    })()`);
    assert.equal(events[0], 'started'); assert.equal(events.at(-1).action, 'exit'); assert.equal(events.at(-1).data, '9');
    assert.equal(events.filter(e => e.action === 'stdErr').map(e => e.data).join(''), '42\n');

    // Real file transfer through local tar/nc; only SSH transport is replaced.
    // All files are isolated and no real server credentials or remote hosts are used.
    if (process.platform !== 'win32') {
        const src = path.join(temp, 'source files'), dst = path.join(temp, 'destination files');
        await fs.mkdir(path.join(src, 'folder'), { recursive: true }); await fs.mkdir(dst);
        await fs.writeFile(path.join(src, 'folder', '한글 $file.txt'), 'nested transfer payload\n');
        await evaluate(`window.originalBuildSSH=buildSSH;buildSSH=(srv,command)=>({shell:command});
            S.srvA={id:101,alias:'source',qsfpHost:'127.0.0.1'};S.srvB={id:102,alias:'destination',qsfpHost:'127.0.0.1'};
            S.pathA=${JSON.stringify(src)};S.pathB=${JSON.stringify(dst)};S.selA=new Set(['folder']);S.panelModeA='files';S.panelModeB='files';
            startTransfer('AB')`);
        await waitFor(() => evaluate(`S.senderExitCode===0 && S.recvExitCode===0`), 'local tar/nc transfer');
        assert.equal(await fs.readFile(path.join(dst, 'folder', '한글 $file.txt'), 'utf8'), 'nested transfer payload\n');
        await waitFor(() => evaluate('!S.busy'), 'transfer completion');
        // Exercise unchanged HF/GGUF backup and restore through the Go command API.
        const mount = path.join(temp, 'external SSD'), hf = path.join(temp, 'HF hub'), gguf = path.join(temp, 'GGUF models');
        await fs.mkdir(path.join(hf, 'models--test'), { recursive: true }); await fs.mkdir(gguf);
        await fs.writeFile(path.join(hf, 'models--test', 'weights.bin'), 'HF payload');
        await fs.writeFile(path.join(gguf, 'test model.gguf'), 'GGUF payload');
        await evaluate(`BK.srv={hfHubPath:${JSON.stringify(hf)},ggufPath:${JSON.stringify(gguf)}};BK.ssdStates=[{mount:${JSON.stringify(mount)},mounted:true}];BK.activeSsdIdx=0;BK.busy=true;
            (async()=>{await bkBackupHF([{name:'models--test'}]);await bkBackupGGUF([{name:'test model.gguf'}]);BK.busy=false;})()`);
        assert.equal(await fs.readFile(path.join(mount, 'gguf_backup', 'test model.gguf'), 'utf8'), 'GGUF payload');
        await fs.rm(path.join(hf, 'models--test'), { recursive: true }); await fs.rm(path.join(gguf, 'test model.gguf'));
        await evaluate(`BK.busy=true;(async()=>{await bkRestoreHF([{name:'models--test'}]);await bkRestoreGGUF([{name:'test model.gguf'}]);BK.busy=false;})()`);
        assert.equal(await fs.readFile(path.join(hf, 'models--test', 'weights.bin'), 'utf8'), 'HF payload');
        assert.equal(await fs.readFile(path.join(gguf, 'test model.gguf'), 'utf8'), 'GGUF payload');
        // Receiver failure must abort before starting a sender and release busy state.
        await evaluate(`window.localBuildSSH=buildSSH;buildSSH=(srv,cmd)=>cmd.includes('nc -l')&&cmd.includes('tar -xf')?{executable:${JSON.stringify(process.execPath)},args:['-e','process.exit(55)']}:window.localBuildSSH(srv,cmd);S.selA=new Set(['folder']);startTransfer('AB')`);
        await waitFor(() => evaluate(`!S.busy`), 'receiver failure cleanup');
        assert.equal(await evaluate('S.senderPid'), null);
        await evaluate('buildSSH=window.localBuildSSH');
        // Cancellation while size discovery is unresolved must not start a receiver.
        assert.equal(await evaluate(`(async()=>{
            const originalSize=getTransferSize,originalSpawn=Desktop.os.spawnProcess;let release,spawns=0;
            getTransferSize=()=>new Promise(resolve=>release=resolve);Desktop.os.spawnProcess=async()=>{spawns++;throw Error('unexpected spawn')};
            S.selA=new Set(['folder']);const pending=startTransfer('AB');await cancelTransfer();release(1);await pending;
            getTransferSize=originalSize;Desktop.os.spawnProcess=originalSpawn;buildSSH=window.originalBuildSSH;return spawns;
        })()`), 0);
    }
    await runKeyboardChecks({ call, evaluate, waitFor });
    // Settings persist through page reload (new connection).
    await reload();
    await waitFor(() => evaluate(`typeof S!=='undefined' && S.servers.length===2 && !!document.getElementById('btnAddServer').onclick`), 'reload');
    assert.deepEqual(await evaluate(`({lang:document.documentElement.lang,theme:document.documentElement.dataset.theme,zoom:ZOOM.level})`), { lang: 'en', theme: 'dark', zoom: 1.2 });
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    await fs.mkdir('.tmp', { recursive: true }); await fs.writeFile('.tmp/desktop-ui.png', Buffer.from(shot.data, 'base64'));
    assert.deepEqual(errors, [], 'Unexpected browser errors');
    // Corrupt legacy data must be preserved and block the editing UI.
    await fs.writeFile(path.join(dataDir, 'servers.enc'), 'corrupt-fixture');
    await reload();
    await waitFor(() => evaluate(`!!document.getElementById('desktopError')`), 'corrupt server file error');
    assert.match(await evaluate(`document.getElementById('desktopError').textContent`), /Cannot load servers.enc/);
    assert.equal(await fs.readFile(path.join(dataDir, 'servers.enc'), 'utf8'), 'corrupt-fixture');
    if (process.platform !== 'win32') {
        // Exercise the production browser launcher and default executable-relative data path.
        socket.close(); await stop(browser); await stop(app);
        await fs.writeFile(path.join(dataDir, 'servers.enc'), encrypted);
        const installed = path.join(dataDir, 'file-transfer-sparks');
        await fs.copyFile(binary, installed); await fs.chmod(installed, 0o755);
        const wrapper = path.join(temp, 'headless browser');
        const captured = path.join(temp, 'browser-args.json');
        const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
        await fs.writeFile(wrapper, '#!/bin/sh\n' +
            `${quote(process.execPath)} -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${quote(captured)} "$@"\n` +
            `exec ${quote(process.env.CHROME || 'google-chrome')} --headless=new --remote-debugging-port=0 "$@"\n`, { mode: 0o755 });
        app = spawn(installed, ['--browser', wrapper], { cwd: temp, stdio: 'ignore' });
        let launchArgs;
        await waitFor(async () => { try { launchArgs = JSON.parse(await fs.readFile(captured, 'utf8')); return true; } catch { return false; } }, 'production browser launch');
        const managedProfile = launchArgs.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
        assert.ok(launchArgs.some(arg => arg.startsWith('--app=http://127.0.0.1:')));
        let managedPort;
        await waitFor(async () => { try { managedPort = (await fs.readFile(path.join(managedProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return managedPort; } catch { return false; } }, 'managed Chrome');
        const managedPages = await (await fetch(`http://127.0.0.1:${managedPort}/json`)).json();
        const managedSocket = new WebSocket(managedPages.find(p => p.type === 'page').webSocketDebuggerUrl);
        await once(managedSocket, 'open');
        let managedID = 0;
        const managedEval = expression => new Promise(resolve => {
            const id = ++managedID;
            const listener = event => { const m = JSON.parse(event.data); if (m.id === id) { managedSocket.removeEventListener('message', listener); resolve(m.result?.result?.value); } };
            managedSocket.addEventListener('message', listener);
            managedSocket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        });
        await waitFor(() => managedEval(`typeof S !== 'undefined' && S.servers.length === 1 && !!document.getElementById('btnAddServer').onclick`), 'production app initialization');
        managedSocket.send(JSON.stringify({ id: ++managedID, method: 'Browser.close' }));
        await waitFor(() => app.exitCode !== null, 'app exits with browser');
        assert.equal(app.exitCode, 0);
        await assert.rejects(fs.stat(managedProfile), { code: 'ENOENT' });
    }
    console.log('PASS: legacy settings/encryption, UI controls, argv, process events, local tar/nc transfer, HF/GGUF backup/restore, receiver failure, preparation cancellation, reload, corrupt-file preservation and production browser launch/close');
} finally {
    socket?.close(); await stop(browser); await stop(app); await fs.rm(temp, { recursive: true, force: true });
}
