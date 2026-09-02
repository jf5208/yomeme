#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

if [ -f "requirements.txt" ]; then
  echo "[setup] Installing from requirements.txt"
  pip install -r requirements.txt
else
  echo "[setup] Warning: no requirements.txt found, skipping install"
fi
