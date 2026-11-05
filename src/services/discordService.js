const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const { collections, settings } = require('../lib/db');
const config = require('../lib/config');
const logger = require('../lib/logger');
const boltService = require('./boltService');

const API = 'https://discord.com/api/v10';
let gateway = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let gatewayGeneration = 0;
const inviteUses = new Map();
let inviteSync = Promise.resolve();

function enabled() {
  return String(settings.get('discord.rewards_enabled')) === '1';
}

function controlEnabled() {
  return String(settings.get('discord.panel_control_enabled')) === '1';
}

function shouldRunGateway() {
  return enabled() || controlEnabled();
}

function configured() {
  return Boolean(settings.get('discord.client_id') && settings.get('discord.client_secret')
    && settings.get('discord.bot_token') && settings.get('discord.guild_id'));
}

function redirectUri() {
  return settings.get('discord.redirect_uri') || `${config.panelUrl.replace(/\/$/, '')}/auth/discord/callback`;
}

function botHeaders() {
  return { Authorization: `Bot ${settings.get('discord.bot_token')}` };
}

async function awardBoostBolts(userId, premiumSince) {
  if (!premiumSince) return;
  const boostStarted = new Date(premiumSince).toISOString();
  await boltService.credit(userId, Math.max(1, Number(settings.get('discord.boost_reward_bolts')) || 25), {
    source: 'discord_boost',
    reference: `discord-boost:${userId}:${boostStarted}`,
    details: { premiumSince: boostStarted },
  });
}

async function createOAuthState(userId, returnTo = '/rewards') {
  if (!shouldRunGateway() || !configured()) throw new Error('Discord integration is not enabled or configured');
  const state = crypto.randomBytes(32).toString('hex');
  await collections.discord_oauth_states.insertOne({
    state,
    user_id: Number(userId),
    return_to: returnTo === '/profile' ? '/profile' : '/rewards',
    created_at: new Date(),
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
  });
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', settings.get('discord.client_id'));
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);
  return url.toString();
}

async function linkDiscordAccount(code, state) {
  if (!code || !state) throw new Error('Discord authorization was incomplete');
  const oauthState = await collections.discord_oauth_states.findOneAndDelete({
    state: String(state),
    expires_at: { $gt: new Date() },
  });
  const stateDoc = oauthState && Object.prototype.hasOwnProperty.call(oauthState, 'value')
    ? oauthState.value
    : oauthState;
  if (!stateDoc) throw new Error('Discord authorization expired or was already used. Please try again.');

  const body = new URLSearchParams({
    client_id: String(settings.get('discord.client_id')),
    client_secret: String(settings.get('discord.client_secret')),
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: redirectUri(),
  });
  const tokenResponse = await axios.post(`${API}/oauth2/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
  const profileResponse = await axios.get(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
    timeout: 10000,
  });
  const discordId = String(profileResponse.data.id || '');
  if (!/^\d{15,22}$/.test(discordId)) throw new Error('Discord returned an invalid account identifier');

  const existing = await collections.users.findOne({ discord_id: discordId, id: { $ne: Number(stateDoc.user_id) } });
  if (existing) throw new Error('That Discord account is already connected to another panel account');
  const updated = await collections.users.updateOne(
    { id: Number(stateDoc.user_id) },
    { $set: { discord_id: discordId, discord_username: String(profileResponse.data.username || ''), discord_linked_at: new Date().toISOString() } }
  );
  if (updated.matchedCount !== 1) throw new Error('The panel account for this Discord authorization no longer exists');
  const referral = await collections.discord_invites.findOne({ invitee_id: discordId });
  if (referral && referral.inviter_id !== discordId) {
    await collections.users.updateMany(
      { discord_id: discordId, discord_referrer_id: { $exists: false } },
      { $set: { discord_referrer_id: String(referral.inviter_id) } }
    );
  }
  return {
    discordId,
    username: String(profileResponse.data.username || ''),
    returnTo: stateDoc.return_to === '/profile' ? '/profile' : '/rewards',
  };
}

async function getRewardStatus(user) {
  const maxActive = Math.max(1, Number(settings.get('discord.reward_max_active')) || 1);
  const activeCount = await collections.vms.countDocuments({ owner_id: Number(user.id), reward_type: { $in: ['discord', 'bolts'] } });
  let plans = settings.get('discord.reward_plans', []);
  if (typeof plans === 'string') {
    try { plans = JSON.parse(plans); } catch (_) { plans = []; }
  }
  if (!Array.isArray(plans) || plans.length === 0) {
    plans = [{
      id: 'legacy-default', name: 'Community VPS', costBolts: 100,
      cpus: Math.max(1, Number(settings.get('discord.reward_cpus')) || 1),
      memory: Math.max(128, Number(settings.get('discord.reward_memory')) || 1024),
      disk: String(settings.get('discord.reward_disk') || '10G'),
      os: String(settings.get('discord.reward_os') || 'Ubuntu 24.04'),
    }];
  }
  const status = {
    enabled: enabled(),
    configured: configured(),
    linked: Boolean(user.discord_id),
    discordUsername: user.discord_username || '',
    invites: 0,
    invitesPerReward: Math.max(1, Number(settings.get('discord.invites_per_reward')) || 5),
    inviteRewardBolts: Math.max(1, Number(settings.get('discord.invite_reward_bolts')) || 50),
    boostRewardBolts: Math.max(1, Number(settings.get('discord.boost_reward_bolts')) || 25),
    plans: plans.map((plan) => {
      const costBolts = Math.max(1, Number(plan.costBolts) || 100);
      return { ...plan, costBolts, affordable: Number(user.bolts) >= costBolts };
    }),
    activeCount,
    maxActive,
    boltBalance: await boltService.getBalance(user.id),
    boosting: false,
    reason: '',
    error: '',
  };
  if (!status.enabled) {
    status.reason = 'Discord rewards are disabled by the administrator.';
    return status;
  }
  if (!status.configured) {
    status.reason = 'Discord rewards have not been fully configured by the administrator.';
    return status;
  }
  if (!status.linked) {
    status.reason = 'Connect your Discord account to check your reward progress.';
    return status;
  }

  status.invites = await collections.users.countDocuments({ discord_referrer_id: String(user.discord_id) });
  const rewardCount = Math.floor(status.invites / status.invitesPerReward);
  for (let count = Math.max(0, Number(user.discord_invite_reward_count) || 0) + 1; count <= rewardCount; count += 1) {
    await boltService.credit(user.id, status.inviteRewardBolts, {
      source: 'discord_invites',
      reference: `discord-invites:${user.id}:${count}`,
      details: { invites: count * status.invitesPerReward, rewardCount: count },
    });
    await collections.users.updateOne({ id: Number(user.id) }, { $max: { discord_invite_reward_count: count } });
  }
  try {
    const response = await axios.get(`${API}/guilds/${encodeURIComponent(settings.get('discord.guild_id'))}/members/${encodeURIComponent(user.discord_id)}`, {
      headers: botHeaders(),
      timeout: 10000,
    });
    const premiumSince = response.data && response.data.premium_since;
    status.boosting = Boolean(premiumSince);
    if (premiumSince) await awardBoostBolts(user.id, premiumSince);
  } catch (error) {
    if (error.response?.status !== 404) {
      status.error = error.response?.data?.message || 'Could not verify Discord server membership. Try again later.';
    }
  }
  status.boltBalance = await boltService.getBalance(user.id);
  status.plans = status.plans.map((plan) => ({ ...plan, affordable: status.boltBalance >= plan.costBolts }));
  if (status.activeCount >= status.maxActive) status.reason = 'You already have the maximum number of active reward servers.';
  else status.reason = 'Earn BOLTs with verified invites or an active server boost, then spend them on a VPS plan.';
  return status;
}

async function readGuildInvites() {
  const response = await axios.get(`${API}/guilds/${encodeURIComponent(settings.get('discord.guild_id'))}/invites`, {
    headers: botHeaders(),
    timeout: 10000,
  });
  return response.data;
}

async function rememberMemberJoin(discordId) {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const invites = await readGuildInvites();
  let used = null;
  for (const invite of invites) {
    const previous = inviteUses.get(invite.code);
    const count = Number(invite.uses) || 0;
    if (previous !== undefined && count > previous && invite.inviter?.id) {
      if (!used || count - previous > used.delta) used = { inviter: String(invite.inviter.id), delta: count - previous };
    }
    inviteUses.set(invite.code, count);
  }
  if (!used || used.inviter === String(discordId)) return;
  try {
    await collections.discord_invites.updateOne(
      { invitee_id: String(discordId) },
      { $setOnInsert: { invitee_id: String(discordId), inviter_id: used.inviter, created_at: new Date().toISOString() } },
      { upsert: true }
    );
    await collections.users.updateMany(
      { discord_id: String(discordId), discord_referrer_id: { $exists: false } },
      { $set: { discord_referrer_id: used.inviter } }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
}

function stopGateway() {
  gatewayGeneration += 1;
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  heartbeatTimer = null;
  reconnectTimer = null;
  if (gateway) {
    gateway.removeAllListeners();
    if (gateway.readyState === WebSocket.CONNECTING) gateway.terminate();
    else gateway.close();
    gateway = null;
  }
}

const panelCommands = [{
  name: 'vps',
  description: 'View and manage your panel VPSs',
  options: [
    { type: 1, name: 'list', description: 'List your VPSs' },
    { type: 1, name: 'status', description: 'Check a VPS status', options: [
      { type: 4, name: 'server_id', description: 'Panel server ID', required: true },
    ] },
    { type: 1, name: 'start', description: 'Start a VPS', options: [
      { type: 4, name: 'server_id', description: 'Panel server ID', required: true },
    ] },
    { type: 1, name: 'stop', description: 'Stop a VPS', options: [
      { type: 4, name: 'server_id', description: 'Panel server ID', required: true },
    ] },
    { type: 1, name: 'restart', description: 'Restart a VPS', options: [
      { type: 4, name: 'server_id', description: 'Panel server ID', required: true },
    ] },
  ],
}];

async function syncPanelCommands() {
  const applicationId = String(settings.get('discord.client_id') || '');
  const guildId = String(settings.get('discord.guild_id') || '');
  await axios.put(`${API}/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`, controlEnabled() ? panelCommands : [], {
    headers: botHeaders(),
    timeout: 10000,
  });
}

async function sendInteractionReply(interaction, content) {
  await axios.patch(
    `${API}/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
    { content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } },
    { timeout: 10000 }
  );
}

async function executePanelCommand(interaction) {
  const discordId = String(interaction.member?.user?.id || interaction.user?.id || '');
  const user = await collections.users.findOne({ discord_id: discordId });
  if (!user || user.suspended) return 'Connect an active panel account from your profile before using VPS commands.';

  const isAdmin = user.role === 'admin' || Boolean(user.root_admin);
  const subcommand = interaction.data?.options?.[0];
  if (!subcommand) return 'Choose a VPS command.';
  if (subcommand.name === 'list') {
    const filter = isAdmin ? {} : { owner_id: Number(user.id) };
    const rows = await collections.vms.find(filter).sort({ id: -1 }).limit(10).toArray();
    if (!rows.length) return 'No VPSs are available to your linked panel account.';
    const lines = rows.map((row) => {
      const vm = vmService.serializeVm(row);
      return `#${vm.id} ${vm.name} — ${vm.status} (${vm.virtualization})`;
    });
    const suffix = rows.length === 10 ? '\nShowing the newest 10 VPSs.' : '';
    return `Your panel VPSs:\n${lines.join('\n')}${suffix}`;
  }

  const idOption = subcommand.options?.find((option) => option.name === 'server_id');
  const serverId = Number(idOption?.value);
  if (!Number.isSafeInteger(serverId) || serverId < 1) return 'Enter a valid server ID.';
  const vm = await vmService.getVm(serverId);
  if (!vm || (!isAdmin && Number(vm.owner_id) !== Number(user.id))) return 'VPS not found or your panel account does not have access.';
  if (subcommand.name === 'status') return `#${vm.id} ${vm.name}: ${vm.status} (${vm.virtualization})`;
  if (!['start', 'stop', 'restart'].includes(subcommand.name)) return 'That VPS command is not supported.';
  if (vm.suspended) return 'This VPS is suspended and cannot be controlled from Discord.';

  if (subcommand.name === 'start') await vmService.start(vm, { user });
  else if (subcommand.name === 'stop') await vmService.stop(vm, { user });
  else await vmService.restart(vm, user);
  return `#${vm.id} ${vm.name}: ${subcommand.name} request completed.`;
}

async function handlePanelInteraction(interaction) {
  if (!controlEnabled() || interaction.data?.name !== 'vps') return;
  try {
    await axios.post(
      `${API}/interactions/${encodeURIComponent(interaction.id)}/${encodeURIComponent(interaction.token)}/callback`,
      { type: 5, data: { flags: 64 } },
      { timeout: 5000 }
    );
    let response = 'The VPS command could not be completed.';
    if (String(interaction.application_id || '') !== String(settings.get('discord.client_id'))) {
      response = 'This command was not issued for the configured panel application.';
    } else if (String(interaction.guild_id || '') !== String(settings.get('discord.guild_id'))) {
      response = 'This bot is not enabled for this Discord server.';
    } else {
      try {
        response = await executePanelCommand(interaction);
      } catch (error) {
        logger.warn('[discord] VPS command failed: ' + error.message);
        response = 'The VPS command failed. Check the panel logs or contact an administrator.';
      }
    }
    await sendInteractionReply(interaction, response);
  } catch (error) {
    logger.warn('[discord] Could not acknowledge VPS command: ' + error.message);
  }
}

function startGateway() {
  stopGateway();
  if (!shouldRunGateway() || !configured()) return;
  const generation = gatewayGeneration;
  const socket = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
  gateway = socket;
  socket.on('message', (raw) => {
    let packet;
    try { packet = JSON.parse(raw.toString()); } catch (error) {
      logger.warn('[discord] Ignored invalid gateway payload: ' + error.message);
      return;
    }
    if (packet.op === 10) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 1, d: null }));
      }, packet.d.heartbeat_interval);
      socket.send(JSON.stringify({
        op: 2,
        d: {
          token: settings.get('discord.bot_token'),
          intents: enabled() ? 67 : 1,
          properties: { os: process.platform, browser: 'mvm-panel', device: 'mvm-panel' },
        },
      }));
      return;
    }
    if (packet.op === 1) {
      socket.send(JSON.stringify({ op: 1, d: null }));
      return;
    }
    if (packet.op === 7 || packet.op === 9) {
      socket.close();
      return;
    }
    if (packet.t === 'READY' || packet.t === 'GUILD_CREATE') {
      syncPanelCommands().catch((error) => logger.warn('[discord] Could not sync panel commands: ' + (error.response?.data?.message || error.message)));
      if (enabled()) {
        readGuildInvites().then((items) => {
          inviteUses.clear();
          for (const invite of items) inviteUses.set(invite.code, Number(invite.uses) || 0);
        }).catch((error) => logger.warn('[discord] Could not sync invites: ' + error.message));
      }
      return;
    }
    if (packet.t === 'INTERACTION_CREATE') {
      handlePanelInteraction(packet.d).catch((error) => logger.warn('[discord] Panel interaction failed: ' + error.message));
    }
    if (enabled() && packet.t === 'GUILD_MEMBER_ADD' && packet.d.guild_id === String(settings.get('discord.guild_id'))) {
      inviteSync = inviteSync
        .then(() => rememberMemberJoin(packet.d.user.id))
        .catch((error) => logger.warn('[discord] Could not record invite join: ' + error.message));
    }
    if (enabled() && packet.t === 'GUILD_MEMBER_UPDATE'
      && packet.d.guild_id === String(settings.get('discord.guild_id'))
      && packet.d.premium_since && packet.d.user?.id) {
      collections.users.findOne({ discord_id: String(packet.d.user.id) })
        .then((user) => user && awardBoostBolts(user.id, packet.d.premium_since))
        .catch((error) => logger.warn('[discord] Could not credit boost reward: ' + error.message));
    }
    if (enabled() && (packet.t === 'INVITE_CREATE' || packet.t === 'INVITE_DELETE')) {
      readGuildInvites().then((items) => {
        inviteUses.clear();
        for (const invite of items) inviteUses.set(invite.code, Number(invite.uses) || 0);
      }).catch((error) => logger.warn('[discord] Could not refresh invites: ' + error.message));
    }
  });
  socket.on('error', (error) => logger.warn('[discord] Gateway error: ' + error.message));
  socket.on('close', (code) => {
    clearInterval(heartbeatTimer);
    if (generation !== gatewayGeneration) return;
    gateway = null;
    if (shouldRunGateway() && configured()) {
      logger.warn(`[discord] Gateway disconnected (${code}); reconnecting in 5 seconds`);
      reconnectTimer = setTimeout(startGateway, 5000);
    }
  });
}

module.exports = {
  enabled,
  controlEnabled,
  configured,
  redirectUri,
  createOAuthState,
  linkDiscordAccount,
  getRewardStatus,
  startGateway,
  stopGateway,
};
