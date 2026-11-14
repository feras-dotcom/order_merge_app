import type { ActionFunctionArgs } from "@remix-run/node";
import { handleCheckoutEligibilityWebhook } from "../lib/checkout-discount/webhook.server";

export const action = async ({ request }: ActionFunctionArgs) =>
  handleCheckoutEligibilityWebhook(request, "ORDERS_CANCELLED");
