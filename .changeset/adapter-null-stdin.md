---
"sessionpipe-core": patch
---

Treat a hook stdin that is JSON but not an object (`null`, a number, a string, an array) as no payload in every adapter. Such a stdin made `fromHook` throw on the first field it read, and the worker job for that hook died with it; it is now handled exactly like an empty stdin, so the hook reports nothing and the session carries on.
