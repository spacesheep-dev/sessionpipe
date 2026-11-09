# The outbox

> This document describes the sender's local state, not the wire. It is Apache-2.0 with the code, not part of the CC BY protocol. The words MUST, SHOULD and MAY are used as in RFC 2119. Status: **Describes the reference client as of 0.13.3**; a second implementation (RFC 0002) MUST produce the same files.

The outbox is where a sender's events wait between the hook that produced them and the
sinks that deliver them. It is also read directly by a receiver on the same machine
(sessionpipe-gui's outbox source, `sessionpipe tail`), so its layout is an interface,
not an implementation detail. Three promises from [PROTOCOL.md §6](PROTOCOL.md): never
lose, never duplicate, redact before anything is written.

## 1. Layout

Under the state directory (`$SESSIONPIPE_STATE`, else `$XDG_STATE_HOME/sessionpipe`, else
`~/.local/state/sessionpipe`; on Windows `%LOCALAPPDATA%\sessionpipe`), every directory
`0700` and every file `0600`:

| Path | Holds |
|---|---|
| `outbox/<harness>/<session>.jsonl` | the session's events, one JSON object per line, append-only |
| `outbox/<harness>/<session>.seq` | the next `session.seq`, as decimal text |
| `cursors/<sink>.json` | one sink's byte offsets into session files: `{"<harness>/<session>": <offset>}` |
| `locks/<name>.lock` | a lock: `"<pid> <16 hex>"` |
| `jobs/<id>.json` | a hook's job for the worker (hook and worker only; not read by anything else) |

`<harness>`, `<session>` and `<sink>` in a file name are the **safe id** of the value:
every character outside `A-Za-z0-9_.-` replaced by `_`, cut to 160 characters. The
cursor key uses the raw values, not the safe ids.

## 2. Writing

- **Append only.** An event is written as `JSON.stringify(event)` followed by `\n`, in one
  `append` call per batch. A later append MUST NOT rewrite earlier bytes. Two processes
  appending to one file MUST NOT tear a line: the writer appends whole lines in one write.
- **seq.** `nextSeq` reads `<session>.seq`; if it is missing, empty or not a decimal, the
  counter is recovered as one more than the last line of the session file that carries a
  numeric `session.seq`, or 0 when none does. The file is then written with the next
  value. The counter survives pruning: a session resumed after its file was pruned counts
  on from where it was, so a receiver's `(harness, session id, seq)` dedup never takes new
  events for old ones.
- **A session lock** (`locks/<safe harness>-<safe session>.lock`) is held while a worker
  appends and drains that session, so two workers never interleave.

## 3. Reading

A reader keeps a byte offset per session file and reads from it:

- Lines are read whole. A trailing line without `\n` is a write in progress and MUST be
  left for the next read; the offset stops before it.
- A blank line is skipped and its bytes consumed. A line that is not JSON is skipped and
  its bytes consumed.
- Offsets count **bytes**, not characters.
- A read takes at most `maxEvents` events; it reads in chunks of 1 MiB and MUST read on
  until the batch is full or the file ends, so a run of lines that parse to nothing never
  stops it. One line longer than a chunk gets a larger one, doubling up to 8 MiB; a line
  longer than 8 MiB stops the read before it, without hanging.
- A read from an offset at or past the end of the file, or of a session with no file,
  returns no events and the offset it was given.

`sessions()` lists every `*.jsonl` under `outbox/`, newest modification first; a
stray file that is not `.jsonl` is skipped.

## 4. Cursors

One file per sink. The map moves **only when the sink acknowledged** a batch (a 2xx). It
is written whole to `<file>.<pid>.tmp` and renamed into place. A missing file, one cut off
mid-write, or one holding anything but an object reads as an empty map, never as "past
anything". A failed delivery re-reads the same bytes; a crash between the append and the
cursor move loses nothing, because the next drain re-reads.

## 5. Locks

`locks/<name>.lock` is created with `O_EXCL` (`wx`) holding `"<pid> <nonce>"`. It is stale
when its process is gone or it is older than 5 minutes (a worker lives 15 seconds). A stale
lock is taken over by **renaming it aside first**: of two takers that both judged it stale,
one rename wins; a taker that moved a fresh lock made in between puts it back and stands
down. The release deletes the file only while it still holds this taker's content, so a
lock taken over cannot be wiped by its old holder. `processAlive(pid)`: a pid that cannot
be read counts as running, and the age rule decides.

Named locks today: `flush` (the drain, and `prune`), and one per session (§2).

## 6. Pruning

Files whose modification time is older than the window (30 days by default) are removed,
and every sink's cursor keys into them go first, under the `flush` lock. The `.seq` file
stays (§2). While a drain holds the lock nothing is pruned. A prune never throws.

## 7. Vectors

[`conformance/outbox/read.json`](../conformance/outbox/read.json) holds byte-level
read cases (a partial trailing line, a blank line, a corrupt line, multibyte characters, a
read from past the end) with the events and offsets a reader MUST return. The reference
client runs them in `packages/core/test/outbox-vectors.test.ts`; a second implementation
runs the same file.
