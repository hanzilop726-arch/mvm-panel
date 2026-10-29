#!/usr/bin/env bash
# =============================================================================
#  ⚡ MVM Panel - Next-Gen QEMU Virtual Machine Management Web Panel
#  Full Support Installer for Debian (11, 12, 13) & Ubuntu (20.04, 22.04, 24.04)
# =============================================================================

set -e

# ANSI Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$SCRIPT_DIR/vpanel-pro" ]; then
  APP_DIR="$SCRIPT_DIR/vpanel-pro"
else
  APP_DIR="$SCRIPT_DIR"
fi

cd "$APP_DIR"

safe_clear() {
  clear 2>/dev/null || true
}

log_info()  { printf "${CYAN}${BOLD}[MVM Panel]${NC} %b\n" "$*"; }
log_ok()    { printf "${GREEN}${BOLD}[✔ SUCCESS]${NC} %b\n" "$*"; }
log_warn()  { printf "${YELLOW}${BOLD}[⚠ WARN]${NC} %b\n" "$*"; }
log_err()   { printf "${RED}${BOLD}[✖ ERROR]${NC} %b\n" "$*" >&2; }

check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_err "This script must be run as root. Please run with: sudo bash install.sh"
    exit 1
  fi
}

detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_VER="${VERSION_ID:-}"
    OS_NAME="${PRETTY_NAME:-$ID}"
  else
    log_err "Cannot detect Linux distribution (/etc/os-release missing)."
    exit 1
  fi

  case "$OS_ID" in
    debian|ubuntu)
      log_info "Detected Supported OS: ${GREEN}${OS_NAME}${NC}"
      ;;
    *)
      log_warn "Detected OS: ${OS_NAME}. Recommended distributions: Debian 11/12/13, Ubuntu 20.04/22.04/24.04."
      ;;
  esac
}

get_server_ip() {
  local ip
  ip=$(curl -s -4 https://api.ipify.org 2>/dev/null || curl -s -4 https://ifconfig.me 2>/dev/null || ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' || echo "localhost")
  echo "$ip"
}

# =============================================================================
# 1. INSTALL MVM PANEL
# =============================================================================
do_install() {
  safe_clear
  printf "${CYAN}${BOLD}"
  echo "================================================================="
  echo "             🚀 Installing MVM Panel on $OS_NAME                "
  echo "================================================================="
  printf "${NC}\n"

  # Ensure PATH includes npm / node global binary directory
  export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin:/usr/local/bin:/usr/bin"

  # Step 1: System Packages
  log_info "Step 1/8: Updating APT package repositories..."
  export DEBIAN_FRONTEND=noninteractive
  rm -f /etc/apt/sources.list.d/mongodb-org*.list 2>/dev/null || true
  apt-get update -y || true

  log_info "Step 2/8: Installing core system dependencies & QEMU packages..."
  apt-get install -y --no-install-recommends \
    git curl wget openssl ca-certificates tar gzip iproute2 procps \
    build-essential python3 make g++ \
    qemu-system-x86 qemu-utils cloud-image-utils || true

  # Step 2: Node.js 18+ LTS Check
  log_info "Step 3/8: Verifying Node.js 18+ LTS environment..."
  local install_node=0
  if ! command -v node >/dev/null 2>&1; then
    install_node=1
  else
    local cur_ver
    cur_ver=$(node -v | sed 's/^v//; s/\..*$//')
    if [ "${cur_ver:-0}" -lt 18 ]; then
      install_node=1
    fi
  fi

  if [ "$install_node" -eq 1 ]; then
    log_info "Installing Node.js 20.x LTS repository via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  log_ok "Node.js $(node -v) & NPM $(npm -v) ready"

  # Step 3: KVM / No-KVM check
  log_info "Step 4/8: Checking hardware virtualization (/dev/kvm)..."
  if [ -e "/dev/kvm" ]; then
    chmod 666 /dev/kvm || true
    log_ok "KVM Hardware Acceleration detected (/dev/kvm)"
  else
    log_warn "/dev/kvm not found or disabled. Enabling automatic No-KVM Mode (QEMU TCG Software Emulation)."
    export NO_KVM=1
  fi

  # Step 4: NPM Dependencies
  log_info "Step 5/8: Installing NPM packages & building native binaries..."
  npm install --no-audit --no-fund

  # Step 5: Configuration (.env)
  log_info "Step 6/8: Setting up environment configuration (.env)..."
  if [ ! -f .env ]; then
    log_info "Generating secure .env configuration..."
    if [ -f .env.example ]; then
      cp .env.example .env
    else
      cat << 'EOF' > .env
PANEL_PORT=3001
API_PORT=3002
PANEL_URL=http://localhost:3001
JWT_SECRET=
JWT_EXPIRES=7d
MONGO_URI=mongodb://admin:password@127.0.0.1:27017/vpanel?authSource=admin
AUTO_PORT_MIN=25501
AUTO_PORT_MAX=25600
AUTO_VNC_PORT_MIN=25901
AUTO_VNC_PORT_MAX=26000
AUTO_AGENT_PORT_MIN=26101
AUTO_AGENT_PORT_MAX=26200
ALLOW_REGISTER=1
EOF
    fi
    local secret
    secret="$(openssl rand -hex 32)"
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${secret}|" .env
  else
    log_info ".env already exists, preserving existing configuration."
  fi

  # Step 6: MongoDB Installation & Verification
  log_info "Step 7/8: Checking MongoDB service & database connection..."
  local mongo_ready=0

  # Ensure docker-proxy is available at all standard paths (Ubuntu 24.04 / Debian / Codespaces compatibility)
  local dproxy=""
  dproxy=$(command -v docker-proxy 2>/dev/null || find /usr/bin /usr/sbin /usr/libexec -name "docker-proxy" 2>/dev/null | head -n 1 || true)
  if [ -n "$dproxy" ]; then
    mkdir -p /usr/libexec/docker
    if [ ! -e /usr/libexec/docker/docker-proxy ]; then
      ln -sf "$dproxy" /usr/libexec/docker/docker-proxy 2>/dev/null || true
    fi
    if [ ! -e /usr/bin/docker-proxy ]; then
      ln -sf "$dproxy" /usr/bin/docker-proxy 2>/dev/null || true
    fi
  fi

  if node -e "require('dotenv').config(); const { MongoClient } = require('mongodb'); const uri = process.env.MONGO_URI || 'mongodb://admin:password@127.0.0.1:27017/vpanel?authSource=admin'; const c = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 }); c.connect().then(() => { c.close(); process.exit(0); }).catch(() => process.exit(1));" >/dev/null 2>&1; then
    log_ok "MongoDB is already reachable and authenticated."
    mongo_ready=1
  fi

  if [ "$mongo_ready" -eq 0 ]; then
    if ! command -v docker >/dev/null 2>&1 && ! command -v mongod >/dev/null 2>&1; then
      log_info "Installing Docker engine for containerized MongoDB..."
      apt-get install -y --no-install-recommends docker.io || true
      systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
    fi

    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      if docker ps --filter "name=mongodb" --format "{{.Names}}" | grep -q "^mongodb$"; then
        log_ok "MongoDB Docker container is already running."
      elif docker ps -a --filter "name=mongodb" --format "{{.Names}}" | grep -q "^mongodb$"; then
        log_info "Starting existing MongoDB Docker container..."
        if ! docker start mongodb 2>/dev/null; then
          log_warn "Failed to restart existing container, recreating..."
          docker rm -f mongodb >/dev/null 2>&1 || true
          docker run -d \
            --name mongodb \
            -p 27017:27017 \
            -e MONGO_INITDB_ROOT_USERNAME=admin \
            -e MONGO_INITDB_ROOT_PASSWORD=password \
            -v mongodb_data:/data/db \
            --restart unless-stopped \
            mongo:latest
        fi
      else
        log_info "Deploying MongoDB server container via Docker..."
        docker rm -f mongodb >/dev/null 2>&1 || true
        docker run -d \
          --name mongodb \
          -p 27017:27017 \
          -e MONGO_INITDB_ROOT_USERNAME=admin \
          -e MONGO_INITDB_ROOT_PASSWORD=password \
          -v mongodb_data:/data/db \
          --restart unless-stopped \
          mongo:latest
      fi
    elif command -v mongod >/dev/null 2>&1; then
      log_info "Starting native MongoDB service..."
      systemctl start mongod 2>/dev/null || systemctl start mongodb 2>/dev/null || service mongodb start 2>/dev/null || true
    else
      log_warn "Neither Docker nor mongod is running. Attempting to start Docker service..."
      systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
      if docker info >/dev/null 2>&1; then
        docker rm -f mongodb >/dev/null 2>&1 || true
        docker run -d \
          --name mongodb \
          -p 27017:27017 \
          -e MONGO_INITDB_ROOT_USERNAME=admin \
          -e MONGO_INITDB_ROOT_PASSWORD=password \
          -v mongodb_data:/data/db \
          --restart unless-stopped \
          mongo:latest
      fi
    fi

    # Wait up to 30s for MongoDB to accept connections
    log_info "Waiting for MongoDB to become ready..."
    local attempts=0
    while [ $attempts -lt 30 ]; do
      if node -e "require('dotenv').config(); const { MongoClient } = require('mongodb'); const uri = process.env.MONGO_URI || 'mongodb://admin:password@127.0.0.1:27017/vpanel?authSource=admin'; const c = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 }); c.connect().then(() => { c.close(); process.exit(0); }).catch(() => process.exit(1));" >/dev/null 2>&1; then
        mongo_ready=1
        log_ok "MongoDB server is online and ready."
        break
      fi
      sleep 1
      attempts=$((attempts + 1))
    done

    if [ "$mongo_ready" -eq 0 ]; then
      log_warn "Could not verify MongoDB connection automatically within 30s. Please verify MONGO_URI in .env."
    fi
  fi

  # Step 7: Initialize Application & Directories
  log_info "Initializing storage directories & building assets..."
  mkdir -p data vms public/uploads/logo public/uploads/favicon public/uploads/background public/uploads/music public/uploads/avatar storage/backups storage/logs data/tmp
  node scripts/build.js

  # Step 8: Administrator Account
  log_info "Step 8/8: Creating Administrator Account..."
  local IN_USER="${ADMIN_USER:-admin}"
  local IN_EMAIL="${ADMIN_EMAIL:-admin@mvm-panel.local}"
  local IN_PASS="${ADMIN_PASS:-}"

  if [ -t 0 ] && [ "$NON_INTERACTIVE" -eq 0 ] && [ -z "$ADMIN_PASS" ]; then
    echo ""
    read -r -p "Enter Admin Username [default: ${IN_USER}]: " INPUT_USER
    IN_USER="${INPUT_USER:-$IN_USER}"

    read -r -p "Enter Admin Email [default: ${IN_EMAIL}]: " INPUT_EMAIL
    IN_EMAIL="${INPUT_EMAIL:-$IN_EMAIL}"

    read -r -s -p "Enter Admin Password [default: generate secure]: " INPUT_PASS
    echo ""
    IN_PASS="${INPUT_PASS:-}"
  fi

  if [ -z "$IN_PASS" ]; then
    IN_PASS="$(openssl rand -hex 6)"
    log_warn "Generated secure admin password: ${IN_PASS}"
  fi

  log_info "Provisioning Administrator account '${IN_USER}' in database..."
  CREATEUSER_USERNAME="$IN_USER" \
  CREATEUSER_EMAIL="$IN_EMAIL" \
  CREATEUSER_PASSWORD="$IN_PASS" \
  CREATEUSER_NAME="$IN_USER" \
  CREATEUSER_ROLE=admin \
  node -e "
    const auth = require('./src/services/authService');
    const { initDb, closeDb, collections } = require('./src/lib/db');
    const username = process.env.CREATEUSER_USERNAME;
    const email = process.env.CREATEUSER_EMAIL;
    const password = process.env.CREATEUSER_PASSWORD;
    const name = process.env.CREATEUSER_NAME || username;

    (async () => {
      await initDb();
      const existing = await collections.users.findOne({ \$or: [{ username }, { email }] });
      if (existing) {
        await auth.updateUser(existing.id, { password, role: 'admin', root_admin: 1, suspended: 0, verified: 1 });
        console.log('[✔] Administrator user ' + username + ' password updated and promoted to Root Admin.');
      } else {
        const u = await auth.createUser({ username, email, password, name, role: 'admin', verified: 1 });
        await collections.users.updateOne({ id: u.id }, { \$set: { root_admin: 1 } });
        console.log('[✔] Administrator user ' + username + ' created successfully.');
      }
      await closeDb();
    })().catch((err) => { console.error('[✖] Admin setup error: ' + err.message); process.exit(1); });
  "

  # Step 9: Setup PM2 Daemon
  if [ "$USE_PM2" -eq 1 ]; then
    if ! command -v pm2 >/dev/null 2>&1; then
      log_info "Installing PM2 Process Manager globally..."
      npm install -g pm2 --no-audit --no-fund
    fi

    log_info "Starting MVM Panel cluster with PM2..."
    pm2 delete vpanel >/dev/null 2>&1 || true
    pm2 start ecosystem.config.js || pm2 start src/server.js --name vpanel
    pm2 save
    pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
  else
    log_info "PM2 skipped (--no-pm2). Start manually with: npm start"
  fi

  local s_ip
  s_ip=$(get_server_ip)

  echo ""
  printf "${GREEN}${BOLD}"
  echo "================================================================="
  echo "           🎉 MVM Panel Successfully Installed & Online!        "
  echo "================================================================="
  printf "${NC}\n"
  echo "  🌐 Web Panel URL:    http://${s_ip}:3001"
  echo "  ⚡ REST API URL:     http://${s_ip}:3002/api"
  echo "  👤 Admin Username:   ${IN_USER}"
  echo "  🔑 Admin Password:   ${IN_PASS}"
  echo "  📧 Admin Email:      ${IN_EMAIL}"
  echo ""
  if [ "$USE_PM2" -eq 1 ]; then
    echo "  ⚙️  PM2 Process:      pm2 status | pm2 logs vpanel"
  else
    echo "  ⚙️  Run Server:      npm start"
  fi
  echo "================================================================="
  echo ""
}

# =============================================================================
# 2. CREATE / RESET ADMIN USER (user create admin)
# =============================================================================
do_create_user() {
  safe_clear
  printf "${CYAN}${BOLD}"
  echo "================================================================="
  echo "               👤 Create / Reset Administrator User               "
  echo "================================================================="
  printf "${NC}\n"

  export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin:/usr/local/bin:/usr/bin"

  local A_USER="${ADMIN_USER:-admin}"
  local A_EMAIL="${ADMIN_EMAIL:-}"
  local A_NAME="${ADMIN_NAME:-Administrator}"
  local A_PASS="${ADMIN_PASS:-}"

  if [ -t 0 ] && [ "$NON_INTERACTIVE" -eq 0 ] && [ -z "$ADMIN_PASS" ]; then
    read -r -p "Enter Username [default: ${A_USER}]: " INPUT_USER
    A_USER="${INPUT_USER:-$A_USER}"

    local DEF_EMAIL="${A_USER}@mvm-panel.local"
    read -r -p "Enter Email [default: ${A_EMAIL:-$DEF_EMAIL}]: " INPUT_EMAIL
    A_EMAIL="${INPUT_EMAIL:-${A_EMAIL:-$DEF_EMAIL}}"

    read -r -p "Enter Display Name [default: ${A_NAME}]: " INPUT_NAME
    A_NAME="${INPUT_NAME:-$A_NAME}"

    read -r -s -p "Enter Password: " INPUT_PASS
    echo ""
    while [ -z "$INPUT_PASS" ]; do
      read -r -s -p "Password cannot be empty. Please enter password: " INPUT_PASS
      echo ""
    done
    A_PASS="$INPUT_PASS"
  fi

  if [ -z "$A_EMAIL" ]; then
    A_EMAIL="${A_USER}@mvm-panel.local"
  fi

  if [ -z "$A_PASS" ]; then
    A_PASS="$(openssl rand -hex 6)"
    log_warn "Generated secure admin password: ${A_PASS}"
  fi

  log_info "Provisioning Administrator account '${A_USER}' in database..."

  CREATEUSER_USERNAME="$A_USER" \
  CREATEUSER_EMAIL="$A_EMAIL" \
  CREATEUSER_PASSWORD="$A_PASS" \
  CREATEUSER_NAME="$A_NAME" \
  CREATEUSER_ROLE=admin \
  node -e "
    const auth = require('./src/services/authService');
    const { initDb, closeDb, collections } = require('./src/lib/db');
    const username = process.env.CREATEUSER_USERNAME;
    const email = process.env.CREATEUSER_EMAIL;
    const password = process.env.CREATEUSER_PASSWORD;
    const name = process.env.CREATEUSER_NAME || username;

    (async () => {
      await initDb();
      const existing = await collections.users.findOne({ \$or: [{ username }, { email }] });
      if (existing) {
        await auth.updateUser(existing.id, { password, role: 'admin', root_admin: 1, suspended: 0, verified: 1 });
        console.log('[✔] Administrator user ' + username + ' password updated and promoted to Root Admin.');
      } else {
        const u = await auth.createUser({ username, email, password, name, role: 'admin', verified: 1 });
        await collections.users.updateOne({ id: u.id }, { \$set: { root_admin: 1 } });
        console.log('[✔] Administrator user ' + username + ' created successfully.');
      }
      await closeDb();
    })().catch((err) => { console.error('[✖] Error: ' + err.message); process.exit(1); });
  "

  log_ok "Administrator account '${A_USER}' is ready for login."
  echo "  👤 Username: ${A_USER}"
  echo "  🔑 Password: ${A_PASS}"
  echo "  📧 Email:    ${A_EMAIL}"
  echo ""
}

# =============================================================================
# 3. UPDATE MVM PANEL
# =============================================================================
do_update() {
  safe_clear
  printf "${CYAN}${BOLD}"
  echo "================================================================="
  echo "                   🔄 Updating MVM Panel                        "
  echo "================================================================="
  printf "${NC}\n"

  export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin:/usr/local/bin:/usr/bin"

  if [ -d ".git" ]; then
    log_info "Fetching latest updates from git repository..."
    git pull || log_warn "Git pull reported conflicts or already up to date."
  else
    log_info "Preserving current source directory..."
  fi

  log_info "Updating npm packages..."
  npm install --no-audit --no-fund

  log_info "Running build & database migrations..."
  node scripts/build.js

  if command -v pm2 >/dev/null 2>&1; then
    log_info "Reloading PM2 cluster with zero downtime..."
    pm2 restart all || pm2 start ecosystem.config.js
    pm2 save
  fi

  log_ok "MVM Panel has been updated successfully!"
  echo ""
}

# =============================================================================
# 4. PM2 MANAGEMENT
# =============================================================================
do_pm2_menu() {
  export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin:/usr/local/bin:/usr/bin"
  while true; do
    safe_clear
    printf "${MAGENTA}${BOLD}"
    echo "================================================================="
    echo "                   ⚙️  PM2 Process Manager                       "
    echo "================================================================="
    printf "${NC}\n"
    echo "  [1] 📊 View Status (pm2 status)"
    echo "  [2] 🔄 Restart MVM Panel (pm2 restart vpanel)"
    echo "  [3] ⏹️  Stop MVM Panel (pm2 stop vpanel)"
    echo "  [4] ▶️  Start MVM Panel (pm2 start vpanel)"
    echo "  [5] 📜 View Live Logs (pm2 logs vpanel)"
    echo "  [6] ⚡ Enable Auto-start on System Boot"
    echo "  [7] 🚫 Disable Auto-start on System Boot"
    echo "  [0] 🔙 Back to Main Menu"
    echo ""
    read -r -p "Select PM2 Option [0-7]: " PM2_OPT

    case "$PM2_OPT" in
      1)
        echo ""
        pm2 status
        echo ""
        read -r -p "Press Enter to continue..." _
        ;;
      2)
        log_info "Restarting MVM Panel cluster..."
        pm2 restart all
        log_ok "MVM Panel restarted."
        read -r -p "Press Enter to continue..." _
        ;;
      3)
        log_info "Stopping MVM Panel cluster..."
        pm2 stop all
        log_ok "MVM Panel stopped."
        read -r -p "Press Enter to continue..." _
        ;;
      4)
        log_info "Starting MVM Panel cluster..."
        pm2 start ecosystem.config.js || pm2 start all
        log_ok "MVM Panel started."
        read -r -p "Press Enter to continue..." _
        ;;
      5)
        log_info "Streaming live PM2 logs (Ctrl+C to exit)..."
        pm2 logs vpanel --lines 50
        ;;
      6)
        log_info "Configuring PM2 startup systemd service..."
        pm2 save
        pm2 startup systemd -u root --hp /root || true
        log_ok "Auto-start on boot enabled."
        read -r -p "Press Enter to continue..." _
        ;;
      7)
        log_info "Disabling PM2 startup service..."
        pm2 unstartup systemd || true
        log_ok "Auto-start on boot disabled."
        read -r -p "Press Enter to continue..." _
        ;;
      0)
        break
        ;;
      *)
        log_warn "Invalid option. Please choose between 0 and 7."
        sleep 1
        ;;
    esac
  done
}

# =============================================================================
# 5. UNINSTALL MVM PANEL
# =============================================================================
do_uninstall() {
  safe_clear
  printf "${RED}${BOLD}"
  echo "================================================================="
  echo "                 🗑️  Uninstall MVM Panel                         "
  echo "================================================================="
  printf "${NC}\n"

  if [ "$NON_INTERACTIVE" -eq 0 ]; then
    read -r -p "Are you sure you want to completely uninstall MVM Panel? (y/N): " CONFIRM
    if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
      log_info "Uninstall aborted."
      return
    fi

    read -r -p "Do you want to KEEP your VM disks and database data? [Y/n]: " KEEP_DATA
    KEEP_DATA="${KEEP_DATA:-Y}"
  else
    KEEP_DATA="Y"
  fi

  log_info "Stopping and removing PM2 daemon process..."
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete vpanel >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
    pm2 unstartup systemd >/dev/null 2>&1 || true
  fi

  if [[ "$KEEP_DATA" == "n" || "$KEEP_DATA" == "N" ]]; then
    log_info "Removing all data, VMs, and uploads..."
    rm -rf data/tmp vms/* public/uploads/logo/* public/uploads/favicon/* public/uploads/background/* public/uploads/music/* public/uploads/avatar/*
    if command -v docker >/dev/null 2>&1; then
      if docker ps -a --format "{{.Names}}" | grep -q "^mongodb$"; then
        log_info "Removing MongoDB Docker container and volume..."
        docker stop mongodb >/dev/null 2>&1 || true
        docker rm mongodb >/dev/null 2>&1 || true
        docker volume rm mongodb_data >/dev/null 2>&1 || true
      fi
    fi
  else
    log_info "Preserving database and VM disks."
  fi

  log_ok "MVM Panel has been uninstalled successfully."
  echo ""
}

# =============================================================================
# MAIN INTERACTIVE MENU
# =============================================================================
show_menu() {
  while true; do
    safe_clear
    printf "${CYAN}${BOLD}"
    echo "================================================================="
    echo "                   ⚡ MVM Panel Management Suite                 "
    echo "            Full Support: Debian 11/12/13 & Ubuntu 20/22/24      "
    echo "================================================================="
    printf "${NC}"
    echo ""
    echo "  [1] 🚀 1. Install (Full automated install for Debian/Ubuntu)"
    echo "  [2] 👤 2. User Create Admin (Create or reset admin account)"
    echo "  [3] 🔄 3. Update (Pull updates, rebuild & zero-downtime reload)"
    echo "  [4] ⚙️  4. PM2 Management (Restart, logs, boot startup)"
    echo "  [5] 🗑️  5. Uninstall (Safe uninstall wizard)"
    echo "  [0] 🚪 0. Exit"
    echo ""
    printf "${CYAN}=================================================================${NC}\n"
    read -r -p "Enter choice [0-5]: " CHOICE

    case "$CHOICE" in
      1)
        do_install
        read -r -p "Press Enter to return to menu..." _
        ;;
      2)
        do_create_user
        read -r -p "Press Enter to return to menu..." _
        ;;
      3)
        do_update
        read -r -p "Press Enter to return to menu..." _
        ;;
      4)
        do_pm2_menu
        ;;
      5)
        do_uninstall
        read -r -p "Press Enter to return to menu..." _
        ;;
      0)
        log_info "Exiting MVM Panel Installer. Goodbye!"
        exit 0
        ;;
      *)
        log_warn "Invalid option '$CHOICE'. Please choose 1, 2, 3, 4, 5, or 0."
        sleep 1.2
        ;;
    esac
  done
}

# Entrypoint
check_root
detect_os

ACTION=""
USE_PM2=1
NON_INTERACTIVE=0
ADMIN_USER="${ADMIN_USERNAME:-${ADMIN_USER:-}}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASS="${ADMIN_PASSWORD:-${ADMIN_PASS:-}}"

while [ $# -gt 0 ]; do
  case "$1" in
    1|--install|install)
      ACTION="install"
      ;;
    2|--create-admin|--create-user|createuser|usercreate|--usercrate)
      ACTION="create_user"
      ;;
    3|--update|update)
      ACTION="update"
      ;;
    4|--pm2|pm2)
      ACTION="pm2"
      ;;
    5|--uninstall|uninstall)
      ACTION="uninstall"
      ;;
    --admin-user|--user|-u)
      shift
      ADMIN_USER="${1:-}"
      ACTION="${ACTION:-install}"
      ;;
    --admin-email|--email|-e)
      shift
      ADMIN_EMAIL="${1:-}"
      ACTION="${ACTION:-install}"
      ;;
    --admin-pass|--password|-p)
      shift
      ADMIN_PASS="${1:-}"
      ACTION="${ACTION:-install}"
      ;;
    --no-pm2)
      USE_PM2=0
      ;;
    -y|--yes|--non-interactive)
      NON_INTERACTIVE=1
      ;;
    --branch)
      shift
      BRANCH="${1:-}"
      if [ -n "$BRANCH" ]; then
        log_info "Switching to branch: $BRANCH"
        git fetch --all || true
        git checkout "$BRANCH" || git checkout -B "$BRANCH" origin/"$BRANCH" || true
      fi
      ;;
    -h|--help)
      echo "Usage: sudo bash install.sh [action] [options]"
      echo ""
      echo "Actions:"
      echo "  1, install, --install           Full automated installation"
      echo "  2, createuser, --create-admin   Create or reset admin account"
      echo "  3, update, --update             Pull updates and rebuild"
      echo "  4, pm2, --pm2                   PM2 cluster management menu"
      echo "  5, uninstall, --uninstall       Uninstall MVM Panel"
      echo ""
      echo "Options:"
      echo "  --admin-user <user>             Admin username (default: admin)"
      echo "  --admin-email <email>           Admin email (default: admin@mvm-panel.local)"
      echo "  --admin-pass <pass>             Admin password (default: random secure)"
      echo "  --no-pm2                        Skip PM2 process manager"
      echo "  -y, --non-interactive           Run without interactive prompts"
      echo "  -h, --help                      Show this help message"
      exit 0
      ;;
    *)
      log_warn "Unknown option: $1"
      ;;
  esac
  shift
done

if [ -n "$ACTION" ]; then
  case "$ACTION" in
    install)     do_install ;;
    create_user) do_create_user ;;
    update)      do_update ;;
    pm2)         do_pm2_menu ;;
    uninstall)   do_uninstall ;;
  esac
else
  show_menu
fi
