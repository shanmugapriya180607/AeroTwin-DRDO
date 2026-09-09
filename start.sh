#!/usr/bin/env bash
# AEROTWIN - one-command launch (POSIX shells / Git Bash).
set -euo pipefail

BACKEND_PORT="${BACKEND_PORT:-8011}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "AEROTWIN - Propulsion Intelligence System"
echo "Research prototype. Not certified for airworthiness decisions."
echo

[ -d "$ROOT/frontend/node_modules" ] || (cd "$ROOT/frontend" && npm install)

cleanup() { echo; echo "Stopping..."; kill ${BACKEND_PID:-} ${FRONTEND_PID:-} 2>/dev/null || true; }
trap cleanup EXIT INT TERM

( cd "$ROOT/backend" && python -m uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" ) &
BACKEND_PID=$!

( cd "$ROOT/frontend" && npm run dev -- --port "$FRONTEND_PORT" ) &
FRONTEND_PID=$!

echo "  Ground station: http://127.0.0.1:${FRONTEND_PORT}/"
echo "  API docs:       http://127.0.0.1:${BACKEND_PORT}/docs"
echo
wait
