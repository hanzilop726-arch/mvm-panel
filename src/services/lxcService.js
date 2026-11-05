const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../lib/config');
const { settings } = require('../lib/db');

const proxies = new Map();
const REQUIRED_BINARIES = [
  'lxc-create', 'lxc-info', 'lxc-start', 'lxc-stop', 'lxc-attach', 'lxc-destroy',
  'truncate', 'mkfs.ext4', 'mount', 'cp', 'umount', 'resize2fs',
];
const execFile = (file, args, options = {}) => new Promise((resolve, reject) => {
  const { input, ...spawnOptions } = options;
  const executable = findExecutable(file);
  if (!executable) return reject(new Error(`${file} is not available in the panel service PATH.`));
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], ...spawnOptions });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) return resolve(stdout.trim());
    reject(new Error(`${file} failed (${code}): ${stderr.trim() || stdout.trim()}`));
  });
  if (input) child.stdin.end(input);
  else child.stdin.end();
});

function containerName(vm) {
  return String(vm.container_name || vm.id);
}

function baseArgs(vm) {
  return ['-P', config.vmDir, '-n', containerName(vm)];
}

function findExecutable(command) {
  const fs = require('fs');
  const path = require('path');
  const searchPath = [...String(process.env.PATH || '').split(path.delimiter), '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
  for (const directory of new Set(searchPath.filter(Boolean))) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {}
  }
  return null;
}

function isInstalled() {
  return REQUIRED_BINARIES.every((binary) => findExecutable(binary));
}

function cgroupVersion() {
  const fs = require('fs');
  if (fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) {
    const controllers = fs.readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8').trim().split(/\s+/);
    if (controllers.includes('memory') && controllers.includes('cpu')) return 2;
    return null;
  }
  try {
    const controllers = fs.readFileSync('/proc/cgroups', 'utf8');
    const enabled = new Set(controllers.split('\n')
      .filter((line) => !line.startsWith('#'))
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[3] === '1')
      .map((fields) => fields[0]));
    if (enabled.has('memory') && enabled.has('cpu')) return 1;
  } catch (_) {}
  return null;
}

function readiness() {
  const missingBinaries = REQUIRED_BINARIES.filter((binary) => !findExecutable(binary));
  if (missingBinaries.length) {
    return { ready: false, error: `Missing required classic LXC tools: ${missingBinaries.join(', ')}.` };
  }
  const version = cgroupVersion();
  if (!version) return { ready: false, error: 'The host must enable both CPU and memory cgroup controllers (cgroup v1 or v2).' };
  try {
    require('fs').accessSync(config.vmDir, require('fs').constants.W_OK);
  } catch (_) {
    return { ready: false, error: `The panel service cannot write to the LXC directory: ${config.vmDir}.` };
  }
  return { ready: true, error: '', cgroupVersion: version };
}

function isReady() {
  return readiness().ready;
}

function isRunning(vm) {
  const executable = findExecutable('lxc-info');
  if (!executable) return false;
  const result = require('child_process').spawnSync(executable, [...baseArgs(vm), '-sH'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === 'RUNNING';
}

function osRelease(vm) {
  const distro = String(vm.os_type || '').toLowerCase();
  const release = String(vm.codename || '').toLowerCase();
  if (['ubuntu', 'debian'].includes(distro) && /^[a-z0-9._-]+$/.test(release)) {
    return { distro, release };
  }
  throw new Error(`LXC provisioning is not configured for ${vm.os_type || 'this operating system'}`);
}

function resourceLimitConfig(memory, cpus, version) {
  if (!Number.isInteger(memory) || memory < 128 || memory > 1048576) {
    throw new Error('LXC memory must be between 128 and 1048576 MB.');
  }
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 256) {
    throw new Error('LXC CPU count must be between 1 and 256.');
  }
  if (version === 2) {
    return [
      `lxc.cgroup2.memory.max = ${memory * 1024 * 1024}`,
      `lxc.cgroup2.cpu.max = ${cpus * 100000} 100000`,
    ];
  }
  return [
    `lxc.cgroup.memory.limit_in_bytes = ${memory * 1024 * 1024}`,
    `lxc.cgroup.cpu.cfs_period_us = 100000`,
    `lxc.cgroup.cpu.cfs_quota_us = ${cpus * 100000}`,
  ];
}

function setResourceLimitConfig(contents, memory, cpus, version) {
  const keys = [
    'lxc.cgroup.memory.limit_in_bytes', 'lxc.cgroup2.memory.max',
    'lxc.cgroup.cpu.cfs_period_us', 'lxc.cgroup.cpu.cfs_quota_us', 'lxc.cgroup2.cpu.max',
  ];
  const withoutOldLimits = contents.split(/\r?\n/).filter((line) => {
    const key = line.split('=')[0].trim();
    return !keys.includes(key);
  }).join('\n').trimEnd();
  return `${withoutOldLimits}\n${resourceLimitConfig(memory, cpus, version).join('\n')}\n`;
}

function withMemoryInfoMount(contents) {
  const source = '/var/lib/lxcfs/proc/meminfo';
  const mount = `lxc.mount.entry = ${source} proc/meminfo none bind,ro,create=file 0 0`;
  if (!fs.existsSync(source) || contents.split(/\r?\n/).some((line) => line.trim() === mount)) return contents;
  return `${contents.trimEnd()}\n${mount}\n`;
}

function writeResourceConfig(vm) {
  const ready = readiness();
  if (!ready.ready) throw new Error(`Classic LXC is not ready: ${ready.error}`);
  const configPath = path.join(config.vmDir, containerName(vm), 'config');
  const contents = fs.readFileSync(configPath, 'utf8');
  const limitedConfig = setResourceLimitConfig(contents, Number(vm.memory), Number(vm.cpus), ready.cgroupVersion);
  fs.writeFileSync(configPath, withMemoryInfoMount(limitedConfig));
}

async function createRootfsImage(vm, directory) {
  const size = String(vm.disk_size || '');
  const match = size.match(/^([1-9]\d{0,4})([GM])$/i);
  if (!match) throw new Error('LXC disk size must be between 1 and 99999 GB or MB, such as 10G');
  const image = path.join(directory, 'rootfs.img');
  const rootfs = path.join(directory, 'rootfs');
  const mountpoint = path.join(directory, 'rootfs-limited');
  const rootfsConfig = `lxc.rootfs.path = loop:${image}`;
  await execFile('truncate', ['-s', `${match[1]}${match[2].toUpperCase()}`, image]);
  await execFile('mkfs.ext4', ['-F', '-m', '0', image]);
  fs.mkdirSync(mountpoint, { recursive: true });
  let mounted = false;
  try {
    await execFile('mount', ['-o', 'loop', image, mountpoint]);
    mounted = true;
    await execFile('cp', ['-a', `${rootfs}/.`, mountpoint]);
  } finally {
    if (mounted) await execFile('umount', [mountpoint]);
    try { fs.rmSync(mountpoint, { recursive: true, force: true }); } catch (_) {}
  }
  fs.rmSync(rootfs, { recursive: true, force: true });
  const configPath = path.join(directory, 'config');
  const current = fs.readFileSync(configPath, 'utf8');
  const updated = /^lxc\.rootfs\.path\s*=.*$/m.test(current)
    ? current.replace(/^lxc\.rootfs\.path\s*=.*$/m, rootfsConfig)
    : `${current}\n${rootfsConfig}\n`;
  fs.writeFileSync(configPath, updated);
}

async function create(vm) {
  const ready = readiness();
  if (!ready.ready) throw new Error(`Classic LXC is not ready: ${ready.error}`);
  const { distro, release } = osRelease(vm);
  const name = containerName(vm);
  const directory = path.join(config.vmDir, name);
  if (fs.existsSync(directory)) throw new Error(`LXC container ${name} already exists`);

  await execFile('lxc-create', [
    '-P', config.vmDir, '-n', name, '-t', 'download', '--',
    '-d', distro, '-r', release, '-a', 'amd64',
  ]);

  try {
    await createRootfsImage(vm, directory);
    const bridge = String(settings.get('vm.lxc_bridge') || 'lxcbr0');
    if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(bridge)) throw new Error('Invalid LXC bridge name');
    fs.appendFileSync(path.join(directory, 'config'), [
      '',
      'lxc.net.0.type = veth',
      `lxc.net.0.link = ${bridge}`,
      'lxc.net.0.flags = up',
      '',
    ].join('\n'));
    writeResourceConfig(vm);
    await start(vm);
    await waitForIp(vm);
    await execFile('lxc-attach', [...baseArgs(vm), '--clear-env', '--', 'sh', '-lc',
      'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y openssh-server && (systemctl enable ssh 2>/dev/null || systemctl enable sshd 2>/dev/null || true); mkdir -p /run/sshd; sed -i "s/^#\\?PermitRootLogin.*/PermitRootLogin yes/" /etc/ssh/sshd_config; sed -i "s/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/" /etc/ssh/sshd_config; (systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart)']);
    if (!vm.password || /[\r\n:]/.test(vm.password)) throw new Error('Password must not contain colons or line breaks');
    await execFile('lxc-attach', [...baseArgs(vm), '--', 'chpasswd'], { input: `root:${vm.password}\n` });
    await stop(vm);
  } catch (error) {
    try { await stop(vm); } catch (_) {}
    try { await destroy(vm); } catch (_) {}
    throw error;
  }
}

function diskBytes(value) {
  const match = String(value || '').match(/^([1-9]\d{0,4})([GM])$/i);
  if (!match) throw new Error('LXC disk size must be between 1 and 99999 GB or MB, such as 10G');
  return Number(match[1]) * (match[2].toUpperCase() === 'G' ? 1024 ** 3 : 1024 ** 2);
}

async function resizeDisk(vm, newSize) {
  if (isRunning(vm)) throw new Error('Stop the LXC container before resizing its disk.');
  const currentBytes = diskBytes(vm.disk_size);
  const newBytes = diskBytes(newSize);
  if (newBytes < currentBytes) throw new Error('LXC disks can only be expanded, not shrunk.');
  if (newBytes === currentBytes) return;
  const image = path.join(config.vmDir, containerName(vm), 'rootfs.img');
  await execFile('truncate', ['-s', String(newSize).toUpperCase(), image]);
  await execFile('resize2fs', [image]);
}

async function updateResources(vm, data) {
  if (isRunning(vm)) throw new Error('Stop the LXC container before changing its resources.');
  const cpus = data.cpus === undefined ? Number(vm.cpus) : Number(data.cpus);
  const memory = data.memory === undefined ? Number(vm.memory) : Number(data.memory);
  const ready = readiness();
  if (!ready.ready) throw new Error(`Classic LXC is not ready: ${ready.error}`);
  resourceLimitConfig(memory, cpus, ready.cgroupVersion);
  if (data.disk_size !== undefined) await resizeDisk(vm, data.disk_size);
  writeResourceConfig({ ...vm, memory, cpus });
}

async function start(vm) {
  const state = await status(vm);
  if (state === 'RUNNING') {
    const ip = await waitForIp(vm);
    await ensureProxy(vm, ip);
    return;
  }
  writeResourceConfig(vm);
  await execFile('lxc-start', [...baseArgs(vm), '-d']);
  const ip = await waitForIp(vm);
  await ensureProxy(vm, ip);
}

async function waitForIp(vm) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const out = await execFile('lxc-info', [...baseArgs(vm), '-iH']);
      const ip = out.split(/\s+/).find((candidate) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate));
      if (ip) return ip;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`LXC container ${containerName(vm)} did not receive an IPv4 address. Check the configured bridge.`);
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

async function stop(vm, { force = false } = {}) {
  try {
    const state = await status(vm);
    if (state === 'RUNNING') {
      await execFile('lxc-stop', [...baseArgs(vm), ...(force ? ['-k'] : ['-t', '15'])]);
    }
  } finally {
    const server = proxies.get(Number(vm.id));
    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      proxies.delete(Number(vm.id));
    }
  }
}

async function status(vm) {
  try {
    return await execFile('lxc-info', [...baseArgs(vm), '-sH']);
  } catch (error) {
    if (/does not exist|not found|No such file/i.test(error.message)) return 'STOPPED';
    throw error;
  }
}

async function destroy(vm) {
  try {
    await stop(vm);
    await execFile('lxc-destroy', [...baseArgs(vm), '-f']);
  } catch (error) {
    if (!fs.existsSync(path.join(config.vmDir, containerName(vm)))) return;
    throw error;
  }
}

async function reconcile(vms) {
  for (const vm of vms) {
    try {
      if (await status(vm) === 'RUNNING') await ensureProxy(vm);
    } catch (error) {
      throw new Error(`Could not restore LXC SSH forwarding for ${vm.name}: ${error.message}`);
    }
  }
}

module.exports = {
  create, start, stop, destroy, status, reconcile, isInstalled, isReady, readiness,
  isRunning, resizeDisk, updateResources,
};
