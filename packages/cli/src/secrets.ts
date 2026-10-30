// SPDX-License-Identifier: Apache-2.0
// Where this machine's secrets live: each sink's token (and Webhooks secret) and each
// paired receiver's machine token. In the operating system's keychain when this person
// has one unlocked — the macOS Keychain, or the Secret Service (GNOME Keyring, KWallet)
// in a Linux desktop session — and otherwise in config.json / control.json at mode
// 0600, which is all a headless server has (the same as ~/.ssh). A secret in a store
// leaves `token_in` in the file and no token.
//
// What a store protects against, plainly: a dotfiles repo, a backup, a synced
// ~/.config, a `cat` over a shoulder. Not a program running as you: `security` hands an
// item it wrote back without asking, which is also how the hook's worker reads it.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { configFile, readConfig, type SinkConfig, writeConfig } from "@sessionpipe/core";

export type SecretStore = "keychain" | "secret-service";
export type StoreName = SecretStore | "file";

const SERVICE = "sessionpipe";

export type Runner = (cmd: string, args: string[], input?: string) => { status: number | null; stdout: string };
export const defaultRunner: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, {
    input: input ?? "",
    encoding: "utf8",
    timeout: 8000,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
};

/** A sink's item. The machine has one config, so a sink's name is enough — except
 *  where SESSIONPIPE_CONFIG points at another (a second profile, a test): then the
 *  item names that config too, so two configs' sinks of one name never share a key. */
export const sinkAccount = (name: string, what: "token" | "secret" = "token"): string => {
  const scope = process.env.SESSIONPIPE_CONFIG
    ? `@${createHash("sha256").update(configFile()).digest("hex").slice(0, 8)}`
    : "";
  return `sink:${name}:${what}${scope}`;
};
export const controlAccount = (machine: string): string => `control:${machine}`;

/** `security -i` reads its commands from stdin, so the value never sits in argv (and in
 *  `ps`). Its parser takes double-quoted words: a value with a quote, a backslash or a
 *  space isn't stored there and stays in the file. */
const KC_SAFE = /^[\x21\x23-\x5b\x5d-\x7e]{1,4096}$/;
const NAME_SAFE = /^[\x20\x21\x23-\x5b\x5d-\x7e]{1,200}$/;

export function secretGet(store: SecretStore, account: string, run: Runner = defaultRunner): string | null {
  const r =
    store === "keychain"
      ? run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
      : run("secret-tool", ["lookup", "service", SERVICE, "account", account]);
  if (r.status !== 0) return null;
  const v = r.stdout.replace(/\r?\n$/, "");
  return v || null;
}

export function secretSet(store: SecretStore, account: string, value: string, run: Runner = defaultRunner): boolean {
  if (store === "keychain") {
    if (!KC_SAFE.test(value) || !NAME_SAFE.test(account)) return false;
    run(
      "security",
      ["-i"],
      `add-generic-password -U -s ${SERVICE} -a "${account}" -l "${SERVICE} ${account}" -w "${value}"\n`,
    );
  } else {
    run("secret-tool", ["store", "--label", `${SERVICE} ${account}`, "service", SERVICE, "account", account], value);
  }
  // Trust only a read-back: `security -i` exits 0 whatever its commands did.
  return secretGet(store, account, run) === value;
}

export function secretDel(store: SecretStore, account: string, run: Runner = defaultRunner): void {
  if (store === "keychain") run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
  else run("secret-tool", ["clear", "service", SERVICE, "account", account]);
}

/** Can this process write, read back and delete an item in the store right now? */
export function probe(store: SecretStore, run: Runner = defaultRunner): boolean {
  const account = `probe:${randomBytes(6).toString("hex")}`;
  const ok = secretSet(store, account, randomBytes(12).toString("base64url"), run);
  secretDel(store, account, run);
  return ok;
}

/** The best place for secrets on this machine, from this session. SESSIONPIPE_SECRETS
 *  (file | keychain | secret-service) overrides. The Secret Service is used only in a
 *  desktop session: on a server its keyring is locked whenever nobody is logged in,
 *  which is exactly when the daemon needs its token. */
export function bestStore(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  run: Runner = defaultRunner,
): StoreName {
  const want = env.SESSIONPIPE_SECRETS;
  if (want === "file") return "file";
  const candidates: SecretStore[] =
    want === "keychain" || want === "secret-service"
      ? [want]
      : platform === "darwin"
        ? ["keychain"]
        : platform === "linux" && env.DBUS_SESSION_BUS_ADDRESS && (env.DISPLAY || env.WAYLAND_DISPLAY)
          ? ["secret-service"]
          : [];
  for (const s of candidates) if (probe(s, run)) return s;
  return "file";
}

export const storeLabel = (s: StoreName | undefined, platform: NodeJS.Platform = process.platform): string =>
  s === "keychain"
    ? "the macOS Keychain"
    : s === "secret-service"
      ? "the Secret Service keyring"
      : platform === "win32"
        ? "a file under your profile"
        : "a 0600 file";

/** What keeps a key in the config file private: a mode on POSIX; on Windows, where modes
 *  mean nothing, the profile folder's own permissions. */
export const fileKept = (platform: NodeJS.Platform = process.platform): string =>
  platform === "win32" ? "your profile's permissions" : "0600";

/** `connect`'s line for keys that stay in the file. */
export function keysFileNote(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") return "under your profile's permissions (Windows has no keychain sessionpipe uses)";
  return `at 0600 — no unlocked keychain in this session${env.SSH_CONNECTION ? " (an ssh shell)" : ""}`;
}

/** The sink with its token and secret filled in from its store. Null when they live in
 *  a store this process can't read right now (a keychain locked in an ssh session):
 *  the caller leaves the events in the outbox rather than sending them unsigned. */
export function sinkWithSecrets(s: SinkConfig, run: Runner = defaultRunner): SinkConfig | null {
  if (!s.token_in) return s;
  const token = secretGet(s.token_in, sinkAccount(s.name), run);
  if (!token) return null;
  const secret = secretGet(s.token_in, sinkAccount(s.name, "secret"), run);
  return { ...s, token, ...(secret ? { secret } : {}) };
}

/** Store a sink's secrets in `to` (or back in the file) and save the config. */
export function moveSinkSecrets(
  to: StoreName,
  o: { run?: Runner; file?: string } = {},
): { moved: string[]; kept: string[] } {
  const run = o.run ?? defaultRunner;
  const cfg = o.file ? readConfig(o.file) : readConfig();
  const moved: string[] = [];
  const kept: string[] = [];
  for (const s of cfg.sinks) {
    const from = s.token_in;
    if ((from ?? "file") === to) continue;
    const full = sinkWithSecrets(s, run);
    if (!full) {
      kept.push(s.name);
      continue;
    }
    if (!full.token && !full.secret) continue;
    if (to === "file") {
      // From a store, so with a token (sinkWithSecrets is null without one); a sink
      // already in the file never gets here.
      /* v8 ignore else */
      if (full.token) s.token = full.token;
      if (full.secret) s.secret = full.secret;
      delete s.token_in;
    } else {
      const ok =
        (!full.token || secretSet(to, sinkAccount(s.name), full.token, run)) &&
        (!full.secret || secretSet(to, sinkAccount(s.name, "secret"), full.secret, run));
      if (!ok) {
        secretDel(to, sinkAccount(s.name), run);
        secretDel(to, sinkAccount(s.name, "secret"), run);
        kept.push(s.name);
        continue;
      }
      delete s.token;
      delete s.secret;
      s.token_in = to;
    }
    moved.push(s.name);
    if (from) {
      // Written first, then the file says where; only then is the old copy dropped.
      if (o.file) writeConfig(cfg, o.file);
      else writeConfig(cfg);
      secretDel(from, sinkAccount(s.name), run);
      secretDel(from, sinkAccount(s.name, "secret"), run);
    }
  }
  if (o.file) writeConfig(cfg, o.file);
  else writeConfig(cfg);
  return { moved, kept };
}

/** Forget a sink's secrets wherever they are (sink remove, uninstall). */
export function dropSinkSecrets(s: SinkConfig, run: Runner = defaultRunner): void {
  if (!s.token_in) return;
  secretDel(s.token_in, sinkAccount(s.name), run);
  secretDel(s.token_in, sinkAccount(s.name, "secret"), run);
}
