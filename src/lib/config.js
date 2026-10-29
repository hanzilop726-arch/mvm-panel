const path = require('path');
require('dotenv').config();

const root = path.resolve(__dirname, '..', '..');

const config = {
  root,
  panelPort: parseInt(process.env.PANEL_PORT || '3001', 10),
  apiPort: parseInt(process.env.API_PORT || '3002', 10),
  panelUrl: process.env.PANEL_URL || `http://localhost:${parseInt(process.env.PANEL_PORT || '3001', 10)}`,
  jwtSecret: process.env.JWT_SECRET || 'mvm-panel-insecure-secret-change-me',
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  mongoUri: process.env.MONGO_URI || 'mongodb://admin:password123@127.0.0.1:27017/vpanel?authSource=admin',
  dbPath: path.resolve(root, process.env.DB_PATH || 'data/vpanel.db'),
  vmDir: path.resolve(root, process.env.VM_DIR || 'vms'),
  autoPortMin: parseInt(process.env.AUTO_PORT_MIN || '25501', 10),
  autoPortMax: parseInt(process.env.AUTO_PORT_MAX || '25600', 10),
  autoVncPortMin: parseInt(process.env.AUTO_VNC_PORT_MIN || '25901', 10),
  autoVncPortMax: parseInt(process.env.AUTO_VNC_PORT_MAX || '26000', 10),
  autoAgentPortMin: parseInt(process.env.AUTO_AGENT_PORT_MIN || '26101', 10),
  autoAgentPortMax: parseInt(process.env.AUTO_AGENT_PORT_MAX || '26200', 10),
  allowRegister: String(process.env.ALLOW_REGISTER || '1') === '1',
  logLevel: process.env.LOG_LEVEL || 'info',
  uploads: {
    dir: path.resolve(root, 'public/uploads'),
    logo: path.resolve(root, 'public/uploads/logo'),
    favicon: path.resolve(root, 'public/uploads/favicon'),
    background: path.resolve(root, 'public/uploads/background'),
    music: path.resolve(root, 'public/uploads/music'),
    avatar: path.resolve(root, 'public/uploads/avatar'),
    backup: path.resolve(root, 'storage/backups'),
  },
  mail: {
    host: process.env.MAIL_HOST || '',
    port: parseInt(process.env.MAIL_PORT || '587', 10),
    secure: String(process.env.MAIL_SECURE || 'false') === 'true',
    user: process.env.MAIL_USER || '',
    pass: process.env.MAIL_PASS || '',
    from: process.env.MAIL_FROM || 'MVM Panel <no-reply@mvm-panel.local>',
  },
  wallpaperApiKey: process.env.WALLPAPERS_API_KEY || '',
};

module.exports = config;
