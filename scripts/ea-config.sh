#!/usr/bin/env bash
# ea-config — easy-agent 配置管理一条命令（2026-10-31）
# 两类操作：
#   ① agent 参数 → 网关 PATCH /api/agents（即时生效 + 自动回写 easy-agent.json，无需重启）
#   ② 其他配置节（websearch/wecom…）→ jq 直改 easy-agent.json：
#      改前备份 + ConfigSchema 试加载（防写坏崩服务）；--restart 尾参立即重启
set -euo pipefail

CFG="${EASY_AGENT_CONFIG:-$HOME/.easy-agent/easy-agent.json}"
GW="${EASY_AGENT_GATEWAY:-http://127.0.0.1:4096}"

usage() {
  cat <<'EOF'
用法: ea-config <命令> ... [--restart]

■ agent（PATCH 网关：即时生效 + 写回配置文件，不需要 --restart）
  ea-config agent thinking  <name> <off|low|medium|high>
  ea-config agent tools-off <name> <t1,t2>     # 追加工具黑名单（并集）
  ea-config agent tools-on  <name> <t1,t2>     # 从黑名单移除
  ea-config agent related   <name> <a1,a2|*>   # 检索关联（替换语义）
  ea-config agent watch     <name> <a1,a2|*>   # 监视名单（替换语义）
  ea-config agent hint      <name> "<文本>|-"  # 每轮注入提示词（-=清除）
  ea-config agent list                         # 全部 agent 现值

■ websearch（编辑配置文件）
  ea-config websearch provider   <auto|tavily|brave|bocha|ollama|bing>
  ea-config websearch ollama-url <url>
  ea-config websearch key        <tavily|brave|bocha> <key>

■ wecom（编辑配置文件）
  ea-config wecom default-agent <name>
  ea-config wecom pin   <chatId> <agentName>   # 固定会话→agent
  ea-config wecom unpin <chatId>
  ea-config wecom list

■ 通用
  ea-config get [jq路径]        # 缺省 .；例: get .websearch
  ea-config set '<jq过滤>'      # 例: set '.wecom.agentId = "life"'
  ea-config check               # JSON 合法 + 网关健康 + agents 一览
  ea-config restart [gateway|wecom|both]

--restart：编辑类命令写完后立即重启相关服务
EOF
}

RESTART=""
ARGS=()
for a in "$@"; do [[ $a == "--restart" ]] && RESTART=1 || ARGS+=("$a"); done
[[ ${#ARGS[@]} -gt 0 ]] && set -- "${ARGS[@]}" || set -- help

do_restart() { # gateway|wecom|both
  [[ -n $RESTART ]] || return 0
  case "$1" in
    gateway) systemctl --user restart easy-agent.service ;;
    wecom)   systemctl --user restart easy-agent-wecom.service ;;
    both)    systemctl --user restart easy-agent.service easy-agent-wecom.service ;;
  esac
  sleep 3
  curl -s "$GW/health" >/dev/null && echo "🟢 网关健康" || echo "🔴 网关未响应！journalctl --user -u easy-agent.service -n 30"
}

patch_agent() { # <name> <json-body>
  local code
  code=$(curl -s -o /tmp/ea-config-resp.json -w "%{http_code}" -X PATCH "$GW/api/agents/$1" \
    -H 'Content-Type: application/json' -d "$2")
  [[ $code == 200 ]] || { echo "❌ PATCH $1 失败 HTTP $code: $(cat /tmp/ea-config-resp.json)"; exit 1; }
  echo "✅ $1 已更新（即时生效，已写回 $CFG）"
}

edit_cfg() { # <jq-filter> [--arg k v ...]
  local filter="$1"; shift
  [[ -f $CFG ]] || { echo "❌ 配置文件不存在: $CFG"; exit 1; }
  jq empty "$CFG" || { echo "❌ 现有配置 JSON 非法，拒绝修改"; exit 1; }
  local tmp; tmp=$(mktemp)
  jq "$filter" "$@" "$CFG" > "$tmp" || { rm -f "$tmp"; exit 1; }
  # ConfigSchema 试加载（bun 在且是源码环境才做；zod 默认剥未知键，这里只验结构合法性）
  if command -v bun >/dev/null && [[ -d ~/easy_agent/packages/config/src ]]; then
    cp "$tmp" "$CFG.schema-check"
    if ! (cd ~/easy_agent && CHECK_FILE="$CFG.schema-check" bun -e '
      const fs = require("fs");
      const { ConfigSchema } = await import("./packages/config/src/schema.ts");
      ConfigSchema.parse(JSON.parse(fs.readFileSync(process.env.CHECK_FILE, "utf8")));' >/dev/null 2>&1); then
      rm -f "$tmp" "$CFG.schema-check"
      echo "❌ 新值未通过 schema 校验（会崩服务），修改已放弃"; exit 1
    fi
    rm -f "$CFG.schema-check"
  fi
  cp "$CFG" "$CFG.bak-$(date +%m%d-%H%M%S)"
  mv "$tmp" "$CFG"
  echo "✅ 已写入 $CFG"
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  agent)
    sub="${1:-}"; name="${2:-}"; val="${3:-}"
    case "$sub" in
      thinking) patch_agent "$name" "{\"thinking\":\"$val\"}" ;;
      tools-off)
        IFS=',' read -ra ts <<< "$val"
        cur=$(curl -s "$GW/api/agents" | jq -r --arg n "$name" '.agents[]|select(.name==$n).toolsDisable[]?')
        merged=$( { [[ -n ${cur:-} ]] && printf '%s\n' $cur; printf '%s\n' "${ts[@]}"; } | grep -v '^$' | jq -Rn '[inputs]|unique')
        patch_agent "$name" "{\"toolsDisable\":$merged}" ;;
      tools-on)
        IFS=',' read -ra ts <<< "$val"
        cur=$(curl -s "$GW/api/agents" | jq -r --arg n "$name" '.agents[]|select(.name==$n).toolsDisable[]?')
        merged=$( { [[ -n ${cur:-} ]] && printf '%s\n' $cur; } | { grep -vxF "${ts[@]}" || true; } | jq -Rn '[inputs]' )
        patch_agent "$name" "{\"toolsDisable\":$merged}" ;;
      related) patch_agent "$name" "{\"relatedAgents\":$(jq -R 'split(",")' <<< "$val")}" ;;
      watch)   patch_agent "$name" "{\"watchAgents\":$(jq -R 'split(",")' <<< "$val")}" ;;
      hint)
        if [[ $val == "-" ]]; then patch_agent "$name" '{"toolHint":null}'
        else patch_agent "$name" "{\"toolHint\":$(jq -Rs . <<< "$val")}"; fi ;;
      list) curl -s "$GW/api/agents" | jq '.agents' ;;
      *) usage; exit 1 ;;
    esac ;;
  websearch)
    sub="${1:-}"; val="${2:-}"
    case "$sub" in
      provider)   edit_cfg '.websearch = ((.websearch // {}) + {provider: $v})' --arg v "$val"; do_restart gateway ;;
      ollama-url) edit_cfg '.websearch = ((.websearch // {}) + {ollamaBaseUrl: $v})' --arg v "$val"; do_restart gateway ;;
      key)
        kind="${2:-}"; kval="${3:-}"
        case "$kind" in
          tavily) edit_cfg '.websearch = ((.websearch // {}) + {tavilyApiKey: $v})' --arg v "$kval" ;;
          brave)  edit_cfg '.websearch = ((.websearch // {}) + {braveApiKey: $v})' --arg v "$kval" ;;
          bocha)  edit_cfg '.websearch = ((.websearch // {}) + {bochaApiKey: $v})' --arg v "$kval" ;;
          *) usage; exit 1 ;;
        esac; do_restart gateway ;;
      *) usage; exit 1 ;;
    esac ;;
  wecom)
    sub="${1:-}"; a2="${2:-}"; a3="${3:-}"
    case "$sub" in
      default-agent) edit_cfg '.wecom = ((.wecom // {}) + {agentId: $v})' --arg v "$a2"; do_restart wecom ;;
      pin)   edit_cfg '.wecom = ((.wecom // {}) | .chatAgents = ((.chatAgents // {}) + {($k): $v}))' --arg k "$a2" --arg v "$a3"; do_restart wecom ;;
      unpin) edit_cfg 'del(.wecom.chatAgents[$k])' --arg k "$a2"; do_restart wecom ;;
      list)  jq '{defaultAgent: .wecom.agentId, pinned: (.wecom.chatAgents // {}), allowed: (.wecom.allowedUserIds // [])}' "$CFG" ;;
      *) usage; exit 1 ;;
    esac ;;
  get) jq "${1:-.}" "$CFG" ;;
  set) edit_cfg "$1" ;;
  check)
    jq empty "$CFG" && echo "🟢 JSON 合法"
    curl -s "$GW/health" >/dev/null && echo "🟢 网关健康" || echo "🔴 网关未响应"
    curl -s "$GW/api/agents" | jq -r '.agents[]|"\(.name): \(.model) thinking=\(.thinking) disable=\(.toolsDisable|join(",")) related=\(.relatedAgents // [] | join(",")) watch=\(.watchAgents // [] | join(","))"' ;;
  restart)
    RESTART=1; do_restart "${1:-both}" ;;
  help|*) usage ;;
esac
