---
"sessionpipe-core": minor
---

A new tier-1 event, `limits.observed`: the account's usage limits as the harness last reported them, one `windows[]` entry each (`id`, `used_percent`, `resets_at?`, `window_minutes?`) and an optional `plan`. The numbers belong to the account, so a receiver keeps the newest per (harness, `session.account_id`). Codex's adapter reads them from the rollout (`token_count` → `rate_limits`, new `limits()` on the adapter); Claude Code's maps them from its status line's `rate_limits` (a new `StatusLine` input) and, with `statusLine: true`, installs that status line in `settings.json`, never over one the person set. Schemas: `event-data` gains `limits.observed`.
