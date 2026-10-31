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

■ 定时任务/监巡视（PATCH 风格同 agent）
  ea-config cron list                                    # 任务一览
  ea-config cron watch <agent> <被监视者,...|*> <间隔小时>   # 建巡检任务（payload 跑在 <agent> 名下）
  ea-config cron run  <name>                      # 立即触发（≤60s）
  ea-config cron last <name>                      # 看上次巡检结果
  ea-config cron rm <name|id>

■ 通用
  ea-config get [jq路径]        # 缺省 .；例: get .websearch
  ea-config set '<jq过滤>'      # 例: set '.wecom.agentId = "life"'
  ea-config check [--live]      # 分层自动校验（见下）；--live 加真实搜索探针
  ea-config restart [gateway|wecom|both]
  ea-config know reindex                    # 立即重建知识索引（新文档秒进知识拓扑）
  ea-config know stats                      # 索引规模（文件/块数按来源）
  ea-config cron-install        # 装 systemd 用户定时器，每 30 分钟自动 check
  ea-config cron-remove

■ check 分层方案（退出码=❌数；告警⚠️不影响退出码）
  L0 配置：JSON 合法 + ConfigSchema 试加载 + 关键节存在
  L1 进程：两个 systemd 服务 active + /health 可达
  L2 数据：sqlite integrity_check + WAL 体积 + 僵尸轮次台账 + 备份新鲜度
  L3 记忆：dreaming 三阶段最后运行时间（light≤8h/rem≤16h/deep≤30h）
            + 各 agent MEMORY.md 可注入（非占位）
  L4 通道：wecom 服务日志最近认证成功 + 会话固定表非空时 agent 名合法
  L5(--live)：websearch 真实探针（计入一次搜索调用）+ 拓扑边可读

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
  # 自动校验提醒：网关在跑且没要求 --restart 时，提示运行时仍是旧值
  if [[ -z $RESTART ]] && curl -s --max-time 2 "$GW/health" >/dev/null 2>&1; then
    echo "ℹ️ 文件已更新；运行中服务仍是旧配置（未加 --restart）。生效：ea-config restart gateway 或对应服务"
  fi
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
    exit_err=0
    ok()   { echo "  ✅ $1"; }
    warn() { echo "  ⚠️ $1"; }
    bad()  { echo "  ❌ $1"; exit_err=$((exit_err+1)); }
    LIVE=""; [[ "${1:-}" == "--live" ]] && LIVE=1
    STATE=$(dirname "$CFG"); DB="$STATE/agent.db"

    echo "L0 配置"
    if jq empty "$CFG" 2>/dev/null; then ok "JSON 合法"; else bad "JSON 非法"; fi
    if command -v bun >/dev/null && [[ -d ~/easy_agent/packages/config/src ]]; then
      if (cd ~/easy_agent && CHECK_FILE="$CFG" bun -e '
        const fs = require("fs");
        const { ConfigSchema } = await import("./packages/config/src/schema.ts");
        ConfigSchema.parse(JSON.parse(fs.readFileSync(process.env.CHECK_FILE, "utf8")));' >/dev/null 2>&1); then
        ok "ConfigSchema 试加载通过"
      else bad "schema 校验不过（服务会 crash-loop）"; fi
    fi
    jq -e '.model and .agents' "$CFG" >/dev/null && ok "model/agents 节存在" || warn "缺 model 或 agents 节"

    echo "L1 进程"
    for s in easy-agent easy-agent-wecom; do
      st=$(systemctl --user is-active "$s.service" 2>/dev/null || true)
      [[ $st == active ]] && ok "$s active" || bad "$s $st"
    done
    H=$(curl -s --max-time 5 "$GW/health" || true)
    [[ -n $H ]] && ok "网关响应（uptime $(jq -r '.uptime' <<< "$H")s）" || bad "网关 /health 不可达"

    echo "L2 数据"
    if [[ -f $DB ]] && command -v sqlite3 >/dev/null; then
      ic=$(sqlite3 "$DB" "PRAGMA integrity_check;" 2>/dev/null | head -1)
      [[ $ic == ok ]] && ok "sqlite 完整性 ok" || bad "sqlite: $ic"
      wal=$(stat -c%s "$DB-wal" 2>/dev/null || echo 0)
      (( wal < 20*1048576 )) && ok "WAL $(numfmt --to=iec "$wal" 2>/dev/null || echo "$wal")" || warn "WAL 过大 $((wal/1048576))MB（重启后应 checkpoint）"
      stale=$(sqlite3 "$DB" "SELECT COUNT(*) FROM active_turns WHERE last_step_at < (strftime('%s','now')*1000 - 15*60000);" 2>/dev/null || echo 0)
      (( stale == 0 )) && ok "无僵尸轮次台账" || warn "发现 $stale 个 >15min 未推进的 active_turns（重启会自愉续跑）"
      nb=$(curl -s --max-time 5 "$GW/api/backup" 2>/dev/null || true)
      last=$(jq -r '.backups[0].name // empty' <<< "$nb" 2>/dev/null)
      if [[ -n $last ]]; then
        age_h=$(( ( $(date +%s)*1000 - $(jq -r '.backups[0].createdAt // 0' <<< "$nb" | cut -d. -f1) ) / 3600000 + 1 ))
        (( age_h <= 49 )) && ok "最新备份 ${last:7:16}（≈${age_h}h 前）" || warn "备份已 ${age_h}h 未更新（间隔 $(jq -r '.settings.intervalHours' <<< "$nb")h）"
      else warn "读不到备份列表"; fi
    else warn "跳过 sqlite 检查（无 sqlite3 或 DB）"; fi

    echo "L3 记忆"
    if command -v sqlite3 >/dev/null && [[ -f $DB ]]; then
      # 用用户实际设定判新鲜度（别拿写死的缺省值误报配置漂移；本次 check 开路就发现
      # intervalMinutes=1440 而被硬编 8h 报假警）：读 settings.json，阈值=interval×2 宽限
      ivl_min=$(jq -r '.dreaming.intervalMinutes // 120' "$STATE/settings.json" 2>/dev/null || echo 120)
      if [[ "$(jq -r '.dreaming.enabled // true' "$STATE/settings.json" 2>/dev/null || echo true)" == "true" ]]; then
        t=$(sqlite3 "$DB" "SELECT MAX(last_run_at) FROM dreaming_state;" 2>/dev/null)
        age_h=$(( ( $(date +%s)*1000 - ${t:-0} ) / 3600000 ))
        limit_h=$(( ivl_min * 2 / 60 ))
        (( age_h <= limit_h )) && ok "梦境周期正常（上次运行 ${age_h}h 前，间隔 ${ivl_min}min）" \
          || bad "梦境 ${age_h}h 未运行（间隔 ${ivl_min}min 的 2 倍宽限=${limit_h}h）→ 调度卡死？手动：POST /api/settings/dreaming/run"
      else warn "梦境自动巩固已禁用（settings.dreaming.enabled=false）"; fi
      for d in "$STATE/workspace" "$STATE"/workspaces/*; do
        [[ -f $d/MEMORY.md ]] || continue
        first=$(head -1 "$d/MEMORY.md" || true)
        [[ $first == *"Long-Term Memory"* ]] || bad "$(basename "$d")/MEMORY.md 结构异常"
        # 占位行与真内容共存 = 深眠晋升没删占位（10-20 老伤会误杀注入）
        if [[ $(wc -l < "$d/MEMORY.md") -gt 3 ]] && grep -q "_No memories yet._" "$d/MEMORY.md"; then
          bad "$(basename "$d")/MEMORY.md 占位行与内容共存（会误杀注入）"
        fi
      done
      ok "各 agent MEMORY.md 检查完成"
    fi

    echo "L4 通道"
    # 注意：本脚本开了 pipefail，grep -q 提前退会给了上游 SIGPIPE → 管道码非 0 误判失败；
    # 日志匹配一律先落变量再 [[ =~ ]]
    WLOG=$(journalctl --user -u easy-agent-wecom.service --since "1 day ago" --no-pager 2>/dev/null || true)
    if [[ $WLOG == *"认证成功"* || $WLOG == *"Authenticated"* ]]; then
      ok "wecom 近 24h 有认证成功记录"
    else warn "wecom 无近期认证成功日志"; fi
    pinned=$(jq -r '.wecom.chatAgents // {} | to_entries[].value' "$CFG" 2>/dev/null)
    if [[ -n $pinned ]]; then
      agents_json=$(curl -s --max-time 5 "$GW/api/agents" || true)
      for pa in $pinned; do
        jq -e --arg n "$pa" '.agents[]|select(.name==$n)' <<< "$agents_json" >/dev/null 2>&1 && ok "固定会话 agent $pa 存在" || bad "固定会话指向不存在的 agent: $pa"
      done
    else ok "无固定会话映射"; fi

    if [[ -n $LIVE ]]; then
      echo "L5 功能实测"
      if command -v bun >/dev/null && [[ -d ~/easy_agent/packages/config/src ]]; then
        (cd ~/easy_agent && bun -e '
          import { loadConfig } from "./packages/config/src/loader.ts";
          import { createWebsearchTool } from "./packages/core/src/tool/builtins/websearch.ts";
          const c = loadConfig() as any;
          const ws = c.websearch ?? {};
          const tool = createWebsearchTool({ ...ws, ollamaBaseUrl: ws.ollamaBaseUrl ?? c.providers?.ollama?.baseUrl });
          const r: any = await tool.execute({ query: "hello", maxResults: 1 }, { sessionId: "chk", agentId: "default", workDir: "/tmp" });
          const o = r.output ?? r;
          if ((o.results ?? []).length) console.log("  ✅ websearch 实测通过 (provider=" + o.provider + ")");
          else { console.log("  ❌ websearch 实测无结果: " + JSON.stringify(o).slice(0,120)); process.exitCode = 1; }
        ' 2>/dev/null) || { echo "  ❌ websearch 实测失败"; exit_err=$((exit_err+1)); }
      fi
      edges=$(curl -s --max-time 5 "$GW/api/topology" | jq '.edges | length' 2>/dev/null || true)
      [[ -n $edges ]] && ok "拓扑可读（$edges 条边）" || bad "拓扑接口不可读"
    fi

    echo "----"
    if (( exit_err )); then echo "🔴 check 完成：$exit_err 项失败"; else echo "🟢 check 全部通过"; fi
    exit $exit_err ;;
  cron)
    sub="${1:-list}"; shift || true
    case "$sub" in
      list) curl -s "$GW/api/cron" | jq '.jobs[]|{id,name,description,schedule:.schedule.kind,everyH:((.schedule.everyMs//0)/3600000),payloadAgent:.payload.agent,enabled,runCount,lastRunAt:(if (.lastRunAt//0)>0 then (.lastRunAt/1000|strftime("%m-%d %H:%M")) else "从未" end)}' ;;
      watch)
        ag="${1:-}"; targets="${2:-}"; hrs="${3:-2}"
        [[ -n $ag && -n $targets ]] || { usage; exit 1; }
        BODY=$(jq -n --arg n "${ag}-watch-${targets}" --arg ag "$ag" --arg t "$targets" \
          --argjson ms $(( hrs * 3600000 )) --arg h "$hrs" '
          {name:$n, description:($ag + " 每 " + $h + "h 巡检 " + $t + " 运行状态"),
           schedule:{kind:"every", everyMs:$ms},
           payload:{kind:"agentTurn", agent:$ag,
             message:("【定时巡检】用 agent_status 查看 agent：" + $t + "。仅异常（卡在同一步>10min/连续 error/长时间 busy 不推进）才详细说明；正常则一行 ✅ 概要。")}}
          ')
        curl -s -X POST "$GW/api/cron" -H "Content-Type: application/json" -d "$BODY" | jq -r '"✅ 已创建 id=" + (.id // "FAIL")'
        ;;
      run)
        key="${1:-}"
        id=$(curl -s "$GW/api/cron" | jq -r --arg k "$key" '.jobs[]|select(.name==$k or .id==$k).id' | head -1)
        [[ -n $id ]] || { echo "❌ 找不到任务 $key"; exit 1; }
        sqlite3 "$(dirname "$CFG")/agent.db" "UPDATE cron_jobs SET next_run_at=$(date +%s%3N), enabled=1 WHERE id='$id';" \
          && echo "▶️ $key 已置为到期，≤60s 内调度器执行（会话标题 [cron] $key；结果：ea-config cron last $key）"
        ;;
      last)
        key="${1:-}"
        sid=$(sqlite3 "$(dirname "$CFG")/agent.db" "SELECT id FROM sessions WHERE title LIKE '%${key}%' AND title LIKE '[cron]%' ORDER BY created_at DESC LIMIT 1;")
        [[ -n $sid ]] || { echo "❌ 无该 cron 的历史会话"; exit 1; }
        sqlite3 "$(dirname "$CFG")/agent.db" "SELECT role||': '||substr(replace(content,char(10),' '),1,300) FROM messages WHERE session_id='$sid' AND role IN ('user','assistant') ORDER BY rowid DESC LIMIT 3;" | tac
        ;;
      rm)
        key="${1:-}"
        id=$(curl -s "$GW/api/cron" | jq -r --arg k "$key" '.jobs[]|select(.name==$k or .id==$k).id' | head -1)
        [[ -n $id ]] || { echo "❌ 找不到任务 $key"; exit 1; }
        curl -s -X DELETE "$GW/api/cron/$id" >/dev/null && echo "🗑 已删除 $key ($id)" ;;
      *) usage; exit 1 ;;
    esac ;;
  restart)
    RESTART=1; do_restart "${1:-both}" ;;
  know)
    case "${1:-}" in
      reindex) curl -s -X POST "$GW/api/reindex" --max-time 120 | jq . ;;
      stats)   curl -s "$GW/api/retrieval" | jq '{entries, embedding: .embedding.model, reindexMin: .reindexIntervalMinutes, dreaming: .dreaming.enabled}' ;;
      *) usage; exit 1 ;;
    esac ;;
  cron-install)
    mkdir -p ~/.config/systemd/user
    cat > ~/.config/systemd/user/ea-check.service <<EOS
[Unit]
Description=ea-config 分层自动体检

[Service]
Type=oneshot
ExecStart=$HOME/bin/ea-config check --live
StandardOutput=journal
EOS
    cat > ~/.config/systemd/user/ea-check.timer <<'EOF'
[Unit]
Description=每 30 分钟自动体检（结果进 journal：journalctl --user -u ea-check.service）

[Timer]
OnBootDelaySec=60
OnUnitActiveSec=30min

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now ea-check.timer
    echo "⏰ 已安装 ea-check.timer（每 30min）；结果看 journalctl --user -u ea-check.service -f" ;;
  cron-remove)
    systemctl --user disable --now ea-check.timer 2>/dev/null || true
    rm -f ~/.config/systemd/user/ea-check.{service,timer}
    systemctl --user daemon-reload
    echo "已移除 ea-check 定时器" ;;
  help|*) usage ;;
esac
