// A faithful offline Admin client for the projection tests: models the
// customer $app:ship_elig metafield, per-metafield compareDigest (digest =
// hash of the stored value string) and metafieldsSet CAS semantics, with a
// deterministic interleaving hook that lets tests force collisions between
// a writer's read and commit.
import { ELIG_KEY, ELIG_NAMESPACE } from "./records";

const digestOf = (value: string): string => {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return `d${value.length}:${(h >>> 0).toString(16)}`;
};

type Hook = () => Promise<void> | void;

export function makeFakeEligibilityAdmin() {
  const store = new Map<string, { id: string; jsonValue: unknown; compareDigest: string }>();
  const writes: { ownerId: string; value: string }[] = [];
  let beforeCommit: Hook = async () => {};

  const setMetafield = (ownerId: string, value: string) => {
    const mf = {
      id: `gid://shopify/Metafield/${store.size + 1}`,
      jsonValue: JSON.parse(value),
      compareDigest: digestOf(value),
    };
    store.set(`${ownerId}:${ELIG_NAMESPACE}:${ELIG_KEY}`, mf);
    return mf;
  };

  const admin = {
    writes,
    callCount: 0,
    setInterleaveHook(h: Hook) {
      beforeCommit = h;
    },
    stored(ownerId: string) {
      return store.get(`${ownerId}:${ELIG_NAMESPACE}:${ELIG_KEY}`)?.jsonValue;
    },
    async graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<unknown> {
      this.callCount += 1;
      const vars = options?.variables ?? {};
      if (query.includes("EligibilityProjectionRead")) {
        const ownerId = vars.ownerId as string;
        const mf = store.get(`${ownerId}:${ELIG_NAMESPACE}:${ELIG_KEY}`) ?? null;
        return { data: { customer: { metafield: mf ? { ...mf } : null } } };
      }
      if (query.includes("metafieldsSet")) {
        // Interleaving point: another writer may commit between our read
        // and this CAS write. The hook fires before the staleness check,
        // once, then self-disarms so a recursive write inside it terminates.
        const h = beforeCommit;
        beforeCommit = async () => {};
        await h();
        const inputs = (vars.metafields ?? []) as Record<string, unknown>[];
        const userErrors: { code: string; field: string[]; message: string; elementIndex: number }[] = [];
        for (let i = 0; i < inputs.length; i++) {
          const inp = inputs[i];
          const ownerId = inp.ownerId as string;
          const k = `${ownerId}:${inp.namespace}:${inp.key}`;
          const cur = store.get(k) ?? null;
          const want = inp.compareDigest;
          const actual = cur ? cur.compareDigest : null;
          if (want !== undefined && want !== actual) {
            userErrors.push({
              code: "STALE_OBJECT",
              field: ["metafields", String(i), "compareDigest"],
              message: "The metafield has been modified since it was loaded.",
              elementIndex: i,
            });
          }
        }
        if (userErrors.length === 0) {
          for (const inp of inputs) {
            setMetafield(inp.ownerId as string, String(inp.value));
            writes.push({ ownerId: inp.ownerId as string, value: String(inp.value) });
          }
        }
        return { data: { metafieldsSet: { metafields: userErrors.length ? [] : inputs.map((_, i) => ({ id: `m${i}` })), userErrors } } };
      }
      throw new Error(`fake admin: unhandled query: ${query.slice(0, 80)}`);
    },
  };
  return admin;
}
