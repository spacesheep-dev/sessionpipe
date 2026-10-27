// SPDX-License-Identifier: Apache-2.0
// sessionpipe.org: one Node script, no framework. Renders spec/*.md and the legal
// files with marked into one HTML template, copies schemas/v1 (the $ids), writes
// website/dist/. No analytics, no external requests, no cookies.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { marked } from "marked";
import { loadChangelog, splitLead } from "./src/changelog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const _src = path.join(root, "website/src");
const out = path.join(root, "website/dist");
const SITE = "https://sessionpipe.org";
const read = (p) => readFileSync(path.join(root, p), "utf8");
const version = JSON.parse(read("packages/core/package.json")).version;
// The sessionpipe-gui release the home page offers, with each file's size in bytes as the
// release lists it: the one place to bump. The page prints decimal MB, as Finder does.
const guiVersion = "0.4.1";
const gui = {
  version: guiVersion,
  files: {
    dmg: [`sessionpipe_${guiVersion}_universal.dmg`, 7484167],
    deb: [`sessionpipe_${guiVersion}_amd64.deb`, 4054690],
    appimage: [`sessionpipe_${guiVersion}_amd64.AppImage`, 82676216],
    tgz: [`sessionpipe-gui-${guiVersion}.tgz`],
  },
};
// {{gui:dmg}} in a page is that file's URL, {{gui:dmg-size}} its size, {{gui:version}} the release.
const guiReleases = "https://github.com/spacesheep-dev/sessionpipe-gui/releases";
const guiValues = { version: gui.version, releases: guiReleases };
for (const [key, [file, bytes]] of Object.entries(gui.files)) {
  guiValues[key] = `${guiReleases}/download/v${gui.version}/${file}`;
  if (bytes) guiValues[`${key}-size`] = `${(bytes / 1e6).toFixed(1)}&nbsp;MB`;
}
const withGui = (text, file) =>
  text.replace(/\{\{gui:([a-z-]+)\}\}/g, (_, k) => {
    if (!(k in guiValues)) throw new Error(`${file}: no sessionpipe-gui value "${k}"`);
    return guiValues[k];
  });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "website/public"), out, { recursive: true });
mkdirSync(path.join(out, "schema/v1"), { recursive: true });
cpSync(path.join(root, "schemas/v1"), path.join(out, "schema/v1"), { recursive: true });

const css = read("website/src/site.css");
// A light or dark chosen with the header's button, applied before the first paint. It is the
// one inline script, allowed by its hash; theme.js wires the button.
const themeBoot = `try{const t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}`;
const themeHash = createHash("sha256").update(themeBoot).digest("base64");
const sun =
  '<svg class="sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>';
const moon =
  '<svg class="moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.5 14.6A7.5 7.5 0 0 1 9.4 4.5a7.5 7.5 0 1 0 10.1 10.1z"/></svg>';

const nav = [
  ["/", "Home"],
  ["/docs/", "Docs"],
  ["/protocol/", "Protocol"],
  ["/receivers/", "Receivers"],
  ["/#gui", "GUI"],
  ["/changelog/", "Changelog"],
  ["https://github.com/spacesheep-dev/sessionpipe", "GitHub"],
];

/** Spec links: PROTOCOL.md → /protocol/, HTTP.md → /protocol/http/, section anchors kept. */
const specPath = {
  "PROTOCOL.md": "/protocol/",
  "HTTP.md": "/protocol/http/",
  "PRIVACY.md": "/protocol/privacy/",
  "CONTROL.md": "/protocol/control/",
  "ADAPTERS.md": "/protocol/adapters/",
  "VERSIONING.md": "/protocol/versioning/",
  LICENSE: "/legal/#spec-license",
};
const rootPath = {
  LICENSE: "/legal/",
  NOTICE: "https://github.com/spacesheep-dev/sessionpipe/blob/main/NOTICE",
  DCO: "https://github.com/spacesheep-dev/sessionpipe/blob/main/DCO",
  "CONTRIBUTING.md": "https://github.com/spacesheep-dev/sessionpipe/blob/main/CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md": "https://github.com/spacesheep-dev/sessionpipe/blob/main/CODE_OF_CONDUCT.md",
  "SECURITY.md": "/security/",
  "GOVERNANCE.md": "/governance/",
  "TRADEMARKS.md": "/legal/#trademarks",
  "ROADMAP.md": "https://github.com/spacesheep-dev/sessionpipe/blob/main/ROADMAP.md",
  "CHANGELOG.md": "/changelog/",
  "SUPPORT.md": "https://github.com/spacesheep-dev/sessionpipe/blob/main/SUPPORT.md",
};

function rewriteLinks(md, map, dirPrefix) {
  return md.replace(/\]\(([^)\s]+)\)/g, (m, href) => {
    if (/^(https?:|#|mailto:)/.test(href)) return m;
    const [file, hash] = href.split("#");
    const base = file.replace(/^\.\.\//, "").replace(new RegExp(`^${dirPrefix}`), "");
    const target = map[base];
    if (!target) return m;
    return `](${target}${hash ? `#${hash}` : ""})`;
  });
}

marked.use({ gfm: true, headerIds: true, mangle: false });

function page({ title, description, body: html, pathname, edit, license, jsonld }) {
  // A block that scrolls sideways takes focus, so a keyboard can scroll it; a header cell
  // with nothing in it (a Markdown table with a blank heading) is an ordinary cell.
  const body = html
    .replace(/<pre(?![^>]*aria-hidden)(?=[\s>])/g, '<pre tabindex="0"')
    .replace(/<table>/g, '<table tabindex="0">')
    .replace(/<th([^>]*)>\s*<\/th>/g, "<td$1></td>");
  const canonical = SITE + pathname;
  const twin = twins.has(pathname) ? `${pathname}index.md` : null;
  const bar =
    twin && pathname !== "/"
      ? `<div class="agentbar"><button type="button" class="copy" data-copy="${twin}" hidden>Copy page as Markdown</button><a href="${twin}">Markdown</a><a href="/llms.txt">llms.txt</a></div>`
      : "";
  const navHtml = nav
    .map(
      ([href, label]) =>
        `<a href="${href}"${href === pathname || (href !== "/" && pathname.startsWith(href)) || (href === "/docs/" && pathname === "/get-started/") ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self' 'sha256-${themeHash}'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark">
<script>${themeBoot}</script>
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/fonts/Geist-latin.woff2" as="font" type="font/woff2" crossorigin>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="sessionpipe: an open protocol, and a client, for what your coding agents are doing.">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#f5f5f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141414" media="(prefers-color-scheme: dark)">
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
${twin ? `<link rel="alternate" type="text/markdown" href="${twin}" title="This page as Markdown">\n` : ""}<link rel="alternate" type="application/atom+xml" href="/changelog/feed.xml" title="sessionpipe releases">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
<style>${css}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="in"><a class="brand" href="/" aria-label="sessionpipe home"><img class="on-light" src="/brand/lockup-light.svg" alt="" width="175" height="24"><img class="on-dark" src="/brand/lockup-dark.svg" alt="" width="175" height="24"></a><nav aria-label="Site">${navHtml}</nav><button type="button" class="theme" aria-label="Switch to dark mode" title="Switch to dark mode" hidden>${sun}${moon}</button></div></header>
<main id="main">${bar}${body}</main>
<footer><div><img class="mark on-light" src="/brand/mark-light.svg" alt="" width="40" height="40"><img class="mark on-dark" src="/brand/mark-dark.svg" alt="" width="40" height="40"></div><div><p class="links"><a href="/docs/">Docs</a><a href="/protocol/">Protocol</a><a href="/receivers/">Receivers</a><a href="/security/">Security</a><a href="/legal/">Legal &amp; privacy</a><a href="/governance/">Governance</a><a href="https://github.com/spacesheep-dev/sessionpipe/blob/main/CONTRIBUTING.md">Contributing</a><a href="/changelog/">Changelog</a><a href="/llms.txt">For agents</a><a href="https://github.com/spacesheep-dev/sessionpipe">GitHub</a>${edit ? `<a href="${edit}">Edit this page</a>` : ""}</p><p>${license === "spec" ? 'This page is part of the sessionpipe protocol specification, licensed under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.' : "Code is Apache-2.0; the specification is CC BY 4.0."} "sessionpipe" and its logo are marks of Michael Makarov (<a href="/legal/#trademarks">trademarks</a>).</p><p>No cookies, no analytics, nothing loaded from anyone else. Hosted on GitHub Pages. sessionpipe ${version}.</p><p>Started by the people behind <a href="https://spacesheep.dev">spacesheep</a>, and given to the community as an open protocol: Apache-2.0 code, CC BY 4.0 spec, no CLA.</p></div></footer>
<script src="/theme.js" defer></script>
${twin ? '<script src="/copy.js" defer></script>\n' : ""}</body>
</html>
`;
}

function write(pathname, html) {
  const dir = path.join(out, pathname);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.html"), html);
}

// Every page with Markdown behind it also gets <path>index.md, the same words for an agent.
// Links become absolute, so a copied page still works on its own.
const twins = new Map();
function twin(pathname, md) {
  const text = `${md.replace(/\]\((\/[^)\s]*)\)/g, `](${SITE}$1)`).trim()}\n`;
  twins.set(pathname, text);
  mkdirSync(path.join(out, pathname), { recursive: true });
  writeFileSync(path.join(out, pathname, "index.md"), text);
}

function mdPage({ pathname, file, title, description, map, dirPrefix = "", license, extra = "" }) {
  const md = rewriteLinks(read(file), map, dirPrefix);
  twin(pathname, md);
  const body = `<article class="prose">${marked.parse(md)}${extra}</article>`;
  write(
    pathname,
    page({
      title,
      description,
      body,
      pathname,
      edit: `https://github.com/spacesheep-dev/sessionpipe/edit/main/${file}`,
      license,
    }),
  );
}

// h2/h3 get ids (an explicit {#id}, else GitHub's slug, so links written against the
// repository's Markdown land), and the page gets a table of contents from them: a column
// beside the text on a wide screen, and on a narrow one a single folded line under the h1,
// so the page still starts with its title.
function anchored(html) {
  const toc = [];
  const out = html.replace(/<h([23])>(.*?)<\/h\1>/g, (_, level, inner) => {
    const m = /\s*\{#([a-z0-9-]+)\}$/.exec(inner);
    const text = m ? inner.slice(0, m.index) : inner;
    // The heading as plain text for the contents list: tags and entities out, and any `<`,
    // `>`, `&` or `"` left over dropped too, so nothing that could be markup reaches the list.
    let plain = text;
    for (let prev = ""; prev !== plain; ) {
      prev = plain;
      plain = plain.replace(/<[^<>]*>/g, "");
    }
    plain = plain.replace(/&[a-z]+;|&#\d+;/g, "").replace(/[<>&"]/g, "");
    let id =
      m?.[1] ??
      plain
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .trim()
        .replace(/ /g, "-");
    while (toc.some((h) => h.id === id)) id += "-";
    toc.push({ level: Number(level), id, text: plain });
    return `<h${level} id="${id}"><a href="#${id}">${text}</a></h${level}>`;
  });
  const item = (h) => `<li class="l${h.level}"><a href="#${h.id}">${h.text}</a></li>`;
  const tocHtml = `<nav class="toc" aria-label="On this page"><p>On this page</p><ul>${toc.map(item).join("")}</ul></nav>`;
  const fold = `<details class="toc-m"><summary>On this page</summary><nav aria-label="On this page"><ul>${toc
    .filter((h) => h.level === 2)
    .map(item)
    .join("")}</ul></nav></details>`;
  return { html: toc.length ? out.replace("</h1>", `</h1>${fold}`) : out, toc: tocHtml };
}

// --- protocol, from spec/ ---------------------------------------------------------
const specs = [
  [
    "/protocol/",
    "spec/PROTOCOL.md",
    "sessionpipe protocol v1",
    "The envelope, the session block, the event vocabulary and the privacy tiers of the sessionpipe protocol.",
  ],
  [
    "/protocol/http/",
    "spec/HTTP.md",
    "HTTP binding · sessionpipe protocol",
    "Discovery, batches, errors, retry, idempotency, the control long-poll and the native lane.",
  ],
  [
    "/protocol/privacy/",
    "spec/PRIVACY.md",
    "Privacy: tiers and rulesets · sessionpipe protocol",
    "The four tiers in detail, the secrets and PII rulesets, and guidance for receivers.",
  ],
  [
    "/protocol/control/",
    "spec/CONTROL.md",
    "Control: the channel back · sessionpipe protocol",
    "Permission answers, prompts at the next turn boundary, cancel, and acks.",
  ],
  [
    "/protocol/adapters/",
    "spec/ADAPTERS.md",
    "Adapters · sessionpipe protocol",
    "The harness registry and the per-harness mapping from native hooks to protocol events.",
  ],
  [
    "/protocol/versioning/",
    "spec/VERSIONING.md",
    "Versioning · sessionpipe protocol",
    "The protocol integer, capabilities, deprecation and the spec's status.",
  ],
];
const specNav = (current) =>
  `<nav class="subnav" aria-label="Protocol">${[
    ["/protocol/", "Protocol"],
    ["/protocol/http/", "HTTP"],
    ["/protocol/privacy/", "Privacy"],
    ["/protocol/control/", "Control"],
    ["/protocol/adapters/", "Adapters"],
    ["/protocol/versioning/", "Versioning"],
    ["/schema/", "Schemas"],
  ]
    .map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a>`)
    .join("")}</nav>`;
for (const [pathname, file, title, description] of specs) {
  const md = rewriteLinks(read(file), specPath, "");
  twin(pathname, md);
  const { html, toc } = anchored(marked.parse(md));
  const body = `${specNav(pathname)}<div class="docs spec">${toc}<article class="prose">${html}</article></div>`;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: title,
    description,
    url: SITE + pathname,
    license: "https://creativecommons.org/licenses/by/4.0/",
    isPartOf: { "@type": "WebSite", name: "sessionpipe", url: SITE },
    author: { "@type": "Organization", name: "sessionpipe" },
  };
  write(
    pathname,
    page({
      jsonld,
      title,
      description,
      body,
      pathname,
      edit: `https://github.com/spacesheep-dev/sessionpipe/edit/main/${file}`,
      license: "spec",
    }),
  );
}

// --- schemas index ------------------------------------------------------------------
{
  const files = readdirSync(path.join(root, "schemas/v1"))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const body = `${specNav("/schema/")}<article class="prose"><h1>JSON Schemas, v1</h1><p>Generated from the reference implementation's types (<code>packages/core/schema/v1.ts</code>); these URLs are the schemas' <code>$id</code>s. Served as <code>application/json</code>.</p><ul>${files.map((f) => `<li><a href="/schema/v1/${f}">/schema/v1/${f}</a></li>`).join("")}</ul></article>`;
  write(
    "/schema/",
    page({
      title: "Schemas · sessionpipe protocol",
      description: "The JSON Schemas of the sessionpipe protocol, generated from code.",
      body,
      pathname: "/schema/",
      license: "spec",
    }),
  );
}

// --- root documents -----------------------------------------------------------------
mdPage({
  pathname: "/security/",
  file: "SECURITY.md",
  title: "Security · sessionpipe",
  description: "How to report a vulnerability, supported versions, and the threat model.",
  map: rootPath,
});
mdPage({
  pathname: "/governance/",
  file: "GOVERNANCE.md",
  title: "Governance · sessionpipe",
  description: "Maintainers, how decisions are made, how to become a maintainer.",
  map: rootPath,
});
// --- changelog, from packages/*/CHANGELOG.md and .changeset/ -------------------------
const changelog = loadChangelog(root);
const REPO = "https://github.com/spacesheep-dev/sessionpipe";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const day = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
function entryHtml(e) {
  const [lead, rest] = splitLead(e.text);
  const more = rest ? `<details><summary>Details</summary>${marked.parse(rest)}</details>` : "";
  const meta = `<p class="meta">${e.hash ? `<a href="${REPO}/commit/${e.hash}">${e.hash}</a> · ` : ""}${e.packages.join(", ")}</p>`;
  return `<li><span class="bump ${e.bump}">${e.bump}</span><div><p class="what">${marked.parseInline(lead)}</p>${more}${meta}</div></li>`;
}
function releaseHtml(r) {
  const id = `v${r.version}`;
  const when = r.date ? ` <time datetime="${r.date}">${day(r.date)}</time>` : "";
  return `<section class="release" id="${id}"><h2><a href="#${id}">${r.version}</a>${when}</h2><ul class="entries">${r.entries.map(entryHtml).join("")}</ul></section>`;
}
{
  const { next, releases } = changelog;
  const nextHtml = next
    ? `<section class="release next" id="next"><h2><a href="#next">${next.version}</a> <span class="pill">next</span></h2><p class="sub">Merged to main and waiting for the release. The version follows from the largest bump below.</p><ul class="entries">${next.entries.map(entryHtml).join("")}</ul></section>`
    : "";
  const protocol = rewriteLinks(read("CHANGELOG.md"), rootPath, "")
    .replace(/^# .*\n/, "")
    .replace(/^## /gm, "### ");
  const entryMd = (e) =>
    `- **${e.bump}** ${e.text.replace(/\n/g, "\n  ")}${e.hash ? ` ([${e.hash}](${REPO}/commit/${e.hash}))` : ""}`;
  twin(
    "/changelog/",
    [
      "# sessionpipe changelog",
      "",
      "Every release of the four packages (one shared version number), newest first, generated from the repository's changesets.",
      "",
      ...(next ? [`## ${next.version} (next, on main, not released yet)`, "", ...next.entries.map(entryMd), ""] : []),
      ...releases.flatMap((r) => [`## ${r.version}${r.date ? ` (${r.date})` : ""}`, "", ...r.entries.map(entryMd), ""]),
      "## Protocol",
      "",
      protocol,
    ].join("\n"),
  );
  const body = `<div class="changelog"><header class="cl-head"><h1>Changelog</h1><p class="sub">Every release of the four packages (they share one version number), newest first. Built from the repository's changesets each time the site deploys, so this page cannot drift from what shipped. Each entry links the commit that made it. Subscribe with the <a href="/changelog/feed.xml">Atom feed</a>.</p></header>${nextHtml}${releases.map(releaseHtml).join("")}<section class="release" id="protocol"><h2><a href="#protocol">Protocol</a></h2><div class="prose">${marked.parse(protocol)}</div></section></div>`;
  write(
    "/changelog/",
    page({
      title: "Changelog · sessionpipe",
      description: "Every sessionpipe release and what it changed, generated from the repository's changesets.",
      body,
      pathname: "/changelog/",
    }),
  );
  // Atom: one entry per release.
  const updated = (r) => `${r.date ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>sessionpipe releases</title>
<link href="${SITE}/changelog/"/>
<link rel="self" href="${SITE}/changelog/feed.xml"/>
<id>${SITE}/changelog/</id>
<updated>${releases[0] ? updated(releases[0]) : new Date().toISOString()}</updated>
${releases
  .slice(0, 20)
  .map(
    (r) => `<entry>
<title>sessionpipe ${r.version}</title>
<link href="${SITE}/changelog/#v${r.version}"/>
<id>${SITE}/changelog/#v${r.version}</id>
<updated>${updated(r)}</updated>
<content type="html">${esc(`<ul>${r.entries.map((e) => `<li><strong>${e.bump}</strong> ${marked.parse(e.text)}</li>`).join("")}</ul>`)}</content>
</entry>`,
  )
  .join("\n")}
</feed>
`;
  writeFileSync(path.join(out, "changelog/feed.xml"), feed);
}
{
  const privacy = read("website/src/pages/privacy.md");
  const body = `<article class="prose">${marked.parse(privacy)}<h2 id="trademarks">Trademarks</h2>${marked.parse(read("TRADEMARKS.md").replace(/^# Trademarks\n/, ""))}<h2 id="code-license">Code license</h2><p>Apache License 2.0. <a href="https://github.com/spacesheep-dev/sessionpipe/blob/main/LICENSE">Full text</a> · <a href="https://github.com/spacesheep-dev/sessionpipe/blob/main/NOTICE">NOTICE</a></p><h2 id="spec-license">Specification license</h2><p>Creative Commons Attribution 4.0 International. <a href="https://creativecommons.org/licenses/by/4.0/">Summary</a> · <a href="https://github.com/spacesheep-dev/sessionpipe/blob/main/spec/LICENSE">Full text</a></p></article>`;
  write(
    "/legal/",
    page({
      title: "Legal & privacy · sessionpipe",
      description: "Privacy notice, trademarks, licenses.",
      body,
      pathname: "/legal/",
    }),
  );
}
for (const [pathname, file, title, description] of [
  [
    "/get-started/",
    "website/src/pages/get-started.md",
    "Get started · sessionpipe",
    "Install, add a sink, tail. The receiver in Docker. Send to spacesheep or to a Slack webhook.",
  ],
  [
    "/receivers/",
    "website/src/pages/receivers.md",
    "Receivers · sessionpipe",
    "Who speaks the sessionpipe protocol, and how to list yours.",
  ],
]) {
  const md = rewriteLinks(withGui(read(file), file), { ...specPath, ...rootPath }, "spec/");
  twin(pathname, md);
  const body = `<article class="prose">${marked.parse(md)}</article>`;
  write(pathname, page({ title, description, body, pathname }));
}

// --- docs, from website/src/docs/docs.md, the CLI's usage table and the READMEs --------
// The CLI's own usage table (packages/cli/src/help.ts), so a usage line is written once.
const usage = await (async () => {
  const { code } = transformSync(read("packages/cli/src/help.ts"), { loader: "ts", format: "esm" });
  const { usageTable } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  return usageTable(["<harness>"]);
})();
const usageLine = (cmd) => `sessionpipe ${usage[cmd].replace(/ \([^()]*\)$/, "")}`;
const publicCommands = Object.keys(usage).filter(
  (k) => !k.startsWith("-") && !/\((internal|use --help)/.test(usage[k]),
);
{
  const used = new Set();
  const src = "website/src/docs/docs.md";
  const withUsage = (text, render) =>
    text.replace(/^\{\{usage (.+?)\}\}$/gm, (_, cmd) => {
      if (!usage[cmd]) throw new Error(`${src}: the CLI has no command "${cmd}"`);
      used.add(cmd);
      return render(usageLine(cmd));
    });
  let md = read(src).replace(/^\{\{include ([^#}]+)(?:#(.+?))?\}\}$/gm, (_, file, heading) => {
    const lines = read(file).split("\n");
    let from = 0;
    if (heading) {
      from = lines.findIndex((l) => l.startsWith(`## ${heading}`)) + 1;
      if (!from) throw new Error(`${src}: ${file} has no "## ${heading}" section`);
    } else if (lines[0].startsWith("# ")) from = 1;
    const to = lines.findIndex((l, i) => i >= from && /^(#{1,2} |---$)/.test(l));
    return lines
      .slice(from, to === -1 ? undefined : to)
      .join("\n")
      .trim();
  });
  md = rewriteLinks(md, { ...specPath, ...rootPath }, "spec/");
  twin("/docs/", withUsage(md, (line) => `\`\`\`sh\n${line}\n\`\`\``).replace(/ \{#[a-z0-9-]+\}$/gm, ""));
  md = withUsage(md, (line) => `<pre class="usage"><code>${esc(line)}</code></pre>`);
  // A command the CLI has and this page doesn't is a build error, not a gap someone notices.
  const missing = publicCommands.filter((k) => !used.has(k));
  if (missing.length) throw new Error(`${src}: document ${missing.map((k) => `"${k}"`).join(", ")}`);
  const { html, toc } = anchored(marked.parse(md));
  write(
    "/docs/",
    page({
      title: "Docs · sessionpipe",
      description:
        "Every sessionpipe command, the control daemon, self-updates, status JSON and the conformance suite.",
      body: `<div class="docs">${toc}<article class="prose">${html}</article></div>`,
      pathname: "/docs/",
      edit: `https://github.com/spacesheep-dev/sessionpipe/edit/main/${src}`,
    }),
  );
}

// --- home ---------------------------------------------------------------------------
const FAQ = [
  [
    "What is sessionpipe?",
    "An open protocol, and a small client, that turns the hooks coding agents already fire (Claude Code, Codex, Gemini CLI, Antigravity and Devin today; Cursor, Copilot CLI and others next) into one uniform stream of session events: started, working on a tool, needs you, ended. You choose per destination how much leaves your machine.",
  ],
  [
    "Does it work with Claude Code hooks?",
    "Yes. <code>sessionpipe install</code> writes Claude Code's SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, Subagent and Compact hooks into every config dir on the machine, and maps them to protocol events. Codex hooks, Gemini CLI hooks, Antigravity hooks and Devin CLI hooks work the same way.",
  ],
  [
    "What are the privacy tiers?",
    "Tier 0 is presence (session state, timing, folder, model, title). Tier 1 adds tool names, durations and file paths. Tier 2 adds your prompts and the assistant's text. Tier 3 adds tool input and output. A sink is configured at a tier; the receiver declares its maximum; the lower wins. Secrets are redacted on your machine above tier 0, always.",
  ],
  [
    "Do I need a server?",
    "No. <code>sessionpipe tail</code> follows the local outbox with no sink configured. When you want a receiver, run the reference one on your laptop, point at any HTTPS endpoint that speaks the protocol, or use a hosted receiver such as spacesheep.",
  ],
  [
    "Is there telemetry?",
    "None. The client reports only to the sinks you configure, this website has no analytics or cookies, and the optional version check is a plain read of the npm registry that you can turn off.",
  ],
  [
    "Who maintains it, and under what license?",
    "Michael Makarov, with a written path to more maintainers. Code is Apache-2.0, the specification is CC BY 4.0, contributions are under the Developer Certificate of Origin with no CLA.",
  ],
];
{
  const diagram = (name) => read(`website/src/diagrams/${name}.svg`);
  // The home page's Markdown is the brief for an agent; /agent.md is the same file.
  const agent = read("website/src/agents/agent.md")
    .replace("{{version}}", version)
    .replace("{{commands}}", `\`\`\`sh\n${publicCommands.map(usageLine).join("\n")}\n\`\`\``);
  twin("/", agent);
  // The architecture diagram with its colours resolved, for places that take an <img>
  // and have no stylesheet (the README): one copy per theme, from the same source.
  mkdirSync(path.join(out, "diagrams"), { recursive: true });
  const THEMES = {
    light: {
      bg: "#f5f5f3",
      surface: "#ffffff",
      fg: "#141414",
      fg2: "#5c5c5a",
      fg4: "#c4c4c0",
      line: "#e4e4e1",
      accent: "#ff5a1f",
      plate: "#141414",
      "plate-line": "#141414",
      "plate-fg": "#f5f5f3",
      "plate-fg2": "#9a9a96",
    },
    dark: {
      bg: "#141414",
      surface: "#1c1c1b",
      fg: "#f5f5f3",
      fg2: "#9a9a96",
      fg4: "#454545",
      line: "#2a2a2a",
      accent: "#ff5a1f",
      plate: "#1c1c1b",
      "plate-line": "#2a2a2a",
      "plate-fg": "#f5f5f3",
      "plate-fg2": "#9a9a96",
    },
  };
  for (const [theme, vars] of Object.entries(THEMES)) {
    const svg = diagram("architecture")
      .replace(/var\(--([a-z0-9-]+)\)/g, (m, v) => vars[v] ?? m)
      .replace(/<svg /, `<svg style="background:${vars.bg}" `);
    writeFileSync(path.join(out, "diagrams", `architecture-${theme}.svg`), svg);
  }
  writeFileSync(path.join(out, "agent.md"), twins.get("/"));
  // Everything with Markdown behind it, in reading order, in one file.
  const order = ["/", "/docs/", "/get-started/", "/receivers/", ...specs.map((s) => s[0]), "/changelog/"];
  const rest = [...twins.keys()].filter((p) => !order.includes(p));
  const full = [...order, ...rest]
    .map((p) => `<!-- ${SITE}${p} · Markdown: ${SITE}${p}index.md -->\n\n${twins.get(p)}`)
    .join("\n---\n\n");
  writeFileSync(path.join(out, "llms-full.txt"), full);
  let home = withGui(read("website/src/pages/home.html"), "home.html").replace("{{version}}", version);
  {
    // A real screenshot, demo data, the same scene in each scheme. <picture> fetches only the
    // reader's scheme, and the slot stays empty without the files, so the page never shows an
    // older GUI than it offers. (public/gui/ also holds the phone's, for a /gui/ page later.)
    const has = (f) => existsSync(path.join(root, "website/public/gui", f));
    const set = (name, widths) => widths.map((w) => `/gui/${name}-${w}.webp ${w}w`).join(", ");
    const shot = (kind, widths, [width, height], sizes, alt, caption) =>
      has(`${kind}-light-${widths[0]}.webp`) && has(`${kind}-dark-${widths[0]}.webp`)
        ? `<figure class="${kind}"><picture><source media="(prefers-color-scheme: dark)" srcset="${set(`${kind}-dark`, widths)}" sizes="${sizes}"><img src="/gui/${kind}-light-${widths[0]}.webp" srcset="${set(`${kind}-light`, widths)}" sizes="${sizes}" alt="${alt}" width="${width}" height="${height}" loading="lazy" decoding="async"></picture><figcaption>${caption}</figcaption></figure>`
        : "";
    const board = shot(
      "board",
      [960, 1440],
      [1440, 900],
      "(max-width: 720px) calc(100vw - 32px), (max-width: 1184px) calc(100vw - 64px), 1120px",
      "The sessionpipe-gui board, demo data: sessions from two machines grouped by state, the one that needs you first.",
      `Board · macOS · ${gui.version}, demo data`,
    );
    home = home.replace("{{gui-shots}}", board ? `<div class="gui-shots">${board}</div>` : "");
  }
  home = home.replace(/\{\{diagram:([a-z-]+)\}\}/g, (_, n) => diagram(n));
  home = home.replace("{{faq}}", FAQ.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join(""));
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE}/#website`,
        name: "sessionpipe",
        url: SITE,
        description: "An open protocol and client for what your coding agents are doing.",
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE}/#app`,
        name: "sessionpipe",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "macOS, Linux, Windows",
        softwareVersion: version,
        license: "https://www.apache.org/licenses/LICENSE-2.0",
        codeRepository: "https://github.com/spacesheep-dev/sessionpipe",
        url: SITE,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        description:
          "Hooks for Claude Code, Codex, Gemini CLI, Antigravity, Devin and other coding agents; four privacy tiers; secrets removed on your machine; sends to your server or to none.",
      },
      {
        "@type": "FAQPage",
        mainEntity: FAQ.map(([q, a]) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a.replace(/<[^>]+>/g, "") },
        })),
      },
    ],
  };
  write(
    "/",
    page({
      jsonld,
      title: "sessionpipe — an open protocol for what your coding agents are doing",
      description:
        "One install hooks Claude Code, Codex, Gemini CLI, Antigravity, Devin and more. Four privacy tiers, secrets removed on your machine, sent to your server or to none.",
      body: home,
      pathname: "/",
    }),
  );
}

// 404
writeFileSync(
  path.join(out, "404.html"),
  page({
    title: "Not found · sessionpipe",
    description: "That page does not exist.",
    body: `<article class="prose"><h1>Not found</h1><p>Nothing lives at this address. Try the <a href="/">home page</a> or the <a href="/protocol/">protocol</a>.</p></article>`,
    pathname: "/404",
  }),
);
// sitemap + robots
const pages = [
  "/",
  "/docs/",
  ...specs.map((s) => s[0]),
  "/schema/",
  "/get-started/",
  "/receivers/",
  "/security/",
  "/legal/",
  "/governance/",
  "/changelog/",
];
const today = new Date().toISOString().slice(0, 10);
const urlRow = (p) =>
  `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod><priority>${p === "/" ? "1.0" : p.startsWith("/protocol") ? "0.8" : "0.5"}</priority></url>`;
writeFileSync(
  path.join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(urlRow).join("\n")}\n</urlset>\n`,
);
const mdLink = (p, t, note) => `- [${t}](${SITE}${p}index.md)${note ? `: ${note}` : ""}`;
const llms = [
  "# sessionpipe",
  "",
  "> An open protocol and client for what your coding agents are doing: hooks for Claude Code, Codex, Gemini CLI, Antigravity, Devin and more; four privacy tiers; secrets removed on the person's machine; events sent to a server of their choosing or to none. Apache-2.0 code, CC BY 4.0 spec.",
  "",
  "Every page below is Markdown. An agent helping someone set sessionpipe up should read the first link before running anything.",
  "",
  "## Start here",
  "",
  `- [Context for an agent](${SITE}/agent.md): what sessionpipe is, every command, and the rules to follow`,
  `- [The whole site in one file](${SITE}/llms-full.txt)`,
  "",
  "## Use it",
  "",
  mdLink("/get-started/", "Get started", "connect, install, tail, add a sink"),
  mdLink("/docs/", "Docs", "every command, the control daemon, self-updates, status JSON, conformance"),
  mdLink("/receivers/", "Receivers", "who speaks the protocol"),
  mdLink("/changelog/", "Changelog", "every release, generated from the changesets"),
  "",
  "## Protocol",
  "",
  ...specs.map(([p, , t]) => mdLink(p, t)),
  `- [JSON Schemas](${SITE}/schema/v1/event.json): one per message; their $ids are these URLs`,
  "",
  "## Optional",
  "",
  mdLink("/security/", "Security"),
  mdLink("/governance/", "Governance"),
  "- [Source](https://github.com/spacesheep-dev/sessionpipe)",
  "",
];
writeFileSync(path.join(out, "llms.txt"), llms.join("\n"));
writeFileSync(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(path.join(out, ".nojekyll"), "");
console.log(`site: ${pages.length} pages + schemas → website/dist`);
