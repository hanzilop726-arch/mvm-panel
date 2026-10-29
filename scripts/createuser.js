#!/usr/bin/env node
/**
 * MVM Panel user creator
 * Usage:
 *   npm run createuser
 *   npm run createuser -- --username admin --email a@b.c --password secret --role admin
 *   CREATEUSER_USERNAME=... CREATEUSER_PASSWORD=... npm run createuser
 */
const readline = require('readline');
const config = require('../src/lib/config');
const { initDb, closeDb, collections } = require('../src/lib/db');
const authService = require('../src/services/authService');
const logger = require('../src/lib/logger');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q, def) {
  return new Promise((resolve) => {
    rl.question(def ? `${q} (default: ${def}): ` : `${q}: `, (a) => resolve(a.trim() || def));
  });
}

async function main() {
  await initDb();
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true;
      args[k] = v;
      if (v !== true) i++;
    }
  }

  const username = args.username || process.env.CREATEUSER_USERNAME || (await ask('Username', process.env.ADMIN_USERNAME || 'admin'));
  const email = args.email || process.env.CREATEUSER_EMAIL || (await ask('Email', process.env.ADMIN_EMAIL || 'admin@mvm-panel.local'));
  const password = args.password || process.env.CREATEUSER_PASSWORD || (await ask('Password', process.env.ADMIN_PASSWORD || 'admin12345'));
  const role = args.role || 'admin';
  const name = args.name || username;

  const existing = await authService.findByUsername(username);
  if (existing) {
    const ans = await ask('User already exists. Update password and promote to admin? (y/N)', 'n');
    if (ans.toLowerCase() === 'y') {
      await authService.updateUser(existing.id, { password, role, root_admin: 1 });
      logger.info(`[createuser] Updated ${username} (admin)`);
      return;
    }
    logger.error('[createuser] User already exists, aborting.');
    process.exit(1);
  }

  try {
    const user = await authService.createUser({ username, email, password, name, role, verified: true });
    if (role === 'admin') {
      await collections.users.updateOne({ id: user.id }, { $set: { root_admin: 1 } });
    }
    logger.info(`[createuser] Created ${role} user: ${username} <${email}>`);
  } catch (e) {
    logger.error('[createuser] ' + e.message);
    process.exit(1);
  }
}

main().finally(async () => {
  await closeDb();
  rl.close();
});
