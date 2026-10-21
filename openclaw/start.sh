#!/bin/sh
# Container command for the gateway service. See docker-compose.yml.
set -eu

STATE=/home/node/.openclaw
CONFIG=/config/openclaw.json

# On a fresh volume the first CLI call can race the state database setup
# ("undergoing offline maintenance; retry when it finishes"), hence the retry.
cli() {
  attempt=1
  until node dist/index.js "$@"; do
    if [ "$attempt" -ge 5 ]; then
      echo "start.sh: giving up after $attempt attempts: $*" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
}

# First run: seed the volume with the repo config.
if [ ! -f "$STATE/openclaw.json" ]; then
  cp "$CONFIG" "$STATE/openclaw.json"
fi

# Every run: merge the repo config through the CLI, the validated write path.
# A plain cp does not survive "doctor --fix": doctor treats a file much smaller
# than its last-known-good copy as clobbered and restores the old one.
cli config patch --file "$CONFIG"

# The model is a deployment parameter. The CLI checks model names before env
# substitution, so a ${VAR} placeholder in the config file is rejected.
cli config set agents.defaults.model.primary "$OPENCLAW_MODEL"

# Image entrypoint: doctor --fix, then the gateway. "--bind lan" listens on all
# container interfaces, so the backend container can reach it.
exec node /app/docker-entrypoint.mjs node dist/index.js gateway --bind lan --port 18789
