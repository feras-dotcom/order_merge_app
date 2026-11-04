// Real-Postgres regression test for the set-approval opt-in-epoch defect
// found in S3 prep: the old code bound the JS Date read from
// Settings.shippingAdjustmentEnabledAt back into the naive timestamp
// column, so under a non-UTC session timezone merchantOptInEpoch landed
// hours off (3h under Asia/Amman). The fix copies the timestamp inside
// SQL for both the INSERT and the ON CONFLICT path.
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test_x \
//   MERGESHIP_SHADOW_TOKEN=<operator token> \
//     npx vitest run tests/shipping-refund-approval-cli-pg.test.ts
//
// The test ALTERs the disposable database's default timezone to
// Asia/Tokyo, runs the REAL CLI (`scripts/shipping-refund-admin.ts
// set-approval --apply`) as a subprocess twice (create + update), then
// compares the two timestamp columns for exact equality at the DB level.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  preflightDisposableDatabase,
  type PreflightedDatabase,
} from "./helpers/disposable-db";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const REPO_ROOT = join(__dirname, "..");

const runSetApproval = (env: NodeJS.ProcessEnv, shop: string, maxMinor: number) => {
  execFileSync(
    "npx",
    [
      "vite-node",
      "--script",
      join(REPO_ROOT, "scripts/shipping-refund-admin.ts"),
      "set-approval",
      "--shop", shop,
      "--currency", "USD",
      "--max-minor", String(maxMinor),
      "--daily-cap", "1",
      "--auto-approve", "off",
      "--note", "approval-epoch-tz regression",
      "--by", "vitest",
      "--apply",
    ],
    { env, stdio: "pipe", shell: process.platform === "win32", timeout: 90_000 },
  );
};

describe.skipIf(!TEST_URL)(
  "set-approval opt-in epoch under a non-UTC session timezone",
  { timeout: 180_000 },
  () => {
    let preflighted: PreflightedDatabase;
    let db: PrismaClient;
    const shop = `tz-regression-${randomUUID().slice(0, 8)}.myshopify.com`;

    beforeAll(async () => {
      preflighted = await preflightDisposableDatabase(TEST_URL!);
      db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
      // Non-UTC default timezone for every session on this disposable DB.
      await db.$executeRawUnsafe(
        `ALTER DATABASE "${preflighted.dbName}" SET timezone = 'Asia/Tokyo'`,
      );
      // Settings row with a known opt-in epoch written correctly in SQL.
      await db.$executeRawUnsafe(
        `INSERT INTO "Settings" ("id","shop","shippingAdjustmentEnabled","shippingAdjustmentEnabledAt")
         VALUES ($1,$2,true, clock_timestamp() AT TIME ZONE 'UTC')
         ON CONFLICT ("shop") DO NOTHING`,
        randomUUID().replace(/-/g, ""),
        shop,
      );
    }, 60_000);

    afterAll(async () => {
      await db.$executeRawUnsafe(
        `ALTER DATABASE "${preflighted.dbName}" RESET timezone`,
      );
      await db.$disconnect();
    });

    it("creates and updates the approval with an epoch equal to the live opt-in epoch", async () => {
      // A fresh client: ALTER DATABASE applies to new sessions only, so the
      // beforeAll `db` pool may still hold an Asia/Amman session.
      const tokyoDb = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
      try {
        const [{ tz }] = await tokyoDb.$queryRaw<{ tz: string }[]>`
          SELECT current_setting('TimeZone') AS "tz"`;
        expect(tz).toBe("Asia/Tokyo");

        const env = { ...process.env, DATABASE_URL: TEST_URL! };
        runSetApproval(env, shop, 400);   // INSERT path
        runSetApproval(env, shop, 300);   // ON CONFLICT update path

        const [v] = await tokyoDb.$queryRawUnsafe<
        { eq: boolean; epoch: Date; live: Date; maxRefundMinor: string }[]
      >(
        `SELECT a."merchantOptInEpoch" = s."shippingAdjustmentEnabledAt" AS eq,
                a."merchantOptInEpoch" AS epoch,
                s."shippingAdjustmentEnabledAt" AS live,
                a."maxRefundMinor"
           FROM "ShippingExecuteApproval" a
           JOIN "Settings" s ON s."shop" = a."shop"
          WHERE a."shop" = $1`,
        shop,
      );
      expect(v?.eq).toBe(true);
      expect(v?.maxRefundMinor).toBe("300"); // update path applied
      // Equality must hold down to the byte — the text render proves the
      // naive stored values match exactly, not merely at ms precision.
        const [txt] = await tokyoDb.$queryRawUnsafe<{ eq: boolean }[]>(
        `SELECT a."merchantOptInEpoch"::text = s."shippingAdjustmentEnabledAt"::text AS eq
           FROM "ShippingExecuteApproval" a
           JOIN "Settings" s ON s."shop" = a."shop"
          WHERE a."shop" = $1`,
          shop,
        );
        expect(txt?.eq).toBe(true);
      } finally {
        await tokyoDb.$disconnect();
      }
    });
  },
);
