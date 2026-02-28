"use strict";

// ============================================================
// SSH COMMAND BUILDER
// ============================================================
function sshPrefix(srv) {
    const opts = `-o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=30 -p ${srv.port}`;
    if (srv.authType === 'KEY') {
        // Normalize backslashes so OpenSSH on Windows accepts the path
        const kp = srv.keyPath.replace(/\\/g, '/');
        return `ssh ${opts} -i "${kp}"`;
    }
    // AGENT: rely on system SSH agent, no extra flags needed
    return `ssh ${opts}`;
}

// Encode remote command as base64 so Windows cmd.exe / PowerShell
// cannot interpret shell metacharacters ( | & > < ( ) $ ` etc.)
// Base64 alphabet [A-Za-z0-9+/=] contains no cmd.exe special chars.
function b64cmd(remoteCmd) {
    return btoa(unescape(encodeURIComponent(remoteCmd)));
}

function buildSSH(srv, remoteCmd) {
    if (srv.authType === 'PASSWORD') {
        // Use -b64cmd flag: base64-encoded command bypasses all Windows shell quoting issues
        const bin = srv.clientPath || (NL_OS === 'Windows' ? '.\\ssh-client.exe' : './ssh-client');
        return `${bin} -l ${srv.username} -passwd ${srv.credential || ''} -p ${srv.port} -b64cmd ${b64cmd(remoteCmd)} ${srv.sshHost}`;
    }

    if (srv.authType === 'CUSTOM') {
        // Full command template — placeholders replaced verbatim:
        //   {USERNAME} {PASSWD} {PORT} {HOST} {CMD}
        const escaped = remoteCmd.replace(/"/g, '\\"');
        return (srv.customPrefix || '')
            .replace('{USERNAME}', srv.username)
            .replace('{PASSWD}', srv.credential || '')
            .replace('{PORT}', String(srv.port))
            .replace('{HOST}', srv.sshHost)
            .replace('{CMD}', `"${escaped}"`);
    }

    // Standard SSH — AGENT or KEY
    const escaped = remoteCmd.replace(/"/g, '\\"');
    return `${sshPrefix(srv)} ${srv.username}@${srv.sshHost} "${escaped}"`;
}

// Wrap a remote command with sudo. Uses the login password via echo | sudo -S.
// For sender (tar reads files): echo passwd | sudo -S tar ... | pv | nc
// For receiver (tar writes files): echo passwd | sudo -S bash -c "nc | tar"
function wrapSudo(srv, cmd) {
    const passwd = String(srv.credential || '').replace(/'/g, "'\\''");
    return `echo '${passwd}' | sudo -S bash -c ${bq(cmd)}`;
}

// Shell-safe single-quote wrap for remote bash arguments
function bq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

async function execSSH(srv, cmd) {
    return Neutralino.os.execCommand(buildSSH(srv, cmd));
}

// ============================================================
// FILE LISTING
// ============================================================
function parseLs(output) {
    const entries = [];
    for (const line of output.split('\n')) {
        if (!line.trim() || line.startsWith('total ')) continue;
        // ls -la --time-style=+%s : permissions links owner group size unixtimestamp name
        const m = line.match(/^([dl\-scbp][rwxsStTl\-]+)\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const [, perms, size, mtime, rawName] = m;
        const isLink = perms[0] === 'l';
        const isDir = perms[0] === 'd';
        const name = isLink ? rawName.split(' -> ')[0].trim() : rawName;
        if (name === '.' || name === '..') continue;
        entries.push({ name, isDir, isLink, size: parseInt(size) || 0, mtime: parseInt(mtime) || 0 });
    }
    entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return entries;
}

async function listRemote(srv, path) {
    const res = await execSSH(srv, `ls -la --time-style=+%s ${bq(path)} 2>&1`);
    const out = res.stdOut || '';
    if (!out.trim()) {
        throw new Error((res.stdErr || t('misc.noResponse')).trim().slice(0, 120));
    }
    return parseLs(out);
}

async function getHomeDir(srv) {
    const res = await execSSH(srv, 'echo $HOME');
    const out = (res.stdOut || '').trim();
    if (!out) throw new Error((res.stdErr || t('misc.noResponse')).trim().slice(0, 120));
    return out;
}

async function getTransferSize(srv, paths) {
    const q = paths.map(bq).join(' ');
    const res = await execSSH(srv, `du -sb ${q} 2>/dev/null | awk '{s+=$1}END{print s+0}'`);
    return parseInt((res.stdOut || '0').trim()) || 0;
}

