# Client Install Runbook — Fleet Control Appliance

This is the full runbook for installing OpenFleetControl on a client or
appliance machine as part of the `openclaw-stack` appliance, running on the
**client's own tailnet**. Every step is literal: click here, type this.

## What gets installed

Two extra containers join the appliance Compose stack when the fleet-control
flag is enabled:

| Container                            | Image                  | Role                                                                                                                                                               |
| ------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<instance>-fleet-control-tailscale` | `tailscale/tailscale`  | Dedicated tailnet node for the dashboard. Applies a declarative serve config (`TS_SERVE_CONFIG`) that proxies tailnet HTTPS 443 to the dashboard port on loopback. |
| `<instance>-fleet-control`           | `fleet-control:latest` | The dashboard itself. Shares the sidecar's network namespace (`network_mode: service:fleet-control-tailscale`), listens on `127.0.0.1:3333`.                       |

The result: the dashboard is reachable at
`https://<FLEET_CONTROL_TAILSCALE_HOSTNAME>.<client-tailnet>.ts.net` from
anywhere on the client's tailnet, with no public exposure.

## 1. Prerequisites

You need all of the following before starting:

1. **The client's tailnet**, with admin-console access.
   - Open `https://login.tailscale.com/admin/dns`.
   - Confirm **MagicDNS** is **Enabled**; if not, click **Enable MagicDNS**.
   - Under **HTTPS Certificates**, click **Enable HTTPS**.
   - Write down the tailnet DNS name shown on that page (for example
     `client-co.ts.net`). It is used as `<tailnet>` below.
2. **A Tailscale auth key with a tag**:
   - Open `https://login.tailscale.com/admin/acls/file` and make sure a tag
     such as `tag:openclaw` exists in the policy (add
     `"tagOwners": {"tag:openclaw": ["autogroup:admin"]}` if it does not, then
     click **Save**).
   - Open `https://login.tailscale.com/admin/settings/keys`, click
     **Generate auth key**, toggle **Reusable** on, click **Add tags**, select
     `tag:openclaw`, click **Generate key**, and copy the `tskey-auth-...`
     value. A reusable key can authenticate both the OpenClaw sidecar and the
     fleet-control sidecar; otherwise generate one key per sidecar.
3. **A Docker host** with the `openclaw-stack` repository cloned and its
   prerequisites installed (`docker`, `jq`, `rsync`, `git`, `curl`, `openssl`,
   `rg`, `sudo`).
4. **This repository** (`open-fleet-control`) cloned on the same Docker host.
5. Optional: 1Password CLI (`op`) plus a vault, if the client install stores
   secrets as `op://` references instead of plain values.

## 2. Build the dashboard image

The appliance does not pull the dashboard from a registry — you build it once
on the Docker host:

```bash
cd /path/to/open-fleet-control
docker build -t fleet-control:latest .
```

Notes:

- The image installs production dependencies with `npm ci --omit=dev`.
  `@lancedb/lancedb` is a native dependency; `npm ci` selects the prebuilt
  binary for the image platform.
- Cortex memory panels (lancedb / headroom / lean-ctx) only light up if the
  matching host data paths are mounted into the container and pointed at via
  `FLEET_CONTROL_CONFIG_JSON` (step 3). Without them the dashboard still runs;
  those panels report "adapter unavailable".
- The installer fails fast with a clear message if you forget this step.

## 3. Fill in `.env`

1. In the `openclaw-stack` checkout:

   ```bash
   cp secrets/.env.example .env
   chmod 600 .env
   ```

2. Open `.env` in an editor and fill the normal appliance values
   (`INSTANCE_ID`, `TAILSCALE_HOSTNAME`, `TAILSCALE_FQDN`, auth key refs, and
   so on) per the stack README.

3. Find the `# Fleet Control dashboard` block and set, substituting the
   client's tailnet name everywhere:

   ```bash
   FLEET_CONTROL_ENABLE=true
   FLEET_CONTROL_TAILSCALE_HOSTNAME=fleet-control-clientbox
   FLEET_CONTROL_TAILSCALE_FQDN=fleet-control-clientbox.client-co.ts.net
   FLEET_CONTROL_PORT=3333
   # Either a 1Password reference...
   FLEET_CONTROL_TAILSCALE_AUTHKEY_REF="op://OpenClaw clientbox/Tailscale/auth_key"
   # ...or a direct value (leave the other empty):
   FLEET_CONTROL_TAILSCALE_AUTHKEY=tskey-auth-XXXXXXXXXXXX
   ```

4. Optional — fleet behavior overrides. `FLEET_CONTROL_CONFIG_JSON` is passed
   into the container as `FLEET_CONFIG_JSON` and deep-merged over the `fleet`
   section of the dashboard config (alerts, mesh interval, cortex paths,
   rate limits). The appliance mounts the instance's `lean-ctx` and `openclaw`
   state read-only at `/cortex/lean-ctx` and `/cortex/openclaw`, so for
   example:

   ```bash
   FLEET_CONTROL_CONFIG_JSON={"cortex":{"leanCtxStats":"/cortex/lean-ctx/stats.json","headroomStats":""},"mesh":{"intervalMs":15000}}
   ```

   Leave it empty to run with defaults.

## 4. Run the installer

From the `openclaw-stack` checkout:

```bash
./scripts/install.sh --instance clientbox --tailscale sidecar --secrets env
```

(Use `--secrets 1password` if you filled `op://` references and have `op`
logged in. Add `--yes` only for unattended installs you have already
reviewed.)

Type `INSTALL` at the confirmation prompt.

What happens, in order:

1. Prerequisite and secret checks.
2. `render-config.sh` renders the instance state under `$STATE_ROOT`,
   including (because `FLEET_CONTROL_ENABLE=true`):
   - `compose.fleet-control.yaml` — the two extra services;
   - `fleet-control-serve/serve.json` — the declarative serve config mapping
     tailnet `443` to `http://127.0.0.1:3333`;
   - `fleet-control-tailscale.env` — the resolved `TS_AUTHKEY` (mode 0600,
     written once; delete the file to force re-resolution);
   - `fleet-control.env` — the `FLEET_CONFIG_JSON` passthrough;
   - `fleet-control/{state,logs,briefs}` — persistent dashboard data dirs.
3. A "Fleet Control dashboard" step confirms the `fleet-control:latest` image
   exists (and aborts with build instructions if it does not).
4. `docker compose` brings the whole stack up, fleet-control services
   included, with the standard health checks.

## 5. First run

1. On any machine on the client's tailnet, open a browser and go to:

   ```
   https://fleet-control-clientbox.client-co.ts.net
   ```

   The first load can take up to a minute while the sidecar joins the tailnet
   and the TLS certificate is issued.

2. Sanity-check the API:

   ```bash
   curl https://fleet-control-clientbox.client-co.ts.net/api/health
   ```

   Expect `{"status":"ok","port":3333,...}`.

3. Discover the client's nodes: in the dashboard, open **Fleet** →
   **Nodes** → click **Discover**. The list comes from Tailscale status, so
   every machine on the client's tailnet appears as a candidate.

4. Register each machine that runs an OpenClaw gateway: click **Register**,
   keep port `443` and health path `/health`, pick the platform, confirm.
   If a node is not serving `/health` over tailnet HTTPS yet, onboard it first
   using the [Node Setup Guide](./node-setup.md).

5. Within ~15 seconds each registered node shows online status, latency, and
   version.

## 6. Why nothing is hardcoded to any tailnet

Worth stating explicitly during client handoff:

- **Tailnet identity comes only from the auth key.** The sidecars join
  whichever tailnet issued `FLEET_CONTROL_TAILSCALE_AUTHKEY[_REF]` /
  `TAILSCALE_AUTHKEY[_REF]`.
- **Hostnames and FQDNs are `.env` values** rendered into per-instance files
  at install time; the templates ship with `REPLACE_WITH_TAILNET`
  placeholders, never a real tailnet.
- **The dashboard discovers the MagicDNS suffix at runtime** from Tailscale
  status (via the sidecar's local endpoint, wired as
  `TAILSCALE_LOCAL_API_ENDPOINT=http://127.0.0.1:9002`), so node URLs are
  composed against the client's tailnet automatically.
- **Moving to a different tailnet** is: generate a new auth key there, update
  `.env` (authkey + FQDN values), delete
  `$STATE_ROOT/fleet-control-tailscale.env` and the
  `$STATE_ROOT/fleet-control-tailscale/` state directory, re-run
  `./scripts/render-config.sh`, then `docker compose up -d`.

## 7. Day-2 operations

- **Disable fleet control**: set `FLEET_CONTROL_ENABLE=false` in `.env`,
  re-run `./scripts/render-config.sh` (this removes
  `compose.fleet-control.yaml`), then from `$STATE_ROOT`:
  `docker compose --env-file .env -f compose.yaml up -d --remove-orphans`.
- **Update the dashboard**: pull the new `open-fleet-control` code,
  `docker build -t fleet-control:latest .`, then restart just the dashboard:
  `docker rm -f <instance>-fleet-control` followed by the stack's normal
  `compose up -d`.
- **Logs**: `docker logs <instance>-fleet-control` and
  `docker logs <instance>-fleet-control-tailscale`.
- **Persistent data** (kanban state, audit log, briefs) lives under
  `$STATE_ROOT/fleet-control/` on the host and is included in the appliance's
  normal backup paths.

## Troubleshooting

| Symptom                                                    | Fix                                                                                                                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installer aborts at "Fleet Control dashboard" step         | Build the image: `docker build -t fleet-control:latest /path/to/open-fleet-control`.                                                                                                                     |
| Sidecar restarts in a loop                                 | Auth key invalid/expired or not tagged per ACL. Check `docker logs <instance>-fleet-control-tailscale`, regenerate the key, delete `$STATE_ROOT/fleet-control-tailscale.env`, re-run `render-config.sh`. |
| Browser cannot resolve the FQDN                            | MagicDNS disabled on the tailnet, or the viewing machine is not on the tailnet.                                                                                                                          |
| Dashboard loads but Discover shows "tailscale unavailable" | The container reaches Tailscale via `TAILSCALE_LOCAL_API_ENDPOINT`; confirm the sidecar is healthy (`docker inspect --format '{{.State.Health.Status}}' <instance>-fleet-control-tailscale`).            |
| Cortex panels empty                                        | Expected unless cortex paths are set via `FLEET_CONTROL_CONFIG_JSON` and the corresponding read-only mounts contain data.                                                                                |
