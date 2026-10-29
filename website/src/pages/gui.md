# sessionpipe-gui

The control room for the agents you already run. Every coding-agent session on your machines on one live board, and every one you ever ran a keystroke away. Answer, steer and start them from your laptop or your phone. No account, no cloud, no telemetry.

A separate open-source project ([repository](https://github.com/spacesheep-dev/sessionpipe-gui)) that speaks the sessionpipe protocol: plain files on your disk, no database, no account, no service of ours in between. Release {{gui:version}}.

## What it does

- **One live board.** Every session, grouped in the order you would look: needs you, working, stale, idle, done.
- **Answer in place.** A session reads as a chat: allow or deny the open prompt, send the next message, attach images, stop a turn.
- **One inbox.** Every open permission, question and error from every machine, newest first.
- **Search all of it.** ⌘K across every session and this machine's own agent history, sessions from before sessionpipe included, with the network down.
- **Start a session anywhere.** Pick the machine, the agent and the folder; that machine's own sessionpipe starts it. The GUI runs nothing.
- **Signed by you.** Every command is signed by your passkey and checked on the machine that runs the agent.

## Desktop apps

The same UI in a Tauri 2 app on the system's own web view. It connects to the receiver on this machine, and on first run it can start one for you as a service (that needs Node 20 or newer). A menu bar item and a Dock badge count what needs you; on a Mac it also sends, signed with a key in the Secure Enclave and Touch ID. It updates itself.

| Platform | Download |
|---|---|
| macOS 13 or newer, Apple silicon and Intel | [.dmg]({{gui:dmg}}), signed and notarized |
| Linux, x86-64 | [.deb]({{gui:deb}}) · [AppImage]({{gui:appimage}}) |
| Anything with Node 20, Windows included | npm, below |

## On your phone

The same app at phone size, served by your computer. Scan the QR code sessionpipe-gui prints and the board is there. Sending needs https and a passkey: the same Wi-Fi with the GUI's own certificate (`--tls`), or Tailscale from anywhere. Add it to your home screen and it opens like an app. A native iPhone build runs in the simulator; it isn't released yet.

## Install with npm

```sh
npx github:spacesheep-dev/sessionpipe-gui      # try it straight from GitHub
npm i -g {{gui:tgz}}                           # keep it on your PATH
```

Then `npx sessionpipe install` on each machine whose sessions you want on the board. It runs on port 7373. `sessionpipe-gui --demo` fills the board with a synthetic team.
