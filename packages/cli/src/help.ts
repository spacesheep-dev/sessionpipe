// SPDX-License-Identifier: Apache-2.0
// Usage is data: asking for it must never enter a command's implementation. The site's
// docs page reads the same table, so a command's usage is written in one place.
export function usageTable(harnesses: readonly string[]): Record<string, string> {
  return {
    connect:
      "connect <receiver> [--machine NAME] [--rename-machine] [--allow-downgrade] [--tier 0-3] [--mode safe|auto|inherit] [--folder DIR]… [--no-service]",
    install: `install [${harnesses.map((h) => `--${h}`).join(" ")}] [--machine NAME] [--rename-machine] [--allow-downgrade] [--backfill DAYS] [--sink URL --tier N]`,
    sink: "sink add|list|remove|test (use --help after a subcommand for its options)",
    "sink add": "sink add <url|file:PATH|stdout> [--tier 0-3] [--token T] [--secret S] [--pii] [--name N]",
    "sink list": "sink list",
    "sink remove": "sink remove <name>",
    "sink test": "sink test <name>",
    secrets: "secrets [move keychain|secret-service|file]",
    "secrets move": "secrets move keychain|secret-service|file",
    status: "status [--json]",
    doctor: "doctor [--json]",
    tail: "tail [--session ID] [--tier 0-3] [--harness NAME] [--all] [--json]",
    backfill: `backfill [--days 30] [${harnesses.map((h) => `--${h}`).join(" ")}]`,
    forget: "forget <harness> <session>",
    replay: "replay [--sink NAME] [--from-start]",
    update: "update [off|on] (install the latest now; off/on: the daemon's daily update)",
    "update off": "update off",
    "update on": "update on",
    control: "control pair|mode|status|keys|off|run (use --help after a subcommand for its options)",
    "control pair":
      "control pair <receiver> [--folder DIR]… [--mode safe|auto|inherit] [--tier 0-3] [--token T] [--name N] [--no-service]",
    "control mode": "control mode auto|safe|inherit",
    "control status": "control status",
    "control keys": "control keys [remove <id>]",
    "control keys remove": "control keys remove <id>",
    "control off": "control off [<receiver>]",
    "control run": "control run",
    wait: "wait [--session <harness>:<id>]",
    worker: "worker <job-file> (internal: process one queued job)",
    hook: "hook (internal: harnesses run dist/hook.js directly)",
    version: "version (print the installed version)",
    "--version": "--version (print the installed version)",
    "-v": "-v (print the installed version)",
  };
}

export function commandHelp(args: string[], harnesses: readonly string[]): string | undefined {
  const usage = usageTable(harnesses);
  for (let n = Math.min(args.length, 3); n > 0; n--) {
    const line = usage[args.slice(0, n).join(" ")];
    if (line) return `Usage: sessionpipe ${line}\n\n  -h, --help  Show help without running the command.`;
  }
  return undefined;
}
