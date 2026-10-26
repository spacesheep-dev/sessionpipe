# Get started

> **Pre-release.** The packages publish to npm at v0.1.0; until then, the commands below describe the client as specified and built in the repository. Follow the [roadmap](https://github.com/spacesheep-dev/sessionpipe/blob/main/ROADMAP.md).

## To a receiver, in one command

```sh
npx sessionpipe connect your-receiver.example
```

Run it on each machine your agents run on: a laptop, a lab workstation over ssh, a cloud box. It shows six digits; open the receiver's pairing page on any device where you're signed in, type them and approve with that device's passkey. That approval hands the machine both its control token and its sessions key, so there is nothing to copy. Then, without asking:

- **Hooks** for every harness here, and every Claude Code account (`~/.claude`, `~/.claude-*`). Hooks run `~/.local/share/sessionpipe/sessionpipe-hook`, which outlives a Node upgrade or `nvm uninstall`.
- **A sink at tier 2** (prompts and answers, secrets removed; `--tier` to change it), capped at the receiver's `max_tier`.
- **Signed messages**: the control daemon, in safe mode unless `--mode auto`, for the folder you ran it in, or the folders your recent sessions ran in when you ran it from your home folder (never the home folder itself).
- **Keys** in the macOS Keychain, or the Secret Service keyring in a Linux desktop session; otherwise a `0600` file, which is what a headless server has. `sessionpipe secrets` shows where each one is.
- **The daemon keeps running after you log out** (systemd linger on Linux; a background launchd agent on a Mac nobody is logged in to).
- Each Claude Code account it finds, and whether it's **signed in** as this machine sees it: a message you send starts a headless run with that login.

Run it again any time; it only fixes what's missing. `sessionpipe doctor` checks all of the above.

## In the Claude desktop app

The desktop app runs the same hooks, so its sessions report like any other. To message one from another device, say this in that session:

```text
Run `sessionpipe wait` as a background command, with the longest timeout you can.
```

Your messages then arrive in that session, in the app, and its answers go back to you by themselves. A message sent while the session is mid-turn lands when the turn ends. This needs no `claude` command and no separate sign-in.

The `claude` command only matters when the daemon has to start Claude Code outside the app: a new session you start from the receiver, or a message to an app session that is neither running `sessionpipe wait` nor mid-turn (it runs headless, outside the app). That command has its own login, which the app doesn't share: `claude auth login` once if you want those too.

## 1. Install the hooks

```sh
npx sessionpipe install
```

Detects the harnesses on your machine (Claude Code, Codex, Gemini CLI, Antigravity, and more as adapters land), writes their hooks, installs itself globally if run through npx (a hook cannot start from an npx cache), and backfills the last 30 days of sessions into a local outbox. Nothing leaves the machine yet.

## 2. Watch, with no server

```sh
sessionpipe tail --tier 1
```

One event per line from the local outbox, filtered to a tier. This is exactly what a tier-1 sink would receive.

## 3. Add a sink

```sh
sessionpipe sink add https://your-receiver.example --tier 1 --token <t>
sessionpipe status
```

`sink add` reads the receiver's `/.well-known/sessionpipe`, caps the tier at its `max_tier`, stores the token with mode 0600 and sends one heartbeat as a test. `status` shows the last 2xx per sink, queue depth and hook timing.

## The reference receiver

```sh
npx sessionpipe-receiver --port 7357 --token <t> --max-tier 3
```

or in Docker: `docker run -p 7357:7357 -v sessionpipe:/data ghcr.io/spacesheep-dev/sessionpipe-receiver`. Open `http://localhost:7357/` for the page: sessions grouped needs-you / working / recent, live.

<h2 id="sessionpipe-gui">sessionpipe-gui</h2>

A separate open-source project ([repository](https://github.com/spacesheep-dev/sessionpipe-gui)): every session on your machines, live, on one board, with search across your agents' history. The desktop apps for macOS and Linux are on the [home page](/#gui) and in [every release](https://github.com/spacesheep-dev/sessionpipe-gui/releases); they update themselves. On any system with Node 20 or later, Windows included:

```sh
npm i -g {{gui:tgz}}
sessionpipe-gui
```

It serves the board on `localhost:7373`, with a QR code for your phone. The desktop app needs Node 20 or later too; on first run it starts the GUI's receiver on this machine. The app shows everything; sending from it comes later. For now you answer a prompt or send the next message from a browser, a phone's included, signed with your passkey.

## Send to spacesheep

On Pro or Team, one command and one approval at spacesheep.dev/pair:

```sh
npx -y sessionpipe@latest connect spacesheep.dev --mode auto
```

To report sessions only (any plan), make a **sessions-only** key at [spacesheep.dev/settings/api-keys](https://spacesheep.dev/settings/api-keys) (pick *Sessions only* beside the name), then:

```sh
npx -y sessionpipe install --sink https://spacesheep.dev --tier 2 --token <sessions-only ss_ key>
```

A sessions-only key can report sessions and turns and nothing else: no MCP, no deploys, no reads. It is the safe kind to leave in a sink config on every machine. A full `ss_` key still works here, but if it leaks from that file it opens the whole account.

## Send to a Slack webhook

`examples/slack-webhook/` in the repository is a Cloudflare Worker that receives tier-0 events and posts `attention.needed` to a channel: "needs you: Bash on misha-air".

## Uninstall

```sh
sessionpipe uninstall
```

Removes only the entries it wrote; every config file is byte-identical otherwise.
