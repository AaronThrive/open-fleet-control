# Remote (Cross-Node) Dispatch Runbook — OFC Phase 2

This is a literal, click-by-click runbook for bringing up and acceptance-testing
**remote agent dispatch** in Open Fleet Control (OFC) v2.3.1. "Remote dispatch"
means: a kanban card on dashboard **node A** can start an agent that physically
lives on a **different** node **B**, over the tailnet, and record the attempt +
result on A's card identically to a local run.

Follow every step in order. Where you see `<placeholder>` substitute your real
value. Two machines are involved:

- **Node A** — the dashboard you operate from (the orchestrator). Holds the
  kanban board.
- **Node B** — the remote worker. Hosts the agent you want to run. Must run the
  v2.3.1 build that carries the `agent-run` verb + POST route + guard.

Everything below is `curl` + config edits. No code changes are required to run
this — the implementation already ships in the build (`src/agent-locator.js`,
`src/action-guard.js`, the remote path in `src/dispatch.js`, the POST
`/api/action` branch in `src/index.js`).

> Reachability model (same as monitoring): the dashboard composes every node URL
> as `https://<hostname>.<magicdns-suffix>:<port><healthPath>`
> (`src/mesh.js:84` `composeNodeUrl`). Defaults: protocol HTTPS, port `443`,
> health path `/health`. Remote dispatch reuses that same base URL, stripping the
> health path, then POSTing to `<base>/api/action` (`src/agent-locator.js:24`
> `nodeBaseUrl`, `src/dispatch.js:358` `runRemote`).

---

## Glossary of the real config keys (cite-checked against source)

All dispatch config lives under `fleet.dispatch` in your dashboard config file
(`dashboard.json` / `dashboard.local.json`), merged over the defaults in
`src/config.js:256`:

```jsonc
// src/config.js:256 — FLEET_DEFAULTS.dispatch (the shipped defaults)
dispatch: { enabled: true, baseUrl: "", maxConcurrent: 3, timeoutSec: 600, node: "" }
```

| Key | Where read | Meaning |
|---|---|---|
| `fleet.dispatch.enabled` | `src/dispatch.js:305,475` | Master on/off for dispatch on this node. |
| `fleet.dispatch.baseUrl` | `src/index.js:267`, `src/dispatch.js:306` | Base URL injected into kickoff messages. Empty = `http://127.0.0.1:<port>`. |
| `fleet.dispatch.maxConcurrent` | `src/dispatch.js:307` | Cap on simultaneous open dispatches (default 3). |
| `fleet.dispatch.timeoutSec` | `src/dispatch.js:310` | Per-run timeout in seconds (default 600). Also drives the remote-call abort timeout (`timeoutSec*1000 + 5000`, `src/dispatch.js:359`). |
| `fleet.dispatch.node` | `src/index.js:444`, `src/dispatch.js:311` | This node's hostname for local-vs-remote routing. Empty = `os.hostname()`. |
| `fleet.dispatch.identity` | `src/index.js:275` | Value sent in the `Tailscale-User-Login` header on node→node calls. Empty = `os.hostname()`. |
| `fleet.dispatch.token` | `src/index.js:725` | Shared bearer token the remote node accepts for `agent-run` (peer-guard option 3). |

> **IMPORTANT — `token` and `identity` are NOT in the shipped defaults.**
> `src/config.js:256` defines only `{enabled, baseUrl, maxConcurrent, timeoutSec,
> node}`. The code reads `CONFIG.fleet.dispatch.token` (`src/index.js:725`) and
> `CONFIG.fleet.dispatch.identity` (`src/index.js:275`), but neither key exists
> in `FLEET_DEFAULTS`. They resolve to `undefined` (→ token disabled, identity
> falls back to `os.hostname()`) **unless you add them yourself** via the config
> file (`fleet.dispatch.token` / `fleet.dispatch.identity`) or the
> `FLEET_CONFIG_JSON` env override (deep-merged at `src/config.js:299`). There is
> no `DISPATCH_TOKEN`-style env var wired up. See "Configuring the dispatch
> token" in Section 2.

The peer-guard logic that consumes these lives in `src/action-guard.js:42`
(`guardActionPost`) and is wired at `src/index.js:737`.

---

## 1. Prerequisites

Both nodes must be on the **same tailnet** with MagicDNS + HTTPS certificates
enabled (the standard node-onboarding prerequisite — see
`docs/guides/node-setup.md`). Confirm one-time tailnet settings at
`https://login.tailscale.com/admin/dns` (MagicDNS = Enabled, HTTPS Certificates
= Enabled).

### 1.1 Confirm both nodes run OFC v2.3.1

The deploy unit is the systemd **user** service `open-fleet-control.service`,
which runs the `lib/server.js` esbuild bundle. To (re)deploy on a node:

```bash
cd ~/open-fleet-control       # repo root on that node
npm run build                 # rebuild lib/server.js
systemctl --user restart open-fleet-control.service
systemctl --user status open-fleet-control.service --no-pager
```

Confirm the version on **each** node (`/api/about` reports it, served at
`src/index.js:835`, value from `src/utils.js getVersion()`):

```bash
# On node A (run locally on A):
curl -s http://127.0.0.1:3333/api/about | jq '{name, version}'
# Expected: { "name": "OpenFleetControl", "version": "2.3.1" }

# On node B (run locally on B):
curl -s http://127.0.0.1:3333/api/about | jq '{name, version}'
# Expected: { "name": "OpenFleetControl", "version": "2.3.1" }
```

Both must report `"version": "2.3.1"` (or newer). If B reports an older version,
its `/api/action` POST branch will not exist and remote dispatch to B will fail
cleanly with a 400 (`Unknown POST action: agent-run`) — see Section 6.

> All `curl` examples use `http://127.0.0.1:3333` for **local** calls run while
> SSH'd onto that node. Cross-node calls go over tailnet HTTPS at
> `https://<hostname>.<magicdns-suffix>:<port>` — the dashboard does this for
> you; you do not normally curl B from A by hand except for the negative/security
> checks in Sections 5–6.

---

## 2. Node B (the remote worker) setup

Node B is where the agent actually runs. It must (a) run the v2.3.1 build, (b)
expose its health + agents, and (c) accept the privileged `agent-run` POST from
node A.

### 2.1 Deploy the build carrying the `agent-run` verb

On node B:

```bash
cd ~/open-fleet-control
git log --oneline -1          # confirm you are on the v2.3.1 build
npm run build
systemctl --user restart open-fleet-control.service
```

### 2.2 Confirm B's health endpoint

`GET /api/health` is public (no auth) and served at `src/index.js:566`:

```bash
# On node B:
curl -s http://127.0.0.1:3333/api/health | jq
# Expected: { "status": "ok", "port": 3333, "timestamp": "..." }
```

### 2.3 Confirm B's agents are visible

`GET /api/agents` returns B's **local** roster (`src/index.js:1155`,
`src/agents-roster.js:489`). The agent you intend to dispatch to MUST appear
here:

```bash
# On node B:
curl -s http://127.0.0.1:3333/api/agents | jq '{hostname, agents: [.agents[].id]}'
# Expected: B's hostname + the list of agent ids that live on B.
```

Note B's `hostname` from that output — you will register exactly that hostname on
node A in Section 3, and the roster attributes B's agents to it
(`src/agents-roster.js:317` `attributeRemoteAgent`).

### 2.4 Configure the dispatch peer-guard on node B (REQUIRED for cross-node)

The `agent-run` POST runs an arbitrary local agent, so it is locked down by
`guardActionPost` (`src/action-guard.js:42`). A cross-node call from A is **not**
localhost, so B must authorise A by **one** of:

1. **Mesh-peer identity** — B accepts the POST when it carries header
   `X-OFC-Dispatch: 1` AND `Tailscale-User-Login: <A's identity>` where that
   identity (lowercased) matches a hostname currently registered in B's mesh
   (`src/action-guard.js:54-60`; B's mesh peer set is built at
   `src/index.js:726-734`). This requires A to also be registered as a node in
   **B's** mesh, and A's `fleet.dispatch.identity` to equal A's registered
   hostname.
2. **Shared bearer token** — B accepts the POST when it carries
   `Authorization: Bearer <token>` equal to `fleet.dispatch.token` configured on
   B (`src/action-guard.js:47-52`, `src/index.js:725`). A must send the same
   token (A's `fleet.dispatch.token`, sent by `runRemote`… see note below).

**Recommended for a simple two-node bring-up: the shared token (option 2).** It
does not require mutual mesh registration.

#### Configuring the dispatch token (literal)

Because `token` is not in the shipped defaults, add it to B's config file. Edit
`~/open-fleet-control/dashboard.local.json` on node B (create it if absent) and
add the `fleet.dispatch.token` key:

```jsonc
{
  "fleet": {
    "dispatch": {
      "token": "op://<vault>/<item>/<field>"   // a 1Password ref OR a literal secret string
    }
  }
}
```

Notes on the token:
- The config loader resolves `op://...` references via 1Password at startup
  (`src/config.js` `secrets.resolveDeepSync`), matching the repo's secret
  posture. You may instead inline a literal random string for a quick test, but
  **never commit a real secret** — `dashboard.local.json` should be gitignored.
- Generate a strong token, e.g. `openssl rand -hex 32`.
- Restart B after editing: `systemctl --user restart open-fleet-control.service`.

> **Known limitation to be aware of (cite: `src/dispatch.js:362-372`
> `runRemote`):** the outbound remote call sends `Tailscale-User-Login:
> <meshIdentity>` and `X-OFC-Dispatch: 1`, but it does **NOT** attach an
> `Authorization: Bearer` header from A's `fleet.dispatch.token`. That means
> **option 3 (shared token) is only honoured by B's guard if some intermediary
> adds the bearer header** — A's `runRemote` itself never sends it. In a pure
> A→B OFC call, the working cross-node path today is **option 1 (mesh-peer
> identity)**: A must be registered in B's mesh and A's `fleet.dispatch.identity`
> must equal A's mesh-registered hostname. The token path is fully implemented on
> the **receiving** side (`guardActionPost`) and is useful for manual/curl
> callers, but the A-side sender does not populate it. Plan your guard choice
> accordingly. (See "Design-notes vs. implementation deltas" at the end.)

#### Recommended guard config for a two-node bring-up

Given the sender limitation above, the reliable path is **mutual mesh
registration** so B recognises A as a peer:

- On **B**, set `fleet.dispatch.node` (or rely on `os.hostname()`) so B knows its
  own name.
- Register **A** as a node in **B's** mesh (same `POST /api/fleet/mesh/nodes`
  call as Section 3, but run on B, registering A's hostname).
- On **A**, set `fleet.dispatch.identity` to **A's own registered hostname**
  (lowercase) so the `Tailscale-User-Login` header B sees matches a mesh peer.

After editing A's config, restart A.

---

## 3. Node A → register B via the mesh

On **node A**, register node B so A knows B's URL + watches B's health. The
endpoint is `POST /api/fleet/mesh/nodes` (`src/fleet-routes.js:190`,
handler `src/mesh.js:312` `registerNode`). It is a mutation, so it requires the
dashboard's mutation auth (`guardMutation`).

### 3.1 Register B

The registration body fields (validated at `src/mesh.js:99` `validateNodeInput`):
`hostname` (required; lowercase letters/digits/hyphens), `port` (default 443),
`healthPath` (default `/health`), `platform` (default `unknown`), `label`
(optional).

```bash
# On node A. <B-hostname> = the hostname you noted in step 2.3.
curl -s -X POST http://127.0.0.1:3333/api/fleet/mesh/nodes \
  -H "Content-Type: application/json" \
  -d '{
        "hostname": "<B-hostname>",
        "port": 443,
        "healthPath": "/health",
        "platform": "linux",
        "label": "Remote worker B"
      }' | jq
# Expected: { "success": true, "node": { "id": "...", "hostname": "<B-hostname>", ... } }
```

> If you run A behind Tailscale Serve, the dashboard injects your
> `Tailscale-User-Login` and `guardMutation` authorises you. If `auth.mode` is
> `none`, the mutation is allowed from localhost. If you get a 401/403, you are
> not an authorised mutator — register from the **Mesh** view in the dashboard UI
> instead (same call, done for you), or fix `auth.allowedUsers`.

### 3.2 Wait for B to poll online

The mesh poller checks each node every `fleet.mesh.intervalMs` (default 15000 ms,
`src/config.js:185`). B flips to `online` once its `/health` answers over tailnet
HTTPS (`src/mesh.js:458`). Poll A's mesh state until B is online:

```bash
# On node A — repeat until B shows "online" (give it ~15-30s):
curl -s http://127.0.0.1:3333/api/fleet/mesh \
  | jq '.nodes[] | {hostname, label, status: .health.status, url}'
# Expected eventually: { "hostname": "<B-hostname>", ..., "status": "online", "url": "https://<B-hostname>.<suffix>:443/health" }
```

The `url` field is what dispatch strips to `<base>/api/action`
(`src/agent-locator.js:24,79`).

### 3.3 Confirm B's agents appear in the fleet roster, attributed to B

`GET /api/agents/fleet` aggregates local + mesh + federation agents
(`src/index.js:1155`, `src/agents-roster.js:489` → `getRoster`). B's agents
should now appear with `node` == B's hostname and `via: "mesh"`:

```bash
# On node A:
curl -s http://127.0.0.1:3333/api/agents/fleet \
  | jq '{counts, byNode: (.byNode | keys), agents: [.agents[] | {id, node, via}]}'
# Expected: B's agents listed with "node": "<B-hostname>", "via": "mesh".
```

If B's agents do not show up here, remote dispatch cannot resolve them — the
agent locator returns `kind:"unknown"` and the card will fail with
`Unknown agent '<id>' in fleet roster` (`src/dispatch.js:430`). Wait for the
roster cache (60s, `src/agents-roster.js getRoster`) and re-poll.

---

## 4. Live acceptance test — dispatch a card to a B-only agent

Pick an agent that lives on B (from step 3.3). Two ways to target B:

- **Implicit** — if the agent id exists only on B, the locator routes to B
  automatically (`src/agent-locator.js:63-68`: prefers local, else the matching
  remote node).
- **Explicit pin** — use the `agent@node` qualified form (produced by
  `getAssignees`, `src/agents-roster.js`) to force B even if the id also exists
  locally. The dispatch route accepts an explicit `node` field which is folded
  into the agent ref (`src/dispatch.js:425`).

### 4.1 Create (or pick) a trivial card

Use any existing inbox card, or create one. Note its task id (`<TASK_ID>`).

### 4.2 Dispatch it to the B agent

The dispatch endpoint is `POST /api/fleet/kanban/tasks/<TASK_ID>/dispatch`
(`src/fleet-routes.js:480` `handleKanbanDispatch` → `dispatch.dispatchTask`). Body
fields: `agent` (required), optional `node` (explicit pin), optional `actor`.

```bash
# On node A. Implicit (agent only on B):
curl -s -X POST "http://127.0.0.1:3333/api/fleet/kanban/tasks/<TASK_ID>/dispatch" \
  -H "Content-Type: application/json" \
  -d '{ "agent": "<B-agent-id>" }' | jq

# OR explicit pin to node B:
curl -s -X POST "http://127.0.0.1:3333/api/fleet/kanban/tasks/<TASK_ID>/dispatch" \
  -H "Content-Type: application/json" \
  -d '{ "agent": "<B-agent-id>", "node": "<B-hostname>" }' | jq
# Expected immediate response:
# { "success": true, "task": {...}, "agent": "<B-agent-id>", "sessionKey": "agent:<B-agent-id>:kanban-<TASK_ID>-<ts>" }
```

The call returns immediately — it never waits for the agent turn
(`src/dispatch.js:684` `dispatchTask`). On success the card gets an **open
dispatched attempt** (the lock) and moves `inbox → assigned`.

### 4.3 What happens under the hood

1. A's locator resolves `<B-agent-id>` → `{kind:"remote", baseUrl, online}`
   (`src/agent-locator.js:75`).
2. A POSTs `{action:"agent-run", agent, message, sessionKey, timeoutSec}` to
   `<B-base>/api/action` (`src/dispatch.js:357` `runRemote`).
3. B's POST branch authorises the call (`src/index.js:737` `guardActionPost`),
   then runs `openclaw agent --agent <id> --session-key … --message … --json
   --timeout <sec>` locally via the long-timeout `runAgent` runner
   (`src/actions.js:283` `agent-run` case, `src/index.js:326` `runAgent`).
4. B parses its own CLI output (`parseRunResult`) and returns
   `{success, output, detail:{sessionId, outputText, cliError}}`.
5. A maps that envelope back into a synthetic stdout (`src/dispatch.js:91`
   `synthStdout`) and feeds it to the **same** watcher a local run uses
   (`handleRunSettled`, `src/dispatch.js:599`) — so the bookkeeping is identical.

### 4.4 Confirm the result on A

Poll the card until its attempt closes:

```bash
# On node A:
curl -s "http://127.0.0.1:3333/api/fleet/kanban" \
  | jq '.tasks[] | select(.id=="<TASK_ID>") | {status, attempts}'
```

**Expected on success:**
- The open attempt is now closed with `result: "success"`.
- The attempt `note` contains `dispatched · session <B-session-id> · result: <snippet>`
  (`src/dispatch.js:609-613`) — the session id is **B's** session.
- The attempt `result_text` holds B's full answer
  (`src/dispatch.js:614-618`, `canonicalResultText`).
- The card `status` auto-moved `assigned → review`
  (`src/dispatch.js:620` `autoMoveOnSettle`, only from assigned/inprogress).

Diff against a local run if you want proof of parity: dispatch the same trivial
card to a **local** A agent and compare the closed attempt JSON. They should
differ only in the session id and the node that ran it — every other field
(result, note shape, result_text, auto-move target) is identical, by design
(synthStdout → the shared watcher).

---

## 5. Negative test — B offline → card fails cleanly, A stays healthy

This proves the failure path: a dead remote node fails the card fast with a clear
reason, and never wedges or crashes A.

### 5.1 Stop B's dashboard

```bash
# On node B:
systemctl --user stop open-fleet-control.service
```

### 5.2 Let A's mesh notice (or dispatch immediately to test fetch-failure)

A's poller will flip B to a non-online status within ~`intervalMs` (15s). Two
sub-cases, both end in a failed card:

- **Mesh precheck (fast-fail):** if B is already marked not-online in A's mesh,
  the locator returns `online:false` and dispatch fails **before** any HTTP call
  (`src/dispatch.js:439-443`) with reason
  `Target node <B-hostname> is offline (mesh precheck)`. No 5–10s timeout.
- **Fetch failure:** if A still thinks B is online (dispatched within the poll
  window), `runRemote`'s `fetchFn` throws (connection refused / DNS / abort) and
  the run settles as a failure (`src/dispatch.js:373-375`).

### 5.3 Dispatch again and confirm failure

```bash
# On node A — pick a fresh inbox card <TASK_ID_2>:
curl -s -X POST "http://127.0.0.1:3333/api/fleet/kanban/tasks/<TASK_ID_2>/dispatch" \
  -H "Content-Type: application/json" \
  -d '{ "agent": "<B-agent-id>", "node": "<B-hostname>" }' | jq

# Then read the card:
curl -s "http://127.0.0.1:3333/api/fleet/kanban" \
  | jq '.tasks[] | select(.id=="<TASK_ID_2>") | {status, attempts}'
```

**Expected:**
- The attempt closes `result: "failure"` with a note like
  `dispatched · failed: Target node <B-hostname> is offline (mesh precheck)`
  OR a connection-error reason (`src/dispatch.js:580` `settleFailure`).
- A comment `[Dispatch] Agent run for <B-agent-id> failed: …` is added
  (`src/dispatch.js:587`).
- The card auto-moves to `failed` (`src/dispatch.js:594`).
- Node A stays healthy — `curl -s http://127.0.0.1:3333/api/health` still
  returns `{"status":"ok"}`. The concurrency cap and per-card lock are
  unaffected.

### 5.4 Restore B

```bash
# On node B:
systemctl --user start open-fleet-control.service
```

---

## 6. Security checklist

Verify the privileged `agent-run` endpoint is locked down. All of these are
cite-checked against the shipped guard (`src/action-guard.js`,
`src/index.js:682-772`).

### 6.1 Unauthorised caller is rejected (403)

A non-localhost caller with no mesh-peer identity and no token must be denied
(`src/action-guard.js:62` returns `allowed:false` → `src/index.js:744` writes
403). From a third machine **not** registered in B's mesh:

```bash
# From an unauthorised host, against B over tailnet:
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "https://<B-hostname>.<suffix>:443/api/action" \
  -H "Content-Type: application/json" \
  -d '{ "action": "agent-run", "agent": "someagent", "message": "hi" }'
# Expected: 403
```

A denial is audited with `kind:"remote-dispatch"`, `denied:"<reason>"`
(`src/index.js:739-743`).

### 6.2 Unknown POST verb is rejected (400)

Only `agent-run` is allowed over POST (`PRIVILEGED_POST_ACTIONS`,
`src/action-guard.js:11`; enforced `src/index.js:718`):

```bash
curl -s -X POST "http://127.0.0.1:3333/api/action" \
  -H "Content-Type: application/json" \
  -d '{ "action": "gateway-restart" }' | jq
# Expected: { "success": false, "action": "gateway-restart", "error": "Unknown POST action: gateway-restart" }
```

(And `GET /api/action?action=gateway-status` still works — the GET branch,
`src/index.js:773`, is unchanged. Regression check.)

### 6.3 Oversized body is rejected (413)

The POST reader caps the body at 64 KB and destroys the request
(`src/index.js:691-700`):

```bash
# 70KB of payload:
python3 -c "import json,sys; sys.stdout.write(json.dumps({'action':'agent-run','agent':'a','message':'x'*72000}))" \
  | curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://127.0.0.1:3333/api/action" \
    -H "Content-Type: application/json" --data-binary @-
# Expected: 413
```

### 6.4 No shell injection — argv is `execFile`

The agent is run as an **argv array** (no shell) at `src/dispatch.js:325-336`
(`defaultExecFn`, `execFile("openclaw", args, …)`) and the receiving side builds
the argv array at `src/actions.js:311-321`. Every field is regex-validated at the
boundary first (`AGENT_ID_PATTERN` `src/actions.js:41`, `SESSION_KEY_PATTERN`,
64 KB message cap `src/actions.js:301`). Confirm a hostile agent id is rejected
without ever invoking the runner:

```bash
# On node B (localhost is authorised, so this isolates the input validation):
curl -s -X POST "http://127.0.0.1:3333/api/action" \
  -H "Content-Type: application/json" \
  -d '{ "action": "agent-run", "agent": "foo; rm -rf /", "message": "hi" }' | jq
# Expected: { "success": false, "error": "Invalid agent id", ... } — runner never called.
```

### 6.5 Audit entry is recorded

Every `agent-run` POST is audited as `action.execute` with `kind:"remote-dispatch"`,
the `success` flag, and the `agent` (`src/index.js:757-761`). Confirm via the
dashboard's audit log / `recordAudit` sink after a successful Section 4 run.

---

## 7. Rollback

Remote dispatch is **back-compatible by construction**: with no resolver wired or
no mesh peer hosting the agent, dispatch is local-only.

To revert to local-only operation on node A:

1. **Deregister B from A's mesh** (`src/fleet-routes.js:199`,
   `src/mesh.js:333` `unregisterNode`). You need B's node `id` or hostname:

   ```bash
   # On node A — find B's id:
   curl -s http://127.0.0.1:3333/api/fleet/mesh | jq '.nodes[] | {id, hostname}'
   # Then delete it:
   curl -s -X DELETE "http://127.0.0.1:3333/api/fleet/mesh/nodes/<B-id-or-hostname>" | jq
   # Expected: { "success": true, "node": { ... } }
   ```

   With B gone from the mesh, the locator can no longer resolve B's agents to a
   node: a dispatch for a B-only agent returns `kind:"unreachable"`
   (`src/agent-locator.js:73`) and fails cleanly; an agent that also exists
   locally routes local (`src/agent-locator.js:65`). No restart needed — the
   roster cache clears within 60s.

2. **Remove the dispatch token (if you added one)** from B's
   `dashboard.local.json` (`fleet.dispatch.token`) and restart B:
   `systemctl --user restart open-fleet-control.service`. With `token` absent,
   `guardActionPost`'s token branch is disabled (`src/action-guard.js:47`).

3. **Full revert to pre-Phase-2 behaviour** is not required at the code level —
   the legacy path is preserved. If `resolveAgentNode` were ever unwired, the
   `ensureLocalNode` guard (`src/dispatch.js:481`) reinstates the original 400
   `remote dispatch not yet supported` throw for any foreign node. In the shipped
   build the resolver is always wired (`src/index.js:273`), so the practical
   rollback is simply "deregister the remote node" (step 1).

In-flight cards already locked by an open attempt close out via the normal grace
window (`timeoutSec + 15min`, `src/dispatch.js:312`) — deregistering B does not
strand them.

---

## Design-notes vs. implementation deltas (what is aspirational vs. real)

These are gaps between the design notes
(`~/.claude/plans/ofc-build/remote-dispatch-NOTES.md`) and the shipped code,
noted so you don't rely on a knob that isn't wired:

1. **`fleet.dispatch.token` and `fleet.dispatch.identity` are NOT in the config
   defaults.** `src/config.js:256` ships only `{enabled, baseUrl, maxConcurrent,
   timeoutSec, node}`. The code reads `.token` (`src/index.js:725`) and
   `.identity` (`src/index.js:275`) but they only take effect if you add them via
   the config file or `FLEET_CONFIG_JSON`. There is no dedicated env var
   (`DISPATCH_TOKEN` etc.) — the design note's "store via env/secret" is realised
   only through the generic `op://` / config-file mechanism.

2. **The A-side sender (`runRemote`) does NOT attach `Authorization: Bearer
   <token>`.** Design §5 lists the shared token as guard option 3, and the
   **receiving** guard fully implements it (`src/action-guard.js:47-52`). But the
   outbound call at `src/dispatch.js:362-372` sends only `Tailscale-User-Login`
   and `X-OFC-Dispatch: 1` — never a bearer header sourced from A's
   `fleet.dispatch.token`. So in a pure OFC A→B dispatch, the **working**
   cross-node auth path is the **mesh-peer identity** (option 1), not the token.
   The token path works for manual/curl callers but is effectively dormant for
   the automated sender. (This runbook recommends mutual mesh registration
   accordingly.)

3. **Design §5 "Rate limiting" via `fleet.rateLimiter` on `agent-run` is NOT
   wired into the POST branch.** The POST handler (`src/index.js:682-772`) does
   guard + audit but does not route `agent-run` through a rate limiter. Body size
   (64 KB) and the per-board concurrency cap are the only throttles in effect.

4. **`previewDispatch` stays local-only.** It still calls `ensureLocalNode`
   (`src/dispatch.js:663`) and reports `node: selfNode`
   (`src/dispatch.js:669`) — the design's "show the resolved remote node in
   preview" is not implemented. Preview never executes, so this is cosmetic.

5. Everything else in the design notes maps cleanly to shipped code: the agent
   locator (`src/agent-locator.js`), the `agent-run` verb + validators
   (`src/actions.js:283`), the remote path / `synthStdout` / `startRun` /
   `runRemote` (`src/dispatch.js`), the POST branch + `guardActionPost` wiring
   (`src/index.js:682`, `src/action-guard.js`), the mesh-health precheck
   (`src/dispatch.js:439`), and the unchanged `handleRunSettled` watcher reuse.
