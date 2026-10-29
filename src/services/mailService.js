const nodemailer = require('nodemailer');
const config = require('../lib/config');
const { settings } = require('../lib/db');
const logger = require('../lib/logger');

let transporter = null;

function configured() {
  const host = settings.get('mail.host') || config.mail.host;
  return Boolean(host);
}

function getTransporter() {
  if (transporter) return transporter;
  const host = settings.get('mail.host') || config.mail.host;
  if (!host) return null;
  transporter = nodemailer.createTransport({
    host,
    port: parseInt(settings.get('mail.port') || config.mail.port, 10),
    secure: settings.get('mail.secure') === true || settings.get('mail.secure') === 'true',
    auth: settings.get('mail.user')
      ? { user: settings.get('mail.user'), pass: settings.get('mail.pass') }
      : undefined,
    tls: { rejectUnauthorized: false },
  });
  return transporter;
}

async function send({ to, subject, html, text }) {
  const tr = getTransporter();
  const from = settings.get('mail.from') || config.mail.from;
  if (!tr) {
    logger.info(`[mail] SMTP not configured, skipping mail to ${to} (subject: ${subject})`);
    return false;
  }
  try {
    await tr.sendMail({ from, to, subject, html, text });
    logger.info(`[mail] Sent "${subject}" to ${to}`);
    return true;
  } catch (e) {
    logger.error('[mail] send failed:', e.message);
    return false;
  }
}

function sendVerifyEmail(user, token) {
  const url = `${config.panelUrl}/verify?token=${token}`;
  return send({
    to: user.email,
    subject: `${settings.get('panel.name') || 'MVM Panel'} - Verify your email`,
    html: `<h2>Welcome to ${settings.get('panel.name') || 'MVM Panel'}</h2><p>Click the button below to verify your email address:</p><a style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none" href="${url}">Verify Email</a><p>If the button does not work, open: <a href="${url}">${url}</a></p>`,
  });
}

function sendResetEmail(user, token) {
  const url = `${config.panelUrl}/reset?token=${token}`;
  return send({
    to: user.email,
    subject: `${settings.get('panel.name') || 'MVM Panel'} - Password reset`,
    html: `<h2>Password reset</h2><p>Click below to reset your password. This link expires in 1 hour.</p><a style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none" href="${url}">Reset Password</a><p>If the button does not work, open: <a href="${url}">${url}</a></p>`,
  });
}

function sendNotify(user, title, body) {
  return send({
    to: user.email,
    subject: title,
    html: `<p>${body}</p>`,
  });
}

module.exports = { configured, send, sendVerifyEmail, sendResetEmail, sendNotify };
