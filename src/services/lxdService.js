const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { settings } = require('../lib/db');

const proxies = new Map();
const LXD_POOL_PATTERN = /^[a-zA-Z0-9_.-]{1,63}$/;

function containerName(vm) {
  return String(vm.container_name || vm.id);
}

function poolName() {
  return String(settings.get('vm.lxd_storage_pool') || 'default');
}

function execute(args, { input, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('lxc', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`lxc ${args[0]} timed out after ${timeout} ms`));
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(`lxc ${args[0]} failed (${code}): ${(stderr || stdout).trim()}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function readiness() {
  if (!LXD_POOL_PATTERN.test(poolName())) return { ready: false, error: 'LXD storage pool name is invalid.' };
  const info = spawnSync('lxc', ['info'], { encoding: 'utf8', timeout: 5000 });
  if (info.error || info.status !== 0) {
    return { ready: false, error: 'LXD CLI/daemon is not available to the panel service account.' };
  }
  const pools = spawnSync('lxc', ['storage', 'list', '--format=json'], { encoding: 'utf8', timeout: 5000 });
  if (pools.error || pools.status !== 0) return { ready: false, error: 'Could not list LXD storage pools.' };
  let poolRows;
  try { poolRows = JSON.parse(pools.stdout); } catch (_) {
    return { ready: false, error: 'LXD returned invalid storage-pool data.' };
  }
  if (!Array.isArray(poolRows) || !poolRows.some((pool) => pool.name === poolName())) {
    return { ready: false, error: `LXD storage pool "${poolName()}" does not exist.` };
  }
  const profile = spawnSync('lxc', ['profile', 'show', 'default', '--format=json'], { encoding: 'utf8', timeout: 5000 });
  if (profile.error || profile.status !== 0) return { ready: false, error: 'Could not inspect the LXD default profile.' };
  try {
    const profileData = JSON.parse(profile.stdout);
    const devices = profileData.devices || {};
    if (!Object.values(devices).some((device) => device.type === 'disk' && device.path === '/')) {
      return { ready: false, error: 'LXD default profile needs a root disk device.' };
    }
    if (!Object.values(devices).some((device) => device.type === 'nic')) {
      return { ready: false, error: 'LXD default profile needs a network interface with working DHCP.' };
    }
  } catch (_) {
    return { ready: false, error: 'LXD returned invalid default-profile data.' };
  }
  return { ready: true, error: '' };
}

function isInstalled() {
  const result = spawnSync('which', ['lxc'], { stdio: 'ignore' });
  return result.status === 0;
}

function isReady() {
  return isInstalled() && readiness().ready;
}

async function instanceInfo(vm) {
  const output = await execute(['list', containerName(vm), '--format=json']);
  let instances;
  try { instances = JSON.parse(output); } catch (_) {
    throw new Error('LXD returned invalid instance status data.');
  }
  const instance = instances.find((item) => item.name === containerName(vm));
  if (!instance) return null;
  return instance;
}

function isRunning(vm) {
  const result = spawnSync('lxc', ['list', containerName(vm), '--format=json'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return false;
  try {
    const instance = JSON.parse(result.stdout).find((item) => item.name === containerName(vm));
    return String(instance?.status || '').toLowerCase() === 'running';
  } catch (_) {
    return false;
  }
}

function imageReference(vm) {
  const distro = String(vm.os_type || '').toLowerCase();
  const release = String(vm.codename || '').toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(release)) throw new Error('The selected operating-system release is invalid for LXD.');
  if (distro === 'ubuntu') return `ubuntu:${release}`;
  if (distro === 'debian') return `images:debian/${release}`;
  throw new Error(`LXD provisioning is not configured for ${vm.os_type || 'this operating system'}.`);
}

function parseDiskSize(value) {
  const match = String(value || '').match(/^([1-9]\d{0,4})([GM])$/i);
  if (!match) throw new Error('LXD disk size must be between 1 and 99999 GB or MB, such as 10G.');
  const unit = match[2].toUpperCase();
  return {
    bytes: Number(match[1]) * (unit === 'G' ? 1024 ** 3 : 1024 ** 2),
    lxdValue: `${match[1]}${unit === 'G' ? 'GB' : 'MB'}`,
  };
}

async function setMemoryLimit(name, memory) {
  if (!Number.isInteger(memory) || memory < 128 || memory > 1048576) {
    throw new Error('LXD memory must be between 128 and 1048576 MB.');
  }
  await execute(['config', 'set', name, 'limits.memory.enforce', 'hard']);
  await execute(['config', 'set', name, 'limits.memory', `${memory}MB`]);
}

function ipFromInstance(instance) {
  const networks = instance?.state?.network || {};
  for (const network of Object.values(networks)) {
    const address = (network.addresses || []).find((entry) => entry.family === 'inet' && entry.scope !== 'local');
    if (address) return address.address;
  }
  return null;
}

async function waitForIp(vm) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const instance = await instanceInfo(vm);
    const ip = ipFromInstance(instance);
    if (ip) return ip;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`LXD container ${containerName(vm)} did not receive an IPv4 address. Check the LXD default profile and DHCP network.`);
}

async function ensureProxy(vm, ip = null) {
  if (proxies.has(Number(vm.id))) return;
  const target = ip || await waitForIp(vm);
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: target, port: 22 });
    client.setTimeout(300000);
    upstream.setTimeout(300000);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('timeout', () => client.destroy());
    upstream.on('timeout', () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(vm.ssh_port), '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  proxies.set(Number(vm.id), server);
}

async function closeProxy(vm) {
  const server = proxies.get(Number(vm.id));
  if (!server) return;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  proxies.delete(Number(vm.id));
}

async function start(vm) {
  const instance = await instanceInfo(vm);
  if (!instance) throw new Error(`LXD container ${containerName(vm)} does not exist.`);
  if (String(instance.status).toLowerCase() !== 'running') {
    await execute(['start', containerName(vm)], { timeout: 120000 });
  }
  const ip = await waitForIp(vm);
  await ensureProxy(vm, ip);
}

async function stop(vm, { force = false } = {}) {
  try {
    const instance = await instanceInfo(vm);
    if (instance && String(instance.status).toLowerCase() === 'running') {
      await execute(force
        ? ['stop', containerName(vm), '--force']
        : ['stop', containerName(vm), '--timeout=15'], { timeout: 30000 });
    }
  } finally {
    await closeProxy(vm);
  }
}

async function create(vm) {
  const ready = readiness();
  if (!ready.ready) throw new Error(`LXD is not ready: ${ready.error} Configure LXD before creating containers.`);
  const name = containerName(vm);
  if (!/^[a-zA-Z0-9_.-]{1,63}$/.test(name)) throw new Error('Invalid LXD container name.');
  const image = imageReference(vm);
  const disk = parseDiskSize(vm.disk_size);
  if (!vm.password || /[\r\n:]/.test(vm.password)) throw new Error('Container password must not contain colons or line breaks.');
  let created = false;
  try {
    await execute(['init', image, name, '--storage', poolName()], { timeout: 900000 });
    created = true;
    const memory = Number(vm.memory);
    await setMemoryLimit(name, memory);
    await execute(['config', 'set', name, 'limits.cpu', String(Math.max(1, Number(vm.cpus) || 1))]);
    await execute(['config', 'set', name, 'security.nesting', 'true']);
    await execute(['config', 'device', 'set', name, 'root', 'size', disk.lxdValue]);
    await start(vm);
    await execute(['exec', name, '--', 'sh', '-lc', [
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update',
      'apt-get install -y openssh-server',
      'mkdir -p /etc/ssh/sshd_config.d',
      "printf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/99-mvm-panel.conf",
      'mkdir -p /run/sshd',
      '(systemctl enable ssh 2>/dev/null || systemctl enable sshd 2>/dev/null || true)',
      '(systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart)',
    ].join(' && ')], { timeout: 600000 });
    await execute(['exec', name, '--', 'chpasswd'], { input: `root:${vm.password}\n` });
    await stop(vm);
  } catch (error) {
    if (created) {
      try {
        await stop(vm, { force: true });
        await execute(['delete', name, '--force'], { timeout: 120000 });
      } catch (cleanupError) {
        throw new Error(`${error.message} Cleanup also failed for LXD container ${name}: ${cleanupError.message}`);
      }
    }
    throw error;
  }
}

async function resizeDisk(vm, newSize) {
  const current = parseDiskSize(vm.disk_size);
  const next = parseDiskSize(newSize);
  if (next.bytes < current.bytes) throw new Error('LXD container disks can only be expanded, not shrunk.');
  if (next.bytes === current.bytes) return;
  await execute(['config', 'device', 'set', containerName(vm), 'root', 'size', next.lxdValue]);
}

async function updateResources(vm, data) {
  if (isRunning(vm)) throw new Error('Stop the LXD container before changing its resources.');
  const cpus = data.cpus === undefined ? Number(vm.cpus) : Number(data.cpus);
  const memory = data.memory === undefined ? Number(vm.memory) : Number(data.memory);
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 256) throw new Error('LXD CPU count must be between 1 and 256.');
  if (data.disk_size !== undefined) await resizeDisk(vm, data.disk_size);
  await setMemoryLimit(containerName(vm), memory);
  await execute(['config', 'set', containerName(vm), 'limits.cpu', String(cpus)]);
}

async function destroy(vm) {
  await stop(vm, { force: true });
  const instance = await instanceInfo(vm);
  if (instance) await execute(['delete', containerName(vm), '--force'], { timeout: 120000 });
}

async function reconcile(vms) {
  for (const vm of vms) {
    try {
      if (isRunning(vm)) await ensureProxy(vm);
    } catch (error) {
      throw new Error(`Could not restore LXD SSH forwarding for ${vm.name}: ${error.message}`);
    }
  }
}

async function createBackup(vm, destination) {
  await execute(['export', containerName(vm), destination], { timeout: 900000 });
}

async function restoreBackup(vm, backupFile) {
  const name = containerName(vm);
  const oldName = `mvm-restore-${String(vm.id)}-${Date.now()}`;
  await stop(vm, { force: true });
  await execute(['rename', name, oldName], { timeout: 120000 });
  try {
    await execute(['import', backupFile], { timeout: 900000 });
  } catch (error) {
    try { await execute(['rename', oldName, name], { timeout: 120000 }); } catch (rollbackError) {
      throw new Error(`${error.message} The previous container is preserved as ${oldName}; restoring its original name failed: ${rollbackError.message}`);
    }
    throw error;
  }
  await execute(['delete', oldName, '--force'], { timeout: 120000 });
}

module.exports = {
  create, start, stop, destroy, isRunning, resizeDisk, updateResources,
  reconcile, createBackup, restoreBackup, isInstalled, isReady, readiness,
};
