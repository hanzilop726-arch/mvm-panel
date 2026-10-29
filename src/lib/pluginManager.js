const EventEmitter = require('events');
const axios = require('axios');
const crypto = require('crypto');
const logger = require('./logger');
const { collections, ensureConnected } = require('./db');

class PluginManager extends EventEmitter {
  constructor() {
    super();
    this.plugins = new Map();
    this.defaultConfigs = {
      discord: {
        id: 'discord',
        name: 'Discord Notifications',
        description: 'Rich Discord webhook embeds for VM power events, backups, and security alerts',
        icon: 'message-square',
        enabled: false,
        webhook_url: '',
        bot_token: '',
        channel_id: '',
        events: ['vm:start', 'vm:stop', 'vm:create', 'backup:create', 'auth:failed_login'],
      },
      telegram: {
        id: 'telegram',
        name: 'Telegram Bot Alerts',
        description: 'Instant push alerts to your Telegram group or private channel',
        icon: 'send',
        enabled: false,
        bot_token: '',
        chat_id: '',
        events: ['vm:start', 'vm:stop', 'backup:create', 'system:high_load'],
      },
      webhook: {
        id: 'webhook',
        name: 'Custom Webhook Dispatcher',
        description: 'HMAC-signed HTTP POST webhooks for external integrations and automations',
        icon: 'globe',
        enabled: false,
        endpoint: '',
        secret: '',
        events: ['*'],
      },
    };
  }

  async init() {
    try {
      await ensureConnected();
      const existing = await collections.plugins_config.find({}).toArray();
      const map = new Map();
      existing.forEach(p => map.set(p.id, p));

      for (const [id, def] of Object.entries(this.defaultConfigs)) {
        if (!map.has(id)) {
          await collections.plugins_config.updateOne(
            { id },
            { $set: def },
            { upsert: true }
          );
          this.plugins.set(id, { ...def });
        } else {
          this.plugins.set(id, { ...def, ...map.get(id) });
        }
      }
      logger.info('[plugins] Plugin manager initialized with ' + this.plugins.size + ' plugins');
    } catch (e) {
      logger.warn('[plugins] Failed to initialize plugin manager: ' + e.message);
    }
  }

  async getConfigs() {
    const list = [];
    for (const [id, def] of this.plugins.entries()) {
      list.push({ ...def });
    }
    return list;
  }

  async getConfig(pluginId) {
    return this.plugins.get(pluginId) || null;
  }

  async updateConfig(pluginId, newConfig) {
    await ensureConnected();
    const current = this.plugins.get(pluginId) || this.defaultConfigs[pluginId] || { id: pluginId };
    const merged = { ...current, ...newConfig, id: pluginId, updated_at: new Date().toISOString() };
    this.plugins.set(pluginId, merged);

    await collections.plugins_config.updateOne(
      { id: pluginId },
      { $set: merged },
      { upsert: true }
    );
    return merged;
  }

  async emitPlatformEvent(eventName, payload = {}, meta = {}) {
    this.emit(eventName, payload, meta);

    // Save to audit_events
    try {
      await ensureConnected();
      await collections.audit_events.insertOne({
        event: eventName,
        payload,
        user_id: meta.user_id || payload.user_id || null,
        vm_id: meta.vm_id || payload.vm_id || null,
        ip: meta.ip || payload.ip || '127.0.0.1',
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}

    // Dispatch to active plugins
    for (const [id, plugin] of this.plugins.entries()) {
      if (!plugin.enabled) continue;
      const isSubscribed = (plugin.events || []).includes('*') || (plugin.events || []).includes(eventName);
      if (!isSubscribed) continue;

      try {
        if (id === 'discord') {
          this.dispatchDiscord(plugin, eventName, payload).catch(err => {
            logger.warn(`[plugins:discord] Error dispatching event ${eventName}: ` + err.message);
          });
        } else if (id === 'telegram') {
          this.dispatchTelegram(plugin, eventName, payload).catch(err => {
            logger.warn(`[plugins:telegram] Error dispatching event ${eventName}: ` + err.message);
          });
        } else if (id === 'webhook') {
          this.dispatchWebhook(plugin, eventName, payload).catch(err => {
            logger.warn(`[plugins:webhook] Error dispatching event ${eventName}: ` + err.message);
          });
        }
      } catch (err) {
        logger.warn(`[plugins:${id}] dispatch error: ` + err.message);
      }
    }
  }

  async dispatchDiscord(plugin, eventName, payload) {
    if (!plugin.webhook_url) return;
    const colorMap = {
      'vm:start': 0x10b981, // Emerald Green
      'vm:stop': 0xef4444, // Red
      'vm:create': 0x6366f1, // Indigo
      'backup:create': 0x38bdf8, // Sky Blue
      'auth:failed_login': 0xf59e0b, // Amber
      'system:high_load': 0xf43f5e, // Rose
    };

    const color = colorMap[eventName] || 0x6366f1;
    const embed = {
      title: `MVM Panel Event: ${eventName}`,
      description: payload.message || `Platform event **${eventName}** triggered.`,
      color,
      timestamp: new Date().toISOString(),
      fields: Object.entries(payload)
        .filter(([k]) => k !== 'message' && typeof payload[k] !== 'object')
        .slice(0, 8)
        .map(([k, v]) => ({ name: k, value: String(v), inline: true })),
      footer: { text: 'MVM Panel Virtualization Platform' },
    };

    await axios.post(plugin.webhook_url, {
      username: 'MVM Panel Bot',
      avatar_url: 'https://vpanel.io/icon.png',
      embeds: [embed],
    }, { timeout: 8000 });
  }

  async dispatchTelegram(plugin, eventName, payload) {
    if (!plugin.bot_token || !plugin.chat_id) return;
    const text = `*MVM Panel Alert*\nEvent: \`${eventName}\`\n${payload.message || ''}\nTime: ${new Date().toISOString()}`;
    const url = `https://api.telegram.org/bot${plugin.bot_token}/sendMessage`;
    await axios.post(url, {
      chat_id: plugin.chat_id,
      text,
      parse_mode: 'Markdown',
    }, { timeout: 8000 });
  }

  async dispatchWebhook(plugin, eventName, payload) {
    if (!plugin.endpoint) return;
    const bodyStr = JSON.stringify({
      event: eventName,
      payload,
      timestamp: new Date().toISOString(),
    });

    const headers = { 'Content-Type': 'application/json' };
    if (plugin.secret) {
      const sig = crypto.createHmac('sha256', plugin.secret).update(bodyStr).digest('hex');
      headers['X-VPanel-Signature'] = `sha256=${sig}`;
    }

    await axios.post(plugin.endpoint, bodyStr, { headers, timeout: 8000 });
  }

  async testPlugin(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' not found`);

    const testPayload = {
      message: `Test alert from MVM Panel for plugin ${plugin.name}`,
      status: 'OK',
      test: true,
      timestamp: new Date().toISOString(),
    };

    if (pluginId === 'discord') {
      if (!plugin.webhook_url) throw new Error('Discord Webhook URL is not configured');
      await this.dispatchDiscord(plugin, 'test:ping', testPayload);
      return { ok: true, message: 'Discord test embed dispatched successfully' };
    } else if (pluginId === 'telegram') {
      if (!plugin.bot_token || !plugin.chat_id) throw new Error('Telegram Bot Token and Chat ID are required');
      await this.dispatchTelegram(plugin, 'test:ping', testPayload);
      return { ok: true, message: 'Telegram test message dispatched successfully' };
    } else if (pluginId === 'webhook') {
      if (!plugin.endpoint) throw new Error('Webhook endpoint URL is not configured');
      await this.dispatchWebhook(plugin, 'test:ping', testPayload);
      return { ok: true, message: 'Webhook test POST dispatched successfully' };
    }
    return { ok: true };
  }
}

const instance = new PluginManager();
module.exports = instance;
