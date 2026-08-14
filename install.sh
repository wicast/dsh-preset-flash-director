#!/usr/bin/env bash
# Install the "Flash 主控 · Pro 专家" preset into $DSH_HOME/.agent-presets/
# Usage: ./install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESET_SOURCE="$SCRIPT_DIR/flash-director"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
TARGET="$DSH_HOME_DIR/.agent-presets/flash-director"

if [[ ! -d "$PRESET_SOURCE" ]]; then
  echo "error: preset source missing: $PRESET_SOURCE" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
if [[ -d "$TARGET" ]]; then
  BACKUP="$TARGET.bak-$(date +%s)"
  mv "$TARGET" "$BACKUP"
  echo "existing preset backed up to $BACKUP"
fi
cp -R "$PRESET_SOURCE" "$TARGET"
echo "installed preset -> $TARGET"
echo ""
echo "Next steps:"
echo "  1. open the DeepSeek Harness web UI and start a new session"
echo "  2. pick the \"Flash 主控 · Pro 专家\" preset"
echo "  3. switch the session model to deepseek-v4-flash"
echo "  4. confirm expert_consult / expert_review show up in the tool list"
