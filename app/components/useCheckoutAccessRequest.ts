import { useState } from "react";
import { useRevalidator } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";

export const CHECKOUT_SCOPES = ["write_customers", "write_discounts"];

/** Opens Shopify's permission modal for the optional checkout-discount
 *  scopes, then reloads loader data so the page reflects the merchant's
 *  choice. Sibling of useLocationAccessRequest — same pattern, different
 *  scopes; the location flow is untouched. */
export function useCheckoutAccessRequest() {
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [requesting, setRequesting] = useState(false);

  const request = async () => {
    setRequesting(true);
    try {
      const response = await shopify.scopes.request(CHECKOUT_SCOPES);
      if (response.result === "granted-all") {
        shopify.toast.show("Checkout discount access allowed");
      }
      revalidator.revalidate();
    } catch {
      shopify.toast.show("Could not request checkout discount access", { isError: true });
    } finally {
      setRequesting(false);
    }
  };

  return { request, requesting };
}
