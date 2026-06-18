# OFC Overload Safety & OOM Hardening

> How a single-box OFC fleet survives memory pressure without a human at the dashboard.
> Verified on Hostinger KVM8 (Ubuntu 24.04.4, systemd 255, cgroup v2, kernel 6.8,
> Docker 29.5.3 systemd-driver swapLimit=true, 32 GiB RAM, 8 GiB disk swap). This is the
> Phase 2 design; it is the prerequisite for the Phase 3 on-demand worker pool.

## The mental model (get this right or everything else misfires)

Two jobs that look the same but are NOT:

- **Protect** the critical services (OFC dashboards, the Slack gateway) so the OOM killer
  never takes them. Tools: `MemoryMin` + `OOMScoreAdjust=-800`.
- **Contain** a genuine leak so it throttles and gets the *runaway* killed, not its healthy
  siblings or the whole box. Tools: `MemoryHigh` + `systemd-oomd` on the slice.

Containers and the user fleet are contained by **separate, non-overlapping** mechanisms, so
they can never fight or kill the wrong thing:

| Subtree | Containment | Mechanism |
|---|---|---|
| Docker containers (`system.slice/docker-*.scope`) | per-container `memory.max` | instant hard wall → in-container OOM kill, Docker restarts it |
| User fleet (`user-1001.slice` / `user@1001.service`) | `MemoryHigh` + oomd | sustained PSI → oomd SIGKILLs the worst-reclaim child |

## The decisive correction (why the "obvious" cap is wrong)

`OOMScoreAdjust=-800` only biases the **global** OOM killer's victim selection. It gives
**zero** protection against the **in-cgroup** OOM killer that a tight `MemoryMax` triggers —
that killer *must* kill something inside the cgroup to get back under the wall, and `-800`
(anything short of `-1000`, which you must never use on a leaky service) does not exempt it.

So a tight `MemoryMax` on `user@1001.service` would **order the kernel to kill OFC/Slack** the
instant the slice crossed it — the exact outcome we're avoiding. Correct combination:

- **`MemoryMin=1.5G`** — real protection from global reclaim/OOM (what `-800` alone cannot give).
- **`MemoryHigh=6G`** — soft throttle; a leak hits this first, reclaims hard, generates PSI. Never kills.
- **`MemoryMax=9G`** — HIGH catastrophic backstop only; set far above normal so transient spikes never reach it.

## The live configuration

**`/etc/systemd/system/user@1001.service.d/20-memory.conf`** (beside the existing `oom.conf` -800):
```ini
[Service]
MemoryMin=1536M
MemoryHigh=6G
MemoryMax=9G
```
**`/etc/systemd/system/user-1001.slice.d/10-fleet.conf`** (on the SLICE):
```ini
[Slice]
CPUWeight=300                      # win CPU only under contention; NOT CPUQuota (which throttles an idle box)
ManagedOOMMemoryPressure=kill      # oomd kills the worst-reclaim CHILD service, never the slice/containers
ManagedOOMMemoryPressureLimit=60%
```
**`/etc/systemd/oomd.conf.d/10-fleet.conf`** + `apt install systemd-oomd` + `enable --now`:
```ini
[OOM]
SwapUsedLimit=90%
DefaultMemoryPressureLimit=60%
DefaultMemoryPressureDurationSec=20s
```

`systemd-oomd` watches **`user-1001.slice` ONLY**. It does NOT touch `system.slice`/Docker —
do not set `ManagedOOM*` there (oomd would pick a healthy container or dockerd). No double-kill:
oomd (sustained PSI on the user slice) and Docker `memory.max` (instant hard wall in a container)
operate on disjoint cgroups with disjoint mechanisms.

**Do NOT:** set a tight `MemoryMax` on the protected services · set `ManagedOOMSwap=kill` (with
swappiness=10 the protected services get paged, so swap-kill targets exactly what you protect) ·
install `earlyoom` (fights oomd) · set `OOMScoreAdjust=-1000` (true OOM-immunity → box OOMs elsewhere).

## Container caps (cgroup v2)

On cgroup v2 there is **no `memory.memsw`**; swap is the separate `memory.swap.max`. Docker compose
`memswap_limit == mem_limit` → `memory.swap.max = 0` → **the container gets NO swap** (run-in-RAM-or-
die-clean — correct for agents). Pair with `mem_reservation` (→ soft floor). Live caps: openclaw 8g,
hermes 2g, gbrain-db 2g (compose-persisted); portainer 512m (run-managed → `docker update` only).
gbrain-db at 2g is safe: measured ~57 MiB actual, ~35× headroom; default `shared_buffers` fits.

## zram is REJECTED (it's a trap here, not an optimization)

Running zram **alongside the existing disk swap** causes LRU inversion + a thin-provisioning
deadlock → multi-minute brownouts **with the OOM killer never firing** (kernel maintainer guidance,
2026; matches a real production incident). That is the precise failure class this hardening
eliminates. Keep **disk-swap-only at swappiness 10**. "More agent capacity" comes from per-agent
caps + admission control + oomd, NOT from swap. If compression is ever wanted alongside a disk
device, the answer is **zswap** (graceful shrinker), never zram — and that's a separate kernel-cmdline decision.

## RAM budget (the spine of Phase 3 sizing)

Idle base ≈ 5 GiB (openclaw ~1–2G, gbrain ~60 MiB, hermes ~0.7G, OFC×2 ~0.5G, system ~1.5G). Caps
are spike ceilings, not reservations. ~20 GiB headroom → **6–8 isolated workers @ ~2.5 GiB** (Phase 3
target peak 4–6, comfortable). Pool governor: `Σ active × 2.5G + base ≤ 0.8 × 32 ≈ 25.6 GiB`.

## Phase 3 note: CRIU is NOT viable here

CRIU checkpoint/restore cannot restore a container whose netns is owned by the Tailscale sidecar
(`network_mode: service:<sidecar>`) — the tunnel crypto session lives outside the checkpointed tree
(confirmed broken on Docker + Ubuntu 24.04). The Phase 3 worker pool uses **`docker start` of pre-built,
pre-stopped containers** (warm pool), not CRIU.

## Applying sudo changes on this box (operational gotchas — verified the hard way)

- **`sudo tee <<'EOF'` fails when there is no controlling TTY** ("a terminal is required to read the
  password") because the heredoc occupies stdin. **Stage the file as the unprivileged user, then
  `sudo install -m 644 -o root -g root <staged> <dest>`** (no stdin redirection → sudo prompts normally).
- **`&&` chains break mid-sequence** when one sudo call can't authenticate; the rest silently don't run.
  Prefer one sudo invocation per line, or `;` for read-backs that must run regardless.
- **`systemctl daemon-reload` applies cgroup resource controls to the RUNNING unit live** — no restart
  of `user@1001.service` needed (confirmed for MemoryMin/High/Max and the slice CPUWeight/ManagedOOM).
  Fallback if a build doesn't re-apply: `sudo systemctl set-property user@1001.service MemoryMin=… MemoryHigh=… MemoryMax=…`.

## Verify it's live
```bash
# host cgroup (kernel truth)
cat /sys/fs/cgroup/user.slice/user-1001.slice/user@1001.service/memory.{min,high,max}
systemctl show user@1001.service -p MemoryMin,MemoryHigh,MemoryMax
systemctl show user-1001.slice -p CPUWeight,ManagedOOMMemoryPressure   # 60% shows as ~2576980377 (=0.6×2^32)
systemctl is-active systemd-oomd && oomctl     # oomctl needs root
# containers
for c in openclaw hermes gbrain-db portainer; do docker inspect --format '{{.Name}} {{.HostConfig.Memory}}' $c; done
# leading-indicator alarm
~/.local/bin/vps-pressure-monitor   # prints "ok (...)" or fires ntfy
```

## Related
- `docs/security-hardening.md` — the orthogonal security switches.
- `docs/remote-dispatch-runbook.md` — cross-node dispatch.
- `~/tasks/fleet-reliability-master-plan-20260618.md` + `~/tasks/phase2-execution-plan-20260618.md` —
  the full plan (Phases 1–3) and the Phase 2 execution log.
