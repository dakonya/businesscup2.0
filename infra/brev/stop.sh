#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
docker compose --profile demo-tunnel down
printf '%s\n' 'Containers stopped; downloaded model cache is retained.'
printf '%s\n' 'GPU billing may continue until the Brev instance itself is stopped in Brev.'
