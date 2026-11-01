---
"sessionpipe": patch
---

`--tier` takes a whole number: `sink add`, `install --sink`, `connect`, `control pair` and `tail` refuse `--tier` with its value left off, or a value that is not a whole number (`--tier one`, `--tier 1.5`, `--tier --name x`), with "--tier takes 0, 1, 2 or 3", before doing anything. Until now `sink add` stored such a tier as `null` (or 1.5, which no event can carry) and printed "tier NaN sends: undefined". A value out of range is still held to 0–3, and a tier of 1.5 already in config.json sends as 1. The hook reads a sink's tier the same way, capped by the receiver's `max_tier` too: a stored 0.5, or a sink a receiver caps at 0, no longer turns every tool event into a job.
