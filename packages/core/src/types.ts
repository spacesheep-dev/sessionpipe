// SPDX-License-Identifier: Apache-2.0
// Runtime types, inferred from the Zod source with type-only imports: zod is a build
// tool here, never a dependency of the bundle a hook runs.
import type { z } from "zod";
import type * as S from "../schema/v1.js";

export type Tier = 0 | 1 | 2 | 3;
export type Event = z.infer<typeof S.Event>;
export type EventType = (typeof S.KNOWN_TYPES)[number];
export type Harness = z.infer<typeof S.Harness>;
export type HarnessName = (typeof S.HARNESS_NAMES)[number];
export type Session = z.infer<typeof S.Session>;
export type Privacy = z.infer<typeof S.Privacy>;
export type EventData = z.infer<typeof S.EventData>;
export type DataOf<T extends EventType> = EventData[T];
export type Batch = z.infer<typeof S.Batch>;
export type BatchResponse = z.infer<typeof S.BatchResponse>;
export type ErrorResponse = z.infer<typeof S.ErrorResponse>;
export type WellKnown = z.infer<typeof S.WellKnown>;
export type ControlMessage = z.infer<typeof S.ControlMessage>;
export type ControlAck = z.infer<typeof S.ControlAck>;
export type AttentionKind = z.infer<typeof S.AttentionKind>;
export type HarnessAccount = z.infer<typeof S.HarnessAccount>;
export type ControlHello = z.infer<typeof S.ControlHello>;
/** The machine's account pool as its hello lists it (CONTROL.md §2 `pool`). */
export type ControlHelloPool = z.infer<typeof S.ControlHelloPool>;
export type PoolAccount = z.infer<typeof S.PoolAccount>;
