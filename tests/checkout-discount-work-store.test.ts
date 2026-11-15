// CheckoutEligibilityWork store contract — the exact same suite the
// real-Postgres variant (checkout-discount-work-pg.test.ts) runs against
// prismaCheckoutWorkStore. Covers the level-triggered dirty mark, lease
// fencing, generation-gated completion, exhaustion and purge.
import { describe, expect, it } from "vitest";
import { OwnershipLostError } from "../app/lib/ownership.server";
import { memoryCheckoutWorkStore, type CheckoutWorkStore } from "../app/lib/checkout-discount/work.server";

export function checkoutWorkStoreContract(make: () => { store: CheckoutWorkStore; setClock: (ms: number) => void }) {
  const SHOP = "shop.myshopify.com";
  const OID = "gid://shopify/Order/1001";
  const TTL = 60_000;
  const DEADLINE = 6 * 3600_000;

  describe("checkout work store contract", () => {
    it("upsertDirty: new row is PENDING gen 1, leased, acquired", async () => {
      const { store } = make();
      const r = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      expect(r.acquired).toBe(true);
      expect(r.item).toMatchObject({ shop: SHOP, orderId: OID, gen: 1, status: "PENDING", attempts: 1, leaseToken: "tok1" });
    });

    it("upsertDirty on a live lease keeps the lease, bumps gen, acquired=false", async () => {
      const { store } = make();
      const first = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      const second = await store.upsertDirty(SHOP, OID, "tok2", TTL, DEADLINE);
      expect(second.acquired).toBe(false);
      const row = await store.find(SHOP, OID);
      expect(row).toMatchObject({ gen: 2, status: "PENDING", leaseToken: "tok1" });
      expect(row!.id).toBe(first.item.id);
    });

    it("upsertDirty on an expired lease takes the lease, bumps gen, attempts reset", async () => {
      const { store, setClock } = make();
      await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      setClock(Date.now() + TTL + 1); // lease expires
      const r = await store.upsertDirty(SHOP, OID, "tok2", TTL, DEADLINE);
      expect(r.acquired).toBe(true);
      const row = await store.find(SHOP, OID);
      expect(row).toMatchObject({ gen: 2, leaseToken: "tok2", attempts: 1 });
    });

    it("upsertDirty re-opens DONE and REVIEW rows", async () => {
      const { store, setClock } = make();
      const d = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      expect(await store.complete(d.item.id, "tok1", 1, "PROJECTED", "ok")).toBe("DONE");
      const r = await store.upsertDirty(SHOP, OID, "tok2", TTL, DEADLINE);
      expect(r.acquired).toBe(true);
      expect(await store.find(SHOP, OID)).toMatchObject({ gen: 2, status: "PENDING", outcome: null, doneAt: null });
      // REVIEW rows are re-opened the same way.
      const other = "gid://shopify/Order/2002";
      const t0 = Date.now();
      await store.upsertDirty(SHOP, other, "tok3", 1, DEADLINE); // 1ms lease
      // Drive attempts to the cap then exhaust.
      for (let i = 1; i <= 26; i++) {
        setClock(t0 + i * 10);
        const [it] = await store.claimDue(1, 1);
        if (!it) break;
      }
      setClock(t0 + 27 * 10); // let the last claim's 1ms lease lapse
      await store.exhaustDue();
      expect(await store.find(SHOP, other)).toMatchObject({ status: "REVIEW", outcome: "EXHAUSTED" });
      const reopen = await store.upsertDirty(SHOP, other, "tok4", TTL, DEADLINE);
      expect(reopen.acquired).toBe(true);
      expect(await store.find(SHOP, other)).toMatchObject({ status: "PENDING", outcome: null });
    });

    it("complete with matching gen => DONE, clears lease and stamps outcome", async () => {
      const { store } = make();
      const r = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      expect(await store.complete(r.item.id, "tok1", 1, "CONSUMED", "record 1 consumed")).toBe("DONE");
      expect(await store.find(SHOP, OID)).toMatchObject({ status: "DONE", outcome: "CONSUMED", leaseToken: null });
    });

    it("complete against a newer gen => REQUEUED, still PENDING and due now", async () => {
      const { store } = make();
      const r = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      // A second delivery lands mid-processing while tok1 is still live.
      const d2 = await store.upsertDirty(SHOP, OID, "tok2", TTL, DEADLINE);
      expect(d2.acquired).toBe(false);
      expect(await store.complete(r.item.id, "tok1", 1, "PROJECTED", "gen1 work")).toBe("REQUEUED");
      const row = await store.find(SHOP, OID);
      expect(row).toMatchObject({ status: "PENDING", gen: 2, leaseToken: null });
      // Due immediately — the next claim picks the newer generation up.
      const [item] = await store.claimDue(1, TTL);
      expect(item?.gen).toBe(2);
    });

    it("complete with a stale token => LOST", async () => {
      const { store, setClock } = make();
      const r = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      setClock(Date.now() + TTL + 1);
      await store.upsertDirty(SHOP, OID, "tok2", TTL, DEADLINE);
      expect(await store.complete(r.item.id, "tok1", r.item.gen, "PROJECTED", "stale")).toBe("LOST");
    });

    it("claimDue leases only due+unowned rows with fresh distinct tokens", async () => {
      const { store, setClock } = make();
      await store.upsertDirty(SHOP, OID, "tok1", 1, DEADLINE); // lease 1ms
      const other = "gid://shopify/Order/3003";
      await store.upsertDirty(SHOP, other, "tok9", TTL, DEADLINE); // live lease
      setClock(Date.now() + 10);
      const claimed = await store.claimDue(5, TTL);
      // Only the expired-lease row is claimable — the live one stays.
      expect(claimed.map((i) => i.orderId)).toEqual([OID]);
      expect(claimed[0].leaseToken).toBeTruthy();
      expect(claimed[0].leaseToken).not.toBe("tok1");
      expect(claimed[0].attempts).toBe(2);
    });

    it("scheduleRetry defers and clears the lease; stale token is refused", async () => {
      const { store, setClock } = make();
      const r = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      expect(await store.scheduleRetry(r.item.id, "bad", 1000, "x")).toBe(false);
      expect(await store.scheduleRetry(r.item.id, "tok1", 60_000, "transient")).toBe(true);
      let row = await store.find(SHOP, OID);
      expect(row).toMatchObject({ status: "PENDING", leaseToken: null, lastReason: "transient" });
      expect((await store.claimDue(1, TTL)).length).toBe(0); // not due yet
      setClock(Date.now() + 61_000);
      expect((await store.claimDue(1, TTL)).length).toBe(1);
    });

    it("renew extends the lease; a stale token throws OwnershipLostError", async () => {
      const { store, setClock } = make();
      const r = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      await store.renew(r.item.id, "tok1", TTL);
      await expect(store.renew(r.item.id, "bad", TTL)).rejects.toBeInstanceOf(OwnershipLostError);
      setClock(Date.now() + TTL + 1);
      await expect(store.renew(r.item.id, "tok1", TTL)).rejects.toBeInstanceOf(OwnershipLostError);
    });

    it("restart: lease expiry then another worker claims and finishes", async () => {
      const { store, setClock } = make();
      const r = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      setClock(Date.now() + TTL + 1); // worker 1 died
      const [item] = await store.claimDue(1, TTL);
      expect(item).toBeTruthy();
      // The dead worker's completion is LOST; the new owner settles.
      expect(await store.complete(r.item.id, "tok1", item.gen, "PROJECTED", "stale worker")).toBe("LOST");
      expect(await store.complete(item.id, item.leaseToken!, item.gen, "PROJECTED", "recovered")).toBe("DONE");
    });

    it("purgeDone deletes old DONE rows only", async () => {
      const { store, setClock } = make();
      const r = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      await store.complete(r.item.id, "tok1", 1, "PROJECTED", "ok");
      setClock(Date.now() + 31 * 24 * 3600_000);
      expect(await store.purgeDone(30 * 24 * 3600_000)).toBe(1);
      expect(await store.find(SHOP, OID)).toBeNull();
    });

    it("touchExisting on a missing row returns null and writes NOTHING", async () => {
      const { store } = make();
      expect(await store.touchExisting(SHOP, OID, "tok1", TTL, DEADLINE)).toBeNull();
      expect(await store.find(SHOP, OID)).toBeNull();
    });

    it("touchExisting on a live lease keeps the lease, bumps gen, acquired=false", async () => {
      const { store } = make();
      await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      const r = await store.touchExisting(SHOP, OID, "tok2", TTL, DEADLINE);
      expect(r?.acquired).toBe(false);
      expect(await store.find(SHOP, OID)).toMatchObject({ gen: 2, status: "PENDING", leaseToken: "tok1" });
    });

    it("touchExisting on an expired lease acquires it and re-opens DONE rows", async () => {
      const { store, setClock } = make();
      const r = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      await store.complete(r.item.id, "tok1", 1, "PROJECTED", "ok");
      const t = await store.touchExisting(SHOP, OID, "tok2", TTL, DEADLINE);
      expect(t?.acquired).toBe(true);
      expect(await store.find(SHOP, OID)).toMatchObject({
        gen: 2, status: "PENDING", leaseToken: "tok2", outcome: null, doneAt: null,
      });
      // And an expired live lease is taken over too.
      setClock(Date.now() + TTL + 1);
      const t2 = await store.touchExisting(SHOP, OID, "tok3", TTL, DEADLINE);
      expect(t2?.acquired).toBe(true);
      expect((await store.find(SHOP, OID))!.leaseToken).toBe("tok3");
    });

    it("reopenOutstanding re-opens only old DONE/PROJECTED rows within the age bound", async () => {
      const { store, setClock } = make();
      const t0 = Date.now();
      // Fresh PROJECTED row — too young to re-open.
      const a = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      await store.complete(a.item.id, "tok1", 1, "PROJECTED", "ok");
      // A CONSUMED terminal row — never re-opened.
      const OID2 = "gid://shopify/Order/2002";
      const b = await store.upsertDirty(SHOP, OID2, "tok1", TTL, DEADLINE);
      await store.complete(b.item.id, "tok1", 1, "CONSUMED", "ok");
      // A REFUSED row — not an outstanding projection.
      const OID3 = "gid://shopify/Order/3003";
      const c = await store.upsertDirty(SHOP, OID3, "tok1", TTL, DEADLINE);
      await store.complete(c.item.id, "tok1", 1, "REFUSED", "ok");
      // Still fresh => nothing.
      expect(await store.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 50, deadlineMs: DEADLINE })).toBe(0);
      // Aged past the cadence: only the PROJECTED row re-opens.
      setClock(t0 + 601_000);
      expect(await store.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 50, deadlineMs: DEADLINE })).toBe(1);
      expect(await store.find(SHOP, OID)).toMatchObject({ status: "PENDING", outcome: null, doneAt: null, attempts: 0, leaseToken: null });
      expect((await store.find(SHOP, OID2))!.status).toBe("DONE");
      expect((await store.find(SHOP, OID3))!.status).toBe("DONE");
      // Past maxAge the same row is left alone.
      const done = await store.complete(
        (await store.claimDue(1, TTL))[0].id,
        (await store.find(SHOP, OID))!.leaseToken!,
        (await store.find(SHOP, OID))!.gen,
        "PROJECTED",
        "ok",
      );
      expect(done).toBe("DONE");
      setClock(t0 + 601_000 + 9 * 24 * 3600_000);
      expect(await store.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 50, deadlineMs: DEADLINE })).toBe(0);
    });

    it("markConsumedRecord: first value wins, lease-fenced, never cleared", async () => {
      const { store } = make();
      const d = await store.upsertDirty(SHOP, OID, "tok1", TTL, DEADLINE);
      expect(await store.markConsumedRecord(d.item.id, "tok1", "1001")).toBe("1001");
      expect((await store.find(SHOP, OID))!.consumedRecordId).toBe("1001");
      // A second call never overwrites — the caller settles against the
      // returned first value.
      expect(await store.markConsumedRecord(d.item.id, "tok1", "3003")).toBe("1001");
      // Lease-fenced like renew().
      await expect(store.markConsumedRecord(d.item.id, "tok-wrong", "9999")).rejects.toThrow(
        OwnershipLostError,
      );
      // Nothing clears it: touchExisting, a fresh dirty mark, complete.
      await store.touchExisting(SHOP, OID, "tok2", TTL, DEADLINE);
      expect((await store.find(SHOP, OID))!.consumedRecordId).toBe("1001");
      await store.upsertDirty(SHOP, OID, "tok3", TTL, DEADLINE);
      expect((await store.find(SHOP, OID))!.consumedRecordId).toBe("1001");
      const live = (await store.find(SHOP, OID))!;
      await store.complete(live.id, live.leaseToken!, live.gen, "CONSUMED", "ok");
      expect((await store.find(SHOP, OID))!.consumedRecordId).toBe("1001");
    });

    it("reopenOutstanding honours the limit and a second call takes the rest", async () => {
      const { store, setClock } = make();
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) {
        const r = await store.upsertDirty(SHOP, `gid://shopify/Order/${i}`, "tok1", TTL, DEADLINE);
        await store.complete(r.item.id, "tok1", 1, "PROJECTED", "ok");
      }
      setClock(t0 + 601_000);
      expect(await store.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 2, deadlineMs: DEADLINE })).toBe(2);
      expect(await store.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 2, deadlineMs: DEADLINE })).toBe(2);
      expect(await store.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 2, deadlineMs: DEADLINE })).toBe(1);
      // All five are PENDING now; re-opening is idempotent for PENDING rows.
      expect(await store.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 50, deadlineMs: DEADLINE })).toBe(0);
    });
  });
}

// Memory store driven by a per-store controllable fake clock (each test
// gets a fresh store and clock via make()).
describe("memoryCheckoutWorkStore", () => {
  checkoutWorkStoreContract(() => {
    let t = Date.now();
    return {
      store: memoryCheckoutWorkStore(() => t),
      setClock: (ms: number) => {
        t = ms;
      },
    };
  });
});
