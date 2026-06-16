#!/bin/bash
# Lodestone — TUI Chat Launcher
# A terminal chat interface like OpenClaw's TUI.

set -e

WORKSPACE="${LODESTONE_WORKSPACE:-/tmp/lodestone-test/workspace}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "🔮 Starting Lodestone TUI..."
echo ""

node packages/core/dist/test/tui-chat.js