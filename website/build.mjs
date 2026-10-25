// SPDX-License-Identifier: Apache-2.0
// sessionpipe.org: one Node script, no framework. Renders spec/*.md and the legal
// files with marked into one HTML template, copies schemas/v1 (the $ids), writes
// website/dist/. No analytics, no external requests, no cookies.
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

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "website/public"), out, { recursive: true });
mkdirSync(path.join(out, "schema/v1"), { recursive: true });
cpSync(path.join(root, "schemas/v1"), path.join(out, "schema/v1"), { recursive: true });

const css = read("website/src/site.css");
const nav = [
  ["/", "Home"],
  ["/docs/", "Docs"],
  ["/protocol/", "Protocol"],
  ["/receivers/", "Receivers"],
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
        `<a href="${href}"${href === pathname || (href !== "/" && pathname.startsWith(href)) ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark">
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
<header class="top"><div class="in"><a class="brand" href="/" aria-label="sessionpipe home"><picture><source srcset="/brand/lockup-dark.svg" media="(prefers-color-scheme: dark)"><img src="/brand/lockup-light.svg" alt="" width="146" height="18"></picture></a><nav aria-label="Site">${navHtml}</nav></div></header>
<main id="main">${bar}${body}</main>
<footer><div><img class="mark" src="/favicon.svg" alt="" width="28" height="28"></div><div><p class="links"><a href="/docs/">Docs</a><a href="/protocol/">Protocol</a><a href="/receivers/">Receivers</a><a href="/security/">Security</a><a href="/legal/">Legal &amp; privacy</a><a href="/governance/">Governance</a><a href="/changelog/">Changelog</a><a href="https://github.com/spacesheep-dev/sessionpipe">GitHub</a>${edit ? `<a href="${edit}">Edit this page</a>` : ""}</p><p>${license === "spec" ? 'This page is part of the sessionpipe protocol specification, licensed under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.' : "Code is Apache-2.0; the specification is CC BY 4.0."} "sessionpipe" and its logo are marks of Michael Makarov (<a href="/legal/#trademarks">trademarks</a>).</p><p>No cookies, no analytics, nothing loaded from anyone else. Hosted on GitHub Pages. sessionpipe ${version}.</p><p>Started by the people behind <a href="https://spacesheep.dev">spacesheep</a>, and given to the community as an open protocol: Apache-2.0 code, CC BY 4.0 spec, no CLA.</p></div></footer>
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
  const body = `${specNav(pathname)}<article class="prose">${marked.parse(md)}</article>`;
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
function entryHtml(e, { full = true } = {}) {
  const [lead, rest] = splitLead(e.text);
  const more = full && rest ? `<details><summary>Details</summary>${marked.parse(rest)}</details>` : "";
  const meta = full
    ? `<p class="meta">${e.hash ? `<a href="${REPO}/commit/${e.hash}">${e.hash}</a> · ` : ""}${e.packages.join(", ")}</p>`
    : "";
  return `<li><span class="bump ${e.bump}">${e.bump}</span><div><p class="what">${marked.parseInline(lead)}</p>${more}${meta}</div></li>`;
}
function releaseHtml(r) {
  const id = `v${r.version}`;
  const when = r.date ? ` <time datetime="${r.date}">${day(r.date)}</time>` : "";
  return `<section class="release" id="${id}"><h2><a href="#${id}">${r.version}</a>${when}</h2><ul class="entries">${r.entries.map((e) => entryHtml(e)).join("")}</ul></section>`;
}
{
  const { next, releases } = changelog;
  const nextHtml = next
    ? `<section class="release next" id="next"><h2><a href="#next">${next.version}</a> <span class="pill">next</span></h2><p class="sub">Merged to main and waiting for the release. The version follows from the largest bump below.</p><ul class="entries">${next.entries.map((e) => entryHtml(e)).join("")}</ul></section>`
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
  const md = rewriteLinks(read(file), { ...specPath, ...rootPath }, "spec/");
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
  const toc = [];
  const html = marked.parse(md).replace(/<h([23])>(.*?)<\/h\1>/g, (_, level, inner) => {
    const m = /\s*\{#([a-z0-9-]+)\}$/.exec(inner);
    const text = m ? inner.slice(0, m.index) : inner;
    let id =
      m?.[1] ??
      text
        .replace(/<[^>]+>/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    while (toc.some((h) => h.id === id)) id += "-";
    toc.push({ level: Number(level), id, text: text.replace(/<[^>]+>/g, "") });
    return `<h${level} id="${id}"><a href="#${id}">${text}</a></h${level}>`;
  });
  const tocHtml = toc.map((h) => `<li class="l${h.level}"><a href="#${h.id}">${h.text}</a></li>`).join("");
  write(
    "/docs/",
    page({
      title: "Docs · sessionpipe",
      description:
        "Every sessionpipe command, the control daemon, self-updates, status JSON and the conformance suite.",
      body: `<div class="docs"><nav class="toc" aria-label="On this page"><p>On this page</p><ul>${tocHtml}</ul></nav><article class="prose">${html}</article></div>`,
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
  const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
  let home = read("website/src/pages/home.html");
  home = home.replace("{{fullkb}}", kb(full)).replace("{{version}}", version);
  {
    // The GUI's board, when website/public/gui/ has it (1440 × 900, light and optionally
    // dark): a slot, so the page never shows a picture of an older GUI than the one shipping.
    const has = (f) => existsSync(path.join(root, "website/public/gui", f));
    const alt =
      "The sessionpipe GUI's board: sessions from every machine grouped by state, the one that needs you first.";
    const img = `<img src="/gui/board.webp" alt="${alt}" width="1440" height="900" loading="lazy" decoding="async">`;
    const shot = has("board.webp")
      ? `<figure class="shot">${has("board-dark.webp") ? `<picture><source srcset="/gui/board-dark.webp" media="(prefers-color-scheme: dark)">${img}</picture>` : img}</figure>`
      : "";
    home = home.replace("{{gui-shot}}", shot).replace("{{gui-class}}", shot ? "" : " noshot");
  }
  home = home.replace(/\{\{diagram:([a-z-]+)\}\}/g, (_, n) => diagram(n));
  {
    // The next release's headlines, then the last release's.
    const { next, releases } = changelog;
    const list = (entries) =>
      `<ul class="entries brief">${entries.map((e) => entryHtml(e, { full: false })).join("")}</ul>`;
    const shown = 5;
    const parts = [];
    if (next) {
      const more = next.entries.length - shown;
      parts.push(
        `<h3 class="minor">Next: ${next.version} <span class="pill">on main</span></h3>${list(next.entries.slice(0, shown))}${more > 0 ? `<p class="more"><a href="/changelog/#next">and ${more} more</a></p>` : ""}`,
      );
    }
    if (releases[0]) {
      const r = releases[0];
      parts.push(
        `<h3 class="minor">${r.version}${r.date ? ` <time datetime="${r.date}">${day(r.date)}</time>` : ""}</h3>${list(r.entries.slice(0, shown + 1))}${r.entries.length > shown + 1 ? `<p class="more"><a href="/changelog/#v${r.version}">and ${r.entries.length - shown - 1} more in ${r.version}</a></p>` : ""}`,
      );
    }
    parts.push(
      `<p class="note"><a href="/changelog/">The full changelog</a>, ${releases.length} releases since ${releases.at(-1)?.version ?? "the start"}, each entry linked to its commit. Generated from the repository on every deploy. <a href="/changelog/feed.xml">Atom feed</a>.</p>`,
    );
    home = home.replace("{{changes}}", parts.join(""));
  }
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
