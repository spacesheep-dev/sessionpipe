// SPDX-License-Identifier: Apache-2.0
// A stdin that is the JSON document `null` (or any JSON that is not an object) is no
// payload: fromHook answers as it does for an empty stdin and never throws. It did,
// on the first field it read, and the worker job died with it.
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/adapters/index.js";

describe("a JSON stdin that is not an object", () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter.name}: Stop with stdin "null" is handled like no payload`, () => {
      const hook = (stdin: string) => adapter.fromHook({ argv: [adapter.name, "Stop"], stdin, env: {}, cwd: "/" });
      for (const stdin of ["null", "42", '"text"', "[]"]) expect(() => hook(stdin)).not.toThrow();
      expect(hook("null")).toEqual(hook(""));
    });
  }
});
