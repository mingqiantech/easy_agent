#!/usr/bin/env bash
# easy-agent 一键构建 + 全局安装
# 用法: bash scripts/install.sh [--server]
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BIN_DIR="${HOME}/.local/bin"

# 找 bun（PATH 里没有就试 ~/.bun/bin）
if ! command -v bun >/dev/null 2>&1; then
  export PATH="${HOME}/.bun/bin:${PATH}"
fi
command -v bun >/dev/null 2>&1 || { echo "❌ 需要 bun: https://bun.sh"; exit 1; }

echo "🔨 构建 CLI..."
bun build --compile packages/cli/src/entry.ts --outfile dist/easy-agent

if [[ "${1:-}" == "--server" ]]; then
  echo "🔨 构建 Gateway..."
  bun build --compile packages/server/src/index.ts --outfile dist/easy-agent-gateway
  mkdir -p "${BIN_DIR}"
  # 正在运行的 gateway 会占用二进制；systemd 服务用 systemctl 停（pkill 会被 Restart=always 拉起）
  GW_WAS_ACTIVE=0
  if systemctl --user is-active --quiet easy-agent-gateway 2>/dev/null; then
    GW_WAS_ACTIVE=1
    systemctl --user stop easy-agent-gateway
  fi
  sleep 0.5
  cp dist/easy-agent-gateway "${BIN_DIR}/easy-agent-gateway"
  chmod +x "${BIN_DIR}/easy-agent-gateway"
  if [[ "${GW_WAS_ACTIVE}" == "1" ]]; then
    systemctl --user start easy-agent-gateway
    echo "↻ systemd 服务已重启"
  fi
  # Web 静态资源：编译后的二进制从 ~/.easy-agent/public 读取
  mkdir -p "${HOME}/.easy-agent/public"
  cp packages/server/public/* "${HOME}/.easy-agent/public/"
  echo "✓ ${BIN_DIR}/easy-agent-gateway (+web 资源)"
fi

mkdir -p "${BIN_DIR}"
cp dist/easy-agent "${BIN_DIR}/easy-agent"
chmod +x "${BIN_DIR}/easy-agent"

echo "✓ ${BIN_DIR}/easy-agent"

# PATH 检查
case ":${PATH}:" in
  *":${BIN_DIR}:"*) : ;;
  *) echo "⚠️ ${BIN_DIR} 不在 PATH，加到 ~/.bashrc: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# 首次安装初始化配置目录
if [[ ! -f "${HOME}/.easy-agent/easy-agent.json" ]]; then
  mkdir -p "${HOME}/.easy-agent"
  cat > "${HOME}/.easy-agent/easy-agent.json" <<'EOF'
{
  "models": {
    "qwencloud-token-plan/qwen3.8-flash": { "alias": "flash", "reasoning": true },
    "qwencloud-token-plan/qwen3.8-max":   { "alias": "max",   "reasoning": true }
  },
  "model": { "primary": "flash", "fallbacks": ["max"] },
  "thinkingDefault": "off",
  "providers": {
    "qwencloud-token-plan": {
      "api": "anthropic",
      "baseUrl": "https://token-plan.maas.qianwenaiapi.com/apps/anthropic",
      "apiKey": "${OPENAI_API_KEY}"
    }
  }
}
EOF
  echo "📦 已生成 ~/.easy-agent/easy-agent.json；密钥写入 ~/.easy-agent/.env 的 OPENAI_API_KEY=<你的key>"
fi
if [[ ! -f "${HOME}/.easy-agent/.env" && -f "${ROOT}/.env" ]]; then
  cp "${ROOT}/.env" "${HOME}/.easy-agent/.env"
  echo "🔑 已从 ${ROOT}/.env 复制密钥到 ~/.easy-agent/.env"
fi

echo ""
echo "✅ 完成！运行: easy-agent"
