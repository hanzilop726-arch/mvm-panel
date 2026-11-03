const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { collections, getNextId } = require('../lib/db');
const config = require('../lib/config');
const logger = require('../lib/logger');
const vmService = require('./vmService');
const lxdService = require('./lxdService');
const { logActivity } = require('./activityService');

const BACKUP_DIR = config.uploads.backup;
fs.mkdirSync(BACKUP_DIR, { recursive: true });

async function listForVm(vmId) {
  return collections.backups.find({ vm_id: Number(vmId) }).sort({ id: -1 }).toArray();
}

async function listAll() {
  const backups = await collections.backups.find().sort({ id: -1 }).toArray();
  if (!backups.length) return [];
  const vmIds = [...new Set(backups.map((b) => b.vm_id))];
  const vms = await collections.vms.find({ id: { $in: vmIds } }).toArray();
  const vmMap = new Map(vms.map((v) => [v.id, v.name]));
  return backups.map((b) => ({ ...b, vm_name: vmMap.get(b.vm_id) || 'Unknown' }));
}

async function createBackup(vm, { user = null, name = null, kind = 'full' } = {}) {
  const isLxc = vm.virtualization === 'lxc';
  if (isLxc && vmService.isRunning(vm)) {
    throw new Error('Stop the LXC container before creating a consistent backup.');
  }
  if (!isLxc && vmService.isRunning(vm)) {
    logger.info('[backup] VM is running; taking qemu snapshot');
  }
  const label = name || `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const vmBackupDir = path.join(BACKUP_DIR, String(vm.id));
  fs.mkdirSync(vmBackupDir, { recursive: true });
  const isLxd = isLxc && vm.lxc_driver === 'lxd';
  const dest = path.join(vmBackupDir, `${label}.${isLxd ? 'tar.gz' : isLxc ? 'img' : 'qcow2'}`);
  if (isLxc) {
    if (isLxd) {
      await lxdService.createBackup(vm, dest);
    } else {
      const source = path.join(vmService.vmDir(vm), 'rootfs.img');
      const r = spawnSync('cp', ['--sparse=always', source, dest], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr || 'LXC backup copy failed');
    }
  } else {
    const r = spawnSync('qemu-img', ['convert', '-U', '-O', 'qcow2', vm.img_file, dest], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || 'Backup conversion failed');
  }
  const size = fs.statSync(dest).size;
  const id = await getNextId('backups');
  const doc = {
    id,
    vm_id: Number(vm.id),
    name: label,
    file: dest,
    size,
    kind,
    virtualization: vm.virtualization || 'kvm',
    lxc_driver: isLxc ? (vm.lxc_driver || 'legacy') : undefined,
    created_at: new Date().toISOString(),
  };
  await collections.backups.insertOne(doc);
  await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'backup:create', details: { name: label } });
  return doc;
}

async function restoreBackup(backup, { user = null } = {}) {
  const vm = await vmService.getVm(backup.vm_id);
  if (!vm) throw new Error('VM not found');
  if ((backup.virtualization || 'kvm') !== (vm.virtualization || 'kvm')) throw new Error('Backup virtualization type does not match this server');
  if (vm.virtualization === 'lxc' && (backup.lxc_driver || 'legacy') !== (vm.lxc_driver || 'legacy')) {
    throw new Error('Backup container driver does not match this server.');
  }
  if (vmService.isRunning(vm)) {
    await vmService.stop(vm, { user, force: true });
  }
  if (!fs.existsSync(backup.file)) throw new Error('Backup file missing');
  if (vm.virtualization === 'lxc' && vm.lxc_driver === 'lxd') {
    await lxdService.restoreBackup(vm, backup.file);
    await collections.vms.updateOne({ id: Number(vm.id) }, { $set: { updated_at: new Date().toISOString() } });
    await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'backup:restore', details: { name: backup.name } });
    return true;
  }
  const target = vm.virtualization === 'lxc'
    ? path.join(vmService.vmDir(vm), 'rootfs.img')
    : vm.img_file;
  const tmp = target + '.restore';
  fs.copyFileSync(backup.file, tmp);
  fs.renameSync(tmp, target);
  await collections.vms.updateOne({ id: Number(vm.id) }, { $set: { updated_at: new Date().toISOString() } });
  await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'backup:restore', details: { name: backup.name } });
  return true;
}

async function deleteBackup(backup, { user = null } = {}) {
  try { fs.unlinkSync(backup.file); } catch (_) {}
  try {
    fs.rmdirSync(path.dirname(backup.file));
  } catch (_) {}
  await collections.backups.deleteOne({ id: Number(backup.id) });
  await logActivity({ user_id: user ? user.id : null, vm_id: backup.vm_id, event: 'backup:delete', details: { name: backup.name } });
  return true;
}

async function pruneBackups(vmId, keep = 5) {
  const rows = await collections.backups.find({ vm_id: Number(vmId) }).sort({ id: -1 }).toArray();
  if (rows.length <= keep) return;
  for (const b of rows.slice(keep)) {
    await deleteBackup(b);
  }
}

module.exports = { listForVm, listAll, createBackup, restoreBackup, deleteBackup, pruneBackups };
