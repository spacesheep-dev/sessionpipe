// SPDX-License-Identifier: Apache-2.0
// Light or dark by choice. The header's button sets <html data-theme>, which the stylesheet
// reads ahead of the system's preference; the inline script in <head> applies a stored choice
// before the first paint. A choice that matches the system is forgotten, so the page follows
// the system again. Picture sources and theme-color answer only to media queries, so their
// media are rewritten here. Without this file the button stays hidden and the system decides.
// It also closes the phone's menu (a <details>, which opens without it) on Esc, on a tap
// outside it, and when one of its links is followed.
const root = document.documentElement;
const system = matchMedia("(prefers-color-scheme: dark)");
const button = document.querySelector("button.theme");
const schemed = document.querySelectorAll('source[media*="prefers-color-scheme"], meta[media*="prefers-color-scheme"]');
const current = () => root.dataset.theme ?? (system.matches ? "dark" : "light");

function apply() {
  const chosen = root.dataset.theme;
  for (const el of schemed) {
    el.dataset.media ??= el.getAttribute("media");
    const dark = el.dataset.media.includes("dark");
    el.setAttribute("media", chosen ? (dark === (chosen === "dark") ? "all" : "not all") : el.dataset.media);
  }
  const label = `Switch to ${current() === "dark" ? "light" : "dark"} mode`;
  button.setAttribute("aria-label", label);
  button.title = label;
}

if (button) {
  button.hidden = false;
  button.addEventListener("click", () => {
    // the scheme changes at once; only the icon cross-fades (no grounds fading through grey)
    root.classList.add("switching");
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("switching")));
    const next = current() === "dark" ? "light" : "dark";
    if (next === (system.matches ? "dark" : "light")) delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (root.dataset.theme) localStorage.setItem("theme", next);
      else localStorage.removeItem("theme");
    } catch {}
    apply();
  });
  system.addEventListener("change", apply);
  apply();
}

const menu = document.querySelector(".top .menu");
if (menu) {
  const close = () => menu.removeAttribute("open");
  const panel = menu.querySelector("nav");
  menu.addEventListener("toggle", () => {
    if (menu.open && !matchMedia("(prefers-reduced-motion: reduce)").matches)
      panel.animate(
        [
          { opacity: 0, transform: "translateY(-4px) scale(0.98)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
  });
  // Tab out of it and it closes, so focus never sits under an open panel
  menu.addEventListener("focusout", (e) => {
    if (menu.open && !menu.contains(e.relatedTarget)) close();
  });
  document.addEventListener("pointerdown", (e) => {
    if (menu.open && !menu.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !menu.open) return;
    close();
    menu.querySelector("summary").focus();
  });
  menu.addEventListener("click", (e) => {
    if (e.target.closest("a")) close();
  });
}
