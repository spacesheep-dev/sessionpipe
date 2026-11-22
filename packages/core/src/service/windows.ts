// SPDX-License-Identifier: Apache-2.0
/** The Windows half of sessionpipe-core/service: a scheduled task at this user's logon,
 *  `\sessionpipe\<label>` in Task Scheduler, and the launcher file it runs. No admin is
 *  needed: plain `schtasks /Create /SC ONLOGON` is refused to a user who isn't one, and
 *  `/Create /XML` with a logon trigger that names this user is not.
 *
 *  node.exe is a console program, so a task that runs it opens a terminal window at every
 *  logon (measured on Windows 11: a Windows Terminal window titled node.exe). The task
 *  runs it under `conhost.exe --headless`, which gives it a console and no window.
 *
 *  Task Scheduler gives an action no environment of its own, keeps none of its output and
 *  starts it again on no exit code. The launcher does those three: a small script the
 *  task's node runs, which starts the service with the environment it was given, appends
 *  its output to the log file, starts it again at once when it exits UPDATE_EXIT (75) and
 *  after 5 s when it fails, and ends with it when it exits 0. What it runs is one line of
 *  JSON in the file, so nothing in a path, an argument or a variable is ever read by
 *  cmd.exe: only the two paths on the task's own command line pass through conhost. */
import path from "node:path";

/** The task's name: its folder in Task Scheduler, and the label. */
export const taskName = (label: string): string => `\\sessionpipe\\${label}`;

/** Task Scheduler's TASK_STATE_RUNNING: a number, the same in every language. */
export const TASK_RUNNING = 4;

/** A program Windows ships, by its full path: `%SystemRoot%\System32\<parts>`. Node looks
 *  for a bare name in the working directory before PATH, so a `schtasks.exe` in the folder
 *  a command is typed in would be the one started. %SystemRoot% (else %windir%) counts
 *  only when it is a full path on a drive; anything else is read as C:\Windows. */
export function system32(env: NodeJS.ProcessEnv, ...parts: string[]): string {
  // Windows reads a variable's name whatever its case, and so does process.env there; a
  // copy of it, or Git Bash's SYSTEMROOT, is a plain object and does not.
  const named = (name: string) =>
    Object.entries(env).find(([k, v]) => v !== undefined && k.toLowerCase() === name.toLowerCase())?.[1];
  const root = [named("SystemRoot"), named("windir")].find((v) => v !== undefined && /^[A-Za-z]:[\\/]/.test(v));
  return path.win32.join(root ?? "C:\\Windows", "System32", ...parts);
}

/** What the launcher runs, as it is written into the launcher file. */
export interface Launched {
  label: string;
  /** The node that runs the launcher: a launcher run by that node is this service's. */
  node: string;
  argv: string[];
  env: Record<string, string>;
  log: string;
}

/** The launcher file's text. The service is one line of JSON, so it is read back as it
 *  was written (`launched`), whatever is in a path or a variable. */
export function launcherText(s: Launched & { description: string }): string {
  const { description, ...service } = s;
  return `// ${description.replace(/\s+/g, " ")}
// Written by sessionpipe; Task Scheduler runs it at logon as ${taskName(s.label)}, with no
// window. It runs the service below, appends its output to the log, starts it again at
// once when it exits 75 (an update) and after 5 s when it fails, and ends when it exits 0.
const service = ${JSON.stringify(service)};
const { spawn } = require("node:child_process");
const { closeSync, openSync } = require("node:fs");
const start = () => {
  let log = "ignore";
  try {
    log = openSync(service.log, "a");
  } catch {}
  const child = spawn(service.argv[0], service.argv.slice(1), {
    env: { ...process.env, ...service.env, SESSIONPIPE_SERVICE: "schtasks:" + process.pid },
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  let done = false;
  const ended = (code) => {
    if (done) return;
    done = true;
    if (log !== "ignore") closeSync(log);
    if (code === 0) process.exit(0);
    setTimeout(start, code === 75 ? 0 : 5000);
  };
  child.once("exit", ended);
  child.once("error", () => ended(1));
};
start();
`;
}

/** The service a launcher file runs; null when the text isn't one. */
export function launched(text: string): Launched | null {
  const line = /^const service = (\{.*\});$/m.exec(text)?.[1];
  if (line === undefined) return null;
  try {
    const s = JSON.parse(line) as Partial<Launched>;
    const words = (a: unknown): a is string[] => Array.isArray(a) && a.every((w) => typeof w === "string");
    if (typeof s.label !== "string" || typeof s.node !== "string" || typeof s.log !== "string" || !words(s.argv))
      return null;
    const env = Object.fromEntries(
      Object.entries(s.env ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    return { label: s.label, node: s.node, argv: s.argv, env, log: s.log };
  } catch {
    return null;
  }
}

/** A path the task's command line can't carry as it is: a quote (conhost escapes it as
 *  \", which the program it starts doesn't read as one), a % (Task Scheduler puts a
 *  variable's value where a line says %NAME%), a line end, or nothing at all. */
export function unsafeWord(words: string[]): string | undefined {
  return words.find((w) => w === "" || /["%\r\n]/.test(w));
}

const word = (s: string): string => (/\s/.test(s) ? `"${s}"` : s);
const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `--headless <node> <launcher>`: what conhost runs, with no window. */
export const taskArguments = (node: string, launcher: string): string => `--headless ${word(node)} ${word(launcher)}`;

/** The task definition `schtasks /Create /XML` takes. */
export function taskXml(s: { description: string; user: string; node: string; launcher: string }): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(s.description.replace(/\s+/g, " "))}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(s.user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(s.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>${xml(taskArguments(s.node, s.launcher))}</Arguments>
      <WorkingDirectory>${xml(path.dirname(s.launcher))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** The bytes of a task definition: `schtasks /Create /XML` reads UTF-16 with a
 *  byte-order mark, and lines that end as Windows ends them. */
export const taskXmlBytes = (text: string): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\n/g, "\r\n"), "utf16le")]);

// Task Scheduler and the process list are read through PowerShell, not `schtasks /Query`
// and `tasklist`: those answer in the console's code page (a folder with a letter outside
// it comes back with "?" in it) and in the system's language (the status column says
// "Running" only in English). The script prints a number at most; text goes to a file as
// UTF-8 (`Out-File`), so no code page touches it. Cmdlets only, no .NET method calls:
// those are refused where PowerShell is held to its constrained language mode.

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** `powershell -Command <this>` writes every process's id, parent, name and command line
 *  to `file` as JSON, and prints the task's state as a number, or "none" when no task has
 *  the label. The folder is listed and the name compared, so a `*` or `[` in a label is
 *  no pattern; only "no such folder" counts as no task, any other error fails the script. */
export function lookScript(label: string, file: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    `try{$t=Get-ScheduledTask -TaskPath '\\sessionpipe\\'|Where-Object{$_.TaskName -eq ${psQuote(label)}}}catch{if($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*'){throw};$t=$null}`,
    `Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,Name,CommandLine|ConvertTo-Json -Compress|Out-File -Encoding utf8 -LiteralPath ${psQuote(file)}`,
    "if($t){[int]$t.State}else{'none'}",
  ].join(";");
}

/** `powershell -Command <this>` takes the \sessionpipe\ folder out of Task Scheduler when
 *  no task is left in it (another label's can be). schtasks can't delete a folder and no
 *  cmdlet does, so this goes through the Schedule.Service COM object: method calls, which
 *  constrained language mode refuses. Best-effort for that reason: where it fails, the
 *  empty folder stays. DeleteFolder refuses a folder that isn't empty too; the folder is
 *  listed first so that isn't the only thing between this and another label's task. */
export function folderRemoveScript(): string {
  return [
    "$ErrorActionPreference='Stop'",
    "try{$t=Get-ScheduledTask -TaskPath '\\sessionpipe\\'}catch{if($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*'){throw};$t=$null}",
    "if($t){exit 0}",
    "$s=New-Object -ComObject Schedule.Service",
    "$s.Connect()",
    "$s.GetFolder('\\').DeleteFolder('sessionpipe',0)",
  ].join(";");
}

/** One process, as `lookScript` wrote it. */
export interface Proc {
  pid: number;
  ppid: number;
  name: string;
  line: string;
}

/** The processes `lookScript` wrote: an array, or one object where there was one. */
export function parseProcs(text: string): Proc[] {
  const raw = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  return (Array.isArray(raw) ? raw : [raw]).flatMap((p: Record<string, unknown> | null) =>
    typeof p?.ProcessId === "number"
      ? [
          {
            pid: p.ProcessId,
            ppid: Number(p.ParentProcessId),
            name: String(p.Name ?? ""),
            // Null for a process of another account's: its command line isn't shown.
            line: String(p.CommandLine ?? ""),
          },
        ]
      : [],
  );
}

const words = (line: string): string[] => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2]) as string);
/** Two paths Windows reads as one: whatever the case, with either slash. */
const samePath = (a: string, b: string): boolean =>
  a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/** The processes a task of ours started, among all of them: the headless conhost whose
 *  command line ends with the launcher, and the launcher itself (its node, run on that
 *  file: still there after `schtasks /End`, which ends conhost alone). `daemon` is the
 *  process the launcher runs now. Windows reuses process ids, so a process is told by its
 *  command line and never by an id written down earlier; an editor with the launcher
 *  open is neither of the two. */
export function taskProcs(
  all: Proc[],
  launcher: string,
  node: string | null,
): { roots: number[]; daemon: number | null } {
  const ends = (p: Proc) => {
    const w = words(p.line);
    return w.length > 1 && samePath(w[w.length - 1] as string, launcher) ? w : null;
  };
  const conhosts = all.filter((p) => /^conhost(\.exe)?$/i.test(p.name) && ends(p)?.[1] === "--headless");
  const launchers = all.filter((p) => {
    const w = ends(p);
    return !!w && w.length === 2 && node !== null && samePath(w[0] as string, node);
  });
  const mine = new Set(launchers.map((p) => p.pid));
  const daemon = all.find((p) => mine.has(p.ppid) && !mine.has(p.pid));
  return { roots: [...conhosts, ...launchers].map((p) => p.pid), daemon: daemon?.pid ?? null };
}
