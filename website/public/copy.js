// SPDX-License-Identifier: Apache-2.0
// The site's one script: copy buttons, the GUI's download for this system, and the docs'
// contents marking the section being read. Each button copies the Markdown file its
// data-copy names, or the command its data-text holds. Without it the buttons stay hidden
// and the link or the command beside each one does the same job.
for (const button of document.querySelectorAll("button[data-copy], button[data-text]")) {
  const label = button.textContent;
  button.hidden = false;
  button.addEventListener("click", async () => {
    const literal = button.dataset.text;
    const text =
      literal !== undefined
        ? Promise.resolve(literal)
        : fetch(button.dataset.copy).then((r) => {
            if (!r.ok) throw new Error(`${r.status}`);
            return r.text();
          });
    try {
      // Safari keeps the click's permission only through a ClipboardItem handed the promise.
      if (window.ClipboardItem) {
        const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      button.textContent = "Copied";
    } catch {
      button.textContent = literal !== undefined ? "Couldn't copy" : "Couldn't copy: open the link";
    }
    setTimeout(() => {
      button.textContent = label;
    }, 2000);
  });
}

// The GUI's download (home page only): the file for this system first, the others beside it.
// Read from the browser's own platform string, kept here and sent nowhere. Without the script,
// or on a system it doesn't know, the page stays as written: macOS first, then Linux.
const dl = document.querySelector("[data-dl]");
if (dl) {
  const platform = `${navigator.userAgentData?.platform ?? navigator.platform ?? ""} ${navigator.userAgent}`;
  // iPadOS reports a Mac; a Mac with a touch screen is one.
  const os =
    /android|iphone|ipad|ipod/i.test(platform) || (/mac/i.test(platform) && navigator.maxTouchPoints > 1)
      ? "phone"
      : /mac/i.test(platform)
        ? "mac"
        : /linux|x11|cros/i.test(platform)
          ? "linux"
          : /win/i.test(platform)
            ? "other"
            : "mac";
  const primary = { mac: "mac", linux: "linux", other: "node" }[os];
  for (const note of dl.querySelectorAll("[data-for]")) note.hidden = note.dataset.for !== os;
  for (const item of dl.querySelectorAll("[data-os]")) {
    const on = item.dataset.os === primary;
    if (item.dataset.os === "node") item.hidden = !on;
    const button = item.querySelector(".btn");
    button.classList.toggle("primary", on);
    button.classList.toggle("quiet", !on);
  }
  // first in the row is first in the tab order too
  const first = dl.querySelector(`[data-os="${primary}"]`);
  if (first) dl.querySelector("[data-os]").before(first);
}

// The docs' contents: mark the section being read, so the list says where you are.
const toc = document.querySelector(".docs .toc");
if (toc && "IntersectionObserver" in window) {
  const links = new Map([...toc.querySelectorAll("a[href^='#']")].map((a) => [a.hash.slice(1), a]));
  const seen = new Set();
  const mark = () => {
    const first = [...links.keys()].find((id) => seen.has(id));
    for (const [id, a] of links) {
      if (id === first) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    }
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) seen.add(e.target.id);
        else seen.delete(e.target.id);
      }
      if (seen.size) mark();
    },
    { rootMargin: "-80px 0px -60% 0px" },
  );
  for (const id of links.keys()) {
    const h = document.getElementById(id);
    if (h) io.observe(h);
  }
}
