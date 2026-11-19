---
"sessionpipe": patch
---

Uninstall says what it does: only sessionpipe's entries are removed and every other value stays

- `sessionpipe uninstall`, the README and the docs promised every config file "byte-identical". That holds for a TOML config and for a JSON file laid out one item per line. A JSON file with a list or object on a single line keeps its values but comes back spread over several lines (#205). The words now say that; nothing about what is written changed.
