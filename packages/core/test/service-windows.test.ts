// SPDX-License-Identifier: Apache-2.0
// sessionpipe-core/service on Windows: the scheduled task and its launcher, as text (the
// snapshots below are the whole file), and installing, looking at and removing them with a
// stand-in for schtasks, taskkill and PowerShell, in a temp home. Nothing here runs Task
// Scheduler. The launcher is a Node script, so it is run for real, on whatever this is.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installService,
  serviceArgv,
  serviceEnvironment,
  serviceFiles,
  serviceState,
  taskName,
  uninstallService,
} from "../src/service/index.js";
import {
  folderRemoveScript,
  launched,
  launcherText,
  lookScript,
  parseProcs,
  system32,
  taskArguments,
  taskProcs,
  taskXml,
  taskXmlBytes,
  unsafeWord,
} from "../src/service/windows.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-task-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const SPEC = {
  label: "org.sessionpipe.gui",
  unit: "sessionpipe-gui.service",
  description: "sessionpipe board",
  argv: [NODE, "C:\\gui\\server.js", "--port", "7373"],
  env: { NODE_ENV: "production", SP_NOTE: 'a "quoted" 100% & more' },
  logPath: "C:\\logs\\a&b.log",
  node: NODE,
};
const NAMES = { label: SPEC.label, unit: SPEC.unit };
const SYS = "C:\\Windows\\System32";
const launcher = () => path.join(home, "AppData", "Local", "sessionpipe", "service", "org.sessionpipe.gui.cjs");

/** Task Scheduler and the process list, stood in: `state` is what the look prints, `procs`
 *  what it writes (a string: as it is, a file cut short); `refuse` names the schtasks verbs that fail. Remembers what was run,
 *  each program by its file name and each script by which one it is. */
function windows(o: { state?: number | string; procs?: unknown; refuse?: string[]; noPowerShell?: boolean } = {}) {
  const ran: string[] = [];
  const written: Record<string, Buffer> = {};
  const exec = (cmd: string, args: string[]): string => {
    const script = args.at(-1) as string;
    if (cmd === `${SYS}\\WindowsPowerShell\\v1.0\\powershell.exe`) {
      expect(args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
      const file = /-LiteralPath '([^']+)'/.exec(script)?.[1];
      ran.push(file ? "powershell <look>" : "powershell <folder>");
      if (o.noPowerShell) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      if (!file) return "";
      writeFileSync(file, `\uFEFF${typeof o.procs === "string" ? o.procs : JSON.stringify(o.procs ?? [])}\r\n`);
      return `${o.state ?? "none"}\r\n`;
    }
    expect(path.win32.dirname(cmd)).toBe(SYS);
    ran.push([path.win32.basename(cmd), ...args].join(" "));
    const xml = args[args.indexOf("/XML") + 1] as string;
    if (args.includes("/XML")) written[xml] = readFileSync(xml);
    if (o.refuse?.includes(args[0] as string)) throw new Error("ERROR: Access is denied.");
    return "";
  };
  return { ran, written, exec, shell: { USERDOMAIN: "DESK", USERNAME: "misha" } };
}

describe("the launcher", () => {
  it("is a script with the service on one line, and reads back as it was written", () => {
    const f = serviceFiles({ ...SPEC, home }).launcher;
    expect(f.path).toBe(launcher());
    expect(f.text).toBe(`// sessionpipe board
// Written by sessionpipe; Task Scheduler runs it at logon as \\sessionpipe\\org.sessionpipe.gui, with no
// window. It runs the service below, appends its output to the log, starts it again at
// once when it exits 75 (an update) and after 5 s when it fails, and ends when it exits 0.
const service = {"label":"org.sessionpipe.gui","node":"C:\\\\Program Files\\\\nodejs\\\\node.exe","argv":["C:\\\\Program Files\\\\nodejs\\\\node.exe","C:\\\\gui\\\\server.js","--port","7373"],"env":{"NODE_ENV":"production","SP_NOTE":"a \\"quoted\\" 100% & more"},"log":"C:\\\\logs\\\\a&b.log"};
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
`);
    expect(serviceArgv(f.text)).toEqual(SPEC.argv);
    expect(serviceEnvironment(f.text)).toEqual({ SESSIONPIPE_SERVICE: "schtasks", ...SPEC.env });
    expect(launched(f.text)).toEqual({
      label: SPEC.label,
      node: NODE,
      argv: SPEC.argv,
      env: SPEC.env,
      log: SPEC.logPath,
    });
    // The node that runs this, where none is named; no environment where none is given.
    const plain = serviceFiles({ ...NAMES, description: "two\nlines", argv: ["x"], logPath: "l", home }).launcher;
    expect(plain.text.startsWith("// two lines\n")).toBe(true);
    expect(launched(plain.text)).toMatchObject({ node: process.execPath, env: {} });
  });

  it("a text that isn't one reads as none", () => {
    const line = (service: unknown) => `const service = ${JSON.stringify(service)};\n`;
    const good = { label: "l", node: "n", argv: ["a"], log: "x" };
    expect(launched(line(good))).toEqual({ ...good, env: {} });
    // A variable that isn't text is left out; a person's own edit of the rest reads as none.
    expect(launched(line({ ...good, env: { A: "1", B: 2 } }))?.env).toEqual({ A: "1" });
    expect(launched("")).toBeNull();
    expect(launched("const service = {not json};\n")).toBeNull();
    expect(launched(line({ ...good, label: 1 }))).toBeNull();
    expect(launched(line({ ...good, node: null }))).toBeNull();
    expect(launched(line({ ...good, log: [] }))).toBeNull();
    expect(launched(line({ ...good, argv: "a" }))).toBeNull();
    expect(launched(line({ ...good, argv: ["a", 1] }))).toBeNull();
    expect(serviceArgv(line({ ...good, argv: "a" }))).toBeNull();
    expect(serviceEnvironment(line({ ...good, argv: "a" }))).toBeNull();
  });

  /** A stand-in service: writes who started it, then exits with the next code in `codes`. */
  const standIn = (dir: string) => {
    const script = path.join(dir, "service.js");
    writeFileSync(
      script,
      `const fs = require("node:fs");
const codes = fs.readFileSync(${JSON.stringify(path.join(dir, "codes"))}, "utf8").trim().split(" ");
fs.writeFileSync(${JSON.stringify(path.join(dir, "codes"))}, codes.slice(1).join(" "));
console.log(JSON.stringify({ via: process.env.SESSIONPIPE_SERVICE, ppid: process.ppid, note: process.env.SP_NOTE, home: process.env.SP_KEPT, argv: process.argv.slice(2) }));
console.error("exits " + codes[0]);
process.exit(Number(codes[0]));
`,
    );
    return script;
  };
  const run = (file: string, env: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number | null; pid: number }>((resolve) => {
      const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: "ignore" });
      child.on("exit", (code) => resolve({ code, pid: child.pid as number }));
    });

  it("runs the service with its environment, appends its output, and starts it again on 75 and on a failure", async () => {
    const script = standIn(home);
    writeFileSync(path.join(home, "codes"), "75 3 0");
    const log = path.join(home, "service.log");
    writeFileSync(log, "kept\n");
    const file = path.join(home, "launcher.cjs");
    writeFileSync(
      file,
      launcherText({
        description: "a test",
        label: "org.sessionpipe.test",
        node: process.execPath,
        argv: [process.execPath, script, "a b", "100%"],
        env: { SP_NOTE: 'a "quoted" 100% & more' },
        log,
      }).replace("5000", "50"),
    );
    const { code, pid } = await run(file, { SP_KEPT: "the task's own", SP_NOTE: "replaced" });
    expect(code).toBe(0);
    const lines = readFileSync(log, "utf8").trim().split(/\r?\n/);
    expect(lines[0]).toBe("kept");
    expect(lines.filter((l) => l.startsWith("exits"))).toEqual(["exits 75", "exits 3", "exits 0"]);
    const starts = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    expect(starts).toHaveLength(3);
    // The launcher names itself by its pid, which is the parent of what it runs.
    for (const s of starts)
      expect(s).toEqual({
        via: `schtasks:${pid}`,
        ppid: pid,
        note: 'a "quoted" 100% & more',
        home: "the task's own",
        argv: ["a b", "100%"],
      });
  }, 30_000);

  it("a log that can't be opened loses the output and nothing else; a program that can't be started is tried again", async () => {
    const script = standIn(home);
    writeFileSync(path.join(home, "codes"), "0");
    const text = (program: string) =>
      launcherText({
        description: "a test",
        label: "org.sessionpipe.test",
        node: process.execPath,
        argv: [program, script],
        env: {},
        log: path.join(home, "no-such-folder", "service.log"),
      }).replace("5000", "50");
    const file = path.join(home, "launcher.cjs");
    writeFileSync(file, text(process.execPath));
    expect((await run(file)).code).toBe(0);
    expect(readFileSync(path.join(home, "codes"), "utf8")).toBe("");
    expect(existsSync(path.join(home, "no-such-folder"))).toBe(false);
    // No such program: several rounds later it is still trying, and has not ended.
    writeFileSync(file, text(path.join(home, "no-such-program")));
    const child = spawn(process.execPath, [file], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 500));
    expect(child.exitCode).toBeNull();
    child.kill();
  }, 30_000);
});

describe("the task", () => {
  it("its name, and the definition schtasks takes, whole", () => {
    expect(taskName("org.sessionpipe.gui")).toBe("\\sessionpipe\\org.sessionpipe.gui");
    const file = "C:\\Users\\Misha K\\AppData\\Local\\sessionpipe\\service\\org.sessionpipe.gui.cjs";
    expect(taskArguments("C:\\node\\node.exe", "C:\\s\\l.cjs")).toBe("--headless C:\\node\\node.exe C:\\s\\l.cjs");
    const xml = taskXml({ description: 'a <board> & "more"\nhere', user: "DESK\\misha", node: NODE, launcher: file });
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>a &lt;board&gt; &amp; &quot;more&quot; here</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>DESK\\misha</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>DESK\\misha</UserId>
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
      <Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; &quot;C:\\Users\\Misha K\\AppData\\Local\\sessionpipe\\service\\org.sessionpipe.gui.cjs&quot;</Arguments>
      <WorkingDirectory>${path.dirname(file)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`);
    // UTF-16 with a byte-order mark, and Windows line ends.
    const bytes = taskXmlBytes("a\nb");
    expect([...bytes]).toEqual([0xff, 0xfe, 0x61, 0, 0x0d, 0, 0x0a, 0, 0x62, 0]);
  });

  it("a path the command line can't carry is named", () => {
    expect(unsafeWord(["C:\\node.exe", "C:\\a b\\l.cjs", "C:\\R&D\\x^y"])).toBeUndefined();
    expect(unsafeWord(["C:\\node.exe", 'C:\\a"b'])).toBe('C:\\a"b');
    expect(unsafeWord(["C:\\100%\\node.exe"])).toBe("C:\\100%\\node.exe");
    expect(unsafeWord(["a", "b\nc"])).toBe("b\nc");
    expect(unsafeWord(["a", ""])).toBe("");
  });

  it("Windows' own programs are named in full, under the system root the shell names", () => {
    expect(system32({}, "schtasks.exe")).toBe("C:\\Windows\\System32\\schtasks.exe");
    expect(system32({ SystemRoot: "D:\\WINNT" }, "a", "b.exe")).toBe("D:\\WINNT\\System32\\a\\b.exe");
    // Whatever the case of the name; a value that is no full path on a drive doesn't count.
    expect(system32({ SYSTEMROOT: "E:/Win" }, "x.exe")).toBe("E:\\Win\\System32\\x.exe");
    expect(system32({ SystemRoot: "Windows", windir: "F:\\W" }, "x.exe")).toBe("F:\\W\\System32\\x.exe");
    expect(system32({ SystemRoot: undefined, windir: "..\\W" }, "x.exe")).toBe("C:\\Windows\\System32\\x.exe");
  });

  it("the scripts PowerShell is given", () => {
    expect(lookScript("org.sessionpipe.o'k", "C:\\t\\it's.json")).toBe(
      "$ErrorActionPreference='Stop';" +
        "try{$t=Get-ScheduledTask -TaskPath '\\sessionpipe\\'|Where-Object{$_.TaskName -eq 'org.sessionpipe.o''k'}}catch{if($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*'){throw};$t=$null};" +
        "Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,Name,CommandLine|ConvertTo-Json -Compress|Out-File -Encoding utf8 -LiteralPath 'C:\\t\\it''s.json';" +
        "if($t){[int]$t.State}else{'none'}",
    );
    expect(folderRemoveScript()).toBe(
      "$ErrorActionPreference='Stop';" +
        "try{$t=Get-ScheduledTask -TaskPath '\\sessionpipe\\'}catch{if($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*'){throw};$t=$null};" +
        "if($t){exit 0};" +
        "$s=New-Object -ComObject Schedule.Service;$s.Connect();$s.GetFolder('\\').DeleteFolder('sessionpipe',0)",
    );
  });
});

const L = "C:\\Users\\Misha K\\AppData\\Local\\sessionpipe\\service\\org.sessionpipe.gui.cjs";
/** The processes of a task that is running, as PowerShell writes them. */
const RUNNING = [
  { ProcessId: 4, ParentProcessId: 0, Name: "System", CommandLine: null },
  {
    ProcessId: 900,
    ParentProcessId: 700,
    Name: "conhost.exe",
    CommandLine: `"conhost.exe" --headless "${NODE}" "${L}"`,
  },
  { ProcessId: 910, ParentProcessId: 900, Name: "node.exe", CommandLine: `"${NODE}" "${L}"` },
  { ProcessId: 920, ParentProcessId: 910, Name: "node.exe", CommandLine: `"${NODE}" C:\\gui\\server.js --port 7373` },
  { ProcessId: 930, ParentProcessId: 920, Name: "claude.exe", CommandLine: "claude -p" },
];

describe("the processes a task started", () => {
  it("are read as PowerShell wrote them: many, one, or none that counts", () => {
    expect(parseProcs(`\uFEFF${JSON.stringify(RUNNING)}`)).toEqual([
      { pid: 4, ppid: 0, name: "System", line: "" },
      { pid: 900, ppid: 700, name: "conhost.exe", line: `"conhost.exe" --headless "${NODE}" "${L}"` },
      { pid: 910, ppid: 900, name: "node.exe", line: `"${NODE}" "${L}"` },
      { pid: 920, ppid: 910, name: "node.exe", line: `"${NODE}" C:\\gui\\server.js --port 7373` },
      { pid: 930, ppid: 920, name: "claude.exe", line: "claude -p" },
    ]);
    // One process is one object, not a list; an entry with no id is left out.
    expect(parseProcs('{"ProcessId":7,"ParentProcessId":1}')).toEqual([{ pid: 7, ppid: 1, name: "", line: "" }]);
    expect(parseProcs('[null,{"Name":"x"},{"ProcessId":"7"}]')).toEqual([]);
    expect(() => parseProcs("")).toThrow();
  });

  it("the headless conhost and the launcher are the task's, and what the launcher runs is the daemon", () => {
    const all = parseProcs(JSON.stringify(RUNNING));
    expect(taskProcs(all, L, NODE)).toEqual({ roots: [900, 910], daemon: 920 });
    // Windows reads a path whatever its case, with either slash.
    expect(taskProcs(all, L.toUpperCase().replace(/\\/g, "/"), NODE.toLowerCase())).toEqual({
      roots: [900, 910],
      daemon: 920,
    });
    // After `schtasks /End` conhost is gone and the launcher is still there.
    expect(taskProcs(all.slice(2), L, NODE)).toEqual({ roots: [910], daemon: 920 });
    // Between two runs of the service the launcher runs nothing.
    expect(taskProcs(all.slice(0, 3), L, NODE)).toEqual({ roots: [900, 910], daemon: null });
    // With no launcher file to say which node runs it, only conhost is told to be ours.
    expect(taskProcs(all, L, null)).toEqual({ roots: [900], daemon: null });
    // Another label's task, an editor with the launcher open, another node on that file
    // with more words, and a conhost that isn't headless are nobody's to stop.
    const others = parseProcs(
      JSON.stringify([
        {
          ProcessId: 1,
          ParentProcessId: 0,
          Name: "conhost.exe",
          CommandLine: `conhost.exe --headless "${NODE}" "${L}2"`,
        },
        { ProcessId: 2, ParentProcessId: 0, Name: "notepad.exe", CommandLine: `notepad.exe "${L}"` },
        { ProcessId: 3, ParentProcessId: 0, Name: "node.exe", CommandLine: `"${NODE}" --inspect "${L}"` },
        { ProcessId: 5, ParentProcessId: 0, Name: "conhost.exe", CommandLine: `conhost.exe 0x4 "${L}"` },
        { ProcessId: 6, ParentProcessId: 0, Name: "node.exe", CommandLine: `"${L}"` },
        { ProcessId: 8, ParentProcessId: 2, Name: "node.exe", CommandLine: "" },
      ]),
    );
    expect(taskProcs(others, L, NODE)).toEqual({ roots: [], daemon: null });
  });
});

describe("installing, looking and removing, with Task Scheduler stood in", () => {
  it("a dry run writes nothing and says the file and the commands", () => {
    const w = windows();
    const r = installService({ ...SPEC, home, dryRun: true, platform: "win32", exec: w.exec, shell: {} });
    expect(r).toEqual({
      files: [serviceFiles({ ...SPEC, home }).launcher],
      commands: [
        `${SYS}\\schtasks.exe /Create /TN \\sessionpipe\\org.sessionpipe.gui /XML ${path.join(path.dirname(launcher()), "org.sessionpipe.gui.xml")} /F`,
        `${SYS}\\schtasks.exe /Run /TN \\sessionpipe\\org.sessionpipe.gui`,
      ],
      manager: "schtasks",
    });
    expect(w.ran).toEqual([]);
    expect(existsSync(path.join(home, "AppData"))).toBe(false);
    expect(uninstallService({ ...NAMES, home, dryRun: true, platform: "win32", exec: w.exec })).toEqual({
      files: [],
      commands: [],
    });
  });

  it("nothing there: the launcher is written, the task registered for this user and run", () => {
    const w = windows();
    const r = installService({ ...SPEC, home, platform: "win32", exec: w.exec, shell: w.shell });
    expect(r).toMatchObject({ manager: "schtasks", files: [{ path: launcher() }] });
    const xml = path.join(path.dirname(launcher()), "org.sessionpipe.gui.xml");
    expect(w.ran).toEqual([
      "powershell <look>",
      `schtasks.exe /Create /TN \\sessionpipe\\org.sessionpipe.gui /XML ${xml} /F`,
      "schtasks.exe /Run /TN \\sessionpipe\\org.sessionpipe.gui",
    ]);
    expect(r.commands).toEqual(w.ran.slice(1).map((c) => `${SYS}\\${c}`));
    expect(readFileSync(launcher(), "utf8")).toBe(serviceFiles({ ...SPEC, home }).launcher.text);
    // The definition was there for schtasks to read, as UTF-16, and is gone again.
    const given = (w.written[xml] as Buffer).toString("utf16le");
    expect(given).toContain("<UserId>DESK\\misha</UserId>");
    expect(given).toContain(
      `&quot;${NODE}&quot; ${launcher().includes(" ") ? `&quot;${launcher()}&quot;` : launcher()}`,
    );
    expect(existsSync(xml)).toBe(false);
  });

  it("whose logon it is: the shell's domain and name, else the name given, else this account's", () => {
    const user = (o: { shell?: NodeJS.ProcessEnv; user?: string }) => {
      const w = windows();
      installService({ ...SPEC, ...o, home, platform: "win32", exec: w.exec, shell: o.shell ?? {} });
      return /<UserId>([^<]*)<\/UserId>/.exec((Object.values(w.written)[0] as Buffer).toString("utf16le"))?.[1];
    };
    expect(user({ shell: { USERDOMAIN: "DESK", USERNAME: "misha" } })).toBe("DESK\\misha");
    expect(user({ shell: { USERNAME: "misha" }, user: "given" })).toBe("given");
    expect(user({})).toBe(os.userInfo().username);
  });

  it("a task that is running is replaced: ended, what it started stopped by its own ids, registered and run", () => {
    mkdirSync(path.dirname(launcher()), { recursive: true });
    writeFileSync(launcher(), serviceFiles({ ...SPEC, home }).launcher.text);
    const procs = [
      {
        ProcessId: 900,
        ParentProcessId: 1,
        Name: "conhost.exe",
        CommandLine: `conhost.exe --headless "${NODE}" "${launcher()}"`,
      },
      { ProcessId: 910, ParentProcessId: 900, Name: "node.exe", CommandLine: `"${NODE}" "${launcher()}"` },
      { ProcessId: 920, ParentProcessId: 910, Name: "node.exe", CommandLine: "the service" },
    ];
    const w = windows({ state: 4, procs });
    const next = { ...SPEC, argv: [NODE, "C:\\gui2\\server.js"] };
    expect(installService({ ...next, home, platform: "win32", exec: w.exec, shell: w.shell }).manager).toBe("schtasks");
    expect(w.ran.map((c) => c.split(" /XML")[0])).toEqual([
      "powershell <look>",
      "schtasks.exe /End /TN \\sessionpipe\\org.sessionpipe.gui",
      "taskkill.exe /PID 900 /T /F",
      "taskkill.exe /PID 910 /T /F",
      "schtasks.exe /Create /TN \\sessionpipe\\org.sessionpipe.gui",
      "schtasks.exe /Run /TN \\sessionpipe\\org.sessionpipe.gui",
    ]);
    expect(serviceArgv(readFileSync(launcher(), "utf8"))).toEqual(next.argv);
    // A look at it: running, from that file, and the process the launcher runs.
    expect(serviceState({ ...NAMES, home, platform: "win32", exec: w.exec, shell: w.shell })).toEqual({
      manager: "schtasks",
      file: launcher(),
      installed: true,
      loaded: true,
      argv: next.argv,
      pid: 920,
    });
  });

  it("a process that is already gone, and a PowerShell that can't be asked, stop nothing from being placed", () => {
    const refusing = windows({
      state: 3,
      refuse: ["/End", "/PID"],
      procs: [RUNNING[1]].map((p) => ({ ...p, CommandLine: `conhost.exe --headless x "${launcher()}"` })),
    });
    expect(installService({ ...SPEC, home, platform: "win32", exec: refusing.exec, shell: {} }).manager).toBe(
      "schtasks",
    );
    expect(refusing.ran.map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual([
      "powershell <look>",
      "schtasks.exe /End",
      "taskkill.exe /PID",
      "schtasks.exe /Create",
      "schtasks.exe /Run",
    ]);
    // What runs isn't known: the task is still told to end, and the new one placed.
    for (const w of [windows({ noPowerShell: true }), windows({ state: "Running" })]) {
      expect(installService({ ...SPEC, home, platform: "win32", exec: w.exec, shell: {} }).manager).toBe("schtasks");
      expect(w.ran.map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual([
        "powershell <look>",
        "schtasks.exe /End",
        "schtasks.exe /Create",
        "schtasks.exe /Run",
      ]);
    }
  });

  it("a task schtasks won't take: the launcher stays where there was none, and the one from before goes back", () => {
    const w = windows({ refuse: ["/Create"] });
    const r = installService({ ...SPEC, home, platform: "win32", exec: w.exec, shell: {} });
    expect(r).toMatchObject({ manager: null, unreachable: launcher() });
    expect(r.restored).toBeUndefined();
    expect(w.ran.at(-1)).toContain("schtasks.exe /Create");
    expect(existsSync(path.join(path.dirname(launcher()), "org.sessionpipe.gui.xml"))).toBe(false);
    // Another one, refused when it is run: the file from before is back, and run again.
    const old = readFileSync(launcher(), "utf8");
    const again = windows({ state: 3, refuse: ["/Run"] });
    const next = { ...SPEC, argv: [NODE, "C:\\gui2\\server.js"] };
    expect(installService({ ...next, home, platform: "win32", exec: again.exec, shell: {} })).toMatchObject({
      manager: null,
      unreachable: launcher(),
      restored: true,
    });
    expect(readFileSync(launcher(), "utf8")).toBe(old);
    expect(again.ran.slice(-2).map((c) => c.split(" ")[1])).toEqual(["/Run", "/Run"]);
  });

  it("a node or a home the task's command line can't carry: nothing is written or run, and why", () => {
    const w = windows();
    const r = installService({ ...SPEC, node: "C:\\100%\\node.exe", home, platform: "win32", exec: w.exec, shell: {} });
    expect(r).toEqual({
      files: [],
      commands: [],
      manager: null,
      why: 'a scheduled task can\'t carry "C:\\\\100%\\\\node.exe" on its command line (a quote, a % or a line end)',
    });
    expect(w.ran).toEqual([]);
    expect(existsSync(path.join(home, "AppData"))).toBe(false);
    // The node that runs this is the one named where none is.
    const { node: _node, ...plain } = SPEC;
    const mine = windows();
    installService({ ...plain, home, platform: "win32", exec: mine.exec, shell: {} });
    expect((Object.values(mine.written)[0] as Buffer).toString("utf16le")).toContain(
      /\s/.test(process.execPath) ? `&quot;${process.execPath}&quot;` : `--headless ${process.execPath} `,
    );
  });

  it("a look: no task, one that isn't running, and a Task Scheduler that can't be asked", () => {
    const none = windows();
    expect(serviceState({ ...NAMES, home, platform: "win32", exec: none.exec, shell: {} })).toEqual({
      manager: "schtasks",
      file: launcher(),
      installed: false,
      loaded: false,
      argv: null,
      pid: null,
    });
    expect(none.ran).toEqual(["powershell <look>"]);
    installService({ ...SPEC, home, platform: "win32", exec: none.exec, shell: {} });
    const ready = windows({ state: 3 });
    expect(serviceState({ ...NAMES, home, platform: "win32", exec: ready.exec, shell: {} })).toMatchObject({
      manager: "schtasks",
      installed: true,
      loaded: false,
      argv: SPEC.argv,
      pid: null,
    });
    // The file, with the copy it names, is read all the same.
    for (const w of [windows({ noPowerShell: true }), windows({ state: "Ready" }), windows({ state: 4, procs: "{" })])
      expect(serviceState({ ...NAMES, home, platform: "win32", exec: w.exec, shell: {} })).toMatchObject({
        manager: null,
        installed: true,
        loaded: false,
        argv: SPEC.argv,
        pid: null,
      });
  });

  it("removing: the task ended and deleted, what it started stopped, the launcher gone, the folder if it is empty", () => {
    const w = windows({
      state: 4,
      procs: [
        {
          ProcessId: 900,
          ParentProcessId: 1,
          Name: "conhost.exe",
          CommandLine: `conhost.exe --headless n "${launcher()}"`,
        },
      ],
    });
    // No launcher: nobody asked for a service here, and nothing is asked or run.
    expect(uninstallService({ ...NAMES, home, platform: "win32", exec: w.exec, shell: {} })).toEqual({
      files: [],
      commands: [],
    });
    expect(w.ran).toEqual([]);
    installService({ ...SPEC, home, platform: "win32", exec: windows().exec, shell: {} });
    const dry = uninstallService({ ...NAMES, home, dryRun: true, platform: "win32", exec: w.exec, shell: {} });
    expect(dry.files).toEqual([launcher()]);
    expect(dry.commands.map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual([
      `${SYS}\\schtasks.exe /End`,
      `${SYS}\\schtasks.exe /Delete`,
      `${SYS}\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile`,
    ]);
    expect(w.ran).toEqual([]);
    expect(existsSync(launcher())).toBe(true);
    expect(uninstallService({ ...NAMES, home, platform: "win32", exec: w.exec, shell: {} }).files).toEqual([
      launcher(),
    ]);
    expect(w.ran).toEqual([
      "powershell <look>",
      "schtasks.exe /End /TN \\sessionpipe\\org.sessionpipe.gui",
      "taskkill.exe /PID 900 /T /F",
      "schtasks.exe /Delete /TN \\sessionpipe\\org.sessionpipe.gui /F",
      "powershell <folder>",
    ]);
    expect(existsSync(launcher())).toBe(false);
    // With no PowerShell the task and the launcher still go.
    installService({ ...SPEC, home, platform: "win32", exec: windows().exec, shell: {} });
    const bare = windows({ noPowerShell: true });
    uninstallService({ ...NAMES, home, platform: "win32", exec: bare.exec, shell: {} });
    expect(bare.ran).toEqual([
      "powershell <look>",
      "schtasks.exe /End /TN \\sessionpipe\\org.sessionpipe.gui",
      "schtasks.exe /Delete /TN \\sessionpipe\\org.sessionpipe.gui /F",
      "powershell <folder>",
    ]);
    expect(existsSync(launcher())).toBe(false);
  });

  it("with nothing stood in, the shell is this process's own", () => {
    // Not Windows: there is no such PowerShell to run, so nothing can be asked. On
    // Windows this is a real look, and changes nothing.
    const st = serviceState({ ...NAMES, home, platform: "win32" });
    expect(st).toMatchObject({ file: launcher(), installed: false, loaded: false, argv: null, pid: null });
    if (process.platform !== "win32") expect(st.manager).toBeNull();
    // Removing asks the same shell where Windows is.
    const ran: string[] = [];
    const exec = (cmd: string, args: string[]) => `${ran.push(`${path.win32.basename(cmd)} ${args[0]}`)}`;
    installService({ ...SPEC, home, platform: "win32", exec, shell: {} });
    ran.length = 0;
    expect(uninstallService({ ...NAMES, home, platform: "win32", exec }).files).toEqual([launcher()]);
    expect(ran).toEqual([
      "powershell.exe -NoProfile",
      "schtasks.exe /End",
      "schtasks.exe /Delete",
      "powershell.exe -NoProfile",
    ]);
  }, 60_000);
});
