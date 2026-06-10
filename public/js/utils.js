/**
 * Utility functions for Command Center
 */

export function formatTimeAgo(mins) {
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/**
 * Translation helper for ES-module view files.
 *
 * Thin lazy wrapper around the runtime translator installed by js/i18n.js
 * (`window.t`) — see the contract documented there: t(key, params, fallback)
 * with `{name}`-style interpolation. Call sites pass their English default as
 * `fallback`, so even if i18n.js has not loaded yet the English string renders.
 */
export function t(key, params = {}, fallback = undefined) {
  if (typeof window.t === "function") return window.t(key, params, fallback);
  if (fallback === undefined) return String(key);
  return String(fallback).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Smart DOM update using morphdom - only patches what changed
 * @param {HTMLElement} targetEl - Element to update
 * @param {string} newHtml - New HTML content
 */
export function smartUpdate(targetEl, newHtml) {
  if (typeof morphdom === "undefined") {
    // Fallback if morphdom not loaded
    targetEl.innerHTML = newHtml;
    return;
  }
  // Create a temporary container with the new content
  const temp = document.createElement("div");
  temp.innerHTML = newHtml;
  // If target has single child and temp has single child, morph directly
  if (targetEl.children.length === 1 && temp.children.length === 1) {
    morphdom(targetEl.firstElementChild, temp.firstElementChild);
  } else {
    // Otherwise morph the container itself
    morphdom(targetEl, temp, { childrenOnly: true });
  }
}

export function formatBytes(bytes) {
  if (bytes >= 1099511627776) return (bytes / 1099511627776).toFixed(1) + " TB";
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}
