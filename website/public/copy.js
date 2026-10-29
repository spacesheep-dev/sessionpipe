// SPDX-License-Identifier: Apache-2.0
// The site's one script: copy buttons, the GUI's download for this system, and the docs'
// contents marking the section being read. Each button copies the Markdown file its
// data-copy names, or the command its data-text holds. Without it the buttons stay hidden
// and the link or the command beside each one does the same job. The label and its answer
// share one cell (site.css), so saying "Copied" never moves the line; a file that can't be
// copied gives way to the link beside its button (data-gone).
const check =
  '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 6.4 4.9 8.7 9.5 3.6"/></svg>';
// Every code block in a page's prose gets a Copy button in its corner, as the home page's
// commands have, wired by the loop below with the rest.
for (const pre of document.querySelectorAll(".prose pre")) {
  const wrap = document.createElement("div");
  wrap.className = "code";
  pre.before(wrap);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.dataset.text = pre.textContent.replace(/\n$/, "");
  button.textContent = "Copy";
  button.hidden = true;
  wrap.append(pre, button);
}
for (const button of document.querySelectorAll("button[data-copy], button[data-text]")) {
  const idle = document.createElement("span");
  idle.dataset.idle = "";
  idle.textContent = button.textContent;
  const answer = document.createElement("span");
  answer.dataset.done = "";
  answer.setAttribute("aria-hidden", "true");
  // filled from the start, so the cell is as wide as the answer before it is given
  answer.innerHTML = `${check}Copied`;
  button.replaceChildren(idle, answer);
  let timer = 0;
  const say = (state, text) => {
    clearTimeout(timer);
    answer.innerHTML = state === "done" ? `${check}${text}` : text;
    button.dataset.state = state;
    idle.setAttribute("aria-hidden", "true");
    answer.removeAttribute("aria-hidden");
    timer = setTimeout(() => {
      delete button.dataset.state;
      idle.removeAttribute("aria-hidden");
      answer.setAttribute("aria-hidden", "true");
    }, 1600);
  };
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
      say("done", "Copied");
    } catch {
      if (literal !== undefined) say("failed", "Couldn't copy");
      else button.dataset.gone = "";
    }
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
  for (const button of dl.querySelectorAll("[data-os]")) {
    const on = button.dataset.os === primary;
    if (button.dataset.os === "node") button.hidden = !on;
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
