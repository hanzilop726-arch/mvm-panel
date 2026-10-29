# MVM Panel - No-KVM Docker Container

Run **MVM Panel** inside a fully containerized Docker environment with **No-KVM Mode (QEMU TCG Software Emulation)**. Runs anywhere without needing `/dev/kvm` hardware access (VPS, Cloud Instances, GitHub Codespaces, Local Docker).

---

## Quick Start: No-KVM Container

### 1. Start Container with Docker Compose
```bash
docker compose up -d --build
```

### 2. Access the Panel
- **Web UI**: [http://localhost:3001](http://localhost:3001)
- **REST API**: [http://localhost:3002/api](http://localhost:3002/api)
- **Default Login**:
  - **Username**: `admin`
  - **Password**: `admin123`

---

## Standalone No-KVM Docker Command

```bash
# Build the Docker image
docker build -t mvm-panel-nokvm .

# Run container in No-KVM Mode (no /dev/kvm required)
docker run -d \
  --name mvm-panel \
  --restart unless-stopped \
  -e NO_KVM=1 \
  -p 3001:3001 \
  -p 3002:3002 \
  -p 25501-25600:25501-25600 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/vms:/app/vms \
  -v $(pwd)/uploads:/app/uploads \
  mvm-panel-nokvm
```

---

## How No-KVM Mode Works
- **Engine**: QEMU uses `-machine type=pc,accel=tcg` and `-cpu qemu64`.
- **Port Forwarding**: Automatic user-space networking with port forwarding for SSH, VNC, and Agent.
- **Compatibility**: Works on any Linux/Mac/Windows host even if nested virtualization is disabled.
