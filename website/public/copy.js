// SPDX-License-Identifier: Apache-2.0
// The site's one script: copy buttons. Each copies the Markdown file its data-copy names.
// Without it the buttons stay hidden and the link beside each one does the same job.
for (const button of document.querySelectorAll("button[data-copy]")) {
  const label = button.textContent;
  button.hidden = false;
  button.addEventListener("click", async () => {
    const text = fetch(button.dataset.copy).then((r) => {
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
      button.textContent = "Couldn't copy: open the link";
    }
    setTimeout(() => {
      button.textContent = label;
    }, 2000);
  });
}
