---
"sessionpipe-core": patch
---

secrets@1: named values and cookies, in structured data and in text

- What is under `value` goes by the name beside it: `{"name":"DB_PASSWORD","value":"…"}` and `{"name":"Cookie","value":"…"}` are read as a secret's name and a header's name are.
- A cookie's value is replaced whole: an object under a key that ends in `cookie` or `cookies`, one with a `name` and two of a cookie's attributes (`domain`, `path`, `expires`, `httpOnly`, `secure`, `sameSite`), and what is not words in a jar of them (`cookies: { sid: "…" }`).
- An object written out in text is read the same way: JSON on one line or many with its keys in any order, a JavaScript or Python literal, an object held in a string, JSON inside a JSON string.
- A cookie header written out is replaced up to its last pair or attribute: `Cookie: sid=…; theme=dark` becomes `Cookie: [redacted]`, in a request as it was sent, a `curl -H` or `-b`, JSON text, a call or an assignment. Code that builds one from pieces (`"sid=" + sid`) is left as it is.
- `spec/PRIVACY.md` §2 has the four rows, and `conformance/redaction/secrets.json` the cases.
