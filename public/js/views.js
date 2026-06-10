/**
 * Fleet View Loader
 *
 * Loads view partials (/partials/<view>.html) on demand, caches them, and
 * swaps them into the main content area without a full page reload.
 * Follows the same partial-loading pattern as sidebar.js.
 *
 * Routing: views are addressed via the URL hash, e.g. "#view-mesh".
 * Anything else is treated as the regular dashboard.
 */

(function () {
  "use strict";

  const VIEWS = ["mesh", "fleet-chat", "kanban", "briefs", "cortex", "evolution", "logs"];
  const VIEW_HASH_PREFIX = "#view-";

  // Cache of fetched partial HTML, keyed by view name
  const viewCache = new Map();

  let currentView = null;

  /**
   * Parse the current location hash into a known view name (or null)
   */
  function parseViewFromHash() {
    const hash = window.location.hash || "";
    if (!hash.startsWith(VIEW_HASH_PREFIX)) return null;
    const name = hash.slice(VIEW_HASH_PREFIX.length);
    return VIEWS.includes(name) ? name : null;
  }

  function getContainer() {
    return document.getElementById("view-container");
  }

  /**
   * Fetch a view partial, using the cache after the first load
   */
  async function fetchViewHtml(view) {
    if (viewCache.has(view)) return viewCache.get(view);

    const response = await fetch(`/partials/${view}.html`);
    if (!response.ok) {
      throw new Error(`Failed to load view "${view}" (HTTP ${response.status})`);
    }
    const html = await response.text();
    viewCache.set(view, html);
    return html;
  }

  /**
   * Show or hide the regular dashboard content (stats bar + main sections)
   */
  function setDashboardVisible(visible) {
    const main = document.querySelector(".main-wrapper > main");
    const statsBar = document.querySelector(".main-wrapper > .stats-bar");
    if (main) main.style.display = visible ? "" : "none";
    if (statsBar) statsBar.style.display = visible ? "" : "none";
  }

  /**
   * Update active state on the sidebar's view nav items
   */
  function updateActiveNav(view) {
    document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
      item.classList.toggle("active", item.dataset.view === view);
    });
  }

  function translate(root) {
    if (window.I18N?.translateSubtree) {
      window.I18N.translateSubtree(root);
    }
  }

  function renderLoading(container) {
    container.innerHTML =
      '<div class="view-loading" data-i18n="views.loading">Loading view...</div>';
    translate(container);
  }

  function renderError(container) {
    container.innerHTML =
      '<div class="view-loading view-error" data-i18n="views.loadError">' +
      "Failed to load view — check the server and try again." +
      "</div>";
    translate(container);
  }

  /**
   * Activate a view: hide the dashboard, swap in the (cached) partial
   */
  async function showView(view) {
    const container = getContainer();
    if (!container) return;

    currentView = view;
    setDashboardVisible(false);
    container.style.display = "";
    updateActiveNav(view);

    if (!viewCache.has(view)) renderLoading(container);

    try {
      const html = await fetchViewHtml(view);
      if (currentView !== view) return; // user navigated away mid-fetch
      container.innerHTML = html;
      translate(container);
    } catch (error) {
      console.error("[Views] Failed to load view:", error);
      if (currentView === view) renderError(container);
    }
  }

  /**
   * Restore the regular dashboard content
   */
  function showDashboard() {
    currentView = null;
    const container = getContainer();
    if (container) container.style.display = "none";
    setDashboardVisible(true);
    updateActiveNav(null);
  }

  function handleHashChange() {
    const view = parseViewFromHash();
    if (view) {
      showView(view);
    } else if (currentView) {
      showDashboard();
    }
  }

  function init() {
    window.addEventListener("hashchange", handleHashChange);

    // Sidebar partial loads asynchronously; re-apply active state once it lands
    window.addEventListener("sidebar:loaded", () => updateActiveNav(currentView));

    // Handle deep links like /#view-mesh on initial page load
    handleHashChange();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
