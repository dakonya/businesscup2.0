#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
bash ./preflight.sh
python3 - <<'PY'
from pathlib import Path
import re
values = {}
for line in Path('.env').read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        name, value = line.split('=', 1)
        values[name] = value.strip().strip('"\'')
token = values.get('COACH_GATEWAY_TOKEN', '')
if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', token):
    raise SystemExit('Fill COACH_GATEWAY_TOKEN with 32-128 private random letters, digits, underscores or hyphens first.')
PY
docker compose up -d inference gateway
printf '%s\n' 'Started inference and gateway. Model download/startup may take several minutes.'
printf '%s\n' 'Check readiness with: docker compose ps'
printf '%s\n' 'Start temporary HTTPS only after readiness: docker compose --profile demo-tunnel up -d tunnel'
printf '%s\n' 'Read only the public tunnel URL from: docker compose logs tunnel'
