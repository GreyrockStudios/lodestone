#!/bin/bash
set -e

echo "🔮 Lodestone — Starting..."

# Set defaults
: "${LODESTONE_CONFIG:=./lodestone.config.yaml}"
: "${LODESTONE_WORKSPACE:=./workspace}"
: "${LODESTONE_LOG_LEVEL:=info}"

export LODESTONE_CONFIG
export LODESTONE_WORKSPACE
export LODESTONE_LOG_LEVEL

# Ensure workspace directories exist
mkdir -p "$LODESTONE_WORKSPACE/data/lancedb"
mkdir -p "$LODESTONE_WORKSPACE/data/logs"
mkdir -p "$LODESTONE_WORKSPACE/memory/wiki"
mkdir -p "$LODESTONE_WORKSPACE/data"

# Check if identity files exist
if [ ! -f "$LODESTONE_WORKSPACE/IDENTITY.md" ]; then
  echo "⚠️  No IDENTITY.md found. Run 'lodestone init' first."
  echo "   Using default template..."
  cp -r /app/templates/general/* "$LODESTONE_WORKSPACE/"
fi

echo "Config: $LODESTONE_CONFIG"
echo "Workspace: $LODESTONE_WORKSPACE"
echo ""

# Start the engine
exec node /app/packages/core/dist/main.js