// ── Offline-token migration core ──────────────────────────────────────────────
//
// Resumable driver for re-pinning stored Shopify offline sessions onto a new
// client secret. Shopify pins each issued access/refresh token pair to the
// client secret used to create it; rotating the secret requires each stored
// pair to be re-issued under the new secret before the old one is revoked.
//
// The core is dependency-injected so it can be tested without a database or
// network. The concrete wiring (Shopify OAuth refresh + Prisma session
// storage + read-only verification call) lives in
// scripts/migrate-offline-tokens.ts.
//
// Safety properties:
//  - Sessions are migrated one at a time, in a stable order, so a run can be
//    stopped and re-run; a re-run simply re-refreshes pairs (harmless).
//  - A session with no stored refresh token cannot be migrated this way and
//    is reported as "skipped" — it needs merchant re-authorization, never
//    silent deletion.
//  - One shop's failure never stops the batch; the report distinguishes
//    refresh, persist and verify stages.
//  - No token value is ever returned, logged or included in results.

export interface MigrationTarget {
  id: string;
  shop: string;
  refreshToken: string | null;
}

export type MigrationStage = "refresh" | "persist" | "verify";

export class MigrationStepError extends Error {
  readonly stage: MigrationStage;
  constructor(stage: MigrationStage, cause: unknown) {
    super(
      `${stage} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "MigrationStepError";
    this.stage = stage;
  }
}

export interface MigrationResult {
  id: string;
  shop: string;
  status: "migrated" | "skipped" | "failed";
  stage?: MigrationStage;
  error?: string;
}

export interface SessionMigrationDeps {
  listTargets(): Promise<MigrationTarget[]>;
  /** Exchange the stored refresh token for a new token pair under the current
   *  client secret. Returns the material needed for persistence. */
  refresh(target: MigrationTarget): Promise<unknown>;
  /** Persist the refreshed session row (replaces accessToken, refreshToken
   *  and expiry fields). */
  persist(target: MigrationTarget, refreshed: unknown): Promise<void>;
  /** Read-only Admin API check proving the persisted token works. */
  verify(target: MigrationTarget): Promise<void>;
  sleep?(ms: number): Promise<void>;
}

export async function migrateSessions(
  deps: SessionMigrationDeps,
  opts: { delayMs?: number } = {},
): Promise<MigrationResult[]> {
  const targets = await deps.listTargets();
  const results: MigrationResult[] = [];
  for (const target of targets) {
    let result: MigrationResult;
    if (!target.refreshToken) {
      result = { id: target.id, shop: target.shop, status: "skipped" };
    } else {
      try {
        const step = async <T>(stage: MigrationStage, fn: () => Promise<T>) => {
          try {
            return await fn();
          } catch (err) {
            throw new MigrationStepError(stage, err);
          }
        };
        const refreshed = await step("refresh", () => deps.refresh(target));
        await step("persist", () => deps.persist(target, refreshed));
        await step("verify", () => deps.verify(target));
        result = { id: target.id, shop: target.shop, status: "migrated" };
      } catch (err) {
        const wrapped =
          err instanceof MigrationStepError
            ? err
            : new MigrationStepError("refresh", err);
        result = {
          id: target.id,
          shop: target.shop,
          status: "failed",
          stage: wrapped.stage,
          error: wrapped.message,
        };
      }
    }
    results.push(result);
    if (opts.delayMs && deps.sleep && target !== targets[targets.length - 1]) {
      await deps.sleep(opts.delayMs);
    }
  }
  return results;
}
