#!/usr/bin/env bash
set -e

echo "========================================="
echo "  Starting MVM Panel Container Service  "
echo "========================================="

# Detect KVM availability
if [ "$NO_KVM" = "1" ] || [ "$NOKVM" = "1" ] || [ ! -e "/dev/kvm" ]; then
  echo "[MVM Panel] Operating Mode: No-KVM (QEMU TCG Software Emulation)"
  export NO_KVM=1
else
  echo "[MVM Panel] Operating Mode: KVM Hardware Accelerated (/dev/kvm)"
  export NO_KVM=0
fi

# Ensure persistent storage directories exist
mkdir -p /app/data /app/vms /app/uploads/logo /app/uploads/favicon /app/uploads/background /app/uploads/music /app/uploads/backup /app/storage/logs

# Run build / directory initialization
node scripts/build.js

if [ -f "/app/scripts/createuser.js" ]; then
  node -e "
    const { initDb, closeDb, collections } = require('./src/lib/db');
    const auth = require('./src/services/authService');
    (async () => {
      await initDb();
      const count = await collections.users.countDocuments();
      if (count === 0) {
        console.log('[MVM Panel] Creating default administrator user: admin / admin123');
        const u = await auth.createUser({
          username: process.env.ADMIN_USER || 'admin',
          email: process.env.ADMIN_EMAIL || 'admin@mvm-panel.local',
          password: process.env.ADMIN_PASSWORD || 'admin123',
          name: 'Administrator',
          role: 'admin',
          verified: 1
        });
        await collections.users.updateOne({ id: u.id }, { $set: { root_admin: 1 } });
      }
      await closeDb();
    })().catch(console.error);
  " || true
fi

echo "[MVM Panel] Ready on port 3001 (Web) and port 3002 (API)"
exec "$@"
