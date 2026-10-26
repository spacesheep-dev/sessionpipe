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

**sessionpipe-gui.** The release the home page offers (its version, file names and sizes)
is `gui` at the top of `build.mjs`; `home.html` reads it through `{{gui:…}}`, so a new
release is one edit there. `public/copy.js` puts the visitor's system first (macOS without
JS). The screenshots are `public/gui/{board,phone}-{light,dark}-<width>.webp`: real
screenshots of demo data, the same scene in each scheme, at 960/1440 (board) and 390/585
(phone) wide. Without them the section lays out without pictures, so the page never shows
an older GUI than the one it offers.
