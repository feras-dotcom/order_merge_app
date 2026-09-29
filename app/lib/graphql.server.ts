// ── Strict Shopify Admin GraphQL access ───────────────────────────────────────
// Every merge-path call goes through gql(): a transport failure, a top-level
// GraphQL error (access denied, throttling, schema mismatch), a missing
// payload or any userErrors all throw. Callers never continue on a response
// they could not positively confirm.

export type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export class ShopifyGraphqlError extends Error {
  /** true when Shopify definitively rejected the operation (userErrors), so
   *  it is known NOT to have been applied. false for transport / top-level
   *  errors, where the outcome of a mutation is unknown. */
  readonly rejected: boolean;

  constructor(message: string, rejected: boolean) {
    super(message);
    this.name = "ShopifyGraphqlError";
    this.rejected = rejected;
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

/**
 * Runs a GraphQL operation and returns `data[root]`.
 *
 * @param root        Top-level field whose payload must be present.
 * @param userErrorsKey  Field on the payload holding user errors
 *                    ("userErrors" by default; orderCancel uses
 *                    "orderCancelUserErrors"). Pass null for queries.
 */
export async function gql<T = any>(
  admin: AdminClient,
  label: string,
  query: string,
  variables: Record<string, unknown>,
  root: string,
  userErrorsKey: string | null = "userErrors",
): Promise<T> {
  let body: any;
  try {
    const res = await admin.graphql(query, { variables });
    body = await res.json();
  } catch (err: any) {
    // The client throws on HTTP failures and (depending on version) on
    // GraphQL errors; surface whatever detail it carries.
    const detail = err?.body?.errors ?? err?.response?.errors ?? err?.message ?? err;
    throw new ShopifyGraphqlError(`${label} failed: ${describeErrors(detail)}`, false);
  }

  if (body?.errors && (!Array.isArray(body.errors) || body.errors.length)) {
    throw new ShopifyGraphqlError(`${label} failed: ${describeErrors(body.errors)}`, false);
  }

  const payload = body?.data?.[root];
  if (payload === undefined || payload === null) {
    throw new ShopifyGraphqlError(`${label} returned no ${root} payload.`, false);
  }

  if (userErrorsKey) {
    const userErrors = payload[userErrorsKey] ?? [];
    if (userErrors.length) {
      throw new ShopifyGraphqlError(`${label} rejected: ${describeErrors(userErrors)}`, true);
    }
  }

  return payload as T;
}
