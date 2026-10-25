# sessionpipe.org

Static site, built by `website/build.mjs` from `spec/*.md`, `schemas/v1/` and the
legal files at the repo root; deployed to GitHub Pages by `.github/workflows/pages.yml`.
Built in M4. No framework, no analytics, no external requests.

**Brand.** The mark, the lockups, the favicons and `og.png` come from the sessionpipe brand
kit as they are (`public/brand/`, `public/favicon.*`, `public/apple-touch-icon.png`); the
name and the logo are marks of Michael Makarov ([TRADEMARKS.md](../TRADEMARKS.md)). Type is
Geist and Geist Mono (SIL OFL 1.1, `public/fonts/LICENSE-geist.txt`), Latin subsets with
Latin Extended loaded only when a page uses it, and fallback faces sized to Geist so the
swap moves no line. `src/og/og.html` is the source of `og.png`.

**The GUI's picture.** The home page shows the sessionpipe GUI's board when
`public/gui/board.webp` exists (1440 × 900; `board-dark.webp` beside it is used in dark
mode), and leaves the slot out when it doesn't, so the page never shows an older GUI than
the one shipping.
