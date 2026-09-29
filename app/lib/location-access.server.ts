import { gql, type AdminClient } from "./graphql.server";
import { LOCATION_SCOPES } from "./eligibility";

export interface LocationAccess {
  /** null when the count could not be read. */
  activeLocationCount: number | null;
  /** Every optional location scope is granted. */
  granted: boolean;
  /** Multi-location store without location access: automation cannot merge. */
  blocked: boolean;
}

/**
 * Shared by the dashboard and Settings so both show the same state. Mirrors
 * the merge engine's rule: multi-location stores need the optional location
 * scopes (see resolveMergeLocation in merge.server.ts).
 */
export async function getLocationAccess(
  admin: AdminClient,
  scopes: { query: () => Promise<{ granted: string[] }> },
  shop: string,
): Promise<LocationAccess> {
  let granted = false;
  try {
    const current = (await scopes.query()).granted;
    granted = LOCATION_SCOPES.every((scope) => current.includes(scope));
  } catch (err: any) {
    console.warn(`[location-access] Could not query scopes for ${shop}: ${err?.message}`);
  }

  let activeLocationCount: number | null = null;
  try {
    const result = await gql<{ count: number }>(
      admin,
      "Count locations",
      `#graphql
        query LocationAccessCount {
          locationsCount(query: "active:true") { count }
        }`,
      {},
      "locationsCount",
      null,
    );
    activeLocationCount = result.count;
  } catch (err: any) {
    console.warn(`[location-access] Could not count locations for ${shop}: ${err?.message}`);
  }

  const multiLocation = activeLocationCount !== null && activeLocationCount > 1;
  return { activeLocationCount, granted, blocked: multiLocation && !granted };
}
