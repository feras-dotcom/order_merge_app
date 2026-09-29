import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { cancelSubscription, resolveShopGidByDomain } from "../lib/billing.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Shopify App Pricing does not terminate the subscription contract on
  // uninstall — it only marks it cancelAtEndOfCycle, so the old plan would
  // still be returned by activeSubscription after a reinstall and the merchant
  // would never re-approve a charge. Cancel it immediately so a reinstall
  // produces the canonical "no active subscription" state.
  //
  // The Admin API token is already revoked here, so the shop GID comes from
  // the Settings row written during normal app loads, with a Partner API
  // events lookup as fallback.
  const settings = await db.settings.findUnique({ where: { shop } });
  const shopGid =
    settings?.shopifyShopGid ?? (await resolveShopGidByDomain(shop));
  if (shopGid) {
    await cancelSubscription(shopGid);
  }

  // A reinstall is a new install: automation must not silently resume, and
  // the merchant goes through setup (plan, locations, acknowledgement) again.
  // The merge window and combine history are kept.
  await db.settings.updateMany({
    where: { shop },
    data: { autoMergeEnabled: false, onboardingStartedAt: null, onboardingCompletedAt: null },
  });

  return new Response();
};
