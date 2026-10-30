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
const guiVersion = "0.6.1";
const gui = {
  version: guiVersion,
  files: {
    dmg: [`sessionpipe_${guiVersion}_universal.dmg`, 7636816],
    deb: [`sessionpipe_${guiVersion}_amd64.deb`, 4129222],
    appimage: [`sessionpipe_${guiVersion}_amd64.AppImage`, 82762232],
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
// A light or dark chosen with the header's button, applied before the first paint, and a "js"
// class, so what the scripts will show (the scheme button, the copy buttons) holds its place
// from the first paint instead of pushing the line over when it appears; and, should reveal.js
// never arrive, the hero's held entrance plays anyway after 3 s. It is the one inline
// script, allowed by its hash; theme.js wires the button.
const themeBoot = `document.documentElement.classList.add("js");setTimeout(()=>{if(!document.documentElement.dataset.motion)document.querySelector(".feed")?.classList.add("go")},3000);try{const t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}`;
const themeHash = createHash("sha256").update(themeBoot).digest("base64");
const sun =
  '<svg class="sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>';
const moon =
  '<svg class="moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.5 14.6A7.5 7.5 0 0 1 9.4 4.5a7.5 7.5 0 1 0 10.1 10.1z"/></svg>';

// The header's links; the lockup is the way home. GitHub follows them as its mark, and
// Get started closes the row as the one dark button (not on the page it opens).
const nav = [
  ["/docs/", "Docs"],
  ["/protocol/", "Protocol"],
  ["/receivers/", "Receivers"],
  ["/gui/", "GUI"],
  ["/changelog/", "Changelog"],
];
const repo = "https://github.com/spacesheep-dev/sessionpipe";
const githubMark =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 1.5a10.5 10.5 0 0 0-3.32 20.46c.53.1.72-.23.72-.5v-1.8c-2.92.63-3.54-1.4-3.54-1.4-.48-1.22-1.17-1.54-1.17-1.54-.95-.65.08-.64.08-.64 1.05.08 1.6 1.08 1.6 1.08.94 1.6 2.46 1.14 3.06.87.1-.68.37-1.14.66-1.4-2.33-.26-4.78-1.16-4.78-5.18 0-1.15.41-2.08 1.08-2.82-.1-.26-.47-1.33.1-2.78 0 0 .89-.28 2.9 1.08a10 10 0 0 1 5.26 0c2-1.36 2.89-1.08 2.89-1.08.58 1.45.21 2.52.1 2.78.68.74 1.08 1.67 1.08 2.82 0 4.03-2.45 4.92-4.79 5.18.38.32.71.96.71 1.94v2.87c0 .28.19.6.73.5A10.5 10.5 0 0 0 12 1.5z"/></svg>';
const menuIcon =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="a" d="M4.5 8.5h15"/><path class="b" d="M4.5 15.5h15"/></svg>';

// Marks, drawn beside a name wherever the site names a harness, a receiver or a feature:
// {{mark:<key>}} in a page. The harnesses' are their makers' marks in one colour, as
// sessionpipe-gui draws them (web/src/lib/harnessIcons.ts): path data for Anthropic, OpenAI
// and Google Gemini from simple-icons (CC0), Antigravity's arch redrawn from its own asset,
// and Devin, which has none there, as the GUI's monogram. They are trademarks of their
// owners, shown only to name the software (TRADEMARKS.md). The rest are drawn here, on one
// 24 px grid at one stroke, so a row of them reads as one set.
const fillMark = (viewBox, d) =>
  `<svg class="mk" viewBox="${viewBox}" aria-hidden="true" focusable="false"><path fill="currentColor" d="${d}"/></svg>`;
const lineMark = (d) => `<svg class="mk ln" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
const marks = {
  "claude-code": fillMark(
    "0 0 24 24",
    "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  ),
  codex: fillMark(
    "0 0 24 24",
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  ),
  "gemini-cli": fillMark(
    "0 0 24 24",
    "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  ),
  antigravity: fillMark(
    "0 0 112 112",
    "M89.754 92.75c4.667 3.5 11.667 1.167 5.25-5.25-19.25-18.667-15.167-70-39.083-70-23.917 0-19.834 51.333-39.084 70-7 7 .584 8.75 5.25 5.25C40.171 80.5 39.004 58.917 55.921 58.917c16.916 0 15.75 21.583 33.833 33.833Z",
  ),
  devin: '<span class="mk mono" aria-hidden="true">De</span>',
  // sessionpipe's own mark: the wires, the bar and the one orange dot
  sessionpipe:
    '<svg class="mk sp" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g fill="none" stroke-linecap="round" stroke-width="7"><path class="w" d="M9 47C20 47 19 32 29 32M9 32H29M9 17C20 17 19 32 29 32"/><path class="b" d="M29 32H36"/></g><circle cx="51" cy="32" r="7.5" fill="#FF5A1F"/></svg>',
  terminal: lineMark(
    '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m7.5 9.5 2.5 2.5-2.5 2.5M12.5 15h4"/>',
  ),
  envelope: lineMark('<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m3.8 7.2 8.2 5.8 8.2-5.8"/>'),
  outbox: lineMark(
    '<path d="M4 13.5V17a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 17v-3.5"/><path d="M12 15V4.5M8 8.5l4-4 4 4"/>',
  ),
  "eye-off": lineMark(
    '<path d="m3.5 3.5 17 17"/><path d="M10.6 6.1Q11.3 6 12 6c5 0 8.5 4.5 9.5 6-.5.8-1.6 2.3-3.2 3.6M6.4 7.6C4.6 8.9 3.2 10.7 2.5 12c1 1.5 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  ),
  shield: lineMark(
    '<path d="M12 3.2 5 6v5.6c0 4.2 2.9 7.8 7 9.2 4.1-1.4 7-5 7-9.2V6z"/><path d="m9 12 2.1 2.1L15.2 10"/>',
  ),
  server: lineMark(
    '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  ),
  file: lineMark(
    '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4"/>',
  ),
  globe: lineMark(
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5z"/>',
  ),
  plus: lineMark('<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>'),
  board: lineMark('<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M3.5 9h17M9.5 9v11"/>'),
  chat: lineMark('<path d="M5.5 18.5 4 21l3.6-1.4A8.5 8.5 0 1 0 4.4 15"/><path d="M8.5 11h7M8.5 14h4"/>'),
  inbox: lineMark(
    '<path d="M3.5 13.5h4.5l1.5 2.5h5l1.5-2.5h4.5"/><path d="M5.6 6.2A2 2 0 0 1 7.4 5h9.2a2 2 0 0 1 1.8 1.2l2.1 7.3V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-4.5z"/>',
  ),
  search: lineMark('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>'),
  spark: lineMark(
    '<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2 18 18M6 18l2.8-2.8M15.2 8.8 18 6"/>',
  ),
  phone: lineMark('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>'),
  bell: lineMark('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>'),
  fingerprint: lineMark(
    '<path d="M7.5 19.5c1.2-1.9 1.8-4.2 1.8-6.8a2.7 2.7 0 0 1 5.4 0c0 1.5-.1 2.9-.4 4.2"/><path d="M12 12.5c0 3.1-.7 5.9-2.1 8.2M17.6 18.6c.6-1.9.9-3.9.9-5.9a6.5 6.5 0 0 0-11.7-3.9M5.5 12.5c0 1.3-.2 2.6-.6 3.8"/><path d="M15.8 21c.2-.5.4-1 .5-1.5"/>',
  ),
  refresh: lineMark(
    '<path d="M19.5 12a7.5 7.5 0 0 1-13.1 5M4.5 12a7.5 7.5 0 0 1 13.1-5"/><path d="M17.6 3.5V7h-3.5M6.4 20.5V17h3.5"/>',
  ),
  key: lineMark('<circle cx="8" cy="15.5" r="4.5"/><path d="m11.2 12.3 8.3-8.3M16.5 7l2.5 2.5M14 9.5l2 2"/>'),
  wifi: lineMark(
    '<path d="M3 9.5a13 13 0 0 1 18 0M6 12.8a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><path d="M12 19.5h.01"/>',
  ),
  home: lineMark(
    '<path d="M4.5 10.5 12 4l7.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19z"/><path d="M9.5 20.5v-5.5h5v5.5"/>',
  ),
};
const withMarks = (text, file) =>
  text.replace(/\{\{mark:([a-z-]+)\}\}/g, (_, k) => {
    if (!(k in marks)) throw new Error(`${file}: no mark "${k}"`);
    return marks[k];
  });
// A hand-written page's shared pieces: {{downloads}}, the GUI's buttons (gui-download.html);
// {{team}}, who made it. Both before withGui, which fills the downloads' links.
const pagePartials = (text) =>
  text
    .replace("{{downloads}}", read("website/src/pages/gui-download.html").replace(/^<!--[\s\S]*?-->\n/, ""))
    .replace("{{team}}", () => team);
// spacesheep's flying sheep, as spacesheep.dev draws it (assets/brand/sheep-logo.ts): the wool is
// open on paper and filled white in the dark scheme, where the ink deepens, as on that site
const sheep =
  '<svg class="sheep" viewBox="0 0 398.1 327.98" aria-hidden="true" focusable="false"><path class="ss-wool" fill="none" d="M133.1,88.1H273.2V248.1H133.1Z M273.69,148.09h19.39v19.39h-19.39Z M313.19,148.34h19.39v19.39h-19.39Z"/><path d="M193.16,248.06l-.16,60h-19.95l-.16-60h20.28Z" class="ss-ink" fill="#43434b"/><path d="M273.29,248.06l-.24,60h-19.87l-.24-60h20.36Z" class="ss-ink" fill="#404048"/><path d="M313.42,248.06l-.24,60h-19.87l-.24-60h20.36Z" class="ss-ink" fill="#404048"/><path d="M153.49,248.18l-.16,59.88h-19.95l-.24-60,20.36.12Z" class="ss-ink" fill="#404048"/><polygon points="132 68.17 132 88.13 113.03 88.21 113.03 248.06 135.19 248.07 135.19 267.9 306.85 267.72 306.85 252.44 302.46 248.06 273.66 247.57 153.49 247.7 153.49 228.08 133.11 228.08 133.11 108.19 153.09 108.11 153.37 87.94 307.74 88.01 308.29 68.25 132 68.17" class="ss-ink" fill="#43434b"/><path d="M353.61,108.12l.08-39.95h-100.5l-.08,40.04h-19.81v39.8h19.64v60.23h20.36v39.82h59.55v-39.82h20.76v-60.23h19.47v-39.89h-19.47ZM293.08,167.48h-19.39v-19.39h19.39v19.39ZM332.58,167.73h-19.39v-19.39h19.39v19.39Z" class="ss-ink" fill="#43434b"/><path d="M313.24,208.37h-20v20.01h20v-20.01Z" fill="#d58e9e"/><path d="M293.06,28.12v40.06h-19.88V28.12h19.88Z" fill="#fea900"/><path d="M332.81,28.12v40.06h-19.88V28.12h19.88Z" fill="#fea900"/><g fill="#ffdf01"><rect x="93.04" y="68.17" width="38.76" height="19.99"/><rect x="73.06" y="188.1" width="19.99" height="19.99"/><rect x="33.08" y="88.16" width="19.99" height="19.99"/><rect x="73.06" y="148.12" width="19.99" height="19.99"/><rect x="13.09" y="128.13" width="19.99" height="19.99"/><rect x="73.06" y="108.15" width="19.99" height="19.99"/><rect x="33.08" y="168.11" width="19.99" height="19.99"/></g><g fill="#ed5544"><rect x="93.04" y="88.16" width="19.99" height="19.99"/><rect x="93.04" y="128.13" width="19.99" height="19.99"/><rect x="93.04" y="168.11" width="19.99" height="19.99"/><rect x="93.04" y="208.08" width="19.99" height="19.99"/></g><g fill="#fe7700"><rect x="53.07" y="168.11" width="19.99" height="19.99"/><rect x="73.06" y="128.13" width="19.99" height="19.99"/><rect x="73.06" y="88.16" width="19.99" height="19.99"/></g><g fill="#feed87"><rect x="53.07" y="108.15" width="19.99" height="19.99"/><rect x="53.07" y="148.12" width="19.99" height="19.99"/><rect x="53.07" y="188.1" width="19.99" height="19.99"/><rect x="73.06" y="68.17" width="19.99" height="19.99"/></g><g fill="#fea900"><rect x="53.07" y="88.16" width="19.99" height="19.99"/><rect x="93.04" y="108.15" width="19.99" height="19.99"/><rect x="53.07" y="128.13" width="19.99" height="19.99"/><rect x="33.08" y="128.13" width="19.99" height="19.99"/><rect x="93.04" y="148.12" width="19.99" height="19.99"/><rect x="73.06" y="168.11" width="19.99" height="19.99"/><rect x="93.04" y="188.1" width="19.99" height="19.99"/></g></svg>';
marks.spacesheep = sheep.replace('class="sheep"', 'class="mk sheep"');
// who made it, with their mark: in every footer, and at the end of the home and GUI pages
const team = `<a class="team" href="https://spacesheep.dev">${sheep}<span>From the team behind <b>spacesheep.dev</b></span></a>`;

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
    twin && pathname !== "/" && pathname !== "/gui/"
      ? `<div class="agentbar"><button type="button" class="copy" data-copy="${twin}" hidden>Copy page as Markdown</button><a href="${twin}">Markdown</a><a href="/llms.txt">llms.txt</a></div>`
      : "";
  const navHtml = nav
    .map(
      ([href, label]) =>
        `<a href="${href}"${href === pathname || pathname.startsWith(href) || (href === "/docs/" && pathname === "/get-started/") ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  const start = `<a class="btn primary cta" href="/get-started/"${pathname === "/get-started/" ? ' aria-current="page"' : ""}>Get started</a>`;
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
<header class="top"><div class="in"><a class="brand" href="/" aria-label="sessionpipe home"><img class="on-light" src="/brand/lockup-light.svg" alt="" width="175" height="24"><img class="on-dark" src="/brand/lockup-dark.svg" alt="" width="175" height="24"></a><nav class="links" aria-label="Site">${navHtml}<a class="gh" href="${repo}" aria-label="sessionpipe on GitHub" title="GitHub">${githubMark}</a></nav><button type="button" class="theme" aria-label="Switch to dark mode" title="Switch to dark mode" hidden>${sun}${moon}</button>${start}<details class="menu"><summary aria-label="Menu" title="Menu">${menuIcon}</summary><nav aria-label="Site menu">${navHtml}<a href="${repo}">GitHub</a><a class="btn primary" href="/get-started/">Get started</a></nav></details></div></header>
<main id="main">${bar}${body}</main>
<footer><div class="f-brand"><img class="mark on-light" src="/brand/mark-light.svg" alt="" width="40" height="40"><img class="mark on-dark" src="/brand/mark-dark.svg" alt="" width="40" height="40"><p>sessionpipe ${version}</p><p>No cookies, no analytics, nothing loaded from anyone else.</p>${team}</div><nav class="f-cols" aria-label="Footer"><div><p class="f-h">Project</p><a href="/get-started/">Get started</a><a href="/docs/">Docs</a><a href="/gui/">GUI</a><a href="/receivers/">Receivers</a><a href="/changelog/">Changelog</a></div><div><p class="f-h">Protocol</p><a href="/protocol/">Specification</a><a href="/schema/">Schemas</a><a href="${repo}/tree/main/conformance">Conformance</a><a href="/security/">Security</a><a href="/governance/">Governance</a></div><div><p class="f-h">Community</p><a href="${repo}">GitHub</a><a href="${repo}/blob/main/CONTRIBUTING.md">Contributing</a><a href="/llms.txt">For agents</a><a href="/legal/">Legal &amp; privacy</a>${edit ? `<a href="${edit}">Edit this page</a>` : ""}</div></nav><div class="f-base"><p>${license === "spec" ? 'This page is part of the sessionpipe protocol specification, licensed under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.' : "Code is Apache-2.0; the specification is CC BY 4.0."} "sessionpipe" and its logo are marks of Michael Makarov (<a href="/legal/#trademarks">trademarks</a>).</p><p>Hosted on GitHub Pages. Given to the community as an open protocol, with no CLA.</p></div></footer>
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

// --- sessionpipe-gui's pictures ----------------------------------------------------------
// Real screenshots and a real recording of demo data, the same scene in each scheme: the board
// in a window, the phone's own page in a phone. <picture> fetches only the reader's scheme, a
// lazy one that isn't shown is never fetched, and a slot stays empty without its files, so a
// page never shows an older GUI than it offers.
const hasGui = (f) => existsSync(path.join(root, "website/public/gui", f));
const guiSet = (name, widths) => widths.map((w) => `/gui/${name}-${w}.webp ${w}w`).join(", ");
const guiPicture = (name, widths, [width, height], sizes, alt) =>
  `<picture><source media="(prefers-color-scheme: dark)" srcset="${guiSet(`${name}-dark`, widths)}" sizes="${sizes}"><img src="/gui/${name}-light-${widths[0]}.webp" srcset="${guiSet(`${name}-light`, widths)}" sizes="${sizes}" alt="${alt}" width="${width}" height="${height}" loading="lazy" decoding="async"></picture>`;
const hasPair = (name, w) => hasGui(`${name}-light-${w}.webp`) && hasGui(`${name}-dark-${w}.webp`);
const windowSizes = "(max-width: 720px) calc(100vw - 40px), (max-width: 1184px) calc(100vw - 192px), 992px";
// a window: a title bar with the caption as its title, the picture under it
const guiWindow = (cls, name, widths, dims, alt, caption) =>
  hasPair(name, widths[0])
    ? `<figure class="${cls}"><figcaption>${caption}</figcaption>${guiPicture(name, widths, dims, windowSizes, alt)}</figure>`
    : "";
const guiBoard = () =>
  guiWindow(
    "board",
    "board",
    [1200, 2400],
    [1200, 750],
    "The sessionpipe-gui board, demo data: sessions grouped by state, the ones that need you first.",
    `Board · macOS · ${gui.version}, demo data`,
  );
// a phone: the bezel round the phone's own page
const phones = {
  phone: [
    "phone-board",
    [390, 780],
    "The sessionpipe-gui board on a phone, demo data: the session that needs you first, then the ones working.",
    "Board · phone",
  ],
  "phone-session": [
    "phone-session",
    [390, 780],
    "A session on a phone, demo data: the chat and the open prompt, with Allow and Deny.",
    "Session · phone",
  ],
};
const guiPhone = (key) => {
  const [name, widths, alt, caption] = phones[key];
  return hasPair(name, widths[0])
    ? `<figure class="phone"><figcaption>${caption} · ${gui.version}, demo data</figcaption>${guiPicture(name, widths, [390, 664], "280px", alt)}</figure>`
    : "";
};
// The showcase: a short loop of the board in use, one recording per scheme. showcase.js plays the
// shown one while it is on screen (the other never loads); each one's poster is its first frame,
// so without the script, or with reduced motion, the window holds a still.
const guiShowcase = () => {
  if (!["light", "dark"].every((t) => hasGui(`showcase-${t}.mp4`) && hasGui(`showcase-${t}-2400.webp`))) return "";
  const video = (t) =>
    `<video class="on-${t}" muted loop playsinline preload="none" poster="/gui/showcase-${t}-2400.webp" width="1200" height="750"><source src="/gui/showcase-${t}.mp4" type="video/mp4"></video>`;
  return `<figure class="board showcase"><figcaption>sessionpipe-gui ${gui.version} · demo data</figcaption><div class="screen" role="img" aria-label="sessionpipe-gui in use, demo data: the board updating live, a session that needs you opened with Allow and Deny, a search across transcripts, the inbox.">${video("light")}${video("dark")}</div></figure>`;
};
// The tour on /gui/: one band per view, its words beside its window, sides alternating. A view
// whose stills aren't in public/gui/ is left out.
const tour = [
  [
    "session",
    [1200, 750],
    "Answer where it asks",
    "The chat, each turn's tools folded into one line, and the open prompt with Allow and Deny. Send the next message from the composer, or stop the turn.",
    "A session, demo data: the chat and the open prompt with Allow and Deny.",
  ],
  [
    "search-palette",
    [1200, 750],
    "Find what any agent said",
    "⌘K finds any session, page or action, and searches the text of every transcript on the board and in this machine's own history.",
    "The ⌘K palette, demo data: a search across transcripts with the first result previewed.",
  ],
  [
    "inbox",
    [1200, 353],
    "Everything that needs you",
    "Every open permission, question and error from every machine, newest first. A toast tells you about each new one while you're elsewhere in the app.",
    "The inbox, demo data: open prompts from every machine.",
  ],
  [
    "new-session",
    [1200, 750],
    "Start one from here",
    "c anywhere: the machine, the agent, the folder, what it should do. The page opens at once and fills in as the agent starts.",
    "The New session sheet, demo data: a machine, an agent, a folder and a message.",
  ],
];
const guiTour = () => {
  const bands = tour
    .filter(([name]) => hasPair(name, 1200))
    .map(
      ([name, dims, title, text, alt]) =>
        `<div class="band" data-reveal><div class="words"><h3>${title}</h3><p>${text}</p></div>${guiWindow("view", name, [1200, 2400], dims, alt, `${title} · demo data`)}</div>`,
    );
  return bands.length
    ? `<section class="sec" id="tour" aria-labelledby="tour-h"><h2 class="sh" id="tour-h" data-reveal>A closer look</h2>${bands.join("")}</section>`
    : "";
};

// --- /gui/ ------------------------------------------------------------------------------
{
  twin("/gui/", withGui(read("website/src/pages/gui.md"), "gui.md"));
  const body = withMarks(withGui(pagePartials(read("website/src/pages/gui.html")), "gui.html"), "gui.html")
    .replace("{{showcase}}", () => (guiShowcase() || guiBoard()) + guiPhone("phone"))
    .replace("{{tour}}", guiTour)
    .replace("{{phones}}", () => guiPhone("phone") + guiPhone("phone-session"));
  write(
    "/gui/",
    page({
      title: "sessionpipe-gui · every agent session on one board",
      description:
        "Every coding-agent session on your machines on one live board: answer, steer and start them from your laptop or your phone. Desktop apps for macOS and Linux, or npm. No account, no cloud, no telemetry.",
      body,
      pathname: "/gui/",
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
  const order = ["/", "/docs/", "/get-started/", "/gui/", "/receivers/", ...specs.map((s) => s[0]), "/changelog/"];
  const rest = [...twins.keys()].filter((p) => !order.includes(p));
  const full = [...order, ...rest]
    .map((p) => `<!-- ${SITE}${p} · Markdown: ${SITE}${p}index.md -->\n\n${twins.get(p)}`)
    .join("\n---\n\n");
  writeFileSync(path.join(out, "llms-full.txt"), full);
  let home = withMarks(withGui(pagePartials(read("website/src/pages/home.html")), "home.html"), "home.html").replace(
    "{{version}}",
    version,
  );
  {
    const board = guiShowcase() || guiBoard();
    home = home.replace("{{gui-shots}}", board ? `<div class="gui-shots">${board}${guiPhone("phone")}</div>` : "");
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
  "/gui/",
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
  mdLink("/gui/", "sessionpipe-gui", "the board for every session: desktop apps, phone, npm"),
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
