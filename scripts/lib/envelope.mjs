// SPDX-License-Identifier: Apache-2.0
// A fixture's expected event as a full envelope: conformance/harness/** records what an adapter
// must produce and writes "*" where the sender mints a value. Shared by the conformance check,
// the tier-golden recorder and the tier-golden test, so the three never disagree on it.

/** What "*" stands for. */
export const WILD = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", time: "2026-09-28T00:00:00.000Z", seq: 0 };

/** The envelope: fixed id and time, the type's tier for "*", `secrets@1` and no PII. */
export function envelope(e, typeTier) {
  return {
    protocol: 1,
    ...e,
    id: e.id === "*" ? WILD.id : e.id,
    time: e.time === "*" ? WILD.time : e.time,
    tier: e.tier === "*" ? (typeTier[e.type] ?? 0) : e.tier,
    session: { ...e.session, seq: e.session?.seq === "*" ? WILD.seq : e.session?.seq },
    privacy: e.privacy ?? { rulesets: ["secrets@1"], pii: false },
  };
}
