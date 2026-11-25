// SPDX-License-Identifier: Apache-2.0
// `sessionpipe-core/schema`: the protocol's JSON Schemas, a checker for them, and the registry,
// all generated from proto/sessionpipe/v1 (RFC 0001). Zero dependencies; runs anywhere JSON does.
import { type JsonSchema, SCHEMAS, type SchemaName } from "../../gen/schemas.js";
import { problems } from "./validate.js";

/** The machine's own files' schemas (config.proto: the trigger rules file), published nowhere. */
export { CONFIG_SCHEMAS } from "../../gen/config-schemas.js";
export { DATA_ALLOW, HARNESS_NAMES, KNOWN_TYPES, PROTOCOL, SESSION_KEYS, TYPE_TIER } from "../../gen/registry.js";
export { type JsonSchema, SCHEMAS, type SchemaName } from "../../gen/schemas.js";
export { problems } from "./validate.js";

/** Every way `value` fails the named schema (`event`, `control-command`, …); empty when it fits. */
export const validate = (name: SchemaName, value: unknown): string[] => problems(SCHEMAS[name], value);

/** The schema of one event type's `data`, or undefined for a type the protocol doesn't name. */
export function dataSchema(type: string): JsonSchema | undefined {
  const props = SCHEMAS["event-data"].properties as Record<string, JsonSchema>;
  return Object.hasOwn(props, type) ? props[type] : undefined;
}
