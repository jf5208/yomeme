#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# 从 .preview 读取 expose_port，读取不到 fallback 5000
EXPOSE_PORT=$(awk -F '[ =]+' '/^expose_port/ {gsub(/[^0-9]/, "", $2); print $2; exit}' .preview 2>/dev/null || echo 5000)
export PORT="$EXPOSE_PORT"
export STATE_DIR="${STATE_DIR:-/tmp/pet-meme-state}"

# 清理残留（绝不碰 9000）
fuser -k "${EXPOSE_PORT}/tcp" 2>/dev/null || true
sleep 1

# 启动 Flask 服务
exec .venv/bin/python run.py
