# OpenFleetControl — Architecture Overview

> _"The Overmind sees all through its Overlords."_

## Overview

OpenFleetControl is a real-time dashboard for monitoring and managing AI assistant orchestration across a fleet of OpenClaw nodes connected over a Tailscale tailnet. It provides visibility into sessions, token usage, costs, scheduled jobs, and system health — plus fleet-wide coordination: mesh topology, agent chat, a kanban board, briefs, shared memory (Cortex), an evolution/lessons loop, alerts, and audit logging. The fleet architecture is described in [Fleet Architecture (v1.5)](#fleet-architecture-v15) below; the sections before it document the dashboard core.

## Core Architecture Principles

### 1. **DRY (Don't Repeat Yourself)**

- Shared components extracted to reusable partials
- Single source of truth for sidebar, styling, and common logic
- Centralized configuration management

### 2. **Real-Time First**

- Server-Sent Events (SSE) for live updates
- No polling needed for connected clients
- Graceful degradation to polling when SSE unavailable

### 3. **Zero Build Step**

- Plain HTML, CSS, and JavaScript
- No compilation, bundling, or transpilation required
- Works directly from static file serving
- Dynamic loading via fetch() for shared partials

### 4. **Progressive Enhancement**

- Core functionality works without JavaScript
- Enhanced UX with JS (smooth scrolling, live updates, etc.)
- Mobile-responsive design

### 5. **Thematic Consistency**

- Starcraft/Zerg theme throughout
- Dark mode by default (space aesthetic)
- Consistent naming conventions

## System Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser (Client)                         │
├─────────────────────────────────────────────────────────────┤
│  index.html          │  jobs.html         │  (future pages) │
│  ─────────────       │  ─────────────     │                 │
│  Main Dashboard      │  AI Jobs Dashboard │                 │
└──────────┬───────────┴────────┬──────────┴─────────────────┘
           │                    │
           │  ┌─────────────────┴──────────────────┐
           │  │  /partials/sidebar.html            │
           │  │  (shared navigation component)      │
           │  └─────────────────┬──────────────────┘
           │                    │
           └────────────────────┼──────────────────────────────┐
                                │                              │
┌───────────────────────────────┴──────────────────────────────┤
│                    /js/sidebar.js                            │
│  ─ Loads sidebar partial                                     │
│  ─ Manages SSE connection for live badge updates             │
│  ─ Handles navigation and active state                       │
└──────────────────────────────────────────────────────────────┘
                                │
                                │ SSE (/api/events)
                                │ REST (/api/*)
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                    lib/server.js                             │
│  ─ Express HTTP server                                       │
│  ─ SSE event broadcasting                                    │
│  ─ API routes for state, sessions, jobs, etc.                │
│  ─ Static file serving                                       │
└─────────────────────────────────┬────────────────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
                    ▼             ▼             ▼
            ┌───────────┐ ┌───────────┐ ┌───────────┐
            │ OpenClaw  │ │   Jobs    │ │  Linear   │
            │  Gateway  │ │ Scheduler │ │   Sync    │
            │   API     │ │   API     │ │   API     │
            └───────────┘ └───────────┘ └───────────┘
```

## Frontend Architecture

### Pages

| Page         | Purpose            | Key Sections                                                       |
| ------------ | ------------------ | ------------------------------------------------------------------ |
| `index.html` | Main dashboard     | Vitals, LLM Usage, Sessions, Cron Jobs, Memory, Cerebro, Operators |
| `jobs.html`  | AI Jobs management | Job cards, run/pause/history controls                              |

### Shared Components

| Component  | Location                  | Purpose                                     |
| ---------- | ------------------------- | ------------------------------------------- |
| Sidebar    | `/partials/sidebar.html`  | Navigation + live stats badges              |
| Sidebar JS | `/js/sidebar.js`          | Partial loading, SSE connection, navigation |
| Styles     | `/css/dashboard.css`      | Shared visual theme                         |
| morphdom   | `/js/lib/morphdom.min.js` | Efficient DOM diffing                       |

### State Management

- **SSE-based**: Real-time state pushed from server
- **Local state**: Per-component state in JavaScript closures
- **Persistence**: `localStorage` for preferences (sidebar collapsed, etc.)

## Backend Architecture

### Server (`lib/server.js`)

- Express.js HTTP server
- Static file serving from `/public`
- API routes under `/api/*`
- SSE endpoint at `/api/events`

### Data Sources

| Source           | Integration | Purpose                              |
| ---------------- | ----------- | ------------------------------------ |
| OpenClaw Gateway | REST API    | Sessions, token stats, system vitals |
| Jobs Scheduler   | REST API    | AI job definitions and run history   |
| Linear           | GraphQL API | Issue tracking integration           |

### Configuration (`lib/config.js`)

- Auto-detects OpenClaw installation paths
- Supports multiple config file locations
- Environment variable overrides

## API Endpoints

| Endpoint                | Method    | Description                 |
| ----------------------- | --------- | --------------------------- |
| `/api/events`           | GET (SSE) | Real-time state updates     |
| `/api/state`            | GET       | Full current state snapshot |
| `/api/sessions`         | GET       | Session list and details    |
| `/api/jobs`             | GET       | AI job definitions          |
| `/api/jobs/:id/run`     | POST      | Trigger job execution       |
| `/api/jobs/:id/pause`   | POST      | Pause job                   |
| `/api/jobs/:id/resume`  | POST      | Resume job                  |
| `/api/jobs/:id/history` | GET       | Job run history             |

## Design Decisions

### ADR-001: Shared Sidebar via Fetch

**Decision**: Load sidebar HTML via `fetch()` rather than server-side includes or build step.

**Rationale**:

- Keeps zero-build-step architecture
- Works with any static file server
- Enables dynamic loading and hot updates
- Single source of truth for sidebar content

### ADR-002: SSE for Real-Time Updates

**Decision**: Use Server-Sent Events instead of WebSockets.

**Rationale**:

- Simpler protocol (HTTP-based)
- Automatic reconnection
- Better proxy/firewall compatibility
- Sufficient for server→client push (no bidirectional needed)

### ADR-003: Morphdom for DOM Updates

**Decision**: Use morphdom for efficient DOM patching.

**Rationale**:

- Virtual DOM-like efficiency without framework overhead
- Preserves focus, scroll position, form state
- Small footprint (~4KB)

## File Structure

```
open-fleet-control/
├── lib/                        # Backend code
│   ├── server.js               # Main HTTP server
│   ├── config.js               # Configuration loader
│   ├── jobs.js                 # Jobs API integration
│   ├── linear-sync.js          # Linear integration
│   └── topic-classifier.js     # NLP topic classification
├── public/                     # Frontend (served statically)
│   ├── index.html              # Main dashboard
│   ├── jobs.html               # AI Jobs dashboard
│   ├── partials/               # Shared HTML partials
│   │   └── sidebar.html        # Navigation sidebar
│   ├── css/
│   │   └── dashboard.css       # Shared styles
│   ├── js/
│   │   ├── sidebar.js          # Sidebar loader + SSE
│   │   ├── app.js              # Main page logic
│   │   ├── api.js              # API client utilities
│   │   ├── store.js            # State management
│   │   ├── utils.js            # Common utilities
│   │   └── lib/
│   │       └── morphdom.min.js # DOM diffing library
│   └── data/                   # Client-side data cache
├── config/                     # Configuration files
├── docs/                       # Documentation
│   └── architecture/           # Architecture docs
├── scripts/                    # Operational scripts
└── tests/                      # Test files
```

## Performance Considerations

1. **SSE Connection Sharing**: Single SSE connection per page, shared across components
2. **Lazy Loading**: Sidebar loaded on demand, not blocking initial render
3. **Efficient Updates**: morphdom patches only changed DOM nodes
4. **Debouncing**: High-frequency updates batched before render

## Security Considerations

1. **No Secrets in Frontend**: All sensitive data stays server-side
2. **Input Validation**: API inputs validated before processing
3. **CORS**: Restricted to same-origin by default
4. **Rate Limiting**: Consider for public deployments

---

## Fleet Architecture (v1.5)

Everything below was added for OpenFleetControl v1.5. The fleet lives in `src/` (bundled by esbuild into `lib/server.js`), keeps its state in plain files under the package root, and exposes itself through `/api/fleet/*` plus a handful of SSE events.

### Module Map

| Module        | File(s)                                                                                  | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Fleet runtime | `src/fleet.js`                                                                           | Instantiates and cross-wires the module family from `CONFIG.fleet`; owns the lifecycle (`start()`/`stop()` — mesh poller, stale-task watchdog, board watcher), `fireAlert()` (alerts + SSE), and `getSummary()` for `GET /api/state`. Cortex availability is cached and refreshed in the background so the state endpoint never blocks on external CLIs.                                                             |
| HTTP layer    | `src/fleet-routes.js`                                                                    | REST routes over the runtime. Body parsing capped at 64KB (1MB for briefs PUT), per-user+IP rate limiting on every mutation, identity from the `Tailscale-User-Login` header, audit record per mutation, module errors mapped to 4xx/5xx.                                                                                                                                                                            |
| Mesh          | `src/mesh.js`, `src/tailscale.js`                                                        | Node registry persisted atomically to `state/mesh-nodes.json`; health polling over tailnet HTTPS; latency history; cost rollups from remote `/api/state`. The tailscale adapter derives the MagicDNS suffix at runtime (`tailscale status --json`, falling back to the sidecar LocalAPI proxy) — no tailnet name is hardcoded. The runtime wraps it in a non-blocking cache so `getStatus()` never stalls a request. |
| Fleet Chat    | `src/fleet-chat.js`                                                                      | In-memory pub/sub with a durable trail: JSONL append (`logs/fleet-chat.jsonl`, 50MB rotation, 5 kept) + full history in SQLite (`state/fleet-chat.db`, `node:sqlite` DatabaseSync) for filtered queries and retention pruning.                                                                                                                                                                                       |
| Alerts        | `src/alerts.js`                                                                          | Rule-gated engine with 5-minute type+node/task dedupe, a 200-entry ring buffer for the UI, and sinks: HMAC-signed webhooks (`X-OFC-Signature: sha256=<hex>`) and Slack via the OpenClaw gateway (`{channel, text}` only — no tokens held). 10s timeout, one retry, failures never propagate.                                                                                                                         |
| Rate limit    | `src/rate-limit.js`                                                                      | Generic token bucket (`max` per `windowMs` per key), lazily swept. Keyed on `user                                                                                                                                                                                                                                                                                                                                    | ip` by the routes. |
| Kanban        | `src/kanban.js`, `src/kanban-schema.js`                                                  | Task lifecycle on `state/kanban.json` (`inbox → assigned → inprogress → review → done \| failed`, aligned with the agent-team-orchestration skill). Every read goes through the safe store; mutations are immutable (build → validate → atomic write → `onChange`). Includes the stale-task watchdog.                                                                                                                |
| State safety  | `src/state-safety.js`                                                                    | Generic safe JSON store for agent-editable files: validate-then-atomic-write with rotated backups, corrupt reads quarantined and auto-restored from the newest valid backup, debounced `fs.watch` with the same treatment for external writes.                                                                                                                                                                       |
| Briefs        | `src/briefs.js`                                                                          | Markdown SOP repository over `briefs/`. Two always-applied layers: filename allowlist regex (`/^[a-zA-Z0-9._-]+\.md$/`) and resolved-path containment inside the briefs dir.                                                                                                                                                                                                                                         |
| Evolution     | `src/evolution.js`                                                                       | Lessons-learned ledger (`lessons_learned.md`) + validation gate (`state/evolution.json`). Approved bodies are merged into `lessons_learned.approved.md`. Approve/reject rewrites only the target section's status line, atomically.                                                                                                                                                                                  |
| Federation    | `src/federation.js`                                                                      | Read-only fleet-of-fleets: registry of remote OpenFleetControl dashboards (`state/federation.json`), polling each remote's `/api/state` for its compact `fleet` summary. HTTPS-only URLs, optional bearer tokens persisted server-side and redacted from every response. v1 never issues writes against remotes.                                                                                                     |
| Audit         | `src/audit.js`                                                                           | Append-only JSONL (`logs/audit.jsonl`), fixed action enum, 50MB rotation with 10 files kept, filtered queries (user/action/since/until) capped at 1000 entries.                                                                                                                                                                                                                                                      |
| Cortex        | `src/cortex.js`, `src/cortex-lancedb.js`, `src/cortex-gbrain.js`, `src/cortex-gauges.js` | Facade over three adapters: LanceDB memory-pro (direct reads only; search and all writes via the `openclaw memory-pro` CLI), gbrain knowledge graph (read-only via CLI, never opens the PGLite DB), and compression gauges (headroom / lean-ctx / lcm token-savings telemetry). All lazy, all degrade to `{ error }` instead of throwing.                                                                            |

### Fleet Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     Browser (Fleet Panels)                   │
│  mesh ─ fleet-chat ─ kanban ─ briefs ─ cortex ─ evolution ─  │
│  logs   (partials loaded on demand by /js/views.js)          │
└──────────┬────────────────────────────────────▲──────────────┘
           │ REST /api/fleet/*                  │ SSE /api/events
           ▼                                    │ (fleet.* events)
┌──────────────────────────────────────────────────────────────┐
│  src/fleet-routes.js                                         │
│  identity (Tailscale-User-Login) → rate limit → handler      │
│  → audit record → JSON response                              │
└──────────┬───────────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────────┐
│  src/fleet.js (runtime)                                      │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌────────┐ ┌───────────┐     │
│  │  mesh  │ │ chat │ │ kanban │ │ briefs │ │ evolution │     │
│  └───┬────┘ └──┬───┘ └───┬────┘ └───┬────┘ └─────┬─────┘     │
│  ┌───┴────┐ ┌──┴───────┐ │ ┌────────┴───┐ ┌──────┴──────┐    │
│  │tailscale│ │ alerts ──┼─┼─► webhooks/ │ │ audit (jsonl)│   │
│  │adapter  │ │ (dedupe) │ │   Slack gw  │ └─────────────┘    │
│  └────────┘ └──────────┘ │ └────────────┘                    │
│  ┌──────────────────────┴────────────────────────────┐       │
│  │ cortex facade → lancedb / gbrain CLI / gauge files │       │
│  └───────────────────────────────────────────────────┘       │
└──────────┬───────────────────────────────────────────────────┘
           ▼
   state/  logs/  briefs/  (+ remote nodes over the tailnet)
```

Polling and watching run inside the runtime: the mesh poller hits each node's `/health` over tailnet HTTPS every `mesh.intervalMs`, the watchdog scans for stale tasks, and the board watcher picks up direct agent edits to `kanban.json` through the safe store.

### SSE Events (fleet)

In addition to the upstream `connected`, `update`, and `heartbeat` events, the runtime broadcasts:

| Event             | Fired when                                       | Payload (minimal — clients refetch via REST)  |
| ----------------- | ------------------------------------------------ | --------------------------------------------- |
| `fleet.mesh`      | Node health transition                           | `{ id, hostname, previousStatus, status }`    |
| `fleet.chat`      | Message published                                | `{ id, sender, receiver, ts }`                |
| `fleet.kanban`    | Any board mutation (API or direct file edit)     | `{ type, taskId }`                            |
| `fleet.evolution` | Lesson added / approved / rejected, gate toggled | `{ type, id }`                                |
| `fleet.alert`     | Alert actually fired (not disabled/deduped)      | `{ type, severity, node, task, message, ts }` |

### State Files Layout

All fleet directories resolve against the package root by default (`fleet.stateDir` / `logsDir` / `briefsDir` / `workspaceDir` in config):

```
state/
├── mesh-nodes.json            # node registry (atomic writes)
├── kanban.json                # task board (agent-editable)
├── kanban.quarantine.<ts>.json# corrupt board files, quarantined in place
├── fleet-chat.db              # SQLite chat history (node:sqlite)
├── federation.json            # remote dashboard registry (tokens server-side only)
├── evolution.json             # validation gate + pending queue metadata
└── backups/                   # rotated good versions written by the safe
    └── kanban.<ts>-<seq>.json #   store before each successful write (max 10)
logs/
├── audit.jsonl                # append-only audit trail
├── audit.<ts>.jsonl           # rotations at 50MB (max 10 kept)
├── fleet-chat.jsonl           # durable chat trail
└── fleet-chat.jsonl.<n>       # rotations at 50MB (max 5 kept)
briefs/
└── *.md                       # SOPs / reports (strict-allowlisted names)
<workspaceDir>/
├── lessons_learned.md         # full evolution ledger (pending + decided)
└── lessons_learned.approved.md# merged file agents consume
```

The backup/quarantine pattern (from `state-safety.js`) applies to any agent-editable JSON: corrupt files are renamed to `<name>.quarantine.<timestamp>.json` next to the original, the newest valid backup is restored, and if none exists a fresh default is created — reads never throw.

### Security Model

1. **Tailnet perimeter** — the intended deployment puts the dashboard behind Tailscale Serve (`DASHBOARD_AUTH_MODE=tailscale`); only tailnet members reach it, with no public exposure. Token / Cloudflare / IP-allowlist modes remain available.
2. **Identity attribution** — every mutating fleet request is attributed to the `Tailscale-User-Login` header (set by Tailscale Serve, not spoofable from outside the tailnet perimeter), falling back to `anonymous`. That identity flows into rate-limit keys and audit entries.
3. **Rate limiting** — token bucket per `user|ip` on all mutating `/api/fleet` routes (default 120/min); `429` responses include `retryAfterMs`.
4. **Audit trail** — append-only JSONL with a fixed action enum; audit failures never fail the request, and chat publishing relies on its own durable JSONL+SQLite trail instead.
5. **Path-traversal guards** — briefs apply a strict filename allowlist _and_ resolved-path containment (defense in depth); error messages never leak absolute server paths. Cortex and gbrain adapters use `execFile` semantics (args arrays, never a shell).
6. **XSS-safe rendering** — fleet panels render untrusted strings (chat messages, task titles, audit fields) via `textContent`/escaping helpers rather than raw `innerHTML` interpolation.
7. **No secrets held** — the Slack sink posts only `{channel, text}` to the gateway URL; webhook secrets stay server-side and are used solely for HMAC signing; the dashboard never stores tokens for remote nodes.
8. **Input validation at the boundary** — JSON bodies are size-capped and schema-checked (kanban via hand-rolled validators, alerts via event normalization); unknown fleet routes always get an explicit 404.

---

## Future Directions

1. **Component System**: More shared partials (stats bar, modals, etc.)
2. **Plugin Architecture**: Extensible dashboard sections
3. **Multi-Gateway**: Support for monitoring multiple OpenClaw instances
4. **Historical Analytics**: Token usage and cost trends over time
5. **Fleet v1.6**: Kanban keyboard accessibility, federation write-actions, full panel i18n (runtime JS strings)
