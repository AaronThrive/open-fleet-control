---
name: open-fleet-control
version: 1.6.0
description: Mission control dashboard for OpenClaw - real-time session monitoring, LLM usage tracking, cost intelligence, and system vitals. View all your AI agents in one place.
metadata:
  openclaw:
    requires:
      node: ">=18"
    install:
      - id: start
        kind: shell
        command: "node lib/server.js"
        label: "Start OpenFleetControl (http://localhost:3333)"
---

# OpenFleetControl

Mission control for your AI workforce. Built by Aaron May.

## Quick Start

```bash
git clone https://github.com/AaronThrive/open-fleet-control
cd open-fleet-control
npm install && npm run build
node lib/server.js
```

Dashboard runs at **http://localhost:3333**

## Features

- **Session Monitoring** — Real-time view of all AI sessions with live updates
- **LLM Fuel Gauges** — Track Claude, Codex, and other model usage
- **System Vitals** — CPU, Memory, Disk, Temperature
- **Cron Jobs** — View and manage scheduled tasks
- **Cerebro Topics** — Automatic conversation organization
- **Cost Tracking** — Per-session costs, projections, savings estimates
- **Privacy Controls** — Hide sensitive topics for demos

## Configuration

The dashboard auto-detects your OpenClaw workspace. Set `OPENCLAW_WORKSPACE` to override.

### Authentication

| Mode         | Use Case          |
| ------------ | ----------------- |
| `none`       | Local development |
| `token`      | Remote access     |
| `tailscale`  | Team VPN          |
| `cloudflare` | Public deployment |

```bash
DASHBOARD_AUTH_MODE=tailscale node lib/server.js
```

## API

| Endpoint          | Description                  |
| ----------------- | ---------------------------- |
| `GET /api/state`  | All dashboard data (unified) |
| `GET /api/events` | SSE stream for live updates  |
| `GET /api/health` | Health check                 |

## Links

- [GitHub](https://github.com/AaronThrive/open-fleet-control)
- [Documentation](https://github.com/AaronThrive/open-fleet-control#readme)
