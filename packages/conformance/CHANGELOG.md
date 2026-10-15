# @sessionpipe/conformance

## 0.9.0

No changes in this release.

## 0.8.0

### Patch Changes

- ea1d43a: Build on TypeScript 7 (`baseUrl` dropped from every tsconfig; `paths` already resolved relative to the file). Dev-only: published output is unchanged.

## 0.7.0

No changes in this release.

## 0.6.1

No changes in this release.

## 0.6.0

No changes in this release.

## 0.5.0

No changes in this release.

## 0.4.2

No changes in this release.

## 0.4.1

No changes in this release.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.0

No changes in this release.

## 0.1.1

### Patch Changes

- 08b5d89: READMEs carry the published (unscoped) package names.
- a360ee8: Published under unscoped names (sessionpipe-core, sessionpipe-receiver, sessionpipe-conformance) until the @sessionpipe npm org exists.

## 0.1.0

### Minor Changes

- c75aaa0: Core: adapters for Claude Code, Codex, Gemini CLI and Antigravity; the secrets@1 and pii@1 rulesets and the tier filter; outbox, cursors, locks; file, stdout and HTTP sinks. CLI: install, uninstall, sink, status, doctor, tail, backfill, forget, replay, update; the hook entry imports only node: builtins. Conformance: adapter fixture runner.

### Patch Changes

- Updated dependencies [e918475]
- Updated dependencies [c75aaa0]
  - @sessionpipe/core@0.1.0
