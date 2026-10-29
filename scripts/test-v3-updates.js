/**
 * Automated Test Suite for MVM Panel v3 Pterodactyl-Style Update System
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { initDb, collections, settings } = require('../src/lib/db');
const authService = require('../src/services/authService');
const updateService = require('../src/services/updateService');
const moduleLoader = require('../src/lib/moduleLoader');

const BASE_WEB = 'http://127.0.0.1:3001';

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  [PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

async function itAsync(desc, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

async function run() {
  console.log('======================================================');
  console.log('  TESTING vPANEL PRO v3 SYSTEM UPDATE CENTER         ');
  console.log('======================================================\n');

  await initDb();

  const adminUser = await collections.users.findOne({ $or: [{ role: 'admin' }, { root_admin: 1 }] });
  if (!adminUser) {
    console.error('Fatal: Admin user required for tests');
    process.exit(1);
  }
  const token = authService.signToken(adminUser);
  const authHeaders = {
    Authorization: 'Bearer ' + token,
    Cookie: 'token=' + token,
  };

  // 1. Version Comparison & SemVer Logic
  console.log('>>> 1. Semantic Version Comparison & Channel Filtering');
  it('Detects newer major/minor/patch releases', () => {
    assert.strictEqual(updateService.compareVersions('v3.1.0', 'v3.0.0'), 1);
    assert.strictEqual(updateService.compareVersions('v3.0.1', 'v3.0.0'), 1);
    assert.strictEqual(updateService.compareVersions('v4.0.0', 'v3.9.9'), 1);
    assert.strictEqual(updateService.compareVersions('v3.0.0', 'v3.1.0'), -1);
    assert.strictEqual(updateService.compareVersions('v3.0.0', 'v3.0.0'), 0);
  });

  it('isNewer helper accurately compares versions', () => {
    assert.strictEqual(updateService.isNewer('v3.1.0', 'v3.0.0'), true);
    assert.strictEqual(updateService.isNewer('v2.2.0', 'v3.0.0'), false);
    assert.strictEqual(updateService.isNewer('v3.0.0', 'v3.0.0'), false);
  });

  it('Reads current installed version from package.json', () => {
    const current = updateService.getCurrentVersion();
    assert.ok(current.startsWith('v3.0'));
  });

  // 2. Module Loader Integration
  console.log('\n>>> 2. Module Loader Catalog & Extensibility');
  it('Module loader includes "updates" module', () => {
    const mod = moduleLoader.getModule('updates');
    assert.ok(mod, 'Updates module should be registered');
    assert.strictEqual(mod.route, '/admin/updates');
    assert.strictEqual(mod.category, 'System');
  });

  // 3. Pre-Update Backup Snapshot Engine
  console.log('\n>>> 3. Pre-Update Snapshot Backup Engine');
  let testBackupDir = null;
  it('Creates atomic pre-update backup snapshot', () => {
    const backup = updateService.createPreUpdateBackup();
    assert.ok(backup.id.startsWith('backup-'));
    assert.ok(fs.existsSync(backup.dir));
    assert.ok(fs.existsSync(path.join(backup.dir, 'meta.json')));
    testBackupDir = backup.dir;
  });

  it('Backup contains configuration and meta details', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(testBackupDir, 'meta.json'), 'utf8'));
    assert.ok(meta.version);
    assert.ok(meta.timestamp);
    // Cleanup test snapshot
    fs.rmSync(testBackupDir, { recursive: true, force: true });
  });

  // 4. Update History Ledger & Status
  console.log('\n>>> 4. Update History Ledger & Rollbacks');
  await itAsync('Records update event in history collection', async () => {
    await collections.update_history.insertOne({
      id: 99999,
      from_version: 'v3.0.0',
      to_version: 'v3.1.0',
      status: 'SUCCESS',
      backup_id: 'test-backup-99999',
      user: adminUser.username,
      logs: ['[Init] Update test', '[Done] Success'],
      timestamp: new Date().toISOString(),
    });

    const history = await updateService.listHistory(10);
    assert.ok(history.length > 0);
    assert.strictEqual(history[0].id, 99999);

    // Clean up
    await collections.update_history.deleteOne({ id: 99999 });
  });

  // 5. GitHub Releases Check Engine
  console.log('\n>>> 5. GitHub Releases Checker Engine');
  await itAsync('checkForUpdates returns structured release payload', async () => {
    const res = await updateService.checkForUpdates(false);
    assert.ok(res.currentVersion);
    assert.ok(res.latestVersion);
    assert.ok(typeof res.updateAvailable === 'boolean');
    assert.ok(res.lastChecked);
  });

  it('getStatus returns accurate panel state', () => {
    const st = updateService.getStatus();
    assert.ok(st.currentVersion);
    assert.ok(st.latestVersion);
    assert.strictEqual(st.isUpdating, false);
  });

  // 6. Web UI & Live HTTP Routes
  console.log('\n>>> 6. Web UI & Live HTTP Route Endpoints');
  await itAsync('GET /admin/updates returns HTTP 200 with complete UI', async () => {
    const res = await axios.get(`${BASE_WEB}/admin/updates`, { headers: authHeaders });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.includes('System Updates'));
    assert.ok(res.data.includes('Release Notes'));
    assert.ok(res.data.includes('Installed Version'));
    assert.ok(res.data.includes('Update Preferences'));
  });

  await itAsync('POST /admin/updates/check returns JSON status', async () => {
    const res = await axios.post(`${BASE_WEB}/admin/updates/check`, {}, { headers: authHeaders });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.ok(res.data.updateInfo);
    assert.ok(res.data.status);
  });

  await itAsync('POST /admin/updates/settings updates channel preferences', async () => {
    const res = await axios.post(
      `${BASE_WEB}/admin/updates/settings`,
      { channel: 'stable', auto_check: true, backup_before: true, auto_pm2_restart: true },
      { headers: { ...authHeaders, 'Content-Type': 'application/json' } }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(settings.get('update.channel'), 'stable');
  });

  await itAsync('GET /admin/updates/stream connects and sends SSE headers', async () => {
    const res = await axios.get(`${BASE_WEB}/admin/updates/stream`, {
      headers: authHeaders,
      responseType: 'stream',
      timeout: 3000,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/event-stream'));
    res.data.destroy(); // close stream
  });

  // Summary
  console.log('\n======================================================');
  console.log(`  vPANEL PRO v3 UPDATES TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================');

  if (failed > 0) process.exit(1);
  else process.exit(0);
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
