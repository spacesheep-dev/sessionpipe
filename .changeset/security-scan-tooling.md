---
"sessionpipe-conformance": patch
---

conformance: a fixture run reads only the folder it was given, and holds an event's data to the fixture exactly

Four changes to `sessionpipe-conformance`, from a security scan of the repository's tooling.

An event's `data` now has to match the fixture field for field: a field the adapter sends that the fixture does not name is a miss (`[0].data.output: not in the fixture`). Before, the fixture's fields were compared and anything extra passed, so an adapter could start sending more than its fixtures vouch for and still read as conformant. `"*"` is still a wildcard for a value, and a session's facts are compared as before (the fixture's fields; a harness's environment adds others).

A symbolic link under the folder you name is an error that names the link (exit code 2), instead of being followed to a file or a folder somewhere else on the machine.

A fixture whose fields are the wrong kind (`input.argv` that is not a list of strings, an `expect` entry that is not an object, an `env` that is not a map of strings) is a `FAIL` row that says which, instead of an exception that ends the run.

Control characters in a fixture's path or in an error are printed as `\xNN`, so a file name cannot move the cursor or recolour the terminal of whoever runs the suite.
