---
"sessionpipe-core": patch
"sessionpipe": patch
---

An ACP agent that goes away with a message to it still unwritten no longer raises an error nobody catches. A message longer than a pipe holds waits in the pipe; when the agent then exits or is closed, the write fails afterwards, on the agent's input stream, which had no error listener: an uncaught `write EPIPE` in the daemon. The failed write is now heard like the agent's exit is: whoever is waiting for the answer gets "<agent> stopped taking input: …" (or its exit), and the session is closed so the next message opens another.
