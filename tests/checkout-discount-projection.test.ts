// CAS projection writer against the faithful fake admin: real compare-and-
// set semantics, STALE_OBJECT retries with injected sleep/random, conflict
// exhaustion, non-stale userErrors and no-op writes.
import { describe, expect, it } from "vitest";
import {
  ProjectionConflictError,
  ProjectionWriteError,
  writeProjection,
} from "../app/lib/checkout-discount/projection-write";
import { mergeRecords, serializeElig, type EligRecord } from "../app/lib/checkout-discount/records";
import { makeFakeEligibilityAdmin } from "./helpers/checkout-fake-admin";

const K = (...f: string[]) => f.join("\u001f");
const ADDR_KEY = K("jane", "doe", "acme", "123 main st", "apt 4", "new york", "ny", "10001", "us");
const r1v = (over: Record<string, unknown> = {}): EligRecord => ({
  id: "111",
  win: "w1",
  dest: ADDR_KEY,
  method: "standard shipping",
  cur: "USD",
  left: 1,
  exp: "2099-01-01",
  ...over,
});

describe("projection.writeProjection (fake CAS admin)", () => {
  const gid = "gid://shopify/Customer/1";
  const sleepLog: number[] = [];
  const sleep = async (ms: number) => {
    sleepLog.push(ms);
  };

  it("first write uses compareDigest null and persists", async () => {
    const admin = makeFakeEligibilityAdmin();
    const r = await writeProjection(admin, gid, () => ({ serialized: serializeElig({ v: 1, recs: [r1v()] }) }));
    expect(r).toEqual({ written: true, attempts: 1 });
    expect(admin.writes.length).toBe(1);
    expect(admin.stored(gid)).toMatchObject({ v: 1 });
  });

  it("no-ops on byte-identical state — zero writes", async () => {
    const admin = makeFakeEligibilityAdmin();
    const s = serializeElig({ v: 1, recs: [r1v()] });
    await writeProjection(admin, gid, () => ({ serialized: s }));
    const r = await writeProjection(admin, gid, () => ({ serialized: s }));
    expect(r.written).toBe(false);
    expect(admin.writes.length).toBe(1);
  });

  it("two concurrent writers for DIFFERENT orders converge to the union — one retry, no lost update", async () => {
    const admin = makeFakeEligibilityAdmin();
    const o1 = { ...r1v(), id: "111" };
    const o2 = { ...r1v(), id: "222" };
    admin.setInterleaveHook(async () => {
      // B commits entirely inside A's read→write gap.
      await writeProjection(admin, gid, () => ({ serialized: serializeElig({ v: 1, recs: [o2] }) }));
    });
    const a = await writeProjection(admin, gid, (cur) => {
      const m = mergeRecords(cur, [o1], { todayDate: "2026-11-01" });
      return { serialized: m.serialized };
    });
    expect(a.written).toBe(true);
    expect(a.attempts).toBe(2); // one CAS loss, retried
    expect(admin.stored(gid)).toMatchObject({ v: 1, recs: [{ id: "111" }, { id: "222" }] });
  });

  it("same order projected twice concurrently ⇒ one record", async () => {
    const admin = makeFakeEligibilityAdmin();
    const o1 = r1v();
    admin.setInterleaveHook(async () => {
      await writeProjection(admin, gid, () => ({ serialized: serializeElig({ v: 1, recs: [o1] }) }));
    });
    const r = await writeProjection(admin, gid, (cur) => {
      const m = mergeRecords(cur, [o1], { todayDate: "2026-11-01" });
      return { serialized: m.serialized };
    });
    expect(r.attempts).toBe(2);
    const stored = admin.stored(gid) as { recs: { id: string }[] };
    expect(stored.recs.length).toBe(1);
    expect(stored.recs[0].id).toBe("111");
  });

  it("exhausts retries to ProjectionConflictError with injected sleep (no timers)", async () => {
    const admin = makeFakeEligibilityAdmin();
    sleepLog.length = 0;
    const collide = async () => {
      admin.setInterleaveHook(async () => {});
      await writeProjection(admin, gid, (cur) => ({
        serialized: serializeElig(mergeRecords(cur, [{ ...r1v(), id: `x${admin.callCount}` }], { todayDate: "2026-11-01" }).doc),
      }));
      admin.setInterleaveHook(collide);
    };
    admin.setInterleaveHook(collide);
    await expect(
      writeProjection(admin, gid, (cur) => ({ serialized: serializeElig(mergeRecords(cur, [r1v()], { todayDate: "2026-11-01" }).doc) }), { maxRetries: 3, sleep, random: () => 0.5 }),
    ).rejects.toBeInstanceOf(ProjectionConflictError);
    expect(sleepLog.length).toBe(3); // one injected backoff per stale CAS loss
  });

  it("a non-STALE userError throws ProjectionWriteError", async () => {
    const admin = makeFakeEligibilityAdmin();
    const orig = admin.graphql.bind(admin);
    admin.graphql = (async (q: string, o?: { variables?: Record<string, unknown> }) => {
      if (q.includes("metafieldsSet")) {
        return { data: { metafieldsSet: { metafields: [], userErrors: [{ code: "TOO_LONG", field: ["value"], message: "too long", elementIndex: 0 }] } } };
      }
      return orig(q, o);
    }) as typeof admin.graphql;
    await expect(
      writeProjection(admin, gid, () => ({ serialized: serializeElig({ v: 1, recs: [r1v()] }) })),
    ).rejects.toBeInstanceOf(ProjectionWriteError);
  });
});
