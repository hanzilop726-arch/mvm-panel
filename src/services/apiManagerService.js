const crypto = require('crypto');
const axios = require('axios');
const logger = require('../lib/logger');
const { collections, ensureConnected, getNextId } = require('../lib/db');

class ApiManagerService {
  async listApiKeys() {
    await ensureConnected();
    const keys = await collections.api_keys.find({}).toArray();
    return keys.map(k => ({
      id: k.id,
      name: k.name,
      key_preview: k.key_preview || (k.key ? `${k.key.slice(0, 10)}...${k.key.slice(-4)}` : 'vp_live_****'),
      scopes: k.scopes || ['vms:read'],
      user_id: k.user_id,
      last_used_at: k.last_used_at || null,
      created_at: k.created_at,
      expires_at: k.expires_at || 'Never',
    }));
  }

  async createApiKey(name, scopes = ['vms:read'], userId = 1) {
    await ensureConnected();
    const id = await getNextId('api_keys');
    const rawKey = 'vp_live_' + crypto.randomBytes(24).toString('hex');
    const keyPreview = `${rawKey.slice(0, 10)}...${rawKey.slice(-4)}`;

    const doc = {
      id,
      name: name || `API Key ${id}`,
      key: rawKey,
      key_preview: keyPreview,
      scopes: Array.isArray(scopes) ? scopes : [scopes],
      user_id: Number(userId),
      last_used_at: null,
      created_at: new Date().toISOString(),
      expires_at: 'Never',
    };
    await collections.api_keys.insertOne(doc);
    return { ...doc, raw_key: rawKey };
  }

  async revokeApiKey(keyId) {
    await ensureConnected();
    const id = Number(keyId);
    await collections.api_keys.deleteOne({ id });
    return { ok: true, deletedId: id };
  }

  async listWebhooks() {
    await ensureConnected();
    const hooks = await collections.webhooks.find({}).toArray();
    return hooks;
  }

  async createWebhook(data) {
    await ensureConnected();
    const id = await getNextId('webhooks');
    const doc = {
      id,
      name: data.name || `Webhook ${id}`,
      target_url: data.target_url,
      secret: data.secret || crypto.randomBytes(16).toString('hex'),
      events: data.events || ['vm:start', 'vm:stop', 'backup:create'],
      status: 'active',
      created_at: new Date().toISOString(),
      last_delivery: null,
    };
    await collections.webhooks.insertOne(doc);
    return doc;
  }

  async deleteWebhook(hookId) {
    await ensureConnected();
    const id = Number(hookId);
    await collections.webhooks.deleteOne({ id });
    return { ok: true, deletedId: id };
  }

  async testWebhook(hookId) {
    await ensureConnected();
    const id = Number(hookId);
    const hook = await collections.webhooks.findOne({ id });
    if (!hook) throw new Error('Webhook not found');

    const payload = {
      event: 'test:ping',
      timestamp: new Date().toISOString(),
      message: 'MVM Panel Webhook Connectivity Verification',
    };
    const bodyStr = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    if (hook.secret) {
      const sig = crypto.createHmac('sha256', hook.secret).update(bodyStr).digest('hex');
      headers['X-VPanel-Signature'] = `sha256=${sig}`;
    }

    const t0 = Date.now();
    try {
      const res = await axios.post(hook.target_url, bodyStr, { headers, timeout: 6000 });
      const durationMs = Date.now() - t0;
      await collections.webhooks.updateOne(
        { id },
        { $set: { last_delivery: { status: res.status, duration_ms: durationMs, timestamp: new Date().toISOString() } } }
      );
      return { ok: true, status: res.status, duration_ms: durationMs };
    } catch (e) {
      const durationMs = Date.now() - t0;
      await collections.webhooks.updateOne(
        { id },
        { $set: { last_delivery: { status: e.response?.status || 500, error: e.message, timestamp: new Date().toISOString() } } }
      );
      return { ok: false, error: e.message };
    }
  }

  getApiDocs() {
    return [
      { method: 'GET', endpoint: '/api/vms', description: 'List all virtual machines owned or permitted', scope: 'vms:read' },
      { method: 'GET', endpoint: '/api/vms/:id', description: 'Retrieve detailed VM status and metrics', scope: 'vms:read' },
      { method: 'POST', endpoint: '/api/vms/:id/start', description: 'Power on virtual machine', scope: 'vms:write' },
      { method: 'POST', endpoint: '/api/vms/:id/stop', description: 'ACPI shutdown or power off virtual machine', scope: 'vms:write' },
      { method: 'POST', endpoint: '/api/vms/:id/restart', description: 'Reboot virtual machine', scope: 'vms:write' },
      { method: 'POST', endpoint: '/api/vms/create', description: 'Provision a new virtual machine', scope: 'vms:write' },
      { method: 'DELETE', endpoint: '/api/vms/:id', description: 'Terminate and delete virtual machine', scope: 'vms:delete' },
      { method: 'GET', endpoint: '/api/users', description: 'List platform users', scope: 'users:read' },
      { method: 'POST', endpoint: '/api/users/create', description: 'Create user account', scope: 'users:write' },
    ];
  }
}

module.exports = new ApiManagerService();
