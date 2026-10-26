---
"sessionpipe-core": minor
"sessionpipe": minor
---

Control: device keys (CONTROL.md §2, §3.2). `sessionpipe-core/control` verifies a device key's signature (`{cred, sig}`, raw r‖s over `sessionpipe.device.v1⏎<purpose>⏎<rp id>⏎<challenge>`) for a grant, a confirm or a pairing proof, chosen by the machine's own record of the key; `keyUsable` closes key fields and checks a device key's rules (`type: "device"`, `alg -7`, `store: "hardware"`, `uv: "each-use"`, id = SHA-256 of the SPKI); `verifyCommand` refuses a `key.add` whose key could never be used (`bad_fields`). `verifyAssertion` takes the purpose. New exports `DEVICE_CONTEXT`, `deviceMessage`, `deviceKeyId`, `KEY_TYPES`, `DEVICE_SIG_FIELDS`, `DeviceSignature`, `DeviceGrant`. The daemon advertises `key_types: ["passkey","device"]` when pairing and in every hello, stores a device key whole (from a pairing or a `key.add`), and `control keys` shows each key's kind. 26 new shared vectors (`111`–`136`).
