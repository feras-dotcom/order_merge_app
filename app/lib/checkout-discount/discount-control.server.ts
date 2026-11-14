// Operator control for the Shopify automatic discount that runs the
// checkout Function (E). CRITICAL DISTINCTION: the app-side gate only
// controls whether the APP projects/consumes/revokes eligibility records —
// it does NOT stop checkout discounting. Only the Shopify automatic
// discount's own status does: a deactivated discount (status EXPIRED) is
// the only thing that stops the Function from discounting. Shutdown must
// therefore deactivate the Shopify discount FIRST, verify it, and only
// then flip the app flags; enable must stage the config while INACTIVE and
// only activate after the stored windowId matches the fresh enable epoch.
//
// Field shapes are taken from the live-validated spike documents
// (spikes/checkout-shipping-discount/experiments/{queries,discount-state,
// setup-discount}.ts): automaticDiscountNode(id){ automaticDiscount {
// ... on DiscountAutomaticApp } metafield("$app","config") },
// discountAutomaticDeactivate/Activate(id:), discountAutomaticAppUpdate(
// id:, automaticAppDiscount:{ metafields:[...] }).
import { gqlData, type AdminClient } from "../graphql.server";
import { getSettings, setCheckoutDiscountEnabled } from "../settings.server";
import { checkoutDiscountGate, type CheckoutGateResult } from "./gate.server";
import { CHECKOUT_DISCOUNT_MESSAGE, checkoutDiscountWindowId } from "./config";

export class ShutdownNotVerifiedError extends Error {}
export class DiscountConfigError extends Error {}
export class DiscountStateError extends Error {}

const Q_DISCOUNT = `#graphql
  query CheckoutDiscountControl($id: ID!) {
    automaticDiscountNode(id: $id) {
      id
      automaticDiscount {
        __typename
        ... on DiscountAutomaticApp {
          title
          status
          startsAt
          endsAt
          appDiscountType { functionId }
          combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        }
      }
      metafield(namespace: "$app", key: "config") { jsonValue }
    }
  }`;

const M_DEACTIVATE = `#graphql
  mutation CheckoutDiscountDeactivate($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }`;

const M_ACTIVATE = `#graphql
  mutation CheckoutDiscountActivate($id: ID!) {
    discountAutomaticActivate(id: $id) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }`;

const M_UPDATE = `#graphql
  mutation CheckoutDiscountUpdate($id: ID!, $input: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $input) {
      automaticAppDiscount { discountId status }
      userErrors { field message }
    }
  }`;

export interface CheckoutDiscountConfig {
  v: number;
  windowId: string;
  percentage: string;
  message: string;
  windowStart: string;
  windowEnd: string;
  [k: string]: unknown;
}

export interface CheckoutDiscountState {
  status: string;
  title: string;
  functionId: string;
  startsAt: string | null;
  endsAt: string | null;
  combinesWith: {
    orderDiscounts: boolean;
    productDiscounts: boolean;
    shippingDiscounts: boolean;
  };
  windowId: string;
  percentage: string;
  message: string;
  windowStart: string;
  windowEnd: string;
  config: CheckoutDiscountConfig;
}

const NO_TZ_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

/** Config validation shared by every control path (E1): percentage is a
 *  STRING decimal ("100.0" — a numeric 100 is silently ignored by the
 *  Function), windowStart/windowEnd are DateTimeWithoutTimezone values
 *  `YYYY-MM-DDTHH:MM:SS` shop-local (a bare date or a tz-bearing value is
 *  invalid), message equals CHECKOUT_DISCOUNT_MESSAGE in the config the
 *  operator writes. */
export function validateCheckoutConfig(raw: unknown): CheckoutDiscountConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (c.v !== 1) throw new DiscountConfigError("config.v must be 1");
  if (typeof c.windowId !== "string" || c.windowId.length === 0) {
    throw new DiscountConfigError("config.windowId must be a string");
  }
  if (typeof c.percentage !== "string" || !DECIMAL.test(c.percentage)) {
    throw new DiscountConfigError("config.percentage must be a string decimal (e.g. \"100.0\")");
  }
  if (typeof c.message !== "string" || c.message.length === 0) {
    throw new DiscountConfigError("config.message must be a string");
  }
  if (typeof c.windowStart !== "string" || !NO_TZ_DATETIME.test(c.windowStart)) {
    throw new DiscountConfigError("config.windowStart must be a no-timezone YYYY-MM-DDTHH:MM:SS value");
  }
  if (typeof c.windowEnd !== "string" || !NO_TZ_DATETIME.test(c.windowEnd)) {
    throw new DiscountConfigError("config.windowEnd must be a no-timezone YYYY-MM-DDTHH:MM:SS value");
  }
  return c as CheckoutDiscountConfig;
}

interface DiscountNodeData {
  automaticDiscountNode: {
    id: string;
    automaticDiscount: {
      title?: string;
      status?: string;
      startsAt?: string | null;
      endsAt?: string | null;
      appDiscountType?: { functionId?: string } | null;
      combinesWith?: {
        orderDiscounts?: boolean;
        productDiscounts?: boolean;
        shippingDiscounts?: boolean;
      } | null;
    } | null;
    metafield?: { jsonValue?: unknown } | null;
  } | null;
}

const readNode = async (admin: AdminClient, discountId: string) =>
  gqlData<DiscountNodeData>(admin, "Read checkout discount", Q_DISCOUNT, { id: discountId });

/** Current discount state + parsed config; null when the node does not
 *  exist or is not a DiscountAutomaticApp. Throws DiscountConfigError on a
 *  missing/invalid config (a discount without config cannot be trusted). */
export async function readCheckoutDiscount(
  admin: AdminClient,
  discountId: string,
): Promise<CheckoutDiscountState | null> {
  const data = await readNode(admin, discountId);
  const node = data?.automaticDiscountNode;
  if (!node || !node.automaticDiscount) return null;
  const d = node.automaticDiscount;
  const config = validateCheckoutConfig(node.metafield?.jsonValue);
  return {
    status: d.status ?? "UNKNOWN",
    title: d.title ?? "",
    functionId: d.appDiscountType?.functionId ?? "",
    startsAt: d.startsAt ?? null,
    endsAt: d.endsAt ?? null,
    combinesWith: {
      orderDiscounts: d.combinesWith?.orderDiscounts ?? false,
      productDiscounts: d.combinesWith?.productDiscounts ?? false,
      shippingDiscounts: d.combinesWith?.shippingDiscounts ?? false,
    },
    windowId: config.windowId,
    percentage: config.percentage,
    message: config.message,
    windowStart: config.windowStart,
    windowEnd: config.windowEnd,
    config,
  };
}

export interface CheckoutControlDeps {
  admin: AdminClient;
  shop: string;
  discountId: string;
  setEnabled?: (shop: string, enabled: boolean) => Promise<void>;
  gate?: (shop: string) => Promise<CheckoutGateResult>;
}

const doSetEnabled = async (
  deps: Pick<CheckoutControlDeps, "shop" | "setEnabled">,
  enabled: boolean,
) => (deps.setEnabled ?? setCheckoutDiscountEnabled)(deps.shop, enabled);

/** Shutdown order (E): deactivate the Shopify discount FIRST, require the
 *  verified EXPIRED status, and only then flip the app flag. App flags are
 *  never touched when deactivation or verification fails. Idempotent when
 *  the discount is already inactive. */
export async function shutdownCheckoutDiscount(
  deps: CheckoutControlDeps,
): Promise<{ status: string }> {
  const current = await readCheckoutDiscount(deps.admin, deps.discountId);
  if (current && current.status === "EXPIRED") {
    await doSetEnabled(deps, false);
    return { status: "EXPIRED" };
  }
  const res = await gqlData<{ discountAutomaticDeactivate?: { userErrors?: { message: string }[] } }>(
    deps.admin,
    "Deactivate checkout discount",
    M_DEACTIVATE,
    { id: deps.discountId },
  );
  const errs = res?.discountAutomaticDeactivate?.userErrors ?? [];
  if (errs.length) {
    throw new DiscountStateError(`deactivate userErrors: ${JSON.stringify(errs)}`);
  }
  const after = await readCheckoutDiscount(deps.admin, deps.discountId);
  if (!after || after.status !== "EXPIRED") {
    throw new ShutdownNotVerifiedError(
      `discount status after deactivate is ${after?.status ?? "unreadable"}, not EXPIRED — app flags left untouched`,
    );
  }
  await doSetEnabled(deps, false);
  return { status: "EXPIRED" };
}

/** Stage the discount config for a fresh enable (E): requires the discount
 *  to be currently INACTIVE, flips the app flag (stamping a fresh enable
 *  epoch), derives `windowId = w<epochMs>` from the read-back epoch, merges
 *  it into the discount's existing config via discountAutomaticAppUpdate
 *  and re-reads it. The discount is LEFT INACTIVE; activate is a separate
 *  step. */
export async function prepareEnable(
  deps: CheckoutControlDeps & { readEnabledAt?: (shop: string) => Promise<Date | null> },
): Promise<{ windowId: string; enabledAt: Date }> {
  const current = await readCheckoutDiscount(deps.admin, deps.discountId);
  if (!current) throw new DiscountStateError("checkout discount not found");
  if (current.status === "ACTIVE" || current.status === "SCHEDULED") {
    throw new DiscountStateError(
      `discount must be inactive to prepare-enable (status ${current.status})`,
    );
  }
  await doSetEnabled(deps, true);
  const readEpoch =
    deps.readEnabledAt ??
    (async (shop: string) => (await getSettings(shop)).checkoutDiscountEnabledAt);
  const enabledAt = await readEpoch(deps.shop);
  if (!enabledAt) {
    throw new DiscountStateError("shop enabled flag set but no enable epoch was stamped");
  }
  const epoch = enabledAt instanceof Date ? enabledAt : new Date(enabledAt);
  const windowId = checkoutDiscountWindowId(epoch);
  const config = { ...current.config, windowId };
  const res = await gqlData<{ discountAutomaticAppUpdate?: { userErrors?: { message: string }[] } }>(
    deps.admin,
    "Update checkout discount config",
    M_UPDATE,
    {
      id: deps.discountId,
      input: {
        title: current.title,
        functionId: current.functionId,
        discountClasses: ["SHIPPING"],
        startsAt: current.startsAt,
        endsAt: current.endsAt,
        combinesWith: current.combinesWith,
        metafields: [
          {
            namespace: "$app",
            key: "config",
            type: "json",
            value: JSON.stringify(config),
          },
        ],
      },
    },
  );
  const errs = res?.discountAutomaticAppUpdate?.userErrors ?? [];
  if (errs.length) {
    throw new DiscountStateError(`config update userErrors: ${JSON.stringify(errs)}`);
  }
  const after = await readCheckoutDiscount(deps.admin, deps.discountId);
  if (!after || after.windowId !== windowId) {
    throw new DiscountStateError(
      `config read-back windowId ${after?.windowId ?? "unreadable"} != ${windowId}`,
    );
  }
  return { windowId, enabledAt: epoch };
}

/** Activate the staged discount (E): refuses unless the stored config
 *  windowId equals `expectedWindowId` AND the app gate would be on — a
 *  stale config or a disabled app flag means this activation was never
 *  prepared. Requires the post-mutation status to be ACTIVE. */
export async function activateCheckoutDiscount(
  deps: CheckoutControlDeps & { expectedWindowId: string },
): Promise<{ status: string }> {
  const current = await readCheckoutDiscount(deps.admin, deps.discountId);
  if (!current) throw new DiscountStateError("checkout discount not found");
  if (current.windowId !== deps.expectedWindowId) {
    throw new DiscountStateError(
      `stored windowId ${current.windowId} does not match expected ${deps.expectedWindowId} — refusing to activate`,
    );
  }
  const gate = await (deps.gate ?? ((s: string) => checkoutDiscountGate(s)))(deps.shop);
  if (!gate.on) {
    throw new DiscountStateError(`app gate is not on (${!gate.on ? gate.reason : "?"}) — refusing to activate`);
  }
  const res = await gqlData<{ discountAutomaticActivate?: { userErrors?: { message: string }[] } }>(
    deps.admin,
    "Activate checkout discount",
    M_ACTIVATE,
    { id: deps.discountId },
  );
  const errs = res?.discountAutomaticActivate?.userErrors ?? [];
  if (errs.length) {
    throw new DiscountStateError(`activate userErrors: ${JSON.stringify(errs)}`);
  }
  const after = await readCheckoutDiscount(deps.admin, deps.discountId);
  if (!after || after.status !== "ACTIVE") {
    throw new DiscountStateError(
      `discount status after activate is ${after?.status ?? "unreadable"}, not ACTIVE`,
    );
  }
  return { status: "ACTIVE" };
}

export { CHECKOUT_DISCOUNT_MESSAGE };
