# Open Fleet Control — appliance image
#
# Build (from the repo root):
#   docker build -t fleet-control:latest .
#
# Run standalone:
#   docker run -p 3333:3333 fleet-control:latest
#
# Notes:
# - Cortex memory adapters (gbrain / headroom / lean-ctx / lcm) need their host
#   data paths mounted into the container (read-only is fine) and
#   pointed at via FLEET_CONFIG_JSON, e.g.:
#     FLEET_CONFIG_JSON={"cortex":{"leanCtxStats":"/cortex/lean-ctx/stats.json"}}
#   Without those mounts the dashboard runs normally and cortex panels report
#   "adapter unavailable".
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first for layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# Runtime artifacts only: bundled server, static dashboard, reference config.
COPY lib/ ./lib/
COPY public/ ./public/
COPY config/dashboard.example.json ./config/dashboard.example.json
COPY config/system-deps.json ./config/system-deps.json

# Fleet working directories (typically bind-mounted by the operator).
RUN mkdir -p state logs briefs && chown -R node:node /app

USER node

EXPOSE 3333

CMD ["node", "lib/server.js"]
