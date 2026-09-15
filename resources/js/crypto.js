"use strict";

// ============================================================
// CRYPTO  (Web Crypto API, AES-256-GCM, no external deps)
// ============================================================
async function initMasterKey() {
    // Use machine identity as salt so the encrypted file is tied to this machine
    let salt = 'DGXTransfer-salt-default';
    try {
        const u = await Desktop.os.getEnv('USERNAME');
        const c = await Desktop.os.getEnv('COMPUTERNAME');
        if (u || c) salt = 'DGXTransfer-' + (u || 'u') + '-' + (c || 'c');
    } catch (_) { }

    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        'raw', enc.encode('DGXTransfer-AES-GCM-v1'), 'PBKDF2', false, ['deriveKey']
    );
    S.masterKey = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
        baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
}

async function aesEncrypt(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, S.masterKey, new TextEncoder().encode(text)
    );
    const buf = new Uint8Array(12 + ct.byteLength);
    buf.set(iv);
    buf.set(new Uint8Array(ct), 12);
    return btoa(String.fromCharCode(...buf));
}

async function aesDecrypt(b64) {
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dec = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buf.slice(0, 12) }, S.masterKey, buf.slice(12)
    );
    return new TextDecoder().decode(dec);
}

// ============================================================
// STORAGE  — portable: saved next to the executable as servers.enc
// ============================================================
async function loadServers() {
    try {
        const raw = await Desktop.servers.read();
        return JSON.parse(await aesDecrypt(raw.trim()));
    } catch (error) {
        if (error.code === "NOT_FOUND") return [];
        throw new Error("Cannot load servers.enc; existing server settings were preserved. " + error.message);
    }
}

async function saveServers() {
    try {
        await Desktop.servers.write(await aesEncrypt(JSON.stringify(S.servers)));
    } catch (e) {
        toast(t('toast.saveFail', { msg: e.message }), 'err');
    }
}
