#!/usr/bin/env bash
# Isolated Wayforge development launcher for the project-local Pi 1.x binary.
#
# Everything Pi needs (agent config + session state) is redirected below the
# git-ignored `.wayforge-dev/` directory inside this repository. This script
# never reads or writes the production `~/.pi` configuration, disables Pi
# telemetry, and skips version checks so development is deterministic and
# offline-safe. Usage: scripts/pi1-dev.sh [pi args...]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="${REPO_ROOT}/.wayforge-dev"

export PI_CODING_AGENT_DIR="${DEV_DIR}/agent"
export PI_CODING_AGENT_SESSION_DIR="${DEV_DIR}/sessions"
export PI_TELEMETRY="0"
export PI_SKIP_VERSION_CHECK="1"

mkdir -p "${PI_CODING_AGENT_DIR}" "${PI_CODING_AGENT_SESSION_DIR}"

exec "${REPO_ROOT}/node_modules/.bin/pi" "$@"
