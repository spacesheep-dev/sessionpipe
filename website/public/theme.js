// SPDX-License-Identifier: Apache-2.0
// Light or dark by choice. The header's button sets <html data-theme>, which the stylesheet
// reads ahead of the system's preference; the inline script in <head> applies a stored choice
// before the first paint. A choice that matches the system is forgotten, so the page follows
// the system again. Picture sources and theme-color answer only to media queries, so their
// media are rewritten here. Without this file the button stays hidden and the system decides.
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
