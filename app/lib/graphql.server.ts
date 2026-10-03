// ── Strict Shopify Admin GraphQL access ───────────────────────────────────────
// Every merge-path call goes through gql(): a transport failure, a top-level
// GraphQL error (access denied, throttling, schema mismatch), a missing
// payload or any userErrors all throw. Callers never continue on a response
// they could not positively confirm.

import { OwnershipLostError } from "./ownership.server";

export type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown>; signal?: AbortSignal },
  ) => Promise<Response>;
};

/** Hard cap on a single Shopify call. With a 90s lease TTL, a mutation issued
 *  right after a successful renew always finishes inside its lease window. */
export const GQL_TIMEOUT_MS = 45_000;

export class ShopifyGraphqlError extends Error {
  /** true when Shopify definitively rejected the operation (userErrors), so
   *  it is known NOT to have been applied. false for transport / top-level
   *  errors, where the outcome of a mutation is unknown. */
  readonly rejected: boolean;
  /** The userErrors payload when `rejected` (empty otherwise). `code` exists
   *  only on OrderCancelUserError — plain UserError has field+message only. */
  readonly userErrors: { field?: string[] | null; message: string; code?: string | null }[];

  constructor(
    message: string,
    rejected: boolean,
    userErrors: { field?: string[] | null; message: string; code?: string | null }[] = [],
  ) {
    super(message);
    this.name = "ShopifyGraphqlError";
    this.rejected = rejected;
    this.userErrors = userErrors;
  }
}

function describeErrors(errors: unknown): string {
  if (Array.isArray(errors)) {
    return errors
      .map((e: any) => (typeof e?.message === "string" ? e.message : JSON.stringify(e)))
      .join("; ");
  }
  return typeof errors === "string" ? errors : JSON.stringify(errors);
}

/** Transport shared by gql and gqlNullable: the timeout race, top-level
 *  GraphQL errors and the OwnershipLostError pass-through. Returns
 *  `data[root]` or null when the root itself is null/missing. */
async function run<T = any>(
  admin: AdminClient,
  label: string,
  query: string,
  variables: Record<string, unknown>,
  root: string,
  timeoutMs: number,
): Promise<T | null> {
  let body: any;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      // Raced so the cap holds even if the client ignores the signal.
      reject(new ShopifyGraphqlError(`${label} timed out after ${timeoutMs}ms.`, false));
    }, timeoutMs);
  });
  // The timer can fire after the race already settled (e.g. while res.json()
  // is still pending); without a handler that rejection would be unhandled.
  timeout.catch(() => {});
  try {
    const res = await Promise.race([
      admin.graphql(query, { variables, signal: controller.signal }),
      timeout,
    ]);
    // The body read is under the same cap: a stalled response stream must
    // not hold the call (or the lease window) open past timeoutMs.
    body = await Promise.race([res.json(), timeout]);
  } catch (err: any) {
    if (err instanceof ShopifyGraphqlError) throw err;
    // A lease fence refuses inside admin.graphql; ownership loss is never a
    // Shopify failure and must reach callers as OwnershipLostError.
    if (err instanceof OwnershipLostError) throw err;
    // The client throws on HTTP failures and (depending on version) on
    // GraphQL errors; surface whatever detail it carries.
    const detail = err?.body?.errors ?? err?.response?.errors ?? err?.message ?? err;
    throw new ShopifyGraphqlError(`${label} failed: ${describeErrors(detail)}`, false);
  } finally {
    clearTimeout(timer!);
  }

  if (body?.errors && (!Array.isArray(body.errors) || body.errors.length)) {
    throw new ShopifyGraphqlError(`${label} failed: ${describeErrors(body.errors)}`, false);
  }

  return (body?.data?.[root] ?? null) as T | null;
}

/**
 * Runs a GraphQL operation and returns `data[root]`.
 *
 * @param root        Top-level field whose payload must be present.
 * @param userErrorsKey  Field on the payload holding user errors
 *                    ("userErrors" by default; orderCancel uses
 *                    "orderCancelUserErrors"). Pass null for queries.
 * @param timeoutMs   Abort the call after this long (default GQL_TIMEOUT_MS).
 */
export async function gql<T = any>(
  admin: AdminClient,
  label: string,
  query: string,
  variables: Record<string, unknown>,
  root: string,
  userErrorsKey: string | null = "userErrors",
  timeoutMs: number = GQL_TIMEOUT_MS,
): Promise<T> {
  const payload = await run<T>(admin, label, query, variables, root, timeoutMs);
  if (payload === null) {
    throw new ShopifyGraphqlError(`${label} returned no ${root} payload.`, false);
  }

  if (userErrorsKey) {
    const userErrors = (payload as any)[userErrorsKey] ?? [];
    if (userErrors.length) {
      throw new ShopifyGraphqlError(`${label} rejected: ${describeErrors(userErrors)}`, true, userErrors);
    }
  }

  return payload;
}

/**
 * Like gql but for queries where a null root is a meaningful answer (a
 * deleted order, an expired calculated order): returns null instead of
 * throwing "no payload". Transport/top-level errors still throw. Queries
 * only — no userErrors checking.
 */
export async function gqlNullable<T = any>(
  admin: AdminClient,
  label: string,
  query: string,
  variables: Record<string, unknown>,
  root: string,
  timeoutMs: number = GQL_TIMEOUT_MS,
): Promise<T | null> {
  return run<T>(admin, label, query, variables, root, timeoutMs);
}
