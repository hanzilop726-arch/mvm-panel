/**
 * Automated Test Suite for MVM Panel v3 Advanced Capabilities
 * - Global Command Palette
 * - User Impersonation & Floating Revert Banner
 * - AI Assistant & Boot Log Explainer
 * - Billing & Resource Plans Module
 * - i18n Localization Engine
 */

const assert = require('assert');
const { initDb, collections, settings } = require('../src/lib/db');
const authService = require('../src/services/authService');
const billingService = require('../src/services/billingService');
const aiLogService = require('../src/services/aiLogService');
const { translate, LOCALES } = require('../src/lib/i18n');
const moduleLoader = require('../src/lib/moduleLoader');
const { getUserFromReq } = require('../src/middleware/auth');

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
  console.log('  TESTING vPANEL PRO v3 ADVANCED CAPABILITIES');
  console.log('======================================================\n');

  await initDb();

  // 1. Command Palette & Module Discovery
  console.log('>>> 1. Command Palette & Extensibility');
  it('Module loader includes billing module', () => {
    const mod = moduleLoader.getModule('billing');
    assert.ok(mod, 'Billing module should be registered');
    assert.strictEqual(mod.route, '/admin/billing');
    assert.strictEqual(mod.category, 'Monetization');
  });

  it('Total core modules count is at least 7', () => {
    const list = moduleLoader.listModules();
    assert.ok(list.length >= 7, 'Should have at least 7 modules');
  });

  // 2. User Impersonation
  console.log('\n>>> 2. User Impersonation & Session Revert');
  let adminUser = await collections.users.findOne({ role: 'admin' });
  if (!adminUser) {
    adminUser = await authService.createUser({
      username: 'admin_' + Date.now().toString(36),
      email: `admin_${Date.now().toString(36)}@example.com`,
      password: 'password123',
      role: 'admin',
    });
  }

  let tenantUser = await collections.users.findOne({ role: 'user', suspended: false });
  if (!tenantUser) {
    tenantUser = await authService.createUser({
      username: 'tenant_' + Date.now().toString(36),
      email: `tenant_${Date.now().toString(36)}@example.com`,
      password: 'password123',
      role: 'user',
    });
  }

  const adminToken = authService.generateToken(adminUser);
  const userToken = authService.generateToken(tenantUser);

  await itAsync('Auth middleware recognizes impersonation state', async () => {
    const mockReq = {
      headers: {},
      cookies: {
        token: userToken,
        vpanel_impersonate_admin: adminToken,
      },
      query: {},
    };
    const resolvedUser = await getUserFromReq(mockReq);
    assert.ok(resolvedUser, 'User should be resolved');
    assert.strictEqual(resolvedUser.id, tenantUser.id, 'User should be the tenant');
    assert.strictEqual(resolvedUser.is_impersonating, true, 'is_impersonating should be true');
    assert.strictEqual(resolvedUser.impersonated_by, adminUser.username, 'impersonated_by should match admin');
  });

  it('Regular user token without impersonation cookie is not flagged', async () => {
    const mockReq = {
      headers: {},
      cookies: { token: userToken },
      query: {},
    };
    const resolvedUser = await getUserFromReq(mockReq);
    assert.ok(resolvedUser);
    assert.strictEqual(resolvedUser.is_impersonating, undefined);
  });

  // 3. AI Assistant & Virtualization Boot Log Explainer
  console.log('\n>>> 3. AI Assistant & Virtualization Boot Log Explainer');
  await itAsync('Diagnoses Kernel Panic and missing root fs', async () => {
    const panicLog = `
      [    0.000000] Linux version 6.8.0-31-generic
      [    1.234567] Mounting root filesystem...
      [    1.240000] Kernel panic - not syncing: VFS: Unable to mount root fs on unknown-block(0,0)
      [    1.245000] CPU: 0 PID: 1 Comm: swapper/0 Not tainted
    `;
    const res = await aiLogService.diagnoseLog(panicLog);
    assert.strictEqual(res.status, 'issue_detected');
    assert.strictEqual(res.severity, 'CRITICAL');
    assert.ok(res.title.includes('Kernel Panic'));
    assert.ok(res.confidence >= 90);
    assert.ok(res.terminal_commands.length > 0);
  });

  await itAsync('Diagnoses KVM Acceleration permission denied', async () => {
    const kvmLog = 'Could not access KVM kernel module: Permission denied\nqemu-system-x86_64: failed to initialize kvm: Permission denied';
    const res = await aiLogService.diagnoseLog(kvmLog);
    assert.strictEqual(res.status, 'issue_detected');
    assert.strictEqual(res.severity, 'CRITICAL');
    assert.ok(res.title.includes('KVM'));
    assert.ok(res.terminal_commands.some(c => c.includes('chmod 666 /dev/kvm')));
  });

  await itAsync('Diagnoses Linux OOM Killer execution', async () => {
    const oomLog = '[ 450.12] Out of memory: Kill process 1420 (qemu-system-x86_64) score 850 or sacrifice child';
    const res = await aiLogService.diagnoseLog(oomLog);
    assert.strictEqual(res.status, 'issue_detected');
    assert.strictEqual(res.severity, 'CRITICAL');
    assert.ok(res.title.includes('OOM'));
  });

  await itAsync('Diagnoses Port collision (EADDRINUSE)', async () => {
    const portLog = 'qemu: bind failed: Address already in use\nFailed to bind socket: Address already in use';
    const res = await aiLogService.diagnoseLog(portLog);
    assert.strictEqual(res.status, 'issue_detected');
    assert.strictEqual(res.severity, 'WARNING');
    assert.ok(res.title.includes('Port Collision'));
  });

  await itAsync('Diagnoses clean boot without false alarms', async () => {
    const cleanLog = 'systemd[1]: Reached target Graphical Interface.\nUbuntu 24.04 LTS localhost tty1';
    const res = await aiLogService.diagnoseLog(cleanLog);
    assert.strictEqual(res.status, 'healthy');
    assert.strictEqual(res.severity, 'INFO');
  });

  // 4. Billing & Resource Plans Module
  console.log('\n>>> 4. Billing & Resource Plans Engine');
  await itAsync('Initializes default compute tiers (Starter, Pro, Ultra, Enterprise)', async () => {
    const plans = await billingService.listPlans();
    assert.ok(plans.length >= 4, 'Should have at least 4 default plans');
    const starter = plans.find(p => p.slug === 'starter');
    assert.ok(starter, 'Starter plan must exist');
    assert.strictEqual(starter.price_monthly, 5.00);
    assert.strictEqual(starter.cpus, 1);
  });

  let createdPlanId = null;
  await itAsync('Creates custom resource tier', async () => {
    const plan = await billingService.createPlan({
      name: 'Test Gaming VPS',
      slug: 'test-gaming',
      description: 'Ultra high single-core frequency',
      cpus: 6,
      memory: 12288,
      disk: 150,
      price_monthly: 45.00,
    });
    assert.ok(plan.id);
    assert.strictEqual(plan.name, 'Test Gaming VPS');
    assert.strictEqual(plan.cpus, 6);
    createdPlanId = plan.id;
  });

  await itAsync('Updates custom resource tier', async () => {
    const updated = await billingService.updatePlan(createdPlanId, {
      price_monthly: 42.50,
      description: 'Updated description',
    });
    assert.strictEqual(updated.price_monthly, 42.50);
    assert.strictEqual(updated.description, 'Updated description');
  });

  await itAsync('Deletes custom resource tier', async () => {
    const deleted = await billingService.deletePlan(createdPlanId);
    assert.strictEqual(deleted, true);
  });

  let invoiceId = null;
  await itAsync('Generates client invoice with formatted number', async () => {
    const invoice = await billingService.createInvoice({
      user_id: tenantUser.id,
      username: tenantUser.username,
      plan_name: 'Standard Pro Monthly',
      amount: 15.00,
      status: 'pending',
    });
    assert.ok(invoice.id);
    assert.ok(invoice.invoice_number.startsWith('INV-'));
    assert.strictEqual(invoice.status, 'pending');
    invoiceId = invoice.id;
  });

  await itAsync('Updates invoice status to paid', async () => {
    const updated = await billingService.updateInvoiceStatus(invoiceId, 'paid');
    assert.strictEqual(updated.status, 'paid');
    assert.ok(updated.paid_at, 'paid_at timestamp should be set');
  });

  await itAsync('Deletes invoice', async () => {
    const del = await billingService.deleteInvoice(invoiceId);
    assert.strictEqual(del, true);
  });

  let couponId = null;
  await itAsync('Creates promo discount coupon', async () => {
    const coupon = await billingService.createCoupon({
      code: 'TESTSAVE50',
      discount_type: 'percentage',
      discount_value: 50,
      max_uses: 50,
    });
    assert.strictEqual(coupon.code, 'TESTSAVE50');
    assert.strictEqual(coupon.discount_value, 50);
    couponId = coupon.id;
  });

  await itAsync('Validates promo discount coupon calculation', async () => {
    const result = await billingService.validateCoupon('TESTSAVE50', 100);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.discountAmount, 50);
    assert.strictEqual(result.finalAmount, 50);
  });

  await itAsync('Rejects invalid promo coupon', async () => {
    const result = await billingService.validateCoupon('DOES_NOT_EXIST', 100);
    assert.strictEqual(result.valid, false);
  });

  await itAsync('Deletes promo discount coupon', async () => {
    const del = await billingService.deleteCoupon(couponId);
    assert.strictEqual(del, true);
  });

  // 5. Internationalization Engine
  console.log('\n>>> 5. Internationalization (i18n) Engine');
  it('Translates navigation keys to English', () => {
    assert.strictEqual(translate('dashboard', 'en'), 'Dashboard');
    assert.strictEqual(translate('servers', 'en'), 'Servers');
    assert.strictEqual(translate('billing', 'en'), 'Billing');
  });

  it('Translates navigation keys to Hindi', () => {
    assert.strictEqual(translate('dashboard', 'hi'), 'डैशबोर्ड');
    assert.strictEqual(translate('servers', 'hi'), 'सर्वर');
    assert.strictEqual(translate('billing', 'hi'), 'बिलिंग और योजनाएं');
  });

  it('Translates navigation keys to Spanish', () => {
    assert.strictEqual(translate('dashboard', 'es'), 'Panel');
    assert.strictEqual(translate('servers', 'es'), 'Servidores');
  });

  it('Translates navigation keys to German', () => {
    assert.strictEqual(translate('dashboard', 'de'), 'Übersicht');
    assert.strictEqual(translate('servers', 'de'), 'Server');
  });

  it('Translates navigation keys to Arabic with RTL support', () => {
    assert.strictEqual(translate('dashboard', 'ar'), 'لوحة التحكم');
    assert.strictEqual(LOCALES.ar.rtl, true);
  });

  // 6. Live HTTP Route Endpoints
  console.log('\n>>> 6. Live Web & HTTP Endpoints');
  const axios = require('axios');
  const BASE_WEB = 'http://127.0.0.1:3001';
  const authHeaders = {
    Authorization: 'Bearer ' + adminToken,
    Cookie: 'token=' + adminToken,
  };

  await itAsync('GET /admin/billing returns HTTP 200', async () => {
    const res = await axios.get(`${BASE_WEB}/admin/billing`, { headers: authHeaders });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.includes('Billing & Resource Plans'), 'HTML should contain title');
    assert.ok(res.data.includes('Starter Cloud'), 'HTML should list Starter Cloud');
  });

  await itAsync('POST /api/locale switches language successfully', async () => {
    const res = await axios.post(`${BASE_WEB}/api/locale`, { lang: 'hi' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.lang, 'hi');
  });

  await itAsync('POST /api/ai/diagnose-log returns structured diagnosis', async () => {
    const res = await axios.post(
      `${BASE_WEB}/api/ai/diagnose-log`,
      { log: 'Kernel panic - not syncing: VFS: Unable to mount root fs' },
      { headers: { ...authHeaders, 'Content-Type': 'application/json' } }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.diagnosis.status, 'issue_detected');
    assert.strictEqual(res.data.diagnosis.severity, 'CRITICAL');
  });

  await itAsync('POST /admin/users/:id/impersonate returns redirect to dashboard', async () => {
    const res = await axios.post(
      `${BASE_WEB}/admin/users/${tenantUser.id}/impersonate`,
      {},
      {
        headers: { ...authHeaders, Accept: 'application/json' },
        maxRedirects: 0,
        validateStatus: status => status >= 200 && status < 400,
      }
    );
    assert.ok(res.status === 200 || res.status === 302);
    if (res.data && res.data.ok) {
      assert.strictEqual(res.data.redirect, '/dashboard');
    }
  });

  // Summary
  console.log('\n======================================================');
  console.log(`  vPANEL PRO v3 ADVANCED TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
