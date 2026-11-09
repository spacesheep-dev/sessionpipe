// SPDX-License-Identifier: Apache-2.0
// TypeScript types from the descriptors: what packages/core/gen/v1.ts holds. Types only, no runtime,
// so sessionpipe-core keeps its zero dependencies; the shapes are the wire's, which is why no
// off-the-shelf generator fits (decision 002): keys stay snake_case, every integer is a `number`, an
// enum is the union of its words on the wire, an `either` message is a union, a REQUIRED field is
// required and every other one is `?: T | undefined`, as the Zod-inferred types were. Every comment in
// the proto becomes the type's doc comment.
//
//   message                 export interface Name { … }     (`open`: with `[key: string]: unknown`)
//   either message          export type Name = A | B;
//   enum                    export type Name = "word" | "word";
//   string/bool/number      string | boolean | number; a `const` rule is its literal; `in` a union
//   repeated / map          T[] / Record<string, T>
//   google.protobuf.Value   unknown;  Struct → Record<string, unknown>
//   nullable                | null
import { type DescField, type DescFile, ScalarType } from "@bufbuild/protobuf";
import {
  type Descriptors,
  enumWords,
  type FieldRules,
  INT_CASES,
  type Kind,
  kindOf,
  type NumberRules,
  wireName,
} from "./read.js";

/** The leading comment on each message, enum, field or enum value, by its source path (`4.i.2.j`). */
function comments(file: DescFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const loc of file.proto.sourceCodeInfo!.location) {
    // buf build keeps source info unless told not to; this generator always wants it
    const c = loc.leadingComments.trim();
    if (c) out.set(loc.path.join("."), c);
  }
  return out;
}

const doc = (text: string | undefined, indent = ""): string => {
  if (!text) return "";
  const lines = text.split("\n").map((l) => l.replace(/^ ?/, ""));
  return lines.length === 1
    ? `${indent}/** ${lines[0]} */\n`
    : `${indent}/**\n${lines.map((l) => `${indent} * ${l}`.trimEnd()).join("\n")}\n${indent} */\n`;
};
const key = (name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

function scalarType(scalar: ScalarType, rules: FieldRules | undefined): string {
  const r = rules?.type;
  if (scalar === ScalarType.STRING) {
    const s = r?.case === "string" ? r.value : undefined;
    return s?.const !== undefined ? JSON.stringify(s.const) : "string";
  }
  if (scalar === ScalarType.BOOL) {
    const b = r?.case === "bool" ? r.value : undefined;
    return b?.const !== undefined ? String(b.const) : "boolean";
  }
  const name = ScalarType[scalar].toLowerCase();
  if (INT_CASES.has(name) || name === "double" || name === "float") {
    const n =
      r && (INT_CASES.has(r.case) || r.case === "double" || r.case === "float") ? (r.value as NumberRules) : undefined;
    if (n?.const !== undefined) return String(n.const);
    if (n?.in?.length) return n.in.map(String).join(" | ");
    return "number";
  }
  throw new Error(`no TypeScript type for a ${ScalarType[scalar]} field`);
}

function valueType(kind: Kind, rules: FieldRules | undefined): string {
  if ("message" in kind) {
    if (kind.message.typeName === "google.protobuf.Value") return "unknown";
    if (kind.message.typeName === "google.protobuf.Struct") return "Record<string, unknown>";
    return kind.message.name;
  }
  if ("enum" in kind) return kind.enum.name;
  return scalarType(kind.scalar, rules);
}

function fieldType(d: Descriptors, f: DescField): string {
  const rules = d.rules(f);
  if (f.fieldKind === "list") {
    const items = rules?.type?.case === "repeated" ? rules.type.value.items : undefined;
    const t = valueType(kindOf(f), items);
    return t.includes(" | ") ? `(${t})[]` : `${t}[]`;
  }
  if (f.fieldKind === "map") return `Record<string, ${valueType(kindOf(f), undefined)}>`;
  return valueType(kindOf(f), rules);
}

/** The proto files whose messages and enums the types file holds, in order. */
export const WIRE_FILES: readonly string[] = ["options", "events", "http", "control"];

/** The whole file's text: every message and enum of the given `sessionpipe/v1/<name>.proto` files, in order. */
export function typesFile(d: Descriptors, files: readonly string[] = WIRE_FILES): string {
  const parts = [
    "// SPDX-License-Identifier: Apache-2.0",
    "// GENERATED from proto/sessionpipe/v1/*.proto by tools/doors; do not edit. `npm run schemas` rewrites it.",
    "// The wire's shapes as TypeScript: snake_case keys, numbers for every integer, enums as their words.",
    "",
  ];
  for (const name of files) {
    const file = d.registry.getFile(`sessionpipe/v1/${name}.proto`)!;
    const notes = comments(file);
    file.enums.forEach((e, i) => {
      if (e.name === "Format") return; // an option's own enum, not a wire type
      parts.push(
        `${doc(notes.get(`5.${i}`))}export type ${e.name} = ${enumWords(e, d)
          .map((w) => JSON.stringify(w))
          .join(" | ")};\n`,
      );
    });
    file.messages.forEach((m, i) => {
      const head = doc(notes.get(`4.${i}`));
      if (d.either(m)) {
        parts.push(
          `${head}export type ${m.name} = ${m.fields.map((f) => valueType(kindOf(f), undefined)).join(" | ")};\n`,
        );
        return;
      }
      const lines = m.fields.map((f, j) => {
        const opt = d.required(f) || d.defaultJson(f) !== undefined ? "" : "?";
        const t = `${fieldType(d, f)}${d.nullable(f) ? " | null" : ""}${opt ? " | undefined" : ""}`;
        return `${doc(notes.get(`4.${i}.2.${j}`), "  ")}  ${key(wireName(f))}${opt}: ${t};`;
      });
      // An `open` message keeps extra keys: an index signature, as Zod's `.loose()` infers it.
      if (d.open(m)) lines.push("  /** Extra keys a sender added are kept. */\n  [key: string]: unknown;");
      parts.push(`${head}export interface ${m.name} {\n${lines.join("\n")}\n}\n`);
    });
  }
  return parts.join("\n");
}
