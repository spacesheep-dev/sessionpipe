# Security policy

## Reporting a vulnerability

Please report privately, never in a public issue:

- **GitHub private vulnerability reporting**: [open a draft advisory](https://github.com/spacesheep-dev/sessionpipe/security/advisories/new)
- or email **security@sessionpipe.org**

Until that address is live, the GitHub form reaches the maintainer directly.

We acknowledge within **5 working days**, keep you informed, and coordinate
disclosure within **90 days** of the report (sooner when a fix is ready; longer only
by agreement with the reporter). Credit is given in the advisory unless you prefer
otherwise.

## Supported versions

| Version | Supported |
|---------|-----------|
| latest minor (0.x while pre-1.0) | yes |
| older | no; upgrade |

## Threat model, in three lines

1. **Receivers are trusted by the person who added them.** A sink receives exactly
   what its tier allows and nothing more; the client cannot be made to send more than
   the configured tier by anything a receiver says.
2. **Transcripts are untrusted content.** Anything read from a harness's files or
   stdin is data: never executed, never interpolated into a shell, and redacted before
   it reaches the outbox.
3. **The hook path must never be able to block or alter the harness, except to
   deliver a signed control message.** The hook exits 0 in milliseconds, writes only
   what the harness requires to stdout (`{}` where a harness reads it), and does all
   work in a detached process. The one exception is a control message
   (`spec/CONTROL.md`) that the machine itself verified — signed by a key enrolled at
   its own terminal: then a Stop hook may answer a block with the message, and a
   PermissionRequest hook may wait for the person's signed answer, both only through
   the harness's documented hook answers. Nothing is ever auto-allowed, no signal is
   ever sent to a process, and nothing a receiver says on its own can reach a hook.

## FAQ

**What if a sink token leaks?** Its holder can post events to that receiver as you;
the client never gives a sink token anything else. It cannot make your machine do
anything: a control command runs only with a signature from a key enrolled at the
machine's own terminal, and the machine polls with its own token, minted at pairing. What else the token opens is the
receiver's choice, so use a receiver's scoped, sessions-only token when it offers one
(see *Sink tokens, for receivers* below) — spacesheep's is *Sessions only* in Settings →
API keys. Revoke it at the receiver and `sessionpipe sink remove` it.

**What does a device key promise?** A desktop or phone app can't run WebAuthn in its
own window, so it signs with a **device key** instead (`spec/CONTROL.md` §2): a P-256
key the app makes in a hardware key store (the Secure Enclave on a Mac or an iPhone)
that won't sign without Touch ID, Face ID or the device passcode, every time. Its
`store: "hardware"` and `uv: "each-use"` are the app's word, declared when the key is
made and approved by you at the terminal's digits or from a device the machine already
trusts. A machine can't prove them, just as it can't prove the flags of a passkey made
without attestation. What it does check: the key names itself by its SPKI's hash, its
fields and values are exactly the spec's (so a weaker kind added later is refused by
every machine that predates it), and each signature binds its purpose and the rp id,
so one made for one use or one receiver counts for no other. A machine that predates
device keys stores one as a passkey and refuses every signature from it. Remove a lost
device's key with `sessionpipe control keys remove <id>`.

**Sink tokens, for receivers.** A sink's token sits in a config file on every machine
that reports, next to the hooks: the most-copied, least-guarded place a credential
lives. A receiver that has accounts, APIs or data of its own should issue scoped
tokens that open only its sessionpipe endpoints and nothing else of the account, so a
leaked one lets its holder post session events and read nothing. Keep accepting your
broader credentials there if people already use them, so nothing configured breaks,
and say which kind to use. Refuse a scoped token anywhere else with 401 or 403. The
client shows a four-character prefix at most.

**Where the machine keeps its keys.** A sink's token and Webhooks secret and each
receiver's machine token go into the operating system's keychain when `connect` (or
`sessionpipe secrets move`) finds one this session can write and read back: the macOS
Keychain, or the Secret Service (GNOME Keyring, KWallet) in a Linux desktop session.
The config then says `token_in` and holds no token. Otherwise they stay in
`config.json` / `control.json` at mode `0600`, as on a headless server. A keychain keeps
them out of dotfiles repos, backups and synced folders; it does not stop a program
running as you (`security` returns an item it stored without asking, which is how the
hook's worker reads it). A keychain that is locked where a hook runs (an ssh session to
a Mac) leaves events in the outbox, never sent unsigned; the control daemon, which runs
in your own session, sends them within a minute.

**Cryptography / export control.** sessionpipe uses TLS (via Node's `fetch`),
HMAC-SHA256 for Standard-Webhooks signatures, and ECDSA P-256 / RSA PKCS#1 v1.5
signature *verification* (WebCrypto) for control commands. It contains no encryption
of its own and needs no export notice.

**Does sessionpipe phone home?** No. There is no telemetry. Where the control daemon
runs, it reads `https://registry.npmjs.org/sessionpipe/latest` about a minute after it
starts and then at most once a day: a plain GET that carries nothing about you, the
machine or its sessions. When that names a newer release, the daemon waits until it is
idle and installs it with `npm install --global --ignore-scripts` into the prefix it runs
from (npm then talks to the registry as npm always does), and restarts onto it. An
automatic update trusts the registry and the package's publisher exactly as your first
install did, a day later at most; to pin a version, turn it off with
`sessionpipe update off` (`"update_check": false` in `config.json`) or
`SESSIONPIPE_NO_UPDATE_CHECK=1` in the daemon's environment. A copy that isn't a global
npm install (npx, a checkout, a dev build) never updates itself, and `sessionpipe
update` by hand works either way.
