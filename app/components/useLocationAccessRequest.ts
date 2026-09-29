import { useState } from "react";
import { useRevalidator } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { LOCATION_SCOPES } from "../lib/eligibility";

/** Opens Shopify's permission modal for the optional location scopes, then
 *  reloads loader data so the page reflects the merchant's choice. */
export function useLocationAccessRequest() {
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [requesting, setRequesting] = useState(false);

  const request = async () => {
    setRequesting(true);
    try {
      const response = await shopify.scopes.request(LOCATION_SCOPES);
      if (response.result === "granted-all") shopify.toast.show("Location access allowed");
      revalidator.revalidate();
    } catch {
      shopify.toast.show("Could not request location access", { isError: true });
    } finally {
      setRequesting(false);
    }
  };

  return { request, requesting };
}
