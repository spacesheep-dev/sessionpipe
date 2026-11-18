// SPDX-License-Identifier: Apache-2.0
// The protocol's types, generated from proto/sessionpipe/v1 (packages/core/gen/v1.ts; RFC 0001),
// plus the few derived ones. Type-only: nothing here reaches the bundle a hook runs.
import type { EventData } from "../gen/v1.js";

export type * from "../gen/v1.js";

export type Tier = 0 | 1 | 2 | 3;
/** A known event type: the keys of EventData. An unknown type is still an Event. */
export type EventType = keyof EventData;
export type DataOf<T extends EventType> = EventData[T];
