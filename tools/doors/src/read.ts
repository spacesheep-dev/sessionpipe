// SPDX-License-Identifier: Apache-2.0
// Reading the descriptors: the registry, our options and protovalidate's rules as plain data, and
// the few derivations every generator shares (a field's key on the wire, an enum's words, the
// tier of each event type). Nothing here knows about JSON Schema or TypeScript.
import {
  createFileRegistry,
  type DescEnum,
  type DescEnumValue,
  type DescExtension,
  type DescField,
  type DescMessage,
  type FileRegistry,
  fromBinary,
  getExtension,
  hasExtension,
  type Message,
  type ScalarType,
} from "@bufbuild/protobuf";
import { reflect } from "@bufbuild/protobuf/reflect";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

/** protovalidate's rules for one field, as plain data: only the fields that were SET, 64-bit
 *  numbers as `number`, a oneof as `{case, value}`. Only the rules the proto uses are typed. */
export interface FieldRules {
  type?:
    | { case: "string"; value: { const?: string; minLen?: number; maxLen?: number; pattern?: string } }
    | { case: "bool"; value: { const?: boolean } }
    | { case: IntCase; value: NumberRules }
    | { case: "double" | "float"; value: NumberRules }
    | { case: "repeated"; value: { minItems?: number; maxItems?: number; unique?: boolean; items?: FieldRules } }
    | { case: "map"; value: { maxPairs?: number; keys?: FieldRules; values?: FieldRules } };
}
export type IntCase =
  | "int32"
  | "int64"
  | "uint32"
  | "uint64"
  | "sint32"
  | "sint64"
  | "fixed32"
  | "fixed64"
  | "sfixed32"
  | "sfixed64";
export interface NumberRules {
  const?: number;
  in?: number[];
  greaterThan?: { case: "gte" | "gt"; value: number };
  lessThan?: { case: "lte" | "lt"; value: number };
}
export const INT_CASES: ReadonlySet<string> = new Set<IntCase>([
  "int32",
  "int64",
  "uint32",
  "uint64",
  "sint32",
  "sint64",
  "fixed32",
  "fixed64",
  "sfixed32",
  "sfixed64",
]);

/** `Format` in options.proto. */
export const DATE_TIME = 1;
export const URI = 2;
const REQUIRED = 2; // google.api.FieldBehavior.REQUIRED

const EXTENSIONS = {
  behavior: "google.api.field_behavior",
  rules: "buf.validate.field",
  format: "sessionpipe.v1.format",
  nullable: "sessionpipe.v1.nullable",
  defaultJson: "sessionpipe.v1.default_json",
  open: "sessionpipe.v1.open",
  strict: "sessionpipe.v1.strict",
  either: "sessionpipe.v1.either",
  tier: "sessionpipe.v1.tier",
  word: "sessionpipe.v1.word",
} as const;

/** A dynamic message (no generated class) as plain data: set fields only, bigints as numbers. */
function plain(registry: FileRegistry, msg: Message): Record<string, unknown> {
  const r = reflect(registry.getMessage(msg.$typeName)!, msg);
  const value = (v: unknown): unknown =>
    v && typeof v === "object" && "$typeName" in v
      ? plain(registry, v as Message)
      : typeof v === "bigint"
        ? Number(v)
        : v;
  const raw = msg as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of r.fields) {
    if (f.oneof) continue;
    const v = raw[f.localName];
    if (f.fieldKind === "list") {
      if ((v as unknown[]).length) out[f.localName] = (v as unknown[]).map(value);
    } else if (r.isSet(f)) out[f.localName] = value(v);
  }
  for (const o of r.oneofs) {
    const c = raw[o.localName] as { case?: string; value?: unknown };
    if (c.case) out[o.localName] = { case: c.case, value: value(c.value) };
  }
  return out;
}

/** One FileDescriptorSet (the bytes `buf build` wrote) and the readers for its options. */
export class Descriptors {
  readonly registry: FileRegistry;
  private readonly ext: Record<keyof typeof EXTENSIONS, DescExtension>;

  constructor(bytes: Uint8Array) {
    this.registry = createFileRegistry(fromBinary(FileDescriptorSetSchema, bytes));
    const ext = {} as Record<keyof typeof EXTENSIONS, DescExtension>;
    for (const [key, name] of Object.entries(EXTENSIONS) as [keyof typeof EXTENSIONS, string][]) {
      const e = this.registry.getExtension(name);
      if (!e) throw new Error(`descriptors: no extension ${name}`);
      ext[key] = e;
    }
    this.ext = ext;
  }

  private get<T>(options: Message | undefined, key: keyof typeof EXTENSIONS): T | undefined {
    const e = this.ext[key];
    return options && hasExtension(options, e) ? (getExtension(options, e) as T) : undefined;
  }

  /** The message `sessionpipe.v1.<name>`; throws when the proto has none. */
  message(name: string): DescMessage {
    const m = this.registry.getMessage(`sessionpipe.v1.${name}`);
    if (!m) throw new Error(`descriptors: no message sessionpipe.v1.${name}`);
    return m;
  }

  rules(f: DescField): FieldRules | undefined {
    const m = this.get<Message>(f.proto.options, "rules");
    return m && (plain(this.registry, m) as FieldRules);
  }
  required(f: DescField): boolean {
    return (this.get<number[]>(f.proto.options, "behavior") ?? []).includes(REQUIRED);
  }
  format(f: DescField): number | undefined {
    return this.get<number>(f.proto.options, "format");
  }
  nullable(f: DescField): boolean {
    return this.get<boolean>(f.proto.options, "nullable") ?? false;
  }
  defaultJson(f: DescField): string | undefined {
    return this.get<string>(f.proto.options, "defaultJson");
  }
  open(m: DescMessage): boolean {
    return this.get<boolean>(m.proto.options, "open") ?? false;
  }
  strict(m: DescMessage): boolean {
    return this.get<boolean>(m.proto.options, "strict") ?? false;
  }
  either(m: DescMessage): boolean {
    return this.get<boolean>(m.proto.options, "either") ?? false;
  }
  tier(m: DescMessage): number | undefined {
    return this.get<number>(m.proto.options, "tier");
  }
  word(v: DescEnumValue): string | undefined {
    return this.get<string>(v.proto.options, "word");
  }
}

/** What a field holds, whatever its cardinality: a message, an enum or a scalar. */
export type Kind = { message: DescMessage } | { enum: DescEnum } | { scalar: ScalarType };
export function kindOf(f: DescField): Kind {
  switch (f.fieldKind) {
    case "message":
      return { message: f.message };
    case "enum":
      return { enum: f.enum };
    case "scalar":
      return { scalar: f.scalar };
    case "list":
      return f.listKind === "message"
        ? { message: f.message }
        : f.listKind === "enum"
          ? { enum: f.enum }
          : { scalar: f.scalar };
    case "map":
      return f.mapKind === "message"
        ? { message: f.message }
        : f.mapKind === "enum"
          ? { enum: f.enum }
          : { scalar: f.scalar };
  }
}

/** Protobuf's default JSON name for a field: underscores dropped, the next letter capitalised. */
const camel = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** The key on the wire: the proto field name, unless `json_name` says otherwise (EventData's dotted types). */
export const wireName = (f: DescField): string => (f.jsonName === camel(f.name) ? f.name : f.jsonName);

const snake = (s: string): string => s.replace(/(?<!^)(?=[A-Z])/g, "_").toUpperCase();
/** An enum's words on the wire: each value but the zero one, as `word` says or lowercase without the prefix. */
export function enumWords(desc: DescEnum, d: Descriptors): string[] {
  const prefix = `${snake(desc.name)}_`;
  return desc.values.filter((v) => v.number !== 0).map((v) => d.word(v) ?? v.name.replace(prefix, "").toLowerCase());
}

/** The tier each event type is carried at, by the type's JSON name: EventData's fields' messages' `tier`. */
export function typeTiers(d: Descriptors): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of d.message("EventData").fields) {
    const kind = kindOf(f);
    const tier = "message" in kind ? d.tier(kind.message) : undefined;
    if (tier === undefined) throw new Error(`EventData.${f.name}: no tier option on its message`);
    out[wireName(f)] = tier;
  }
  return out;
}
