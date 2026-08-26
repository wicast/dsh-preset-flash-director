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
echo "--- 部署配置 UI（dsh-flash-director-ui）---"
if [[ -f "$SCRIPT_DIR/bin/dsh-preset-flash-director.mjs" ]]; then
  if node "$SCRIPT_DIR/bin/dsh-preset-flash-director.mjs" install-ui; then
    echo ""
  else
    echo "warning: UI 部署未成功（不影响预设安装）。可稍后重跑:" >&2
    echo "  node $SCRIPT_DIR/bin/dsh-preset-flash-director.mjs install-ui" >&2
  fi
else
  echo "warning: 未找到 bin 安装器，跳过 UI 部署（可稍后手动接入，见 README）" >&2
fi
echo ""
echo "Next steps:"
echo "  1. open the DeepSeek Harness web UI and start a new session"
echo "  2. pick the \"Flash 主控 · Pro 专家\" preset"
echo "  3. switch the session model to deepseek-v4-flash"
echo "  4. confirm expert_consult / expert_review show up in the tool list"
echo "  5. if the config UI was deployed, restart DSH Desktop, then refresh —"
echo "     settings should show a \"Flash 主控\" section"
