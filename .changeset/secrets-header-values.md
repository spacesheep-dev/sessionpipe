---
"sessionpipe-core": patch
---

secrets@1: a header's value is redacted under its name in structured data

- Under a key that ends in `authorization` or `cookie`, in any case (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `set_cookie`, `HTTP_COOKIE`, `X-Authorization`), a string is replaced whole, and so is each string of a list (`"set-cookie": ["…", "…"]`). A value that is nothing but a stand-in stays: empty, `[redacted]`, `<token>`, `${TOKEN}`. `spec/PRIVACY.md` §2 has the row, and `conformance/redaction/secrets.json` the cases.
