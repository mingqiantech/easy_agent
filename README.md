# easy-agent ⚡

一个用 **TypeScript + Bun** 打造的个人 AI Agent 框架：命令行对话、HTTP 网关、Web 管理界面、
持久记忆系统、工具调用、多 Agent、定时任务与工作流。设计理念参考 OpenClaw，代码结构自研，
适合作为学习 Agent 架构与二次开发的完整实现（12 周渐进式构建，全量测试绿）。

```
┌──────────┐   ┌──────────────────────┐   ┌───────────────┐
│ CLI REPL │   │ Gateway (Hono :4096)  │   │ Telegram /    │
│ easy-    │──▶│  REST API + Web UI    │◀──│ Discord 渠道   │
│ agent    │   │ 会话/拓扑/模型/思考切换 │   └───────────────┘
└──────────┘   └──────────┬───────────┘
     ┌─────────┬──────────┼──────────┬───────────┐
     │ LLM 层  │ 工具系统  │ 记忆系统  │ 调度/工作流 │
     │ 多厂商+ │ fs/bash/  │ 文件记忆+ │ cron+审批+  │
     │ 故障转移│ web/图像  │ 混合检索  │ 工作流引擎  │
     │ thinking│ /子Agent  │ Dreaming  │ 多团队协作  │
     └─────────┴──────────┴───────────┴───────────┘
```

## ✨ 核心特性

- **多模型接入**：OpenAI / Anthropic / Google / Ollama / OpenRouter，
  支持自定义网关名（如 `token-plan` 订阅端点经 `api` 字段复用任意协议）
- **OpenClaw 式模型配置**：模型目录 + 别名短名、主模型 + 有序故障转移链、
  视觉/图像生成专用槽位、`${OPENAI_API_KEY}` 环境变量密钥引用（密钥不落配置文件）
- **思考等级（thinking）**：`off / low / medium / high` 全局默认 + 每 Agent 独立覆盖；
  OpenAI 协议映射 `reasoning_effort`，Anthropic 协议映射 `thinking.budget_tokens`；
  不支持推理的模型自动降级为 off；Web 界面实时切换且重启不丢
- **多 Agent**：配置文件定义任意多个 Agent（独立模型/工作区/记忆/思考等级），
  Web 界面下拉切换，会话按 Agent 隔离
- **工具系统**：read / write / edit / glob / grep / bash / web_fetch / extract / git /
  image_vision / image_generate / memory_search / sub-agent，带执行审批钩子
- **记忆系统**：`MEMORY.md` + `memory/YYYY-MM-DD.md` 分层文件记忆、
  BM25+向量混合检索（本地 ollama embedding）、短期记忆 Recall 统计、
  Dreaming 巩固（浅眠评分→REM 归纳→晋升）、会话摄取、遗忘与抢救、长对话自动压缩
- **Web 管理界面**：会话管理、模型/思考等级切换、会话删除、一键智能总结、
  **Agent 拓扑图**（实时工作状态脉冲 + 子 Agent 协作边，5s 自刷新）
- **定时任务**：cron 调度 + 一次性任务 + 失败自动退避禁用 + 渠道投递
- **工作流引擎**：多步任务编排，条件分支、重试、审批门控
- **团队协作**：多 Agent 群组任务分发与结果聚合
- **渠道**：Telegram / Discord 接入，白名单用户路由
- **其他**：插件市场与 Skill 系统、审计日志、成本统计、监控告警、
  压测/负载工具、预检脚本、MCP serve 模式

## 📦 安装

### 一键脚本（推荐）

```bash
git clone https://github.com/mingqiantech/easy_agent.git
cd easy_agent

bash scripts/install.sh              # 构建 CLI → ~/.local/bin/easy-agent
bash scripts/install.sh --server     # 额外构建 Gateway + Web 静态资源；
                                     # 若 systemd 服务在跑会先停再装、装完自动拉起
```

脚本做了什么：用 `bun build --compile` 把 CLI/网关编译成单文件二进制（免运行时依赖）、
装到 `~/.local/bin`、**首装自动生成 `~/.easy-agent/easy-agent.json`**
（内置 token-plan 网关示例与 `${OPENAI_API_KEY}` 密钥引用）、把仓库 `.env` 复制进
`~/.easy-agent/.env`、检查 PATH 并给出提示。

等价 npm 入口：`bun run install:global` / `bun run install:global:with-server`。

### 开发模式

```bash
bun install          # 需要 bun ≥ 1.2（https://bun.sh）
bun run dev          # 直接跑 CLI
bun run dev:server   # 直接跑网关
```

## ⚙️ 配置

配置文件加载优先级：`~/.easy-agent/easy-agent.json` → 项目目录 `easy-agent.json(c)`
→ `~/.config/easy-agent/config.json`。支持 **JSONC 注释**。
密钥放 `~/.easy-agent/.env`（`KEY=VALUE` 自动注入环境）；
providers 里的值支持 `${OPENAI_API_KEY}` 占位符，运行时解析、明文不落盘。
完整模板见仓库根目录 **`easy-agent.example.json`**。

```jsonc
{
  // ① 模型目录："provider/model" → 别名与能力标记
  "models": {
    "qwencloud-token-plan/qwen3.8-max":   { "alias": "max",   "reasoning": true },
    "qwencloud-token-plan/qwen3.8-flash": { "alias": "flash", "reasoning": true },
    "ollama/qwen3.5:9b":                  { "alias": "local9b", "reasoning": false }
  },

  // ② 主模型 + 故障转移链：可写 ref、别名或裸 id（目录内唯一时自动补全）
  "model": { "primary": "flash", "fallbacks": ["max", "local9b"] },

  // ③ 全局思考等级（off|low|medium|high）
  "thinkingDefault": "off",

  // ④ 多 Agent：model / thinking / workspaceDir 均可独立配置，缺省继承全局
  "agents": {
    "coder":  { "description": "编程助手", "model": "max", "thinking": "medium" },
    "writer": { "description": "写作助手", "workspaceDir": "/home/<user>/.easy-agent/workspace-writer" }
  },

  // ⑤ providers："api" 选底层协议（openai|anthropic|google|ollama|openrouter），
  //    因此自定义名字也能用任何协议
  "providers": {
    "qwencloud-token-plan": {
      "api": "anthropic",
      "baseUrl": "https://token-plan.maas.qianwenaiapi.com/apps/anthropic",
      "apiKey": "${OPENAI_API_KEY}"
    },
    "ollama": { "api": "ollama", "baseUrl": "http://localhost:11434", "apiKey": "ollama" }
  },

  "visionModel": "flash",           // 图像理解专用槽位
  "imageGenModel": "qwen-image-2.0-pro"  // 图像生成（解析为裸 model id）
}
```

## 🖥 使用

### CLI

```bash
easy-agent            # 交互式 REPL（流式输出、工具确认）
```

REPL 内命令：`/tools`（工具列表）、`/memory`（记忆条目）、`/sessions`（会话管理）、
`/plugins`（插件扫描/安装/启停）、`/model`（模型链/别名目录/思考等级）、`/exit`。

### 网关 + Web 界面

```bash
easy-agent-gateway                     # 前台运行，默认 http://localhost:4096
PORT=8788 easy-agent-gateway           # 换端口
```

推荐 systemd 用户服务托管（开机自启 + 崩溃自愈），单元模板见
`scripts/easy-agent-gateway.service`：

```bash
mkdir -p ~/.config/systemd/user
cp scripts/easy-agent-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now easy-agent-gateway
loginctl enable-linger $USER          # 可选：不登录也常驻（WSL 需要）
```

Web 界面功能：

| 控件 | 作用 |
|---|---|
| Agent 下拉（侧栏顶部） | 切换 default/coder/writer…，会话列表按 Agent 过滤 |
| 💭 思考下拉 | 调整当前 Agent 思考等级，即时生效并持久化到 `agents-state.json` |
| 模型下拉 | 当前会话独立换模型（下一条消息生效） |
| ＋ 新会话 / ✕ 删除 | 会话全生命周期管理；进入页面自动续上最近会话 |
| 📝 总结本会话 | LLM 提炼 ≤200 字摘要写回历史（紫色气泡），模型后续可见 |
| 🕸 Agent 拓扑 Tab | SVG 环形图：节点=Agent（活跃脉冲/模型/会话数），虚线边=子 Agent 派生（×次数），下方卡片=每个 Agent 当前任务；5s 自动刷新 |

### HTTP API 速览

```
GET    /health
GET    /api/agents                       Agent 列表（含 thinking）
PATCH  /api/agents/:name                 {"thinking":"low"} 切换+持久化
GET    /api/models                       模型目录（ref+alias）
GET    /api/sessions?agent=&limit=       按 Agent 过滤的会话列表
POST   /api/sessions                     {"agentId":"coder"} 创建
GET/DELETE /api/sessions/:id             详情 / 删除
PATCH  /api/sessions/:id                 {"model": "***", "title": "..."} 会话换模型/改名
POST   /api/sessions/:id/messages        发消息（按所属 Agent 注入 thinking）
POST   /api/sessions/:id/summarize       会话总结
GET    /api/sessions/:id/messages        历史消息
GET    /api/topology                     拓扑数据（nodes+edges）
GET    /api/memory/search?q=             记忆检索
GET    /api/tools                        工具定义
```

## 🧠 记忆体系

- **文件层**：工作区 `MEMORY.md`（长期精选）、`USER.md`、`AGENTS.md`、
  `memory/YYYY-MM-DD.md`（每日原始日志）；system prompt 自动注入
- **检索层**：`memory_search` = BM25 + 本地向量混合打分，命中计入短期记忆
- **巩固层**：Dreaming 流程（短期高频 → 浅眠评分 → REM 主题归纳 → 晋升长期），
  由 `packages/memory/src/dreaming.ts` 驱动，可手动触发
- **压缩层**：长对话超限自动 compact 成摘要；遗忘清理带抢救窗口

## 📁 工程结构

```
packages/
  cli/        REPL 入口（entry / repl / repl-stream）
  server/     Hono 网关：REST + Web 静态界面（public/）
  core/       Agent 内核：session、工具与审批、cron、工作流、团队、
              插件、审计、监控、压测、备份、迁移…
  llm/        Provider 抽象层：多协议、流式、故障转移、thinking 映射
  memory/     检索 / 短期记忆 / Dreaming / 嵌入 / RAG / wiki
  config/     zod schema、JSONC/env 加载、模型别名与 Agent 解析
  schema/     消息 / 工具 / LLM 类型契约
  channels/   telegram/ discord/ 渠道适配
plugins/      示例插件
scripts/      install.sh、systemd 单元、preflight、version
```

## 🧪 开发

```bash
bun test            # 全量单测（工具/会话/渠道/调度/工作流/配置/thinking 映射…）
bun run typecheck   # tsc --noEmit 严格类型检查
bun run build:binary && bun run build:server   # 产物 dist/easy-agent[-gateway]
bun run packages/cli/src/entry.ts preflight    # 预检
```

## ❓ 常见问题

- **`easy-agent` 找不到**：确认 `~/.local/bin` 在 PATH（脚本会提示）。
- **手动跑网关报端口占用**：网关是常驻服务，先
  `systemctl --user stop easy-agent-gateway` 再手动启动。
- **`\\wsl` 里改了配置不生效**：网关重启才读文件（`systemctl --user restart easy-agent-gateway`）；
  思考等级用 Web 下拉改，即时生效。
- **图像生成/语音报 not supported**：确认 provider `baseUrl` 对应端点支持该 API。
- **换模型**：编辑 `~/.easy-agent/easy-agent.json` 的 `models` + `model.primary`
  或用 Web 界面模型下拉，无需改代码。
