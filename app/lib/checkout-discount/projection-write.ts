// Read-modify-write of the customer $app:ship_elig metafield with a real
// compare-and-set: Admin metafieldsSet compareDigest semantics (STALE_OBJECT
// on a mismatch; compareDigest null = create-only-if-absent). Retries with
// jittered backoff via INJECTED sleep/random — no real timers inside.
import { ELIG_KEY, ELIG_NAMESPACE } from "./records";

export const PROJECTION_READ = `query EligibilityProjectionRead($ownerId: ID!) {
  customer(id: $ownerId) {
    metafield(namespace: "$app", key: "ship_elig") {
      id
      jsonValue
      compareDigest
    }
  }
}`;

export const PROJECTION_WRITE = `mutation EligibilityProjectionWrite($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id }
    userErrors { code field message elementIndex }
  }
}`;

export interface AdminGraphql {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<unknown>;
}

export class ProjectionConflictError extends Error {
  readonly attempts: number;
  constructor(attempts: number) {
    super(`eligibility projection conflict after ${attempts} attempts`);
    this.name = "ProjectionConflictError";
    this.attempts = attempts;
  }
}

export class ProjectionWriteError extends Error {
  readonly errors: unknown;
  constructor(errors: unknown) {
    super(`eligibility projection write refused: ${JSON.stringify(errors)}`);
    this.name = "ProjectionWriteError";
    this.errors = errors;
  }
}

const dataOf = (res: unknown): Record<string, unknown> => {
  if (typeof res === "object" && res !== null && "data" in (res as object)) {
    return (res as { data: Record<string, unknown> }).data ?? {};
  }
  return (res as Record<string, unknown>) ?? {};
};

export async function writeProjection(
  admin: AdminGraphql,
  customerGid: string,
  mutate: (currentValue: unknown) => { serialized: string } | null,
  opts: {
    maxRetries?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<{ written: boolean; attempts: number }> {
  const maxRetries = opts.maxRetries ?? 5;
  const sleep = opts.sleep ?? (() => Promise.resolve());
  const random = opts.random ?? (() => 0.5);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = dataOf(await admin.graphql(PROJECTION_READ, { variables: { ownerId: customerGid } }));
    const customer = res.customer as Record<string, unknown> | null | undefined;
    const mf = customer?.metafield as
      | { id: string; jsonValue: unknown; compareDigest: string | null }
      | null
      | undefined;
    const current = mf?.jsonValue;
    const next = mutate(current);
    if (next === null || next.serialized === JSON.stringify(current)) {
      return { written: false, attempts: attempt };
    }
    const wr = dataOf(
      await admin.graphql(PROJECTION_WRITE, {
        variables: {
          metafields: [
            {
              ownerId: customerGid,
              namespace: ELIG_NAMESPACE,
              key: ELIG_KEY,
              type: "json",
              value: next.serialized,
              compareDigest: mf == null ? null : mf.compareDigest,
            },
          ],
        },
      }),
    );
    const mset = wr.metafieldsSet as
      | { metafields?: unknown; userErrors?: { code?: string }[] }
      | undefined;
    const errs = mset?.userErrors ?? [];
    if (errs.length === 0) return { written: true, attempts: attempt };
    if (errs.every((e) => e.code === "STALE_OBJECT")) {
      // CAS lost: another writer committed between our read and write.
      // Re-read and retry with a jittered backoff.
      await sleep(Math.floor(random() * 40) + attempt * 20);
      continue;
    }
    throw new ProjectionWriteError(errs);
  }
  throw new ProjectionConflictError(maxRetries);
}
