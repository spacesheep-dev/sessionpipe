// SPDX-License-Identifier: Apache-2.0
// The JSON Schemas as a TypeScript module: what packages/core/gen/schemas.ts holds, the same objects as
// schemas/v1/*.json, so a program checks a value against the protocol without reading files or a
// library (packages/core/src/schema/validate.ts does the checking).
import { SCHEMA_FILES, schemaFiles } from "./jsonschema.js";
import type { Descriptors } from "./read.js";

/** The whole file's text. */
export function schemasModuleFile(d: Descriptors): string {
  const files = schemaFiles(d);
  const entries = Object.keys(SCHEMA_FILES).map((name) => {
    const text = files[`schemas/v1/${name}.json`]!.trimEnd().replace(/^/gm, "  ").trimStart();
    return `  ${JSON.stringify(name)}: ${text},`;
  });
  return [
    "// SPDX-License-Identifier: Apache-2.0",
    "// GENERATED from proto/sessionpipe/v1/*.proto by tools/doors; do not edit. `npm run schemas` rewrites it.",
    "// The protocol's JSON Schemas (draft 2020-12), the same bytes as schemas/v1/*.json, keyed by file name.",
    "",
    "/** A JSON Schema, as the generator writes it: an object of keywords. */",
    "export type JsonSchema = Readonly<Record<string, unknown>>;",
    "",
    "export const SCHEMAS = {",
    ...entries,
    "} as const satisfies Record<string, JsonSchema>;",
    "",
    "/** A schema's name: its file under schemas/v1 without `.json`. */",
    "export type SchemaName = keyof typeof SCHEMAS;",
    "",
  ].join("\n");
}
