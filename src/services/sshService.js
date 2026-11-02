const { Client } = require('ssh2');
const path = require('path');
const logger = require('../lib/logger');

function connect(vm, { readyTimeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!vm || !vm.ssh_port || !vm.username) {
      return reject(new Error('VM has no SSH configuration'));
    }
    const conn = new Client();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; conn.end(); reject(new Error('SSH connection timed out')); }
    }, readyTimeout);
    conn.on('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(conn);
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });
    conn.connect({
      host: '127.0.0.1',
      port: vm.ssh_port,
      username: vm.username,
      password: vm.password,
      readyTimeout,
      keepaliveInterval: 5000,
      keepaliveCountMax: 10,
    });
  });
}

function exec(conn, cmd, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.close();
        reject(new Error(`SSH command timed out after ${timeout} ms`));
      }, timeout);
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { errOut += d.toString(); });
      stream.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout: out, stderr: errOut });
      });
      stream.on('error', (streamError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(streamError);
      });
    });
  });
}

async function withExec(vm, cmd, opts) {
  let conn;
  try {
    conn = await connect(vm);
    return await exec(conn, cmd, opts);
  } finally {
    if (conn) conn.end();
  }
}

function shellStream(vm) {
  return connect(vm).then((conn) => {
    return new Promise((resolve, reject) => {
      conn.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) return reject(err);
        resolve({ conn, stream });
      });
    });
  });
}

async function shellStreamWithRetry(vm, { maxRetries = 25, retryDelay = 2000, shouldContinue = () => true } = {}) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    if (!shouldContinue()) {
      throw new Error('Connection cancelled');
    }
    try {
      return await shellStream(vm);
    } catch (err) {
      lastErr = err;
      if (i < maxRetries - 1 && shouldContinue()) {
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }
  }
  throw lastErr || new Error('SSH connection timed out');
}

function statLineToFile(line, base) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('total ')) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 8) return null;

  const perms = parts[0];
  if (!/^[-dclbsp][rwxstST-]{9}/.test(perms)) return null;

  const isDir = perms.startsWith('d');
  const isLink = perms.startsWith('l');

  const owner = parts[2] || 'root';
  const group = parts[3] || 'root';
  const size = isDir ? 0 : (parseInt(parts[4], 10) || 0);

  let date = '';
  let name = '';

  if (parts.length >= 9 && !parts[5].includes('-') && !parts[5].includes(':')) {
    // Traditional format: Mon Day Time/Year Name (e.g. Aug 25 04:30 my_file.txt)
    date = `${parts[5]} ${parts[6]} ${parts[7]}`;
    name = parts.slice(8).join(' ');
  } else {
    // ISO format: YYYY-MM-DD HH:MM Name (e.g. 2026-08-25 04:30 my_file.txt)
    date = `${parts[5]} ${parts[6]}`;
    name = parts.slice(7).join(' ');
  }

  name = name.replace(/^"|"$/g, '').trim();
  if (!name || name === '.' || name === '..') return null;

  if (isLink && name.includes(' -> ')) {
    name = name.split(' -> ')[0].trim();
  }

  return {
    name,
    path: path.posix.join(base || '/', name),
    type: isDir ? 'dir' : isLink ? 'link' : 'file',
    size,
    perms,
    owner,
    group,
    date: date || '-',
  };
}

async function listDir(vm, p = '/') {
  const target = p && p !== '/' ? p : '/';
  const r = await withExec(vm, `ls -la --time-style=long-iso "${target}" 2>/dev/null || ls -la "${target}"`);
  if (r.code !== 0) throw new Error(r.stderr || 'Failed to list directory');
  const lines = r.stdout.split('\n').filter((l) => l && !l.startsWith('total '));
  const files = [];
  for (const line of lines) {
    const f = statLineToFile(line, target);
    if (f) files.push(f);
  }
  files.sort((a, b) => (a.type === 'dir' ? -1 : 1) - (b.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name));
  return files;
}

async function readFile(vm, p) {
  const r = await withExec(vm, `cat "${p}"`, { timeout: 15000 });
  if (r.code !== 0) throw new Error(r.stderr || 'Failed to read file');
  return r.stdout;
}

async function writeFile(vm, p, content) {
  const escaped = Buffer.from(content, 'utf8').toString('base64');
  const cmd = `mkdir -p "$(dirname '${p}')" && echo '${escaped}' | base64 -d > '${p}'`;
  const r = await withExec(vm, cmd, { timeout: 20000 });
  if (r.code !== 0) throw new Error(r.stderr || 'Failed to write file');
  return true;
}

async function mkdir(vm, p) {
  const r = await withExec(vm, `mkdir -p "${p}"`);
  if (r.code !== 0) throw new Error(r.stderr || 'Failed to create directory');
  return true;
}

async function rm(vm, p, { recursive = true } = {}) {
  const cmd = recursive ? `rm -rf "${p}"` : `rm -f "${p}"`;
  const r = await withExec(vm, cmd);
  if (r.code !== 0) throw new Error(r.stderr || 'Failed to delete');
  return true;
}

async function rename(vm, from, to) {
  const r = await withExec(vm, `mv "${from}" "${to}"`);
  if (r.code !== 0) throw new Error(r.stderr || 'Failed to rename');
  return true;
}

async function chmod(vm, p, mode) {
  const r = await withExec(vm, `chmod ${mode} "${p}"`);
  if (r.code !== 0) throw new Error(r.stderr || 'Failed to chmod');
  return true;
}

function uploadBuffer(conn, remotePath, buffer, { mode = 0o644 } = {}) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.writeFile(remotePath, buffer, { mode }, (e) => {
        if (e) return reject(e);
        resolve(true);
      });
    });
  });
}

function downloadBuffer(conn, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readFile(remotePath, (e, data) => {
        if (e) return reject(e);
        resolve(data);
      });
    });
  });
}

module.exports = {
  connect, exec, withExec, shellStream, shellStreamWithRetry, listDir, readFile, writeFile,
  mkdir, rm, rename, chmod, uploadBuffer, downloadBuffer,
};
