#!/usr/bin/env node
const { bootstrap } = require('./app');
const logger = require('./lib/logger');

process.title = 'mvm-panel';

(async () => {
  try {
    const { io } = await bootstrap();

    const shutdown = () => {
      logger.info('[panel] shutting down');
      if (io) io.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    logger.error('[panel] bootstrap error: ' + (err.stack || err));
    process.exit(1);
  }
})();

process.on('uncaughtException', (e) => {
  logger.error('[panel] uncaught exception: ' + e.stack);
});

process.on('unhandledRejection', (e) => {
  logger.error('[panel] unhandled rejection: ' + (e && e.stack || e));
});
