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
import {
  getSettings,
  setCheckoutDiscountEnabled,
  setCheckoutDiscountNodeId,
  type MergeSettings,
} from "../settings.server";
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
          appDiscountType { functionId app { id } }
          combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        }
      }
      metafield(namespace: "$app", key: "config") { jsonValue }
    }
    currentAppInstallation { app { id } }
  }`;

// Emergency-shutdown verification read: ONLY the status. Deliberately never
// selects the config metafield — a missing/malformed config must not block
// stopping checkout discounting.
const Q_STATUS = `#graphql
  query CheckoutDiscountStatus($id: ID!) {
    automaticDiscountNode(id: $id) {
      id
      automaticDiscount {
        __typename
        ... on DiscountAutomaticApp { status }
      }
    }
  }`;

const Q_SHOP_TZ = `#graphql
  query CheckoutShopTimezone {
    shop { ianaTimezone }
  }`;

const DISCOUNT_NODE_ID = /^gid:\/\/shopify\/DiscountAutomaticNode\/\d+$/;

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
  typename: string;
  /** The appDiscountType's owning App id (null when not an app discount). */
  appId: string | null;
  /** True when appDiscountType.app.id === currentAppInstallation.app.id —
   *  live-validated on Admin 2026-04. */
  ownsThisApp: boolean;
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
      __typename?: string;
      title?: string;
      status?: string;
      startsAt?: string | null;
      endsAt?: string | null;
      appDiscountType?: { functionId?: string; app?: { id?: string } | null } | null;
      combinesWith?: {
        orderDiscounts?: boolean;
        productDiscounts?: boolean;
        shippingDiscounts?: boolean;
      } | null;
    } | null;
    metafield?: { jsonValue?: unknown } | null;
  } | null;
  currentAppInstallation?: { app?: { id?: string } | null } | null;
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
  const appId = d.appDiscountType?.app?.id ?? null;
  return {
    status: d.status ?? "UNKNOWN",
    typename: d.__typename ?? "UNKNOWN",
    appId,
    ownsThisApp:
      appId !== null && appId === (data?.currentAppInstallation?.app?.id ?? null),
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

/** Shutdown order (E): NEVER depends on the config metafield — it may be
 *  missing or malformed and must not block stopping checkout discounting.
 *  1. Validate the node-id shape before any Admin call.
 *  2. discountAutomaticDeactivate — always, no pre-read (idempotent;
 *     userErrors such as "already inactive" cannot by themselves fail the
 *     shutdown; a transport error is recorded and does not prevent 3).
 *  3. Independently verify with the status-only read: verified when status
 *     is EXPIRED or the node no longer exists (DELETED — a deleted discount
 *     cannot grant). Anything else — ACTIVE, SCHEDULED, a wrong __typename,
 *     an unreadable read — throws ShutdownNotVerifiedError and leaves the
 *     app flag untouched (it stays on so the failure stays visible and the
 *     sweeper retries).
 *  4. Only after verification, clear the app's opt-in flag.
 * Idempotent. */
export async function shutdownCheckoutDiscount(
  deps: CheckoutControlDeps,
): Promise<{ status: "EXPIRED" | "DELETED" }> {
  if (!DISCOUNT_NODE_ID.test(deps.discountId)) {
    throw new DiscountStateError(`invalid discount node id ${deps.discountId}`);
  }
  let deactivateError: string | null = null;
  try {
    await gqlData(deps.admin, "Deactivate checkout discount", M_DEACTIVATE, {
      id: deps.discountId,
    });
    // userErrors are intentionally not inspected: "already inactive" and
    // friends cannot themselves fail the shutdown — step 3's independent
    // status read is the only authority.
  } catch (err: any) {
    deactivateError = err?.message ?? String(err);
  }
  let status: string | null = null;
  let verifyError: string | null = null;
  try {
    const data = await gqlData<{
      automaticDiscountNode?: {
        automaticDiscount?: { __typename?: string; status?: string } | null;
      } | null;
    }>(deps.admin, "Verify checkout discount status", Q_STATUS, { id: deps.discountId });
    const node = data?.automaticDiscountNode;
    if (!node) {
      status = "DELETED";
    } else if (node.automaticDiscount?.__typename === "DiscountAutomaticApp") {
      status = node.automaticDiscount.status ?? null;
    }
  } catch (err: any) {
    verifyError = err?.message ?? String(err);
  }
  if (status === "EXPIRED" || status === "DELETED") {
    await doSetEnabled(deps, false);
    return { status };
  }
  const parts = [
    `discount status after deactivate is ${status ?? "unreadable"}, not EXPIRED`,
  ];
  if (deactivateError) parts.push(`deactivate failed: ${deactivateError}`);
  if (verifyError) parts.push(`verification read failed: ${verifyError}`);
  throw new ShutdownNotVerifiedError(`${parts.join("; ")} — app flags left untouched`);
}

/** Stage the discount config for a fresh enable (E): requires the discount
 *  to be currently INACTIVE, flips the app flag (stamping a fresh enable
 *  epoch), derives `windowId = w<epochMs>` from the read-back epoch, merges
 *  it into the discount's existing config via discountAutomaticAppUpdate
 *  and re-reads it. The discount is LEFT INACTIVE; activate is a separate
 *  step. */
export async function prepareEnable(
  deps: CheckoutControlDeps & {
    readEnabledAt?: (shop: string) => Promise<Date | null>;
    recordDiscountId?: (shop: string, id: string | null) => Promise<void>;
  },
): Promise<{ windowId: string; enabledAt: Date }> {
  const current = await readCheckoutDiscount(deps.admin, deps.discountId);
  if (!current) throw new DiscountStateError("checkout discount not found");
  if (current.status === "ACTIVE" || current.status === "SCHEDULED") {
    throw new DiscountStateError(
      `discount must be inactive to prepare-enable (status ${current.status})`,
    );
  }
  // Identity proof BEFORE anything is enabled: the node must be a
  // DiscountAutomaticApp owned by THIS app (appDiscountType.app.id ===
  // currentAppInstallation.app.id — live-validated on 2026-04) carrying
  // our checkout message, so an operator typo for someone else's discount
  // can never be recorded or activated.
  if (current.typename !== "DiscountAutomaticApp") {
    throw new DiscountStateError(
      `discount node is a ${current.typename}, not a DiscountAutomaticApp — refusing to enable`,
    );
  }
  if (!current.ownsThisApp) {
    throw new DiscountStateError(
      "discount is not owned by this app (appDiscountType.app.id mismatch) — refusing to enable",
    );
  }
  if (current.message !== CHECKOUT_DISCOUNT_MESSAGE) {
    throw new DiscountStateError(
      "discount config message does not match CHECKOUT_DISCOUNT_MESSAGE — refusing to enable",
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
  // Record the verified discount identity — the only node the shutdown
  // enforcer and the default CLI id may ever touch.
  await (deps.recordDiscountId ?? setCheckoutDiscountNodeId)(deps.shop, deps.discountId);
  return { windowId, enabledAt: epoch };
}

/** Shop-local `YYYY-MM-DDTHH:MM:SS` (no timezone) for `now` in `timeZone`,
 *  matching the DateTimeWithoutTimezone config format so a string compare
 *  is a time compare. */
export function shopLocalNow(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

const shopIanaTimezone = async (admin: AdminClient): Promise<string> => {
  const data = await gqlData<{ shop?: { ianaTimezone?: string } }>(
    admin,
    "Read shop timezone",
    Q_SHOP_TZ,
    {},
  );
  const tz = data?.shop?.ianaTimezone;
  if (!tz) throw new DiscountStateError("shop ianaTimezone unreadable");
  return tz;
};

/** Activate the staged discount (E): a FRESH read must prove, all before
 *  the mutation — the stored config validates and its windowId equals BOTH
 *  `expectedWindowId` AND the current gate's windowId (three-way equality
 *  rules out a stale config from a previous epoch); the config message is
 *  exactly CHECKOUT_DISCOUNT_MESSAGE; the percentage is a string decimal in
 *  (0, 100]; the stored window contains the shop-local now; and the node
 *  id is the recorded checkoutDiscountNodeId (no recorded id → "run
 *  prepare-enable first"). Requires the post-mutation status to be ACTIVE. */
export async function activateCheckoutDiscount(
  deps: CheckoutControlDeps & {
    expectedWindowId: string;
    readSettings?: (shop: string) => Promise<MergeSettings>;
    now?: () => Date;
    shopTimezone?: string;
  },
): Promise<{ status: string }> {
  const current = await readCheckoutDiscount(deps.admin, deps.discountId);
  if (!current) throw new DiscountStateError("checkout discount not found");
  const settings = await (deps.readSettings ?? getSettings)(deps.shop);
  if (!settings.checkoutDiscountNodeId) {
    throw new DiscountStateError(
      "no checkout discount node id recorded — run prepare-enable first",
    );
  }
  if (settings.checkoutDiscountNodeId !== deps.discountId) {
    throw new DiscountStateError(
      `discount id ${deps.discountId} does not match the recorded ${settings.checkoutDiscountNodeId} — refusing to activate an unrelated discount`,
    );
  }
  const gate = await (deps.gate ?? ((s: string) => checkoutDiscountGate(s)))(deps.shop);
  if (!gate.on) {
    throw new DiscountStateError(`app gate is not on (${!gate.on ? gate.reason : "?"}) — refusing to activate`);
  }
  if (
    current.windowId !== deps.expectedWindowId ||
    gate.windowId !== deps.expectedWindowId
  ) {
    throw new DiscountStateError(
      `windowId mismatch (stored ${current.windowId}, expected ${deps.expectedWindowId}, gate ${gate.windowId}) — refusing to activate`,
    );
  }
  if (current.message !== CHECKOUT_DISCOUNT_MESSAGE) {
    throw new DiscountStateError(
      "config message does not match CHECKOUT_DISCOUNT_MESSAGE — refusing to activate",
    );
  }
  const pct = Number(current.percentage);
  if (!(pct > 0 && pct <= 100)) {
    throw new DiscountStateError(
      `config percentage ${current.percentage} out of range (0, 100] — refusing to activate`,
    );
  }
  const tz = deps.shopTimezone ?? (await shopIanaTimezone(deps.admin));
  const localNow = shopLocalNow(deps.now?.() ?? new Date(), tz);
  if (!(current.windowStart <= localNow && localNow < current.windowEnd)) {
    throw new DiscountStateError(
      `config window ${current.windowStart}..${current.windowEnd} does not contain shop-local now ${localNow} (${tz}) — refusing to activate`,
    );
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
