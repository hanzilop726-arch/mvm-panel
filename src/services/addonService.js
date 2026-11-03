const sshService = require('./sshService');
const vmService = require('./vmService');

const ADDONS = new Set(['sshx', 'tailscale', 'docker']);

function commandError(result, label) {
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-4000);
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
}

async function run(vm, command, timeout = 30000) {
  const result = await sshService.withExec(vm, command, { timeout });
  commandError(result, 'Remote command');
  return result.stdout.trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function runAsRoot(vm, command, timeout = 300000) {
  const uid = await run(vm, 'id -u');
  const rootCommand = uid === '0' ? command : `sudo -n sh -c ${shellQuote(command)}`;
  if (uid !== '0') await run(vm, 'sudo -n true');
  const result = await sshService.withExec(vm, rootCommand, { timeout });
  commandError(result, 'Privileged installation');
  return result.stdout.trim();
}

function assertSupported(vm, addon) {
  if (!ADDONS.has(addon)) {
    const error = new Error('Unsupported add-on.');
    error.statusCode = 400;
    throw error;
  }
  if (vm.suspended) {
    const error = new Error('This server is suspended. Ask an administrator to unsuspend it first.');
    error.statusCode = 409;
    throw error;
  }
  if (!vmService.isRunning(vm)) {
    const error = new Error('Start the server before installing or managing add-ons.');
    error.statusCode = 409;
    throw error;
  }
}

async function sshxStatus(vm) {
  const output = await run(vm, [
    'if [ -f "$HOME/.sshx.pid" ]; then',
    '  p=$(cat "$HOME/.sshx.pid");',
    '  case "$p" in ""|*[!0-9]*) ;; *)',
    '    if kill -0 "$p" 2>/dev/null && ps -p "$p" -o args= 2>/dev/null | grep -q "[s]shx"; then echo MVM_SSHX_RUNNING; fi;',
    '  esac;',
    'fi',
    'if command -v sshx >/dev/null 2>&1 || [ -x /usr/local/bin/sshx ]; then echo MVM_SSHX_INSTALLED; fi',
  ].join(' '));
  return { installed: output.includes('MVM_SSHX_INSTALLED'), running: output.includes('MVM_SSHX_RUNNING') };
}

async function stopSshx(vm) {
  const output = await run(vm, [
    'if [ -f "$HOME/.sshx.pid" ]; then',
    '  p=$(cat "$HOME/.sshx.pid");',
    '  case "$p" in ""|*[!0-9]*) rm -f "$HOME/.sshx.pid"; echo "Removed invalid SSHX pid file." ;;',
    '    *) if kill -0 "$p" 2>/dev/null && ps -p "$p" -o args= 2>/dev/null | grep -q "[s]shx"; then kill "$p" || exit $?; echo "SSHX session stopped."; else echo "SSHX session was not running."; fi; rm -f "$HOME/.sshx.pid" ;;',
    '  esac',
    'else echo "No SSHX session is recorded."; fi',
  ].join(' '));
  return { message: output };
}

async function startSshx(vm) {
  const installed = await sshxStatus(vm);
  if (!installed.installed) {
    await runAsRoot(vm, 'curl -sSf https://sshx.io/get | sh');
  }
  await run(vm, [
    'if [ -f "$HOME/.sshx.pid" ]; then',
    '  p=$(cat "$HOME/.sshx.pid");',
    '  case "$p" in ""|*[!0-9]*) ;; *)',
    '    if kill -0 "$p" 2>/dev/null && ps -p "$p" -o args= 2>/dev/null | grep -q "[s]shx"; then cat "$HOME/.sshx.log" 2>/dev/null || true; exit 0; fi;',
    '  esac;',
    'fi',
    'bin=$(command -v sshx 2>/dev/null || true);',
    '[ -n "$bin" ] || { [ -x /usr/local/bin/sshx ] && bin=/usr/local/bin/sshx; };',
    '[ -n "$bin" ] || { echo "sshx binary was not found after installation." >&2; exit 1; };',
    ': > "$HOME/.sshx.log"',
    'nohup "$bin" > "$HOME/.sshx.log" 2>&1 < /dev/null &',
    'echo $! > "$HOME/.sshx.pid"',
  ].join(' '));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const log = await run(vm, 'cat "$HOME/.sshx.log" 2>/dev/null || true');
    const match = log.match(/https:\/\/sshx\.io\/[^\s"'<>]+/);
    if (match) return { link: match[0].replace(/[),.;]+$/, '') };
    const alive = await run(vm, 'p=$(cat "$HOME/.sshx.pid" 2>/dev/null || true); case "$p" in ""|*[!0-9]*) exit 1 ;; *) kill -0 "$p" 2>/dev/null ;; esac').catch(() => '');
    if (!alive) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('SSHX did not return a session link. Check that the VM can reach sshx.io, then try again.');
}

async function runAddon(vm, addon, action = 'install') {
  assertSupported(vm, addon);
  if (addon === 'sshx' && action === 'stop') return stopSshx(vm);
  if (action !== 'install') {
    const error = new Error('Unsupported add-on action.');
    error.statusCode = 400;
    throw error;
  }

  if (addon === 'sshx') return startSshx(vm);

  if (addon === 'tailscale') {
    const output = await runAsRoot(vm, [
      'if ! command -v tailscale >/dev/null 2>&1; then',
      '  command -v curl >/dev/null 2>&1 || { echo "curl is required to install Tailscale." >&2; exit 1; }',
      '  curl -fsSL https://tailscale.com/install.sh | sh || exit $?',
      'fi',
      'if command -v systemctl >/dev/null 2>&1; then systemctl enable --now tailscaled || exit $?;',
      'elif command -v service >/dev/null 2>&1; then service tailscaled start || service tailscale start || exit $?;',
      'else echo "No supported service manager was found for tailscaled." >&2; exit 1; fi',
      'tailscale up 2>&1',
    ].join('; '), 300000);
    const authUrl = output.match(/https:\/\/login\.tailscale\.com\/[^\s"'<>]+/i)?.[0] || '';
    return { output, authUrl };
  }

  const output = await runAsRoot(vm, [
    'command -v apt-get >/dev/null 2>&1 || { echo "Docker add-on currently supports Debian/Ubuntu guests with apt." >&2; exit 1; }',
    'DEBIAN_FRONTEND=noninteractive apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io',
    'if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker;',
    'elif command -v service >/dev/null 2>&1; then service docker start;',
    'else echo "Docker was installed, but no supported service manager was found." >&2; exit 1; fi',
    'docker --version',
  ].join(' && '), 600000);
  return { output };
}

async function status(vm) {
  const output = await run(vm, [
    'for tool in sshx tailscale docker; do',
    '  if command -v "$tool" >/dev/null 2>&1 || { [ "$tool" = sshx ] && [ -x /usr/local/bin/sshx ]; }; then echo "MVM_ADDON_$tool=installed"; else echo "MVM_ADDON_$tool=missing"; fi;',
    'done;',
    'if [ -f "$HOME/.sshx.pid" ]; then p=$(cat "$HOME/.sshx.pid"); case "$p" in ""|*[!0-9]*) ;; *) if kill -0 "$p" 2>/dev/null && ps -p "$p" -o args= 2>/dev/null | grep -q "[s]shx"; then echo MVM_ADDON_sshx=running; fi ;; esac; fi',
  ].join(' '));
  return {
    sshx: { installed: output.includes('MVM_ADDON_sshx=installed'), running: output.includes('MVM_ADDON_sshx=running') },
    tailscale: { installed: output.includes('MVM_ADDON_tailscale=installed') },
    docker: { installed: output.includes('MVM_ADDON_docker=installed') },
  };
}

module.exports = { runAddon, status };
