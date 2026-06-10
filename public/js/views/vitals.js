/**
 * System Vitals view module.
 *
 * Loaded by views.js via dynamic import; `init(containerEl)` runs on every
 * visit of #view-vitals and must be idempotent.
 *
 * Data source: GET /api/vitals → { vitals: { hostname, uptime, cpu, memory,
 * disk, temperature, temperatureNote }, optionalDeps: [...] }. The same
 * vitals object also arrives in the /api/state `vitals` slice over SSE.
 *
 * Real-time: listens for the `fleet:state` window event (fed by the page's
 * single /api/events EventSource) with a polling fallback.
 *
 * All dynamic values are set via textContent — XSS-safe.
 */

import { t } from "../utils.js";

const POLL_MS = 10000;
const SSE_FRESH_MS = 15000;

let pollTimer = null;
let stateListener = null;
let requestSeq = 0;
let lastSseAt = 0;
let optionalDeps = null;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function setText(els, key, value) {
  if (els[key]) els[key].textContent = value;
}

function formatMemBytes(bytes) {
  if (!bytes) return "-";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(gb * 1024).toFixed(0)} MB`;
}

function isHostnameHidden() {
  return typeof window.isHostnameHidden === "function" ? window.isHostnameHidden() : false;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderDepHint(node, affects) {
  if (!node) return;
  const dep = (optionalDeps || []).find((d) => d.affects === affects && !d.installed);
  if (!dep) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.textContent = `💡 Install ${dep.name} for ${String(dep.purpose || "").toLowerCase()}${
    dep.installCmd ? `: ${dep.installCmd}` : ""
  }`;
}

function render(els, vitals) {
  if (!vitals) return;

  setText(els, "hostname", vitals.hostname || "-");
  if (els.hostname) {
    // Respect the dashboard-wide hostname privacy setting
    els.hostname.style.filter = isHostnameHidden() ? "blur(8px)" : "";
    els.hostname.style.userSelect = isHostnameHidden() ? "none" : "";
  }
  setText(els, "uptime", vitals.uptime || "-");

  // CPU
  const cpuPercent = vitals.cpu?.usage || 0;
  setText(els, "cpuPercent", `${cpuPercent}%`);
  if (els.cpuBar) {
    els.cpuBar.style.width = `${cpuPercent}%`;
    els.cpuBar.className =
      "vital-bar-fill " + (cpuPercent > 80 ? "red" : cpuPercent > 50 ? "yellow" : "blue");
  }
  setText(els, "cpuChip", vitals.cpu?.chip || vitals.cpu?.brand || "");
  const fmtPct = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}%` : "-");
  setText(els, "cpuUser", fmtPct(vitals.cpu?.userPercent));
  setText(els, "cpuSys", fmtPct(vitals.cpu?.sysPercent));
  setText(els, "cpuIdle", fmtPct(vitals.cpu?.idlePercent));
  const loadAvg = vitals.cpu?.loadAvg || [];
  setText(els, "cpuLoad1", loadAvg[0]?.toFixed(2) || "-");
  setText(els, "cpuLoad5", loadAvg[1]?.toFixed(2) || "-");
  setText(els, "cpuLoad15", loadAvg[2]?.toFixed(2) || "-");
  setText(els, "cpuCores", vitals.cpu?.cores || "-");
  setText(
    els,
    "cpuTopology",
    vitals.cpu?.pCores && vitals.cpu?.eCores
      ? `${vitals.cpu.pCores}P + ${vitals.cpu.eCores}E cores`
      : "",
  );

  // Memory
  const memPercent = vitals.memory?.percent || 0;
  if (els.memPercent) {
    els.memPercent.replaceChildren(document.createTextNode(`${memPercent}% `));
    const small = document.createElement("small");
    small.style.cssText = "font-size:0.6em;opacity:0.7";
    small.textContent = "used";
    els.memPercent.appendChild(small);
  }
  if (els.memBar) {
    els.memBar.style.width = `${memPercent}%`;
    els.memBar.className =
      "vital-bar-fill " + (memPercent > 90 ? "red" : memPercent > 75 ? "yellow" : "green");
  }
  setText(
    els,
    "memSummary",
    `${vitals.memory?.usedFormatted || "-"} of ${vitals.memory?.totalFormatted || "-"}`,
  );
  setText(els, "memFree", vitals.memory?.freeFormatted || "-");
  setText(els, "memActive", formatMemBytes(vitals.memory?.active));
  setText(els, "memWired", formatMemBytes(vitals.memory?.wired));
  setText(els, "memCompressed", formatMemBytes(vitals.memory?.compressed));
  setText(els, "memCached", formatMemBytes(vitals.memory?.cached));
  const pressure = vitals.memory?.pressure || "normal";
  if (els.memPressure) {
    els.memPressure.textContent = pressure.charAt(0).toUpperCase() + pressure.slice(1);
    els.memPressure.className = `pressure-indicator ${pressure}`;
  }

  // Disk
  const diskPercent = vitals.disk?.percent || 0;
  if (els.diskPercent) {
    els.diskPercent.replaceChildren(document.createTextNode(`${diskPercent}% `));
    const small = document.createElement("small");
    small.style.cssText = "font-size:0.6em;opacity:0.7";
    small.textContent = "used";
    els.diskPercent.appendChild(small);
  }
  if (els.diskBar) {
    els.diskBar.style.width = `${diskPercent}%`;
    els.diskBar.className =
      "vital-bar-fill " + (diskPercent > 90 ? "red" : diskPercent > 75 ? "yellow" : "green");
  }
  setText(
    els,
    "diskSummary",
    `${vitals.disk?.usedFormatted || "-"} of ${vitals.disk?.totalFormatted || "-"}`,
  );
  setText(els, "diskFree", vitals.disk?.freeFormatted || "-");
  setText(els, "diskIops", vitals.disk?.iops?.toFixed(0) || "0");
  setText(els, "diskThroughput", vitals.disk?.throughputMBps?.toFixed(2) || "0.00");
  setText(els, "diskKbt", vitals.disk?.kbPerTransfer?.toFixed(1) || "0.0");
  if (!vitals.disk?.iops && !vitals.disk?.throughputMBps) {
    renderDepHint(els.diskHint, "disk-io");
  } else if (els.diskHint) {
    els.diskHint.hidden = true;
  }

  // Temperature
  const temp = vitals.temperature;
  if (temp !== null && temp !== undefined && temp > 0) {
    setText(els, "tempValue", temp);
    if (els.tempValue) {
      els.tempValue.style.color =
        temp < 50
          ? "var(--green)"
          : temp < 70
            ? "var(--text)"
            : temp < 85
              ? "var(--yellow)"
              : "var(--red)";
    }
    setText(
      els,
      "tempStatus",
      temp < 50 ? "Cool" : temp < 70 ? "Normal" : temp < 85 ? "Warm" : "Hot!",
    );
    if (els.tempHint) els.tempHint.hidden = true;
  } else {
    setText(els, "tempValue", "-");
    if (els.tempValue) els.tempValue.style.color = "var(--text-muted)";
    setText(
      els,
      "tempStatus",
      vitals.temperatureNote || t("views.vitals.tempUnavailable", {}, "Unavailable"),
    );
    renderDepHint(els.tempHint, "temperature");
  }
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

async function load(els) {
  const seq = ++requestSeq;
  try {
    const response = await fetch("/api/vitals");
    const payload = await response.json();
    if (seq !== requestSeq || !els.root.isConnected) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    els.error.hidden = true;
    if (payload.optionalDeps) optionalDeps = payload.optionalDeps;
    render(els, payload.vitals);
  } catch (error) {
    if (seq !== requestSeq || !els.root.isConnected) return;
    els.error.hidden = false;
    els.error.textContent = t(
      "views.vitals.loadError",
      {},
      "Could not reach the vitals API — is the server up?",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function teardown() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (stateListener) {
    window.removeEventListener("fleet:state", stateListener);
    stateListener = null;
  }
}

/**
 * Initialize the Vitals view. Called by views.js on every visit.
 * @param {HTMLElement} container
 */
export function init(container) {
  teardown();

  const els = {
    root: container.querySelector("#vitals-view-section"),
    error: container.querySelector("#vitals-view-error"),
    hostname: container.querySelector("#vv-hostname"),
    uptime: container.querySelector("#vv-uptime"),
    cpuPercent: container.querySelector("#vv-cpu-percent"),
    cpuBar: container.querySelector("#vv-cpu-bar"),
    cpuChip: container.querySelector("#vv-cpu-chip"),
    cpuUser: container.querySelector("#vv-cpu-user"),
    cpuSys: container.querySelector("#vv-cpu-sys"),
    cpuIdle: container.querySelector("#vv-cpu-idle"),
    cpuLoad1: container.querySelector("#vv-cpu-load-1"),
    cpuLoad5: container.querySelector("#vv-cpu-load-5"),
    cpuLoad15: container.querySelector("#vv-cpu-load-15"),
    cpuCores: container.querySelector("#vv-cpu-cores"),
    cpuTopology: container.querySelector("#vv-cpu-topology"),
    memPercent: container.querySelector("#vv-mem-percent"),
    memBar: container.querySelector("#vv-mem-bar"),
    memSummary: container.querySelector("#vv-mem-summary"),
    memFree: container.querySelector("#vv-mem-free"),
    memActive: container.querySelector("#vv-mem-active"),
    memWired: container.querySelector("#vv-mem-wired"),
    memCompressed: container.querySelector("#vv-mem-compressed"),
    memCached: container.querySelector("#vv-mem-cached"),
    memPressure: container.querySelector("#vv-mem-pressure"),
    diskPercent: container.querySelector("#vv-disk-percent"),
    diskBar: container.querySelector("#vv-disk-bar"),
    diskSummary: container.querySelector("#vv-disk-summary"),
    diskFree: container.querySelector("#vv-disk-free"),
    diskIops: container.querySelector("#vv-disk-iops"),
    diskThroughput: container.querySelector("#vv-disk-throughput"),
    diskKbt: container.querySelector("#vv-disk-kbt"),
    diskHint: container.querySelector("#vv-disk-hint"),
    tempValue: container.querySelector("#vv-temp-value"),
    tempStatus: container.querySelector("#vv-temp-status"),
    tempHint: container.querySelector("#vv-temp-hint"),
  };
  if (!els.root || !els.error || !els.hostname) {
    console.error("[Vitals] Partial markup is missing expected elements; aborting init.");
    return;
  }

  stateListener = (event) => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    lastSseAt = Date.now();
    if (event.detail?.vitals) {
      els.error.hidden = true;
      render(els, event.detail.vitals);
    }
  };
  window.addEventListener("fleet:state", stateListener);

  pollTimer = setInterval(() => {
    if (!els.root.isConnected) {
      teardown();
      return;
    }
    if (document.hidden) return;
    if (Date.now() - lastSseAt < SSE_FRESH_MS) return;
    load(els);
  }, POLL_MS);

  load(els);
}
