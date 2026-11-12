// cart.delivery-options.discounts.generate.run — shipping discount driven
// by an explicit per-customer eligibility record ($app:ship_elig). Runs on
// QuickJS/Javy: no Date.now/new Date/Math.random/fetch/Intl/process/Node
// APIs. Every malformed input returns { operations: [] } — never throws.
import { destKey, normMethod } from "./dest-key";

const EMPTY: { operations: unknown[] } = { operations: [] };

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const asJson = (jsonValue: unknown): unknown =>
  typeof jsonValue === "string" ? tryParse(jsonValue) : jsonValue;

const tryParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const EXP_FORMAT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

interface EligRec {
  id: string;
  win: string;
  dest: string;
  method: string;
  cur: string;
  left: number;
  exp: string;
}

const validRec = (r: unknown): r is EligRec =>
  isObj(r) &&
  typeof r.id === "string" &&
  typeof r.win === "string" &&
  typeof r.dest === "string" &&
  typeof r.method === "string" &&
  typeof r.cur === "string" &&
  Number.isInteger(r.left) &&
  (r.left as number) > 0 &&
  typeof r.exp === "string" &&
  EXP_FORMAT.test(r.exp);

export function cartDeliveryOptionsDiscountsGenerateRun(input: unknown): {
  operations: unknown[];
} {
  try {
    return run(input);
  } catch {
    return EMPTY;
  }
}

function run(input: unknown): { operations: unknown[] } {
  if (!isObj(input)) return EMPTY;
  const discount = isObj(input.discount) ? input.discount : undefined;
  const classes = discount?.discountClasses;
  if (!Array.isArray(classes) || !classes.includes("SHIPPING")) return EMPTY;

  const cfg = asJson(isObj(discount?.metafield) ? discount.metafield.jsonValue : undefined);
  if (!isObj(cfg) || cfg.v !== 1) return EMPTY;
  if (typeof cfg.windowId !== "string" || typeof cfg.message !== "string") return EMPTY;
  if (typeof cfg.percentage !== "string" || !DECIMAL.test(cfg.percentage)) return EMPTY;
  const pct = Number(cfg.percentage);
  if (!(pct > 0 && pct <= 100)) return EMPTY;

  const shop = isObj(input.shop) ? input.shop : undefined;
  const localTime = isObj(shop?.localTime) ? shop.localTime : undefined;
  if (localTime?.inWindow !== true || typeof localTime.date !== "string") return EMPTY;
  const today: string = localTime.date;

  const cart = isObj(input.cart) ? input.cart : undefined;
  const buyer = isObj(cart?.buyerIdentity) ? cart.buyerIdentity : undefined;
  if (buyer?.isAuthenticated !== true || !isObj(buyer.customer)) return EMPTY;
  const customer = buyer.customer;

  const groups = cart?.deliveryGroups;
  if (!Array.isArray(groups) || groups.length !== 1) return EMPTY;
  const group = groups[0];
  if (!isObj(group)) return EMPTY;
  const gDest = destKey(isObj(group.deliveryAddress) ? (group.deliveryAddress as never) : undefined);
  if (gDest === null) return EMPTY;

  const elig = asJson(isObj(customer.metafield) ? customer.metafield.jsonValue : undefined);
  if (!isObj(elig) || elig.v !== 1 || !Array.isArray(elig.recs)) return EMPTY;

  const options = Array.isArray(group.deliveryOptions) ? group.deliveryOptions : [];
  const matchHandles = (rec: EligRec): string[] =>
    options
      .filter(
        (o): o is Record<string, unknown> =>
          isObj(o) &&
          o.deliveryMethodType === "SHIPPING" &&
          typeof o.title === "string" &&
          normMethod(o.title) === rec.method &&
          isObj(o.cost) &&
          o.cost.currencyCode === rec.cur &&
          typeof o.handle === "string",
      )
      .map((o) => o.handle as string);

  let best: { rec: EligRec; handles: string[] } | null = null;
  for (const raw of elig.recs) {
    if (!validRec(raw)) continue;
    if (raw.win !== cfg.windowId || raw.exp < today || raw.dest !== gDest) continue;
    const handles = matchHandles(raw);
    if (handles.length === 0) continue;
    if (
      best === null ||
      raw.exp < best.rec.exp ||
      (raw.exp === best.rec.exp && raw.id < best.rec.id)
    ) {
      best = { rec: raw, handles };
    }
  }
  if (best === null) return EMPTY;

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          selectionStrategy: "ALL",
          candidates: [
            {
              targets: best.handles.map((handle) => ({ deliveryOption: { handle } })),
              value: { percentage: { value: cfg.percentage } },
              message: cfg.message,
            },
          ],
        },
      },
    ],
  };
}

// The extension toml names the WASI export "generate-delivery-run"; the
// bundler maps it to this camel-case JS export. The spec-mandated name is
// kept as the primary export and aliases the same implementation.
export function generateDeliveryRun(input: unknown) {
  return cartDeliveryOptionsDiscountsGenerateRun(input);
}
