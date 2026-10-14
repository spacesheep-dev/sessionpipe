---
"sessionpipe-core": minor
"sessionpipe": minor
---

A Claude Code home that runs on another API now has an account. Such a home has no claude.ai login, and its `settings.json` sets `env.ANTHROPIC_BASE_URL` (Kimi K3 on a Modal endpoint, GLM on Z.ai). Its events carry `account_id: api-<16 hex>`, made from the endpoint's origin and the same on every machine that uses it. Control's pair and hello name it by the endpoint's host, in `accounts[].name`, a new optional field. Before this, its sessions carried no account, so a board filed them with the harnesses that report none (a person's Kimi sessions sat in "No account" beside 1,331 Codex ones). Only that one settings key is read, never the token or the headers beside it.
