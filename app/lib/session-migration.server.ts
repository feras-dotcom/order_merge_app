// ── Offline-token migration core ──────────────────────────────────────────────
//
// Resumable driver for re-pinning stored Shopify offline sessions onto a new
// client secret. Shopify pins each issued access/refresh token pair to the
// client secret used to create it; rotating the secret requires each stored
// pair to be re-issued under the new secret before the old one is revoked.
//
// The core is dependency-injected so it can be tested without a database or
// network. The concrete wiring (Shopify OAuth refresh + Prisma session
// storage + read-only verification call) lives in createSessionMigrationDeps
// below; scripts/migrate-offline-tokens.ts is thin glue over it.
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

// ── Production wiring ────────────────────────────────────────────────────────
//
// createSessionMigrationDeps builds the real deps used by
// scripts/migrate-offline-tokens.ts from a Prisma client plus the app's
// client credentials. Kept here (not in the script) so the request shape,
// response validation, conditional persist and verify can be tested against
// fakes without a database or network.
//
// A complete refresh response is REQUIRED: access_token, refresh_token,
// expires_in and refresh_token_expires_in must all be present before
// anything is persisted — persisting a partial response could store a new
// access token against a stale refresh token or expiry.
//
// The persist is conditional: it updates the row only while its stored
// refreshToken still equals the one observed when the target list was read.
// The SDK continuously refreshes/exchanges sessions; if a row's credentials
// changed mid-run, updateMany matches zero rows and the persist fails
// closed — the newer stored credentials are kept and the operator re-runs.

export interface RefreshedSessionMaterial {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
  scope?: string;
}

interface RefreshResponseBody {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
}

export interface SessionMigrationStore {
  session: {
    findMany(args: {
      select: { id: true; shop: true; refreshToken: true };
      orderBy: { id: "asc" };
    }): Promise<MigrationTarget[]>;
    updateMany(args: {
      where: { id: string; refreshToken: string };
      data: {
        accessToken: string;
        scope?: string;
        expires: Date;
        refreshToken: string;
        refreshTokenExpires: Date;
      };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
    }): Promise<{ accessToken: string } | null>;
  };
}

const secondsFromNow = (s: number) => new Date(Date.now() + s * 1000);

export function createSessionMigrationDeps(opts: {
  prisma: SessionMigrationStore;
  apiKey: string;
  apiSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Required<SessionMigrationDeps> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return {
    listTargets: () =>
      opts.prisma.session.findMany({
        select: { id: true, shop: true, refreshToken: true },
        orderBy: { id: "asc" },
      }),

    refresh: async (target: MigrationTarget) => {
      const res = await fetchImpl(
        `https://${target.shop}/admin/oauth/access_token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: opts.apiKey,
            client_secret: opts.apiSecret,
            refresh_token: target.refreshToken,
            grant_type: "refresh_token",
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      const body = (await res
        .json()
        .catch(() => ({}))) as RefreshResponseBody;
      if (
        !res.ok ||
        !body.access_token ||
        !body.refresh_token ||
        typeof body.expires_in !== "number" ||
        typeof body.refresh_token_expires_in !== "number"
      ) {
        throw new Error(
          `HTTP ${res.status}${body.error ? ` ${body.error}` : ""}` +
            (res.ok ? " incomplete refresh response" : ""),
        );
      }
      const material: RefreshedSessionMaterial = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresIn: body.expires_in,
        refreshTokenExpiresIn: body.refresh_token_expires_in,
        ...(body.scope !== undefined ? { scope: body.scope } : {}),
      };
      return material;
    },

    persist: async (target: MigrationTarget, refreshed: unknown) => {
      const m = refreshed as RefreshedSessionMaterial;
      // Compare-and-swap on the refresh token observed at listTargets time:
      // a concurrent SDK refresh/token-exchange already rotated it means our
      // refresh result is stale and must not overwrite the newer row.
      if (!target.refreshToken) {
        throw new Error("no refresh token observed for target");
      }
      let updated: { count: number };
      try {
        updated = await opts.prisma.session.updateMany({
          where: { id: target.id, refreshToken: target.refreshToken },
          data: {
            accessToken: m.accessToken,
            ...(m.scope !== undefined ? { scope: m.scope } : {}),
            expires: secondsFromNow(m.expiresIn),
            refreshToken: m.refreshToken,
            refreshTokenExpires: secondsFromNow(m.refreshTokenExpiresIn),
          },
        });
      } catch (err) {
        // Prisma errors can embed the full where-clause — including the
        // refreshToken value — in their message. Scrub it: only the error
        // kind is useful for diagnosis.
        throw new Error(
          `session persist rejected (${err instanceof Error ? err.name : "unknown"})`,
        );
      }
      if (updated.count !== 1) {
        throw new Error(
          "session credentials changed concurrently — refusing to overwrite newer stored credentials; re-run the migration",
        );
      }
    },

    verify: async (target: MigrationTarget) => {
      const stored = await opts.prisma.session.findUnique({
        where: { id: target.id },
      });
      if (!stored?.accessToken) throw new Error("no stored access token");
      const res = await fetchImpl(
        `https://${target.shop}/admin/api/2026-04/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": stored.accessToken,
          },
          body: JSON.stringify({ query: "{ shop { name } }" }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!res.ok) throw new Error(`verification query HTTP ${res.status}`);
      const body = (await res.json()) as { errors?: unknown };
      if (body.errors) throw new Error("verification query returned errors");
    },

    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
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
