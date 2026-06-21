/**
 * Command Palette — Ctrl+K fleet command runner (self-contained ESM).
 *
 * NOT auto-wired: the integrator imports initCommandPalette() once (see
 * INTEGRATION NOTES in the v2.2 bulk-actions branch report). The module
 * owns its own DOM (overlay appended to <body>), its own styles (injected
 * <style> tag), and its own keyboard handling — nothing in index.html
 * needs to change beyond the single script tag.
 *
 * Commands:
 *   - "Go to <view>" navigation jumps (URL hash routing, views.js contract)
 *   - Fleet bulk operations via POST /api/fleet/bulk:
 *       health-check / gateway-status / kill-stale-sessions (node targets)
 *       dispatch-task / chat-broadcast (agent targets)
 *
 * Flow: fuzzy command list → optional params input → multi-select target
 * picker (nodes from /api/fleet/mesh, agents from /api/agents) → confirm
 * step for destructive ops → per-target result list.
 *
 * Safety: every rendered string goes through textContent (no innerHTML
 * anywhere in this module), so API-sourced names/details cannot inject
 * markup. Keyboard: ArrowUp/Down + Enter in lists, Space toggles targets,
 * Escape steps back (and closes from the command list).
 */

import { t } from "./utils.js";

const VIEWS = [
  "mesh",
  "federation",
  "fleet-chat",
  "kanban",
  "briefs",
  "cortex",
  "evolution",
  "logs",
  "alerts",
  "sessions",
  "cron",
  "vitals",
  "llm-usage",
  "tokens",
  "settings",
  "docker",
  "agents",
];

const BULK_COMMANDS = [
  {
    id: "health-check",
    icon: "🩺",
    targetKind: "node",
    destructive: false,
    params: [],
    label: () => t("palette.cmd.healthCheck", {}, "Fleet: Health check nodes"),
  },
  {
    id: "gateway-status",
    icon: "🚪",
    targetKind: "node",
    destructive: false,
    params: [],
    label: () => t("palette.cmd.gatewayStatus", {}, "Fleet: Gateway status"),
  },
  {
    id: "kill-stale-sessions",
    icon: "🧹",
    targetKind: "node",
    destructive: true,
    params: [
      {
        name: "staleMinutes",
        type: "number",
        required: false,
        label: () => t("palette.param.staleMinutes", {}, "Stale after (minutes, default 1440)"),
      },
    ],
    label: () => t("palette.cmd.killStale", {}, "Fleet: Kill stale sessions"),
  },
  {
    id: "dispatch-task",
    icon: "🚀",
    targetKind: "agent",
    destructive: true,
    params: [
      {
        name: "taskId",
        type: "text",
        required: true,
        label: () => t("palette.param.taskId", {}, "Kanban task id"),
      },
    ],
    label: () => t("palette.cmd.dispatchTask", {}, "Fleet: Dispatch task to agents"),
  },
  {
    id: "chat-broadcast",
    icon: "📣",
    targetKind: "agent",
    destructive: false,
    allowAllTarget: true,
    params: [
      {
        name: "text",
        type: "text",
        required: true,
        label: () => t("palette.param.message", {}, "Message text"),
      },
    ],
    label: () => t("palette.cmd.chatBroadcast", {}, "Fleet: Broadcast chat message"),
  },
];

const STYLE_ID = "cmd-palette-styles";

const CSS = `
.cmdp-overlay{position:fixed;inset:0;z-index:9000;display:flex;align-items:flex-start;
  justify-content:center;padding-top:12vh;background:rgba(0,0,0,.55)}
.cmdp-panel{width:min(640px,92vw);max-height:70vh;display:flex;flex-direction:column;
  background:var(--bg-panel,#10141c);border:1px solid var(--border,#2a3346);
  border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;
  font-family:inherit;color:var(--text,#dbe2f0)}
.cmdp-head{padding:10px 12px;border-bottom:1px solid var(--border,#2a3346);
  display:flex;gap:8px;align-items:center}
.cmdp-input{flex:1;background:transparent;border:none;outline:none;
  color:inherit;font-size:15px}
.cmdp-crumb{font-size:11px;opacity:.65;white-space:nowrap}
.cmdp-list{overflow-y:auto;padding:6px;flex:1}
.cmdp-item{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:6px;
  cursor:pointer;font-size:14px}
.cmdp-item[aria-selected="true"]{background:var(--accent-dim,rgba(80,160,255,.18))}
.cmdp-item .cmdp-hint{margin-left:auto;font-size:11px;opacity:.55}
.cmdp-empty{padding:18px;text-align:center;opacity:.6;font-size:13px}
.cmdp-foot{padding:8px 12px;border-top:1px solid var(--border,#2a3346);
  display:flex;gap:8px;justify-content:flex-end;align-items:center}
.cmdp-foot .cmdp-keys{margin-right:auto;font-size:11px;opacity:.5}
.cmdp-btn{background:var(--accent,#3b82f6);border:none;color:#fff;border-radius:6px;
  padding:6px 14px;font-size:13px;cursor:pointer}
.cmdp-btn:disabled{opacity:.45;cursor:default}
.cmdp-btn.cmdp-danger{background:#c0392b}
.cmdp-btn.cmdp-ghost{background:transparent;border:1px solid var(--border,#2a3346);
  color:inherit}
.cmdp-target{display:flex;gap:10px;align-items:center;padding:7px 10px;border-radius:6px;
  cursor:pointer;font-size:13px}
.cmdp-target[aria-selected="true"]{background:var(--accent-dim,rgba(80,160,255,.18))}
.cmdp-target input{pointer-events:none}
.cmdp-target .cmdp-meta{margin-left:auto;font-size:11px;opacity:.6}
.cmdp-form{padding:14px;display:flex;flex-direction:column;gap:10px}
.cmdp-form label{font-size:12px;opacity:.75}
.cmdp-form input{background:var(--bg-input,#0b0f16);border:1px solid var(--border,#2a3346);
  border-radius:6px;color:inherit;padding:7px 9px;font-size:14px}
.cmdp-confirm{padding:16px;font-size:14px;line-height:1.5}
.cmdp-result{display:flex;gap:10px;align-items:baseline;padding:6px 10px;font-size:13px;
  border-bottom:1px solid var(--border,#1c2433)}
.cmdp-result .cmdp-result-detail{opacity:.75;font-size:12px;white-space:pre-wrap;
  word-break:break-word}
.cmdp-ok{color:#2ecc71}.cmdp-fail{color:#e74c3c}
.cmdp-trigger-btn{background:transparent;border:1px solid var(--border,#2a3346);
  border-radius:6px;color:inherit;cursor:pointer;padding:4px 9px;font-size:14px}
`;

// ---------------------------------------------------------------------------
// Module state (one palette per page)
// ---------------------------------------------------------------------------

let overlay = null;
let keyHandler = null;
let state = null; // active interaction state while open

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Fuzzy matching (subsequence with simple scoring)
// ---------------------------------------------------------------------------

function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (!q) return 1;
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) {
      qi++;
      streak++;
      score += 1 + streak;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

// ---------------------------------------------------------------------------
// Command catalog
// ---------------------------------------------------------------------------

function buildCommands() {
  const commands = [];
  for (const cmd of BULK_COMMANDS) {
    commands.push({
      kind: "bulk",
      id: cmd.id,
      icon: cmd.icon,
      label: cmd.label(),
      hint: t("palette.hint.bulk", {}, "bulk"),
      spec: cmd,
    });
  }
  for (const view of VIEWS) {
    const pretty = view.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    commands.push({
      kind: "nav",
      id: `nav-${view}`,
      icon: "↪",
      label: t("palette.cmd.goTo", { view: pretty }, "Go to {view}"),
      hint: t("palette.hint.nav", {}, "nav"),
      view,
    });
  }
  return commands;
}

function navigateToView(view) {
  const target = `#view-${view}`;
  const unchanged = window.location.hash === target;
  window.location.hash = target;
  // Setting location.hash fires hashchange only when the hash actually
  // changed — re-notify views.js when the user re-runs the same jump.
  if (unchanged) {
    window.dispatchEvent(new window.HashChangeEvent("hashchange"));
  }
}

// ---------------------------------------------------------------------------
// Data fetching for the target picker
// ---------------------------------------------------------------------------

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch (e) {
    /* non-JSON body */
  }
  if (!response.ok) {
    throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`);
  }
  return payload;
}

async function fetchNodeTargets() {
  const targets = [
    {
      id: "local",
      label: t("palette.target.local", {}, "local (this dashboard)"),
      meta: "",
    },
  ];
  try {
    const mesh = await fetchJson("/api/fleet/mesh");
    for (const node of Array.isArray(mesh && mesh.nodes) ? mesh.nodes : []) {
      targets.push({
        id: node.id || node.hostname,
        label: node.label && node.label !== node.hostname
          ? `${node.hostname} (${node.label})`
          : node.hostname,
        meta: node.health && node.health.status ? node.health.status : "unknown",
      });
    }
  } catch (e) {
    // Mesh unavailable — "local" alone is still a valid target set.
  }
  return targets;
}

async function fetchAgentTargets(includeAll) {
  const targets = [];
  if (includeAll) {
    targets.push({
      id: "all",
      label: t("palette.target.all", {}, "all (broadcast)"),
      meta: "",
    });
  }
  try {
    const roster = await fetchJson("/api/agents");
    for (const agent of Array.isArray(roster && roster.agents) ? roster.agents : []) {
      if (!agent || typeof agent.id !== "string") continue;
      targets.push({
        id: agent.id,
        label: agent.name && agent.name !== agent.id ? `${agent.id} (${agent.name})` : agent.id,
        meta: agent.active ? t("palette.target.active", {}, "active") : "",
      });
    }
  } catch (e) {
    // Roster unavailable — picker shows what it has (possibly just "all").
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Rendering — each step replaces the panel body
// ---------------------------------------------------------------------------

function renderShell() {
  injectStyles();
  overlay = el("div", "cmdp-overlay");
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closePalette();
  });
  const panel = el("div", "cmdp-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", t("palette.title", {}, "Command palette"));
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  return panel;
}

function clearPanel() {
  if (state && state.panel) state.panel.replaceChildren();
}

/** Step 1: fuzzy command list. */
function renderCommandStep() {
  clearPanel();
  state.step = "command";

  const head = el("div", "cmdp-head");
  const input = el("input", "cmdp-input");
  input.type = "text";
  input.placeholder = t("palette.searchPlaceholder", {}, "Type a command…");
  input.setAttribute("aria-label", t("palette.title", {}, "Command palette"));
  head.appendChild(input);
  head.appendChild(el("span", "cmdp-crumb", "Ctrl+K"));
  state.panel.appendChild(head);

  const list = el("div", "cmdp-list");
  list.setAttribute("role", "listbox");
  state.panel.appendChild(list);

  const foot = el("div", "cmdp-foot");
  foot.appendChild(
    el("span", "cmdp-keys", t("palette.keysHelp", {}, "↑↓ navigate · Enter run · Esc close")),
  );
  state.panel.appendChild(foot);

  let filtered = [];
  let active = 0;

  const renderList = () => {
    const query = input.value.trim();
    filtered = state.commands
      .map((cmd) => ({ cmd, score: fuzzyScore(query, cmd.label) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.cmd);
    active = Math.min(active, Math.max(0, filtered.length - 1));
    list.replaceChildren();
    if (filtered.length === 0) {
      list.appendChild(el("div", "cmdp-empty", t("palette.noMatches", {}, "No matching commands")));
      return;
    }
    filtered.forEach((cmd, index) => {
      const item = el("div", "cmdp-item");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === active ? "true" : "false");
      item.appendChild(el("span", "", cmd.icon));
      item.appendChild(el("span", "", cmd.label));
      item.appendChild(el("span", "cmdp-hint", cmd.hint));
      item.addEventListener("click", () => selectCommand(cmd));
      item.addEventListener("mousemove", () => {
        if (active !== index) {
          active = index;
          updateActive();
        }
      });
      list.appendChild(item);
    });
  };

  const updateActive = () => {
    const items = list.querySelectorAll(".cmdp-item");
    items.forEach((item, index) => {
      item.setAttribute("aria-selected", index === active ? "true" : "false");
    });
    const current = items[active];
    if (current) current.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", () => {
    active = 0;
    renderList();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(active + 1, filtered.length - 1);
      updateActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      updateActive();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (filtered[active]) selectCommand(filtered[active]);
    }
  });

  renderList();
  input.focus();
}

function selectCommand(cmd) {
  if (cmd.kind === "nav") {
    closePalette();
    navigateToView(cmd.view);
    return;
  }
  state.selected = cmd.spec;
  state.params = {};
  state.targets = new Set();
  if (cmd.spec.params.length > 0) {
    renderParamsStep();
  } else {
    renderTargetStep();
  }
}

/** Step 2 (optional): parameter inputs. */
function renderParamsStep() {
  clearPanel();
  state.step = "params";
  const spec = state.selected;

  const head = el("div", "cmdp-head");
  head.appendChild(el("span", "", spec.icon));
  head.appendChild(el("span", "", spec.label()));
  state.panel.appendChild(head);

  const form = document.createElement("form");
  form.className = "cmdp-form";
  const inputs = [];
  for (const param of spec.params) {
    const label = el("label", "", param.label());
    const input = document.createElement("input");
    input.type = param.type === "number" ? "number" : "text";
    input.dataset.param = param.name;
    if (param.required) input.required = true;
    label.appendChild(document.createElement("br"));
    label.appendChild(input);
    form.appendChild(label);
    inputs.push({ param, input });
  }
  state.panel.appendChild(form);

  const foot = el("div", "cmdp-foot");
  foot.appendChild(el("span", "cmdp-keys", t("palette.keysBack", {}, "Esc back")));
  const back = el("button", "cmdp-btn cmdp-ghost", t("palette.back", {}, "Back"));
  back.type = "button";
  back.addEventListener("click", () => renderCommandStep());
  foot.appendChild(back);
  const next = el("button", "cmdp-btn", t("palette.next", {}, "Next"));
  next.type = "submit";
  foot.appendChild(next);
  form.appendChild(foot);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    for (const { param, input } of inputs) {
      const value = input.value.trim();
      if (param.required && !value) {
        input.focus();
        return;
      }
      if (value) {
        state.params[param.name] = param.type === "number" ? Number(value) : value;
      }
    }
    renderTargetStep();
  });

  if (inputs[0]) inputs[0].input.focus();
}

/** Step 3: multi-select target picker. */
async function renderTargetStep() {
  clearPanel();
  state.step = "targets";
  const spec = state.selected;

  const head = el("div", "cmdp-head");
  head.appendChild(el("span", "", spec.icon));
  head.appendChild(el("span", "", spec.label()));
  head.appendChild(
    el(
      "span",
      "cmdp-crumb",
      spec.targetKind === "node"
        ? t("palette.pickNodes", {}, "Select nodes")
        : t("palette.pickAgents", {}, "Select agents"),
    ),
  );
  state.panel.appendChild(head);

  const list = el("div", "cmdp-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-multiselectable", "true");
  list.appendChild(el("div", "cmdp-empty", t("palette.loadingTargets", {}, "Loading targets…")));
  state.panel.appendChild(list);

  const foot = el("div", "cmdp-foot");
  foot.appendChild(
    el("span", "cmdp-keys", t("palette.keysTargets", {}, "Space toggle · Enter continue · Esc back")),
  );
  const back = el("button", "cmdp-btn cmdp-ghost", t("palette.back", {}, "Back"));
  back.type = "button";
  back.addEventListener("click", () => renderCommandStep());
  foot.appendChild(back);
  const runBtn = el(
    "button",
    `cmdp-btn${spec.destructive ? " cmdp-danger" : ""}`,
    spec.destructive ? t("palette.continue", {}, "Continue") : t("palette.run", {}, "Run"),
  );
  runBtn.type = "button";
  runBtn.disabled = true;
  foot.appendChild(runBtn);
  state.panel.appendChild(foot);

  const targets =
    spec.targetKind === "node"
      ? await fetchNodeTargets()
      : await fetchAgentTargets(spec.allowAllTarget === true);
  if (!state || state.step !== "targets") return; // closed/changed mid-fetch

  let active = 0;
  const rows = [];

  const refreshRun = () => {
    runBtn.disabled = state.targets.size === 0;
  };

  const updateActive = () => {
    rows.forEach((row, index) => {
      row.setAttribute("aria-selected", index === active ? "true" : "false");
    });
    if (rows[active]) rows[active].scrollIntoView({ block: "nearest" });
  };

  const toggle = (target, checkbox) => {
    if (state.targets.has(target.id)) {
      state.targets.delete(target.id);
      checkbox.checked = false;
    } else {
      state.targets.add(target.id);
      checkbox.checked = true;
    }
    refreshRun();
  };

  list.replaceChildren();
  if (targets.length === 0) {
    list.appendChild(el("div", "cmdp-empty", t("palette.noTargets", {}, "No targets available")));
  }
  targets.forEach((target, index) => {
    const row = el("div", "cmdp-target");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", index === 0 ? "true" : "false");
    row.tabIndex = -1;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.tabIndex = -1;
    row.appendChild(checkbox);
    row.appendChild(el("span", "", target.label));
    if (target.meta) row.appendChild(el("span", "cmdp-meta", target.meta));
    row.addEventListener("click", () => {
      active = index;
      updateActive();
      toggle(target, checkbox);
    });
    rows.push(row);
    list.appendChild(row);
  });

  const proceed = () => {
    if (state.targets.size === 0) return;
    if (spec.destructive) renderConfirmStep();
    else runBulk();
  };
  runBtn.addEventListener("click", proceed);

  const keyNav = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(active + 1, rows.length - 1);
      updateActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      updateActive();
    } else if (event.key === " ") {
      event.preventDefault();
      const target = targets[active];
      const checkbox = rows[active] && rows[active].querySelector("input");
      if (target && checkbox) toggle(target, checkbox);
    } else if (event.key === "Enter") {
      event.preventDefault();
      proceed();
    }
  };
  state.panel.addEventListener("keydown", keyNav);
  state.stepKeyHandler = keyNav;

  list.tabIndex = 0;
  list.focus();
  refreshRun();
}

/** Step 4 (destructive ops): confirmation. */
function renderConfirmStep() {
  detachStepKeys();
  clearPanel();
  state.step = "confirm";
  const spec = state.selected;
  const targetList = [...state.targets].join(", ");

  const head = el("div", "cmdp-head");
  head.appendChild(el("span", "", "⚠️"));
  head.appendChild(el("span", "", t("palette.confirmTitle", {}, "Confirm bulk operation")));
  state.panel.appendChild(head);

  const body = el("div", "cmdp-confirm");
  body.appendChild(el("div", "", spec.label()));
  body.appendChild(
    el(
      "div",
      "",
      t("palette.confirmTargets", { count: state.targets.size, targets: targetList },
        "Targets ({count}): {targets}"),
    ),
  );
  const paramKeys = Object.keys(state.params);
  if (paramKeys.length > 0) {
    body.appendChild(
      el(
        "div",
        "",
        paramKeys.map((key) => `${key}: ${state.params[key]}`).join(" · "),
      ),
    );
  }
  state.panel.appendChild(body);

  const foot = el("div", "cmdp-foot");
  const back = el("button", "cmdp-btn cmdp-ghost", t("palette.back", {}, "Back"));
  back.type = "button";
  back.addEventListener("click", () => renderTargetStep());
  foot.appendChild(back);
  const confirm = el("button", "cmdp-btn cmdp-danger", t("palette.confirmRun", {}, "Run on all targets"));
  confirm.type = "button";
  confirm.addEventListener("click", () => runBulk());
  foot.appendChild(confirm);
  state.panel.appendChild(foot);
  confirm.focus();
}

/** Step 5: execute + per-target results. */
async function runBulk() {
  detachStepKeys();
  clearPanel();
  state.step = "results";
  const spec = state.selected;

  const head = el("div", "cmdp-head");
  head.appendChild(el("span", "", spec.icon));
  head.appendChild(el("span", "", spec.label()));
  state.panel.appendChild(head);

  const list = el("div", "cmdp-list");
  list.appendChild(el("div", "cmdp-empty", t("palette.running", {}, "Running…")));
  state.panel.appendChild(list);

  const foot = el("div", "cmdp-foot");
  const closeBtn = el("button", "cmdp-btn cmdp-ghost", t("palette.close", {}, "Close"));
  closeBtn.type = "button";
  closeBtn.addEventListener("click", () => closePalette());
  foot.appendChild(closeBtn);
  state.panel.appendChild(foot);

  let payload;
  try {
    payload = await fetchJson("/api/fleet/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: spec.id,
        targets: [...state.targets],
        params: state.params,
      }),
    });
  } catch (e) {
    if (!state || state.step !== "results") return;
    list.replaceChildren(
      el("div", "cmdp-empty cmdp-fail", t("palette.failed", { message: e.message }, "Failed: {message}")),
    );
    return;
  }
  if (!state || state.step !== "results") return;

  list.replaceChildren();
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  for (const result of results) {
    const row = el("div", "cmdp-result");
    row.appendChild(el("span", result.ok ? "cmdp-ok" : "cmdp-fail", result.ok ? "✓" : "✗"));
    row.appendChild(el("span", "", String(result.target)));
    row.appendChild(el("span", "cmdp-result-detail", String(result.detail || "")));
    list.appendChild(row);
  }
  if (results.length === 0) {
    list.appendChild(el("div", "cmdp-empty", t("palette.noResults", {}, "No results returned")));
  }
  closeBtn.focus();
}

function detachStepKeys() {
  if (state && state.stepKeyHandler && state.panel) {
    state.panel.removeEventListener("keydown", state.stepKeyHandler);
    state.stepKeyHandler = null;
  }
}

// ---------------------------------------------------------------------------
// Open / close / init
// ---------------------------------------------------------------------------

export function openPalette() {
  if (state) return; // already open
  const panel = renderShell();
  state = {
    panel,
    commands: buildCommands(),
    selected: null,
    params: {},
    targets: new Set(),
    step: "command",
    stepKeyHandler: null,
    escHandler: null,
    previousFocus: document.activeElement,
  };
  state.escHandler = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (state.step === "command" || state.step === "results") {
      closePalette();
    } else if (state.step === "params") {
      renderCommandStep();
    } else if (state.step === "targets") {
      detachStepKeys();
      renderCommandStep();
    } else if (state.step === "confirm") {
      renderTargetStep();
    }
  };
  overlay.addEventListener("keydown", state.escHandler);
  renderCommandStep();
}

export function closePalette() {
  if (!state) return;
  detachStepKeys();
  const previousFocus = state.previousFocus;
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  state = null;
  if (previousFocus && typeof previousFocus.focus === "function") {
    previousFocus.focus();
  }
}

/**
 * Build the 🎛️ trigger button — NOT appended anywhere by this module; the
 * integrator places it (e.g. in the header actions strip).
 */
export function createPaletteButton() {
  const button = el("button", "cmdp-trigger-btn", "🎛️");
  button.type = "button";
  button.title = t("palette.buttonTitle", {}, "Command palette (Ctrl+K)");
  button.setAttribute("aria-label", t("palette.buttonTitle", {}, "Command palette (Ctrl+K)"));
  button.addEventListener("click", () => openPalette());
  return button;
}

/**
 * Initialize the palette: installs the global Ctrl+K / Cmd+K shortcut.
 * Idempotent. Returns { open, close, createButton } for the integrator.
 */
export function initCommandPalette() {
  injectStyles();
  if (!keyHandler) {
    keyHandler = (event) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        if (state) closePalette();
        else openPalette();
      }
    };
    window.addEventListener("keydown", keyHandler);
  }
  return { open: openPalette, close: closePalette, createButton: createPaletteButton };
}
