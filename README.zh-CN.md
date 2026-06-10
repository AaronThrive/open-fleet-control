# 🦞 Open Fleet Control（开放舰队控制台）

[English](README.md) | 简体中文

<div align="center">

**面向分布式 OpenClaw 节点的舰队任务控制中心 —— 运行在你的 tailnet 之上**

[![CI](https://github.com/AaronThrive/open-fleet-control/actions/workflows/ci.yml/badge.svg)](https://github.com/AaronThrive/open-fleet-control/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-1.5.0-blue)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/AaronThrive/open-fleet-control/pulls)

[功能巡礼](#功能巡礼) • [快速开始](#快速开始) • [舰队配置](#舰队配置) • [API](#舰队-api) • [部署](#部署)

</div>

---

## 这是什么？

你的 AI 代理早已不是单机上的一个进程，而是一支**舰队**：分布在多台机器上的 OpenClaw 节点，通过 Tailscale tailnet 互联，各自运行会话、消耗 Token、提交工作。

Open Fleet Control 就是这支舰队的**主宰指挥甲板**——一个仪表盘看清每个节点、每段对话、每项任务、每一分开销。它构建于出色的 [OpenClaw Command Center](https://github.com/jontsai/openclaw-command-center)（会话、成本、系统状态、定时任务）之上，并扩展出舰队级协同能力：网格拓扑、代理聊天、看板、共享记忆，以及带人工闸门的自我改进循环。

### ⚡ 依然快、依然轻

- **单次统一状态调用** + 2 秒 SSE 推送——没有轮询风暴
- **前端零构建** —— 原生 JS、ES 模块、morphdom
- **仅一个生产依赖**（`@lancedb/lancedb`，懒加载）——其余全部使用 Node 内置模块，包括 `node:sqlite`
- **暗色、星际争霸风格的 UI** —— 蜂群值得拥有氛围感

---

## 功能巡礼

| 面板 | 功能 |
| --- | --- |
| 🕸️ **网格（Mesh）** | 舰队节点注册表，通过 tailnet 轮询健康状态。节点 URL 在运行时由 Tailscale 上报的 MagicDNS 后缀拼出——**任何 tailnet 名称都不会被硬编码**。提供延迟火花线、节点发现、离线/不可达检测，以及来自各节点 `/api/state` 的尽力而为成本汇总。 |
| 💬 **舰队聊天（Fleet Chat）** | 代理间广播总线。每条消息同时写入持久 JSONL 日志（`logs/fleet-chat.jsonl`，50MB 轮转）**和** SQLite 历史库（`state/fleet-chat.db`，基于 `node:sqlite`），支持筛选查询。 |
| 🚨 **告警（Alerts）** | 基于规则的告警引擎（`nodeOffline`、`nodeUnreachable`、`taskFailed`、`taskStale`、`lessonPending`），5 分钟去重，支持两类接收端：**Webhook**（HMAC 签名，见下文）和经由你的 OpenClaw 网关转发的 **Slack**——仪表盘从不持有 Slack Token。 |
| 📋 **看板（Kanban）** | 蜂群任务看板：`inbox → assigned → inprogress → review → done \| failed`。看板文件允许代理直接编辑；每次读取都经过安全存储层，自动隔离损坏的 JSON 并恢复备份。看门狗会标记停滞的进行中任务。 |
| 📑 **简报（Briefs）** | 由 `briefs/*.md` 提供的 Markdown SOP/报告库——每日站会、操作手册、事件回顾。严格的文件名白名单 + 路径包含校验，双重防护。 |
| 🧠 **Cortex** | 舰队的共享大脑：LanceDB **memory-pro** 数据集（直接读取；搜索与**所有写入都经由 `openclaw memory-pro` CLI**）、**gbrain** 知识图谱（仅通过其 CLI 只读访问——绝不直接打开 PGLite 数据库），以及**压缩燃料表**（headroom / lean-ctx / lcm 的 Token 节省遥测）。任一适配器未配置时都会优雅降级。 |
| 🧬 **进化 + 验证闸门（Evolution + Validation Gate）** | 经验教训台账（`lessons_learned.md`）配人工审批闸门。闸门开启：新经验先标记 `pending`，批准后才合入 `lessons_learned.approved.md`；闸门关闭：自动批准，但仍完整记录。审批仅原子化地重写目标段落的状态行。 |
| 🌐 **联邦（Federation）** | 舰队之舰队：注册其他 Open Fleet Control 仪表盘（仅限 HTTPS，可选 Bearer Token——仅存储于服务器端、响应中始终脱敏），在同一块屏幕上观察它们的紧凑舰队摘要。**v1 仅只读**：绝不对远端执行写操作。 |
| 🧾 **审计日志（Audit Logs）** | 只追加的 JSONL 审计轨迹，记录每次变更：谁（Tailscale 身份）、做了什么（固定的动作枚举）、何时、针对哪个目标。50MB 轮转，可按用户/动作/时间范围查询。 |
| 🔐 **tailnet 开放式鉴权** | 设计为部署在 Tailscale Serve 之后：tailnet 即边界，每个变更请求都归因到 `Tailscale-User-Login` 身份请求头（缺省回落为 `anonymous`）。上游的 Token、Cloudflare Access、IP 白名单模式依然可用。 |

此外还继承了上游全部能力：会话监控、LLM 用量仪表、系统状态、定时任务、Cerebro 话题、Operators、记忆浏览器、隐私控制与成本明细。

---

## 快速开始

```bash
git clone https://github.com/AaronThrive/open-fleet-control
cd open-fleet-control
npm install
npm run build     # 用 esbuild 将 src/ 打包为 lib/server.js
npm start
```

**仪表盘运行在 http://localhost:3333** 🎉

服务器会自动检测你的 OpenClaw 工作区（`$OPENCLAW_WORKSPACE`、`~/.openclaw/workspace`、网关配置以及常见的旧路径）。舰队工作目录（`state/`、`logs/`、`briefs/`）默认相对于包根目录创建。

```bash
# 推荐部署方式：tailnet 边界 + 身份归因
DASHBOARD_AUTH_MODE=tailscale node lib/server.js
```

---

## 舰队配置

舰队的所有行为都在 `config/dashboard.json` 的 `fleet` 配置段中（从 [`config/dashboard.example.json`](config/dashboard.example.json) 复制，本地覆盖放在 `dashboard.local.json`）。解析顺序：内置默认值 ← `dashboard.json` ← `dashboard.local.json` ← **`FLEET_CONFIG_JSON`**（一个承载 JSON 数据的环境变量——非常适合容器与测试）：

```bash
FLEET_CONFIG_JSON='{"mesh":{"intervalMs":30000},"alerts":{"enabled":true}}' npm start
```

```jsonc
"fleet": {
  "stateDir": "state",          // kanban.json、mesh-nodes.json、fleet-chat.db、evolution.json
  "logsDir": "logs",            // audit.jsonl、fleet-chat.jsonl（含轮转文件）
  "briefsDir": "briefs",        // *.md SOP 与报告
  "workspaceDir": ".",          // lessons_learned.md 所在目录
  "mesh":      { "intervalMs": 15000 },        // 节点健康轮询周期
  "watchdog":  { "thresholdMs": 1800000 },     // 任务停滞阈值（30 分钟）
  "alerts": {
    "enabled": false,                          // 总开关（默认关闭）
    "rules": { "nodeOffline": true, "nodeUnreachable": true,
               "taskFailed": true, "taskStale": true, "lessonPending": true },
    "sinks": {
      "slack":    { "enabled": false, "gatewayUrl": "", "channel": "" },
      "webhooks": [ { "url": "https://...", "secret": "...", "events": ["*"] } ]
    }
  },
  "validationGate": { "default": true },       // 进化经验需要审批
  "cortex": {
    "enabled": true,                           // false = 完全跳过 CLI 探测
    "lancedbPath": "",                         // 例如 ~/.openclaw/memory/lancedb-pro
    "gbrainCli": "",                           // 例如 ~/gbrain/bin/gbrain
    "headroomStats": "", "leanCtxStats": "", "lcmDb": ""   // 燃料表数据源
  },
  "rateLimit": { "windowMs": 60000, "max": 120 }   // 按用户+IP，作用于变更路由
}
```

Cortex 路径留空表示"适配器不可用"——面板会如实报告，而不是在你的机器上探测默认路径。

### Webhook 签名

当某个 Webhook 接收端配置了 `secret`，每次投递都会携带 HMAC，供接收方校验真实性：

```
POST <webhook.url>
Content-Type: application/json
X-OFC-Signature: sha256=<以 secret 为密钥、对原始请求体计算的 HMAC-SHA256 十六进制值>

{"event":"nodeOffline","severity":"critical","node":"hermes","task":null,
 "message":"Node hermes went offline (was online)","ts":1717900000000,
 "source":"open-fleet-control"}
```

投递具备韧性：10 秒超时，30 秒后重试一次，失败仅记录日志、绝不影响主流程。Slack 接收端只向你的网关 URL 发送 `{channel, text}`。

---

## 舰队 API

所有舰队端点位于 `/api/fleet/*` 之下。变更操作均受限流（按用户+IP 的令牌桶，超限返回 `429` + `retryAfterMs`）、被审计，并归因到 Tailscale 身份请求头。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/fleet/mesh` | GET | 节点注册表 + 健康状态 + tailscale 状态 |
| `/api/fleet/mesh/discover` | GET | tailnet 上尚未注册的对等节点 |
| `/api/fleet/mesh/nodes` | POST | 注册节点 |
| `/api/fleet/mesh/nodes/:id` | DELETE | 注销节点 |
| `/api/fleet/costs` | GET | 跨节点的尽力而为成本汇总 |
| `/api/fleet/chat` | GET | 查询消息（sender/receiver/text/limit/before） |
| `/api/fleet/chat/publish` | POST | 向总线发布消息 |
| `/api/fleet/kanban` | GET | 完整看板 |
| `/api/fleet/kanban/tasks` | POST | 创建任务 |
| `/api/fleet/kanban/tasks/:id` | PATCH / DELETE | 更新 / 删除任务 |
| `/api/fleet/kanban/tasks/:id/move` | POST | 在列之间移动 |
| `/api/fleet/kanban/tasks/:id/comments` | POST | 添加评论 |
| `/api/fleet/kanban/tasks/:id/attempts` | POST | 记录一次代理尝试 |
| `/api/fleet/briefs` | GET | 简报列表 |
| `/api/fleet/briefs/:name` | GET / PUT / DELETE | 读取 / 写入（≤1MB Markdown）/ 删除 |
| `/api/fleet/evolution` | GET | 闸门状态 + 经验台账 |
| `/api/fleet/evolution/gate` | GET / PUT | 读取 / 切换验证闸门 |
| `/api/fleet/evolution/lessons` | POST | 提交一条经验 |
| `/api/fleet/evolution/lessons/:id/approve` · `/reject` | POST | 闸门裁决 |
| `/api/fleet/cortex` | GET | Cortex 统一状态（记忆/图谱/燃料表） |
| `/api/fleet/cortex/memory` | GET / POST | 列出/搜索记忆 · 存储（经由 CLI） |
| `/api/fleet/cortex/graph` | GET | gbrain 知识图谱（只读） |
| `/api/fleet/cortex/gauges` | GET | 压缩燃料表 |
| `/api/fleet/federation` | GET | 联邦远端及其舰队摘要 |
| `/api/fleet/federation/remotes` | POST | 注册远端仪表盘 |
| `/api/fleet/federation/remotes/:id` | DELETE | 移除远端 |
| `/api/fleet/audit` | GET | 审计轨迹（user/action/since/until 筛选） |
| `/api/fleet/alerts` | GET | 最近触发的告警（环形缓冲区） |

此外，`GET /api/state` 会附带一份紧凑的 `fleet` 摘要；SSE（`/api/events`）推送 `fleet.mesh`、`fleet.chat`、`fleet.kanban`、`fleet.evolution`、`fleet.alert` 事件，负载极简——客户端通过 REST 重新拉取详情。

---

## 代理集成

看板列与任务生命周期同 **agent-team-orchestration** 技能的任务状态一一对应（`inbox → assigned → inprogress → review → done | failed`），因此运行该技能的代理团队可以直接通过 `/api/fleet/kanban/*` 驱动看板——创建任务、记录尝试、移动卡片；舰队聊天（`/api/fleet/chat/publish`）是它们的汇报频道，简报则承载它们的常备指令。看板文件也允许代理直接在磁盘上编辑：状态安全层会在其周围完成校验、隔离与恢复。

---

## 部署

### Docker

生产级 [`Dockerfile`](Dockerfile) 基于 `node:22-alpine`，内含打包后的服务器 + 静态仪表盘：

```bash
docker build -t fleet-control:latest .
docker run -p 3333:3333 fleet-control:latest
```

Cortex 适配器需要将宿主机数据路径挂载进容器（只读即可），并通过 `FLEET_CONFIG_JSON` 指向它们；不挂载时仪表盘照常运行，Cortex 面板会报告"适配器不可用"。

### 一体机叠加层（openclaw-stack）

Fleet Control 以两个额外的 Compose 容器加入 `openclaw-stack` 一体机：一个专用的 `tailscale/tailscale` 边车（声明式 `TS_SERVE_CONFIG`，将 tailnet HTTPS 443 代理到回环 3333），以及共享其网络命名空间的仪表盘容器。最终效果：`https://<hostname>.<client-tailnet>.ts.net`，零公网暴露。

### 分步指南

- **[节点接入指南](docs/guides/node-setup.md)** —— 让网格能够监控一台机器（MagicDNS、HTTPS 证书、网关健康端点、注册流程）。
- **[客户端安装手册](docs/guides/client-install.md)** —— 在客户自己的 tailnet 上完成一体机安装的完整"点这里、输入这个"式手册。

---

## 🚀 路线图（v1.6）

- **看板键盘无障碍** —— 看板的完整键盘导航与 ARIA 语义。
- **联邦写操作** —— 从网格面板驱动远程节点（不止于观察）。
- **面板全量 i18n** —— 当前所有面板的 HTML 外壳均已使用 `data-i18n` 键并覆盖 `en`/`zh-CN`，但**舰队面板内由 JS 运行时生成的字符串尚未键化**；补齐这一缺口是已知的 v1.6 事项。

---

## 致谢

Open Fleet Control 是对 [**jontsai/openclaw-command-center**](https://github.com/jontsai/openclaw-command-center) 心怀感激的分叉——零依赖的仪表盘内核、SSE/状态架构以及虫族之魂皆源于此。Spawn more Overlords. 🦞

## 参与贡献

欢迎贡献！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)（没错，代理也有自己的入职文档）。

```bash
npm install        # 开发依赖
npm run build      # 将 src/ 打包为 lib/server.js
npm test           # node --test
npm run lint       # eslint src/ tests/
```

## 许可证

MIT —— 上游 © [Jonathan Tsai](https://github.com/jontsai)，舰队扩展 © OpenClaw Contributors。

---

<div align="center">

_"主宰通过它的领主洞察一切。"_

**[上游 Command Center](https://github.com/jontsai/openclaw-command-center)** · **[OpenClaw](https://github.com/openclaw/openclaw)** · **[Tailscale](https://tailscale.com)**

</div>
