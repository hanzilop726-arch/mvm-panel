#!/usr/bin/env node
/**
 * MVM Panel build script
 * - ensures all required directories exist
 * - validates configuration
 * - checks system dependencies (qemu etc.) and prints a report
 * Usage: npm run build
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../src/lib/config');
const { initDb, closeDb, collections } = require('../src/lib/db');
const vmService = require('../src/services/vmService');

const check = process.argv.includes('--check');
const errors = [];
const warnings = [];

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function hasBin(b) {
  try { execSync(`which ${b}`, { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

(async () => {
console.log('');
console.log('  MVM Panel build');
console.log('  =================');
console.log('');

// 1. directories
for (const d of [
  config.vmDir, config.uploads.dir, config.uploads.logo, config.uploads.favicon,
  config.uploads.background, config.uploads.music, config.uploads.avatar,
  config.uploads.backup, path.join(config.root, 'data'),
  path.join(config.root, 'storage/logs'),
]) ensureDir(d);
console.log('[ok] directories ready');

// 2. database
try {
  await initDb();
  const userCount = await collections.users.countDocuments();
  console.log(`[ok] database ready (${userCount} users)`);
} catch (e) {
  errors.push(`MongoDB connection failed: ${e.message}`);
}

// 3. dependencies
console.log('[info] system dependency report:');
for (const bin of ['qemu-system-x86_64', 'cloud-localds', 'qemu-img', 'wget', 'openssl']) {
  const ok = hasBin(bin);
  console.log(`       ${ok ? 'ok  ' : 'MISS'}  ${bin}`);
  if (!ok) {
    warnings.push(`${bin} is missing. VM create/start will not work.`);
  }
}

// 4. noVNC (graphical console)
const novncDir = path.join(config.root, 'public/vendor/novnc/core');
if (!fs.existsSync(path.join(novncDir, 'rfb.js'))) {
  console.log('[info] noVNC not found. Downloading...');
  const NOVNC_VERSION = '1.5.0';
  const tmp = path.join(config.root, 'data/tmp/novnc.tar.gz');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  try {
    const url = `https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz`;
    execSync(`wget -q -O "${tmp}" "${url}"`, { stdio: 'inherit' });
    const dir = path.join(config.root, 'public/vendor/novnc');
    fs.mkdirSync(dir, { recursive: true });
    execSync(`tar xzf "${tmp}" -C "${path.dirname(tmp)}"`, { stdio: 'inherit' });
    execSync(`rm -rf "${dir}/core" "${dir}/vendor" && mkdir -p "${dir}/vendor" && cp -r "${path.dirname(tmp)}/noVNC-${NOVNC_VERSION}/core" "${dir}/core" && cp -r "${path.dirname(tmp)}/noVNC-${NOVNC_VERSION}/vendor/pako" "${dir}/vendor/pako"`, { stdio: 'inherit' });
    fs.rmSync(tmp, { force: true });
    console.log('[ok] noVNC downloaded');
  } catch (e) {
    warnings.push(`Could not download noVNC: ${e.message}. The graphical VNC console will not work until it is installed.`);
  }
} else {
  console.log('[ok] noVNC present');
}

// 5. jwt secret
if (['mvm-panel-insecure-secret-change-me', 'vpanel-insecure-secret-change-me'].includes(config.jwtSecret)) {
  warnings.push('JWT_SECRET is still the default. Set a strong value in .env before production.');
}

// 5. .env
if (!fs.existsSync(path.join(config.root, '.env'))) {
  warnings.push('.env not found. Copy .env.example to .env and adjust values.');
}

console.log('');
for (const w of warnings) console.log(`[warn] ${w}`);
for (const e of errors) console.log(`[error] ${e}`);
console.log('');

if (check && (errors.length || warnings.length)) {
  await closeDb();
  process.exit(1);
}

console.log('[done] Build complete. Run with: npm start  (or pm2 start ecosystem.config.js)');
await closeDb();
})();
