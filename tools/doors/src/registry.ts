// SPDX-License-Identifier: Apache-2.0
// The runtime registry from the descriptors: what packages/core/gen/registry.ts holds. The facts the
// sender's filter and the readers need at run time, as constants: the protocol integer, every event
// type with its tier and the data keys each tier carries, the session keys, the harness names. The
// filter (packages/core/src/privacy/filter.ts) reads these instead of tables kept by hand.
import { type Descriptors, enumWords, eventTypes, wireName } from "./read.js";

const list = (xs: string[]): string => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;

/** The whole file's text. */
export function registryFile(d: Descriptors): string {
  const types = eventTypes(d);
  const names = Object.keys(types);
  const allow = names
    .filter((t) => types[t]!.allow)
    .map((t) => {
      const tiers = Object.entries(types[t]!.allow!)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([tier, keys]) => `${tier}: ${list(keys)}`);
      return `  ${JSON.stringify(t)}: { ${tiers.join(", ")} },`;
    });
  return [
    "// SPDX-License-Identifier: Apache-2.0",
    "// GENERATED from proto/sessionpipe/v1/*.proto by tools/doors; do not edit. `npm run schemas` rewrites it.",
    "// The protocol's registry at run time: event types, their tiers and keys, session keys, harness names.",
    "",
    "/** The protocol integer every event carries. */",
    "export const PROTOCOL = 1;",
    "",
    "/** The event types this version of the protocol names, in the order the definition lists them. */",
    `export const KNOWN_TYPES = ${list(names)} as const;`,
    "",
    "/** The lowest tier that carries each known type (spec/PRIVACY.md §1). */",
    "export const TYPE_TIER: Readonly<Record<string, 0 | 1 | 2 | 3>> = {",
    ...names.map((t) => `  ${JSON.stringify(t)}: ${types[t]!.tier},`),
    "};",
    "",
    "/** The data keys each type carries at each tier, cumulative: a sink at tier N sees the keys of every",
    " *  tier up to N. A type not listed here (`native`) is carried whole. */",
    "export const DATA_ALLOW: Readonly<Record<string, Readonly<Partial<Record<0 | 1 | 2 | 3, readonly string[]>>>>> = {",
    ...allow,
    "};",
    "",
    "/** The keys of `session` every event may carry, in the definition's order. */",
    `export const SESSION_KEYS = ${list(d.message("Session").fields.map(wireName))} as const;`,
    "",
    "/** The harnesses in the registry (spec/ADAPTERS.md), in the definition's order. */",
    `export const HARNESS_NAMES = ${list(enumWords(d.registry.getEnum("sessionpipe.v1.HarnessName")!, d))} as const;`,
    "",
  ].join("\n");
}
