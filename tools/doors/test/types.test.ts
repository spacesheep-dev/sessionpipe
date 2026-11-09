// SPDX-License-Identifier: Apache-2.0
// The generated types (packages/core/gen/v1.ts) are the Zod-inferred types, shape for shape, while
// both exist: `npm run typecheck` fails on any difference (expectTypeOf is checked by tsc; it does
// nothing at run time). When the Zod file goes (RFC 0001 step 2), this test goes with it.

import type * as S from "@sessionpipe/core/schema";
import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type * as G from "../../../packages/core/gen/v1.js";

type Z<T extends z.ZodType> = z.infer<T>;

describe("the generated types equal the Zod-inferred types", () => {
  it("the envelope", () => {
    expectTypeOf<G.Event>().toEqualTypeOf<Z<typeof S.Event>>();
    expectTypeOf<G.Harness>().toEqualTypeOf<Z<typeof S.Harness>>();
    expectTypeOf<G.Session>().toEqualTypeOf<Z<typeof S.Session>>();
    expectTypeOf<G.Privacy>().toEqualTypeOf<Z<typeof S.Privacy>>();
    expectTypeOf<G.EventData>().toEqualTypeOf<Z<typeof S.EventData>>();
    expectTypeOf<G.LimitWindow>().toEqualTypeOf<Z<typeof S.LimitWindow>>();
    expectTypeOf<G.AttentionKind>().toEqualTypeOf<Z<typeof S.AttentionKind>>();
    expectTypeOf<G.HarnessName>().toEqualTypeOf<(typeof S.HARNESS_NAMES)[number]>();
  });
  it("the HTTP binding", () => {
    expectTypeOf<G.Batch>().toEqualTypeOf<Z<typeof S.Batch>>();
    expectTypeOf<G.BatchResponse>().toEqualTypeOf<Z<typeof S.BatchResponse>>();
    expectTypeOf<G.ErrorResponse>().toEqualTypeOf<Z<typeof S.ErrorResponse>>();
    expectTypeOf<G.WellKnown>().toEqualTypeOf<Z<typeof S.WellKnown>>();
    expectTypeOf<G.Capability>().toEqualTypeOf<Z<typeof S.Capability>>();
  });
  it("the control channel", () => {
    expectTypeOf<G.ControlCommand>().toEqualTypeOf<Z<typeof S.ControlCommand>>();
    expectTypeOf<G.ControlGrant>().toEqualTypeOf<Z<typeof S.ControlGrant>>();
    expectTypeOf<G.ControlKey>().toEqualTypeOf<Z<typeof S.ControlKey>>();
    expectTypeOf<G.ControlMessage>().toEqualTypeOf<Z<typeof S.ControlMessage>>();
    expectTypeOf<G.ControlPoll>().toEqualTypeOf<Z<typeof S.ControlPoll>>();
    expectTypeOf<G.ControlAck>().toEqualTypeOf<Z<typeof S.ControlAck>>();
    expectTypeOf<G.ControlPairStart>().toEqualTypeOf<Z<typeof S.ControlPairStart>>();
    expectTypeOf<G.ControlPairStarted>().toEqualTypeOf<Z<typeof S.ControlPairStarted>>();
    expectTypeOf<G.ControlPaired>().toEqualTypeOf<Z<typeof S.ControlPaired>>();
    expectTypeOf<G.ControlHello>().toEqualTypeOf<Z<typeof S.ControlHello>>();
    expectTypeOf<G.ControlHelloPool>().toEqualTypeOf<Z<typeof S.ControlHelloPool>>();
    expectTypeOf<G.PoolAccount>().toEqualTypeOf<Z<typeof S.PoolAccount>>();
    expectTypeOf<G.HarnessAccount>().toEqualTypeOf<Z<typeof S.HarnessAccount>>();
    expectTypeOf<G.ControlFile>().toEqualTypeOf<Z<typeof S.ControlFile>>();
    expectTypeOf<G.ControlKind>().toEqualTypeOf<Z<typeof S.ControlKind>>();
    expectTypeOf<G.DeliveryMode>().toEqualTypeOf<Z<typeof S.DeliveryMode>>();
    expectTypeOf<G.ControlOutcome>().toEqualTypeOf<Z<typeof S.ControlOutcome>>();
    expectTypeOf<G.PoolAction>().toEqualTypeOf<Z<typeof S.PoolAction>>();
    expectTypeOf<G.StartPermission>().toEqualTypeOf<Z<typeof S.StartPermission>>();
    expectTypeOf<G.RunLevel>().toEqualTypeOf<Z<typeof S.RunLevel>>();
  });
});
