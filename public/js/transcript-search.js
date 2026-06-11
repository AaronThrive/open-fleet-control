/**
 * Pure helpers for transcript search (no DOM, no fetch) — shared by the
 * sessions view and unit-tested directly under node:test via dynamic import.
 *
 * All matching is case-insensitive and treats the query as a literal
 * substring (never a regex), so hostile transcript content and hostile
 * queries are both inert.
 */

/**
 * Split `text` into ordered segments tagged as match / non-match for a
 * case-insensitive literal query. Renderers turn match segments into
 * highlight elements via textContent (no HTML parsing anywhere).
 *
 * @param {string} text
 * @param {string} query
 * @returns {Array<{text: string, match: boolean}>}
 */
export function splitByQuery(text, query) {
  const source = typeof text === "string" ? text : "";
  if (source.length === 0) return [];
  if (typeof query !== "string" || query.length === 0) {
    return [{ text: source, match: false }];
  }
  const haystack = source.toLowerCase();
  const needle = query.toLowerCase();
  const segments = [];
  let cursor = 0;
  while (cursor < source.length) {
    const hit = haystack.indexOf(needle, cursor);
    if (hit === -1) {
      segments.push({ text: source.slice(cursor), match: false });
      break;
    }
    if (hit > cursor) segments.push({ text: source.slice(cursor, hit), match: false });
    segments.push({ text: source.slice(hit, hit + needle.length), match: true });
    cursor = hit + needle.length;
  }
  return segments;
}

/**
 * True when a transcript viewer message ({ text, tools }) contains the
 * query in its text or any tool name. Empty queries never match.
 *
 * @param {object} message
 * @param {string} query
 * @returns {boolean}
 */
export function messageMatchesQuery(message, query) {
  if (!message || typeof message !== "object") return false;
  if (typeof query !== "string" || query.length === 0) return false;
  const needle = query.toLowerCase();
  if (typeof message.text === "string" && message.text.toLowerCase().includes(needle)) {
    return true;
  }
  return (
    Array.isArray(message.tools) &&
    message.tools.some((tool) => typeof tool === "string" && tool.toLowerCase().includes(needle))
  );
}
