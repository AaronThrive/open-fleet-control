# 🦞 OpenFleetControl

<div align="center">

**Fleet mission control for distributed OpenClaw nodes — over your tailnet**

_built by Aaron May_

[![CI](https://github.com/AaronThrive/open-fleet-control/actions/workflows/ci.yml/badge.svg)](https://github.com/AaronThrive/open-fleet-control/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-2.5.0-blue)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/AaronThrive/open-fleet-control/pulls)

[Feature Tour](#feature-tour) • [Quick Start](#quick-start) • [Fleet Configuration](#fleet-configuration) • [API](#fleet-api) • [Deployment](#deployment)

</div>

---

## What Is It?

Your AI agents are no longer one process on one box. They are a **fleet**: OpenClaw nodes scattered across machines, joined by a Tailscale tailnet, each running sessions, burning tokens, and filing work.

OpenFleetControl is the **Overmind's command deck** for that fleet — one dashboard that sees every node, every conversation, every task, and every credit spent. It combines the session/cost/vitals/cron core with fleet-wide coordination: mesh topology, agent chat, a kanban board, shared memory, and a self-improvement loop with a human gate.

### ⚡ Still Fast, Still Light

- **Single unified state call** + 2-second SSE push — no polling storms
- **No build step for the frontend** — vanilla JS, ES modules, morphdom
- **Zero runtime dependencies** — everything is Node built-ins, including `node:sqlite`
- **Dark, Starcraft-inspired UI** — the swarm deserves atmosphere

---

## Feature Tour

| Panel                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🕸️ **Mesh**                        | Registry of fleet nodes with health polling over the tailnet. Node URLs are composed at runtime from the MagicDNS suffix Tailscale reports — **no tailnet name is ever hardcoded**. Latency sparklines, peer discovery, offline/unreachable detection, and best-effort cost rollups from each node's `/api/state`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 💬 **Fleet Chat**                  | Agent-to-agent broadcast bus. Every message lands in a durable JSONL trail (`logs/fleet-chat.jsonl`, rotated at 50MB) **and** a SQLite history (`state/fleet-chat.db`, via `node:sqlite`) for filtered queries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 🚨 **Alerts**                      | Rule-based alert engine (`nodeOffline`, `nodeUnreachable`, `taskFailed`, `taskStale`, `lessonPending`) with 5-minute dedupe and two sink types: **webhooks** (HMAC-signed, see below) and **Slack** via your OpenClaw gateway — the dashboard never holds Slack tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 📋 **Kanban**                      | Task board for the swarm: `inbox → assigned → inprogress → review → done \| failed`. The board file is agent-editable; every read goes through a safe store that quarantines corrupt JSON and auto-restores backups. A watchdog flags stale in-flight tasks. **Fully keyboard-accessible** (v1.6): `Tab` walks the cards, `Enter`/`Space` opens the detail drawer (focus-trapped, `Esc` closes), `M` toggles move mode, then `←`/`→` changes column, `↑`/`↓` reorders within a column, `Enter` confirms and `Esc` cancels (restoring the original position) — every move is announced via an `aria-live` region.                                                                                                                                  |
| 📑 **Briefs**                      | A markdown SOP/report library served from `briefs/*.md` — daily standups, runbooks, incident recaps. Strict filename allowlist + path containment, double-checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🧠 **Cortex**                      | The fleet's shared brain: the **gbrain** knowledge graph as the single-store memory engine (read-only via its CLI — Cortex lists gbrain pages and never opens the PGLite DB directly; **all writes happen via the nightly gbrain sync, not the app**), and **compression fuel gauges** (headroom / lean-ctx / lcm token-savings telemetry). Each adapter degrades gracefully when unconfigured.                                                                                                                                                                                                                                                                                                                                                                |
| 🧬 **Evolution + Validation Gate** | Lessons-learned ledger (`lessons_learned.md`) with a human approval gate. Gate ON: new lessons are `pending` until approved into `lessons_learned.approved.md`. Gate OFF: auto-approve, still fully recorded. Approvals rewrite only the target section's status line, atomically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🌐 **Federation**                  | Fleet-of-fleets: register other OpenFleetControl dashboards (HTTPS-only, optional bearer token — stored server-side, always redacted in responses) and watch their compact fleet summaries from one pane of glass. Remotes are **read-only by default**; v1.6 adds **opt-in write actions**: flip a per-remote `allowWrites` flag (the WRITES badge) and the card exposes the remote's pending lessons and evolution gate. All writes go through a server-side proxy that only executes a **hardcoded action whitelist** (`lesson.approve`, `lesson.reject`, `gate.set`, `task.move`) with strict param validation, and **forwards your operator identity** (`Tailscale-User-Login`) so the action is audited on both dashboards under your name. |
| 🧾 **Audit Logs**                  | Append-only JSONL trail of every mutation: who (Tailscale identity), what (a fixed action enum), when, against which target. Rotated at 50MB, queryable by user/action/time range.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🔐 **Tailnet-open auth**           | Designed to sit behind Tailscale Serve: the tailnet is the perimeter, and every mutating request is attributed to the `Tailscale-User-Login` identity header (falling back to `anonymous`). Token, Cloudflare Access, and IP-allowlist modes remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🌍 **Keyed UI strings**            | The entire panel — HTML shells **and** every JS-generated runtime string (toasts, confirm dialogs, empty/error states, aria-labels, screen-reader announcements, tooltips) — is keyed through `public/locales/en.json`; missing keys always fall back to inline English defaults, never to a raw key path. `scripts/checks/i18n-coverage.mjs` keeps code and the locale file in sync in CI.                                                                                                                                                                                                                                                                                                                                                       |

Plus the core deck: session monitoring, LLM fuel gauges, system vitals, cron jobs, Cerebro topics, operators, memory browser, privacy controls, and cost breakdowns.

---

## Quick Start

```bash
git clone https://github.com/AaronThrive/open-fleet-control
cd open-fleet-control
npm install
npm run build     # bundles src/ → lib/server.js (esbuild)
npm start
```

**Dashboard runs at http://localhost:3333** 🎉

The server auto-detects your OpenClaw workspace (`$OPENCLAW_WORKSPACE`, `~/.openclaw/workspace`, gateway config, and common legacy paths). Fleet working directories (`state/`, `logs/`, `briefs/`) are created relative to the package root by default.

```bash
# Recommended deployment: tailnet perimeter + identity attribution
DASHBOARD_AUTH_MODE=tailscale node lib/server.js
```

---

## Fleet Configuration

All fleet behavior lives in the `fleet` section of `config/dashboard.json` (copy from [`config/dashboard.example.json`](config/dashboard.example.json), local overrides in `dashboard.local.json`). Resolution order: built-in defaults ← `dashboard.json` ← `dashboard.local.json` ← **`FLEET_CONFIG_JSON`** (an env var holding a JSON blob — handy for containers and tests):

```bash
FLEET_CONFIG_JSON='{"mesh":{"intervalMs":30000},"alerts":{"enabled":true}}' npm start
```

```jsonc
"fleet": {
  "stateDir": "state",          // kanban.json, mesh-nodes.json, fleet-chat.db, evolution.json
  "logsDir": "logs",            // audit.jsonl, fleet-chat.jsonl (+ rotations)
  "briefsDir": "briefs",        // *.md SOPs and reports
  "workspaceDir": ".",          // home of lessons_learned.md
  "mesh":      { "intervalMs": 15000 },        // node health poll cadence
  "watchdog":  { "thresholdMs": 1800000 },     // stale-task threshold (30 min)
  "alerts": {
    "enabled": false,                          // master switch (default OFF)
    "rules": { "nodeOffline": true, "nodeUnreachable": true,
               "taskFailed": true, "taskStale": true, "lessonPending": true },
    "sinks": {
      "slack":    { "enabled": false, "gatewayUrl": "", "channel": "" },
      "webhooks": [ { "url": "https://...", "secret": "...", "events": ["*"] } ]
    }
  },
  "validationGate": { "default": true },       // evolution lessons need approval
  "cortex": {
    "enabled": true,                           // false = skip all CLI probing
    "gbrainCli": "",                           // e.g. ~/gbrain/bin/gbrain
    "headroomStats": "", "leanCtxStats": "", "lcmDb": ""   // fuel gauge sources
  },
  "rateLimit": { "windowMs": 60000, "max": 120 }   // per user+IP, mutating routes
}
```

Empty cortex paths mean "adapter unavailable" — the panel reports it honestly instead of probing your machine for defaults.

### Webhook signatures

When a webhook sink has a `secret`, every delivery carries an HMAC so the receiver can verify authenticity:

```
POST <webhook.url>
Content-Type: application/json
X-OFC-Signature: sha256=<hex HMAC-SHA256 of the raw request body, keyed by secret>

{"event":"nodeOffline","severity":"critical","node":"hermes","task":null,
 "message":"Node hermes went offline (was online)","ts":1717900000000,
 "source":"open-fleet-control"}
```

Delivery is resilient: 10s timeout, one retry after 30s, failures logged but never fatal. Slack sink posts only `{channel, text}` to your gateway URL.

---

## Fleet API

All fleet endpoints live under `/api/fleet/*`. Mutations are rate-limited (token bucket per user+IP, `429` + `retryAfterMs` when exceeded), audited, and attributed to the Tailscale identity header.

| Endpoint                                               | Method             | Description                                                                                                 |
| ------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `/api/fleet/mesh`                                      | GET                | Node registry + health + tailscale status                                                                   |
| `/api/fleet/mesh/discover`                             | GET                | Tailnet peers not yet registered                                                                            |
| `/api/fleet/mesh/nodes`                                | POST               | Register a node                                                                                             |
| `/api/fleet/mesh/nodes/:id`                            | DELETE             | Unregister a node                                                                                           |
| `/api/fleet/costs`                                     | GET                | Best-effort cost rollup across nodes                                                                        |
| `/api/fleet/chat`                                      | GET                | Query messages (sender/receiver/text/limit/before)                                                          |
| `/api/fleet/chat/publish`                              | POST               | Publish a message to the bus                                                                                |
| `/api/fleet/kanban`                                    | GET                | Full board                                                                                                  |
| `/api/fleet/kanban/tasks`                              | POST               | Create task                                                                                                 |
| `/api/fleet/kanban/tasks/:id`                          | PATCH / DELETE     | Update / delete task                                                                                        |
| `/api/fleet/kanban/tasks/:id/move`                     | POST               | Move between columns                                                                                        |
| `/api/fleet/kanban/tasks/:id/comments`                 | POST               | Add comment                                                                                                 |
| `/api/fleet/kanban/tasks/:id/attempts`                 | POST               | Record an agent attempt                                                                                     |
| `/api/fleet/briefs`                                    | GET                | List briefs                                                                                                 |
| `/api/fleet/briefs/:name`                              | GET / PUT / DELETE | Read / write (≤1MB markdown) / delete                                                                       |
| `/api/fleet/evolution`                                 | GET                | Gate state + lessons ledger                                                                                 |
| `/api/fleet/evolution/gate`                            | GET / PUT          | Read / toggle the validation gate                                                                           |
| `/api/fleet/evolution/lessons`                         | POST               | File a lesson                                                                                               |
| `/api/fleet/evolution/lessons/:id/approve` · `/reject` | POST               | Gate decisions                                                                                              |
| `/api/fleet/cortex`                                    | GET                | Unified cortex state (memory/graph/gauges)                                                                  |
| `/api/fleet/cortex/memory`                             | GET / POST         | List/search memory · store (via CLI)                                                                        |
| `/api/fleet/cortex/graph`                              | GET                | gbrain knowledge graph (read-only)                                                                          |
| `/api/fleet/cortex/gauges`                             | GET                | Compression fuel gauges                                                                                     |
| `/api/fleet/federation`                                | GET                | Federated remotes + their fleet summaries                                                                   |
| `/api/fleet/federation/remotes`                        | POST               | Register a remote dashboard                                                                                 |
| `/api/fleet/federation/remotes/:id`                    | PATCH / DELETE     | Toggle per-remote `allowWrites` / remove a remote                                                           |
| `/api/fleet/federation/remotes/:id/actions`            | POST               | Whitelisted write proxy (`lesson.approve` · `lesson.reject` · `gate.set` · `task.move`), identity forwarded |
| `/api/fleet/audit`                                     | GET                | Audit trail (user/action/since/until filters)                                                               |
| `/api/fleet/alerts`                                    | GET                | Recent fired alerts (ring buffer)                                                                           |

`GET /api/state` additionally carries a compact `fleet` summary, and SSE (`/api/events`) pushes `fleet.mesh`, `fleet.chat`, `fleet.kanban`, `fleet.evolution`, and `fleet.alert` events with minimal payloads — clients refetch detail over REST.

---

## Agent Integration

The kanban columns and task lifecycle are aligned 1:1 with the **agent-team-orchestration** skill's task states (`inbox → assigned → inprogress → review → done | failed`), so agent teams running that skill can drive the board directly through `/api/fleet/kanban/*` — create tasks, log attempts, move cards — while Fleet Chat (`/api/fleet/chat/publish`) is the reporting channel and Briefs hold their standing orders. The board file is also safe for agents to edit on disk: the state-safety layer validates, quarantines, and restores around them.

---

## Deployment

### Docker

A production [`Dockerfile`](Dockerfile) ships the bundled server + static dashboard on `node:22-alpine`:

```bash
docker build -t fleet-control:latest .
docker run -p 3333:3333 fleet-control:latest
```

Cortex adapters need their host data paths mounted in (read-only is fine) and pointed at via `FLEET_CONFIG_JSON`; without them the dashboard runs normally and the cortex panel reports "adapter unavailable".

### Appliance overlay (openclaw-stack)

Fleet Control slots into the `openclaw-stack` appliance as two extra Compose containers: a dedicated `tailscale/tailscale` sidecar (declarative `TS_SERVE_CONFIG` proxying tailnet HTTPS 443 → loopback 3333) and the dashboard sharing its network namespace. Result: `https://<hostname>.<client-tailnet>.ts.net`, zero public exposure.

### Step-by-step guides

- **[Node Setup Guide](docs/guides/node-setup.md)** — onboard a machine so the mesh can monitor it (MagicDNS, HTTPS certs, gateway health endpoint, registration).
- **[Client Install Runbook](docs/guides/client-install.md)** — the full click-here-type-this appliance install on a client's own tailnet.

---

## 🚀 Roadmap

- **Fleet-of-fleets (v2.3)** — client fleets on their own tailnets shared into the master
  dashboard via Tailscale node sharing; federation gains a client grouping layer so the
  mesh and board group by client → nodes → agents.
- **Graph edge extraction scheduling** — periodic gbrain edge extraction runs managed (and visualized) from the Cortex panel.
- **Multi-turn dispatch** — let a dispatched kanban card continue across agent turns (auto-redispatch with continuation context) instead of one turn per dispatch.
- **Federation write-actions for briefs and chat** — extend the opt-in `allowWrites` proxy beyond task.move / lesson / gate.

---

## Contributing

Contributions welcome! Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) (yes, the agents have their own onboarding doc).

```bash
npm install        # dev dependencies
npm run build      # bundle src/ → lib/server.js
npm test           # node --test
npm run lint       # eslint src/ tests/
```

## License

MIT — see [LICENSE](LICENSE).

## Credits

Forked from [openclaw-command-center](https://github.com/jontsai/openclaw-command-center), MIT.

---

<div align="center">

_"The Overmind sees all through its Overlords."_

**[OpenClaw](https://github.com/openclaw/openclaw)** · **[Tailscale](https://tailscale.com)**

</div>
