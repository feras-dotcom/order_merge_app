// spikes/checkout-shipping-discount/extension/src/dest-key.ts
var NON_LETTER = /[^\p{L}\p{N}\s]/gu;
var normAddressLine = (line) => line?.toLowerCase().replace(NON_LETTER, "").replace(/\s+/g, " ").trim() ?? "";
var normMethod = (title) => title?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
var SEP = "";
function destKey(addr) {
  if (addr == null)
    return null;
  const f = [
    addr.firstName,
    addr.lastName,
    addr.company,
    addr.address1,
    addr.address2,
    addr.city,
    addr.provinceCode,
    addr.zip,
    addr.countryCode
  ].map(normAddressLine);
  const address1 = f[3];
  const city = f[5];
  const zip = f[7];
  const country = f[8];
  if (!address1 || !city || !zip || !country)
    return null;
  return f.join(SEP);
}

// spikes/checkout-shipping-discount/extension/src/cart_delivery_options_discounts_generate_run.ts
var EMPTY = { operations: [] };
var isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
var asJson = (jsonValue) => typeof jsonValue === "string" ? tryParse(jsonValue) : jsonValue;
var tryParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return void 0;
  }
};
var EXP_FORMAT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
var DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
var validRec = (r) => isObj(r) && typeof r.id === "string" && typeof r.win === "string" && typeof r.dest === "string" && typeof r.method === "string" && typeof r.cur === "string" && Number.isInteger(r.left) && r.left > 0 && typeof r.exp === "string" && EXP_FORMAT.test(r.exp);
function cartDeliveryOptionsDiscountsGenerateRun(input) {
  try {
    return run(input);
  } catch {
    return EMPTY;
  }
}
function run(input) {
  if (!isObj(input))
    return EMPTY;
  const discount = isObj(input.discount) ? input.discount : void 0;
  const classes = discount?.discountClasses;
  if (!Array.isArray(classes) || !classes.includes("SHIPPING"))
    return EMPTY;
  const cfg = asJson(isObj(discount?.metafield) ? discount.metafield.jsonValue : void 0);
  if (!isObj(cfg) || cfg.v !== 1)
    return EMPTY;
  if (typeof cfg.windowId !== "string" || typeof cfg.message !== "string")
    return EMPTY;
  if (typeof cfg.percentage !== "string" || !DECIMAL.test(cfg.percentage))
    return EMPTY;
  const pct = Number(cfg.percentage);
  if (!(pct > 0 && pct <= 100))
    return EMPTY;
  const shop = isObj(input.shop) ? input.shop : void 0;
  const localTime = isObj(shop?.localTime) ? shop.localTime : void 0;
  if (localTime?.inWindow !== true || typeof localTime.date !== "string")
    return EMPTY;
  const today = localTime.date;
  const cart = isObj(input.cart) ? input.cart : void 0;
  const buyer = isObj(cart?.buyerIdentity) ? cart.buyerIdentity : void 0;
  if (buyer?.isAuthenticated !== true || !isObj(buyer.customer))
    return EMPTY;
  const customer = buyer.customer;
  const groups = cart?.deliveryGroups;
  if (!Array.isArray(groups) || groups.length !== 1)
    return EMPTY;
  const group = groups[0];
  if (!isObj(group))
    return EMPTY;
  const gDest = destKey(isObj(group.deliveryAddress) ? group.deliveryAddress : void 0);
  if (gDest === null)
    return EMPTY;
  const elig = asJson(isObj(customer.metafield) ? customer.metafield.jsonValue : void 0);
  if (!isObj(elig) || elig.v !== 1 || !Array.isArray(elig.recs))
    return EMPTY;
  const options = Array.isArray(group.deliveryOptions) ? group.deliveryOptions : [];
  const matchHandles = (rec) => options.filter(
    (o) => isObj(o) && o.deliveryMethodType === "SHIPPING" && typeof o.title === "string" && normMethod(o.title) === rec.method && isObj(o.cost) && o.cost.currencyCode === rec.cur && typeof o.handle === "string"
  ).map((o) => o.handle);
  let best = null;
  for (const raw of elig.recs) {
    if (!validRec(raw))
      continue;
    if (raw.win !== cfg.windowId || raw.exp < today || raw.dest !== gDest)
      continue;
    const handles = matchHandles(raw);
    if (handles.length === 0)
      continue;
    if (best === null || raw.exp < best.rec.exp || raw.exp === best.rec.exp && raw.id < best.rec.id) {
      best = { rec: raw, handles };
    }
  }
  if (best === null)
    return EMPTY;
  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          selectionStrategy: "ALL",
          candidates: [
            {
              targets: best.handles.map((handle) => ({ deliveryOption: { handle } })),
              value: { percentage: { value: cfg.percentage } },
              message: cfg.message
            }
          ]
        }
      }
    ]
  };
}
function generateDeliveryRun(input) {
  return cartDeliveryOptionsDiscountsGenerateRun(input);
}
export {
  cartDeliveryOptionsDiscountsGenerateRun,
  generateDeliveryRun
};
