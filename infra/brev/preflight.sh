#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

command -v docker >/dev/null
command -v python3 >/dev/null
command -v nvidia-smi >/dev/null
docker version --format 'Docker server: {{.Server.Version}}'
docker compose version --short
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
python3 - <<'PY'
import os, re, shutil, stat, subprocess
version = subprocess.check_output(['docker', 'compose', 'version', '--short'], text=True).strip().lstrip('v')
parts = tuple(int(x) for x in version.split('-')[0].split('.')[:2])
if parts < (2, 30):
    raise SystemExit('Docker Compose >=2.30 is required for gpus: all; upgrade through the official Docker instructions.')
free = shutil.disk_usage('.').free
print(f'Free workspace disk: {free // 1024**3} GiB')
if free < 50 * 1024**3:
    raise SystemExit('At least 50 GiB free is required for images, weights and runtime cache.')
if os.path.exists('.env'):
    mode = stat.S_IMODE(os.stat('.env').st_mode)
    if mode != 0o600:
        raise SystemExit('Set permissions 0600 on infra/brev/.env before starting.')
else:
    token = os.environ.get('COACH_GATEWAY_TOKEN', '')
    if token and not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', token):
        raise SystemExit('Invalid gateway token format; use 32-128 letters, digits, underscores or hyphens.')
    fd = os.open('.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as target:
        if token:
            target.write(('COACH_GATEWAY_TOKEN=' + token + '\n').encode())
        else:
            with open('.env.example', 'rb') as template:
                target.write(template.read())
    print('Created private configuration infra/brev/.env; existing files were not overwritten.')
print('Preflight passed. Driver/CUDA compatibility and actual model fit still require a real container launch.')
PY
