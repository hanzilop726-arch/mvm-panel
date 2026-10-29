const { initDb, closeDb } = require('../src/lib/db');
const auth = require('../src/services/authService');

(async () => {
  const { db, collections, settings } = await initDb();

  // Set default theme to dark
  await settings.set('panel.theme', 'dark');
  console.log('[✔] Set default theme to dark');

  // Set default view to vm/all
  await settings.set('panel.defaultView', 'vm/all');
  console.log('[✔] Set default view to vm/all');

  // Set default terminal size to 169x33
  await settings.set('panel.terminalSize', { width: 169, height: 33 });
  console.log('[✔] Set default terminal size to 169x33');

  // Create a default resource user if it doesn't exist
  const resourceUsername = 'resource';
  const resourceEmail = 'resource@mvm-panel.local';
  const resourcePassword = 'ResourcePass123!'; // In a real scenario, this should be generated and displayed
  const resourceName = 'Resource User';

  try {
    const existing = await collections.users.findOne({ 
      $or: [{ username: resourceUsername }, { email: resourceEmail }] 
    });
    if (existing) {
      // Update to ensure it's a resource user (if we have a role field)
      // Assuming we have a role field, set it to 'resource' or similar
      // For now, we just note it exists
      console.log(`[ℹ] Resource user '${resourceUsername}' already exists`);
    } else {
      // Create the resource user
      const u = await auth.createUser({ 
        username: resourceUsername, 
        email: resourceEmail, 
        password: resourcePassword, 
        name: resourceName, 
        role: 'resource', // Assuming there is a role 'resource'
        verified: 1 
      });
      console.log(`[✔] Created resource user '${resourceUsername}'`);
      console.log(`    Email: ${resourceEmail}`);
      console.log(`    Password: ${resourcePassword}`); // In production, do not output password
    }
  } catch (err) {
    console.error('[✖] Failed to create resource user:', err.message);
  }

  await closeDb();
  console.log('[✔] Feature setup completed via database settings');
  console.log('')
  console.log('=== MANUAL STEPS REQUIRED FOR FULL FEATURE SET ===')
  console.log('1. Add SSH Terminal/Novnc/Live Boot Logs tabs to the console UI')
  console.log('2. Modify SSH Terminal to support multi-sessions (+/-) and 24/7 connection')
  console.log('3. Add the template from https://github.com/nobita329/Template.git to the template library')
  console.log('4. Implement VM live status display in the console')
  console.log('')
  console.log('Note: The above manual steps require code changes to the panel source.')
  console.log('After making those changes, run: npm run build && pm2 restart all')
})().catch(err => {
  console.error('[✖] Setup failed:', err);
  process.exit(1);
});