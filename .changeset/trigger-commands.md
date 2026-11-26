---
"sessionpipe": minor
"sessionpipe-core": patch
---

`sessionpipe triggers` and `sessionpipe trigger`: your rules, made at this computer's terminal

- `sessionpipe triggers on | off | status`: triggers are off until you turn them on. `on` shows every rule in plain words, with the level each really runs at on this computer, and takes a typed `yes`; it installs the background service if none runs. `off` stops every rule at once.
- `sessionpipe trigger add <name>` makes a rule on a receiver's notices (`--on board.example --topic acme/tasks`) or on a clock (`--every "mon 09:00"`, `day 08:30`, `2h`). It checks what a run would (the folder is allowed, the agent runs here, the receiver is paired, the session to continue is here), says when a receiver does not send notices or the words name a field the rule doesn't require, shows the rule and the level it will run at here (and why when that is narrower than asked), and takes a typed `yes`. No flag skips it.
- `trigger list` shows each rule in a line, its runs today against its cap, and what it did (ran, refused and why, missed, couldn't start); `trigger test` shows what a sample notice or a tick would run, running nothing; `pause`, `resume` and `remove`. `--json` on `list`, `status` and `test` prints the messages config.proto defines.
- Every command that changes a rule refuses inside a coding session. Characters that don't show are written out wherever a rule is shown.
- A rule that continues a session takes that session's folder: `add` shows it on the folder line and refuses another `--folder`.
- When the rules change in another terminal while you read a rule before typing `yes`, nothing is written: "The rules changed while you were reading. Nothing was written. Run the command again."
- `sessionpipe trigger line <name>` prints the one `sessionpipe trigger add …` command that makes the rule again, exactly as it is at a terminal of any width or in a pipe (`| pbcopy` takes it whole), to make the same rule on another computer: the flags in one fixed order, a value quoted for sh, bash and zsh only when it must be, and a value that starts with `-` written `--flag=<value>`, which `trigger add` now takes for every option. It runs `add`'s checks, so a rule `add` would refuse here is refused with why. `--json` prints it with its words.
- Two commands never write the rules over each other: a command that changes them takes a lock, and another command meanwhile says "Another sessionpipe command is changing the rules. Run it again." A lock left by a command that ended is let go of at once.
- `trigger list` says a run dropped because its rule was paused or changed; `--json` says why a rules file can't be read. A terminal too narrow to show a rule whole asks nothing and says to widen it.
- `sessionpipe ask off` and `sessionpipe control off` keep the background service while triggers are on.
- `sessionpipe-core` exports the machine's own files' schemas (`CONFIG_SCHEMAS`).
