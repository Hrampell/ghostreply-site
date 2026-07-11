(() => {
  "use strict";

  document.documentElement.classList.add("js");

  const copyLabels = new WeakMap();
  const copyAriaLabels = new WeakMap();
  const copyTimers = new WeakMap();

  function commandFor(trigger) {
    const direct = trigger.dataset.command || trigger.getAttribute("data-command");
    if (direct) return direct.trim();

    const targetSelector = trigger.getAttribute("data-copy-target");
    const target = targetSelector
      ? document.querySelector(targetSelector)
      : trigger.querySelector("code");

    return target ? target.textContent.trim() : "";
  }

  function fallbackCopy(value) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    const copied = document.execCommand("copy");
    textarea.remove();

    if (!copied) throw new Error("Copy command was rejected");
  }

  async function writeToClipboard(value) {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        fallbackCopy(value);
        return;
      }
    }

    fallbackCopy(value);
  }

  function setCopyState(trigger, state) {
    const label = trigger.querySelector("[data-copy-label]");

    if (label && !copyLabels.has(label)) {
      copyLabels.set(label, label.textContent);
    }

    if (!copyAriaLabels.has(trigger)) {
      copyAriaLabels.set(trigger, trigger.getAttribute("aria-label"));
    }

    const copied = state === "copied";
    const message = copied
      ? trigger.dataset.copiedLabel || "Copied"
      : trigger.dataset.errorLabel || "Copy failed";

    trigger.setAttribute("data-copy-state", state);
    trigger.setAttribute("aria-label", message);
    if (label) label.textContent = message;

    const activeTimer = copyTimers.get(trigger);
    if (activeTimer) clearTimeout(activeTimer);

    copyTimers.set(
      trigger,
      setTimeout(() => {
        trigger.setAttribute("data-copy-state", "idle");

        const ariaLabel = copyAriaLabels.get(trigger);
        if (ariaLabel) {
          trigger.setAttribute("aria-label", ariaLabel);
        } else {
          trigger.removeAttribute("aria-label");
        }

        if (label) label.textContent = copyLabels.get(label);
      }, 1800)
    );
  }

  function enhanceCopyButtons() {
    document.querySelectorAll("[data-copy-command]").forEach((trigger) => {
      if (trigger.tagName === "BUTTON" && !trigger.hasAttribute("type")) {
        trigger.setAttribute("type", "button");
      }

      trigger.addEventListener("click", async (event) => {
        event.preventDefault();
        const command = commandFor(trigger);
        if (!command) return;

        try {
          await writeToClipboard(command);
          setCopyState(trigger, "copied");
        } catch {
          setCopyState(trigger, "error");
        }
      });
    });
  }

  function panelFor(toggle) {
    const controlledId = toggle.getAttribute("aria-controls");
    if (controlledId) return document.getElementById(controlledId);

    const targetSelector = toggle.getAttribute("data-disclosure-target");
    if (targetSelector) return document.querySelector(targetSelector);

    const disclosure = toggle.closest
      ? toggle.closest("[data-disclosure]")
      : null;
    return disclosure
      ? disclosure.querySelector("[data-disclosure-panel]")
      : null;
  }

  function enhanceDisclosures() {
    let generatedId = 0;

    document.querySelectorAll("[data-disclosure-toggle]").forEach((toggle) => {
      const panel = panelFor(toggle);
      if (!panel) return;

      if (!panel.id) {
        generatedId += 1;
        panel.id = `disclosure-panel-${generatedId}`;
      }

      if (toggle.tagName === "BUTTON" && !toggle.hasAttribute("type")) {
        toggle.setAttribute("type", "button");
      }

      toggle.setAttribute("aria-controls", panel.id);

      const setOpen = (open) => {
        toggle.setAttribute("aria-expanded", String(open));
        panel.hidden = !open;
        panel.setAttribute("aria-hidden", String(!open));
      };

      const startsOpen = Boolean(
        toggle.getAttribute("aria-expanded") === "true" ||
        toggle.hasAttribute("data-open") ||
        (panel.hasAttribute && panel.hasAttribute("data-open"))
      );

      setOpen(startsOpen);

      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        setOpen(toggle.getAttribute("aria-expanded") !== "true");
      });
    });
  }

  function initialize() {
    enhanceCopyButtons();
    enhanceDisclosures();
  }

  if (document.readyState === "loading" && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
