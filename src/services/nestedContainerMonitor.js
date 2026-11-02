const { collections } = require('../lib/db');
const sshService = require('./sshService');
const vmService = require('./vmService');
const activity = require('./activityService');
const logger = require('../lib/logger');

const SCAN_INTERVAL_MS = 30000;
const SSH_TIMEOUT_MS = 8000;
const MAX_CONCURRENT_CHECKS = 5;
const PACKAGE_CHECK = [
  "if command -v snap >/dev/null 2>&1 && snap list lxd >/dev/null 2>&1; then echo MVM_LXD_DETECTED; exit 0; fi",
  "if command -v dpkg-query >/dev/null 2>&1; then for pkg in lxd lxd-client lxc lxc-utils lxcfs; do status=$(dpkg-query -W -f='${db:Status-Status}' \"$pkg\" 2>/dev/null || true); if [ \"$status\" = installed ]; then echo MVM_LXD_DETECTED; exit 0; fi; done; fi",
  "if command -v rpm >/dev/null 2>&1; then for pkg in lxd lxc lxcfs; do if rpm -q \"$pkg\" >/dev/null 2>&1; then echo MVM_LXD_DETECTED; exit 0; fi; done; fi",
  'exit 1',
].join('; ');

let timer = null;
let scanRunning = false;
let stopped = false;
const lastConnectionWarning = new Map();

function nestedContainersForbidden(vm) {
  return vm.allow_nested_containers === false || vm.allow_nested_containers === 0 || vm.allow_nested_containers === '0';
}

async function suspendForNestedRuntime(vm) {
  const reason = 'Automatic suspension: an LXD/LXC container runtime was detected while nested containers are disabled.';
  const result = await collections.vms.updateOne(
    { id: Number(vm.id), allow_nested_containers: false, suspended: { $ne: true } },
    { $set: { suspended: true, suspension_reason: reason, suspended_at: new Date().toISOString(), updated_at: new Date().toISOString() } }
  );
  if (result.matchedCount !== 1) return;

  const suspendedVm = { ...vm, suspended: true };
  try {
    if (vmService.isRunning(suspendedVm)) await vmService.stop(suspendedVm, { force: true });
  } catch (error) {
    logger.error(`[nested-container] Could not stop VM ${vm.id} after LXD detection: ${error.message}`);
  }
  await activity.logActivity({
    user_id: null,
    vm_id: vm.id,
    event: 'vm:auto_suspend_nested_containers',
    details: { reason },
  });
  logger.warn(`[nested-container] VM ${vm.id} (${vm.name}) suspended after LXD/LXC runtime detection`);
}

async function inspectVm(vm) {
  if (!nestedContainersForbidden(vm) || vm.virtualization === 'lxc' || vm.suspended || !vmService.isRunning(vm)) return;
  const result = await sshService.withExec(vm, PACKAGE_CHECK, { timeout: SSH_TIMEOUT_MS });
  lastConnectionWarning.delete(Number(vm.id));
  if (result.stdout.includes('MVM_LXD_DETECTED')) await suspendForNestedRuntime(vm);
}

async function scan() {
  if (scanRunning || stopped) return;
  scanRunning = true;
  try {
    const vms = await collections.vms.find({
      virtualization: { $ne: 'lxc' },
      allow_nested_containers: false,
      suspended: { $ne: true },
    }).toArray();
    for (let index = 0; index < vms.length; index += MAX_CONCURRENT_CHECKS) {
      if (stopped) break;
      const batch = vms.slice(index, index + MAX_CONCURRENT_CHECKS);
      await Promise.all(batch.map(async (vm) => {
        try {
          await inspectVm(vm);
        } catch (error) {
          const vmId = Number(vm.id);
          const lastWarning = lastConnectionWarning.get(vmId) || 0;
          if (Date.now() - lastWarning >= 5 * 60 * 1000) {
            lastConnectionWarning.set(vmId, Date.now());
            logger.warn(`[nested-container] Cannot inspect VM ${vmId} over SSH; policy check will retry: ${error.message}`);
          }
        }
      }));
    }
  } catch (error) {
    logger.error('[nested-container] VM policy scan failed: ' + error.message);
  } finally {
    scanRunning = false;
    if (!stopped) timer = setTimeout(scan, SCAN_INTERVAL_MS);
  }
}

function start() {
  if (timer || scanRunning) return;
  stopped = false;
  scan();
}

function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { start, stop, scan };
