"use strict";

// ============================================================
// SSH COMMAND BUILDER
// ============================================================
// Standard authentication uses argv, keeping passwords, paths and remote shell
// syntax out of the local shell. Only the explicit CUSTOM template uses a shell.
function b64cmd(remoteCmd) {
    return btoa(unescape(encodeURIComponent(remoteCmd)));
}

function buildSSH(srv, remoteCmd) {
    if (srv.authType === 'CUSTOM') {
        const escaped = remoteCmd.replace(/"/g, '\\"');
        return { shell: (srv.customPrefix || '')
            .replace('{USERNAME}', srv.username)
            .replace('{PASSWD}', srv.credential || '')
            .replace('{PORT}', String(srv.port))
            .replace('{HOST}', srv.sshHost)
            .replace('{CMD}', `"${escaped}"`) };
    }
    if (srv.authType === 'PASSWORD') {
        return {
            executable: (srv.clientPath || (Desktop.platform === 'Windows' ? '.\\ssh-client.exe' : './ssh-client')).replace(/^"(.*)"$/, '$1'),
            args: ['-l', srv.username, '-passwd', srv.credential || '', '-p', String(srv.port), '-b64cmd', b64cmd(remoteCmd), srv.sshHost]
        };
    }
    const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=30', '-p', String(srv.port)];
    if (srv.authType === 'KEY') args.push('-i', srv.keyPath);
    args.push(`${srv.username}@${srv.sshHost}`, remoteCmd);
    return { executable: 'ssh', args };
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
    return Desktop.os.execCommand(buildSSH(srv, cmd));
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

