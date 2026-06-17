# OFC Production Security Hardening

> The fleet's security model in one page. Three **orthogonal** switches — do not bundle
> them. Each is owned by exactly one code path. Getting this wrong (treating "auth" as one
> thing) is what caused the cross-node `agent-run` 403 prior to v2.4.3.

## The three switches

| Switch | Protects | Code path | Single-node | Multi-node |
|---|---|---|---|---|
| **Loopback bind + Tailscale Serve** | OFC is never directly reachable on the tailnet — only via Serve | `server.bindHost` (`src/bind-host.js`) + the Serve sidecar | **Required** | **Required** |
| **`verifyServeOrigin` + `allowedUsers`** | The **human** dashboard login (per-user) | `checkAuth` (`src/auth.js`) | **Required** | **Required** |
| **Dispatch token** | **Node→node** `agent-run` (cross-node task dispatch) | the token branch of `guardActionPost` (`src/action-guard.js`) | **Not needed** | **Required** |

Remote dispatch itself (`src/agent-locator.js` / `runRemote` in `src/dispatch.js`) only matters
on **multi-node** fleets; on a single node every agent resolves `local` and the token path is
never exercised.

## Why they must stay separate (the v2.4.3 fix)

Tailscale Serve identifies a caller by tailnet **user** (e.g. `aaron@thrivenmedia.com`, resolved
via `tailscale whois` of the injected `x-forwarded-for`). The mesh-peer branch of
`guardActionPost` matches node **hostnames**. So when `verifyServeOrigin` is ON, a node→node
`agent-run` POST (which arrives via Serve→loopback, carrying `x-forwarded-for`) is verified as a
*user*, which never matches the *hostname* set → **403**.

The fix is **not** to reconcile user-vs-hostname. It is to authenticate node→node on a
**different axis entirely**: a shared **dispatch token** (`Authorization: Bearer`). The token
branch is checked *before* the hostname branch and is identity-agnostic, so it bypasses the
mismatch completely. Humans keep using `verifyServeOrigin` + the allowlist; nodes use the token.
Two axes, no collision.

- `runRemote` sends `Authorization: Bearer <fleet.dispatch.token>` (v2.4.3, `src/dispatch.js`).
- `guardActionPost` accepts it on the token branch regardless of `verifyServeOrigin`.
- Local dispatch is unaffected: a genuine loopback call has no `x-forwarded-for`, so it keeps the
  localhost short-circuit (and never needs the token).

## Config (all default to today's behavior — hardening is opt-in / installer-provisioned)

| Key | Env | Default | Hardened value |
|---|---|---|---|
| `server.bindHost` | `BIND_HOST` | `""` (all interfaces) | `127.0.0.1` |
| `auth.mode` | `DASHBOARD_AUTH_MODE` | `none` | `tailscale` |
| `auth.allowedUsers` | `DASHBOARD_ALLOWED_USERS` | `[]` | the fleet's human logins |
| `auth.tailscale.verifyServeOrigin` | `AUTH_TAILSCALE_VERIFY_SERVE_ORIGIN` | `false` | `true` |
| `auth.tailscale.tailscaledSocket` | `AUTH_TAILSCALED_SOCKET` | `""` (default socket) | the sidecar's `tailscaled.sock` |
| `fleet.dispatch.token` | `FLEET_DISPATCH_TOKEN` | `""` (node→node token auth off) | shared per-fleet secret (`op://`) |
| `fleet.dispatch.identity` | `FLEET_DISPATCH_IDENTITY` | `os.hostname()` | this node's hostname |

**Gotcha:** with `verifyServeOrigin: true` + `auth.mode: tailscale`, an **empty `allowedUsers`
locks every human out** (fail-closed). The installer refuses to provision OFC without
`FLEET_DASHBOARD_ALLOWED_USERS`. And `verifyServeOrigin` needs a working `tailscale whois` — the
`tailscale` CLI + the tailscaled socket must be reachable from the OFC process, or it fails closed.

## Production posture

- **Single-node client:** loopback bind + Serve + `verifyServeOrigin` + `allowedUsers`. No token.
- **Multi-node fleet:** the above on every node, **plus** the same `fleet.dispatch.token` (one
  `op://` ref across the fleet) so node→node `agent-run` is token-authed.

The `openclaw-stack` installer provisions all of this automatically when `FLEET_CONTROL_ENABLE=true`
— see `openclaw-stack/docs/POST-INSTALL-SETUP.md` for the zero-touch onboarding flow. A node still
must be **registered** into the mesh once (`POST /api/fleet/mesh/nodes`) for cross-node routing;
token auth means no per-node *identity* registration is required, only mesh presence.

## Do not

- Do not run production with `auth.mode: none` or `bindHost: ""` (all interfaces) — that's the
  pre-hardening default, safe only on a trusted single-operator tailnet.
- Do not try to make the mesh-peer (hostname) branch authenticate Serve-proxied calls — use the
  token. (This was the v2.4.3 lesson.)
