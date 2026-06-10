(function () {
  "use strict";

  const LOCALE = "en";
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE"]);

  let messages = {};
  let observer = null;
  let isApplyingTranslations = false;

  async function loadMessages() {
    const response = await fetch(`/locales/${LOCALE}.json`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Failed to load locale: ${LOCALE}`);
    messages = (await response.json()) || {};
    return messages;
  }

  function getByPath(obj, path) {
    return String(path)
      .split(".")
      .reduce(
        (acc, key) =>
          acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined,
        obj,
      );
  }

  function interpolate(template, params = {}) {
    if (typeof template !== "string") return template;
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : `{${key}}`;
    });
  }

  /**
   * Runtime translation helper — the contract for ALL JS-generated strings.
   *
   *   t(key, params?, fallback?)
   *
   * - `key`      dot path into the locale file (e.g. "views.mesh.lastSeen").
   * - `params`   interpolation values for `{name}`-style placeholders, matching
   *              the convention used by the locale file
   *              (e.g. t("app.stale", { time: "12:00" }) → "STALE — last update 12:00").
   * - `fallback` the English default, interpolated with the same params.
   *
   * Lookup order: locale bundle → `fallback` → raw key. Because the call sites
   * pass their English default as `fallback`, a missing/late key can never
   * render as a raw key path — worst case the English string is shown.
   *
   * Exposed both as `window.I18N.t` and as the `window.t` shorthand so the
   * ES-module view files (public/js/views/*.js) can call it without imports.
   */
  function t(key, params = {}, fallback = undefined) {
    let value = getByPath(messages, key);
    if (value === undefined || value === null) {
      if (fallback !== undefined) return interpolate(fallback, params);
      return String(key);
    }
    return interpolate(value, params);
  }

  function setAttrIfChanged(el, attr, value) {
    if (!el || typeof value !== "string") return;
    if (el.getAttribute(attr) !== value) {
      el.setAttribute(attr, value);
    }
  }

  function translateElement(el) {
    const textKey = el.getAttribute("data-i18n");
    if (textKey) {
      const translatedText = t(textKey);
      if (el.textContent !== translatedText) {
        el.textContent = translatedText;
      }
    }

    const titleKey = el.getAttribute("data-i18n-title");
    if (titleKey) {
      setAttrIfChanged(el, "title", t(titleKey));
    }

    const placeholderKey = el.getAttribute("data-i18n-placeholder");
    if (placeholderKey) {
      setAttrIfChanged(el, "placeholder", t(placeholderKey));
    }

    const ariaLabelKey = el.getAttribute("data-i18n-aria-label");
    if (ariaLabelKey) {
      setAttrIfChanged(el, "aria-label", t(ariaLabelKey));
    }
  }

  function translateSubtree(root = document) {
    if (!root) return;
    isApplyingTranslations = true;
    if (root.nodeType === Node.ELEMENT_NODE) {
      translateElement(root);
    }
    if (root.querySelectorAll) {
      root
        .querySelectorAll(
          "[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]",
        )
        .forEach(translateElement);
    }
    isApplyingTranslations = false;
  }

  function installObserver() {
    if (observer) observer.disconnect();
    if (!document.body) return;

    observer = new MutationObserver((mutations) => {
      if (isApplyingTranslations) return;
      isApplyingTranslations = true;
      try {
        for (const mutation of mutations) {
          if (mutation.type !== "childList") continue;
          mutation.addedNodes.forEach((addedNode) => {
            if (addedNode.nodeType !== Node.ELEMENT_NODE) return;
            if (SKIP_TAGS.has(addedNode.tagName)) return;
            isApplyingTranslations = false;
            translateSubtree(addedNode);
            isApplyingTranslations = true;
          });
        }
      } finally {
        isApplyingTranslations = false;
      }
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: false,
    });
  }

  async function init() {
    try {
      await loadMessages();
    } catch (error) {
      // Locale file unreachable — t() falls back to inline English defaults.
      console.error("[i18n] Failed to load locale bundle:", error);
      messages = {};
    }
    document.documentElement.lang = LOCALE;
    translateSubtree(document);
    installObserver();
    window.dispatchEvent(new CustomEvent("i18n:updated", { detail: { locale: LOCALE } }));
  }

  window.I18N = {
    init,
    t,
    getLocale: () => LOCALE,
    translateSubtree,
  };

  // Global shorthand for runtime strings generated from JS (see t() docs above).
  window.t = t;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
