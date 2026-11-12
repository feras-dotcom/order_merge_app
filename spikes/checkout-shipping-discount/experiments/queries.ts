// GraphQL documents used by the Phase 2 experiment scripts. Each is
// validated against Admin/Storefront 2026-04 before use.
export const Q_SHOP = `query {
  shop {
    name
    currencyCode
    ianaTimezone
    customerAccounts
    plan { displayName partnerDevelopment shopifyPlus }
    billingAddress { country }
    paymentSettings { supportedDigitalWallets }
  }
  currentAppInstallation {
    accessScopes { handle }
    app { id title handle }
  }
}`;

export const Q_LOCATIONS = `query {
  locations(first: 10) { nodes { id name isActive } }
}`;

export const Q_PRODUCTS = `query {
  products(first: 10) {
    nodes {
      id title status
      variants(first: 5) {
        nodes { id title price inventoryItem { tracked requiresShipping } }
      }
    }
  }
}`;

export const Q_SHIPPING = `query {
  deliveryProfiles(first: 10) {
    nodes {
      id name default
      profileLocationGroups {
        locationGroupZones(first: 10) {
          nodes {
            zone { name countries { name code { restOfWorld countryCode } } }
            methodDefinitions(first: 20) {
              nodes {
                id name active
                rateProvider {
                  ... on DeliveryRateDefinition { price { amount currencyCode } }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export const M_DISCOUNT_CREATE = `mutation DCreate($input: DiscountAutomaticAppInput!) {
  discountAutomaticAppCreate(automaticAppDiscount: $input) {
    automaticAppDiscount {
      discountId
      title
      status
      startsAt
      endsAt
      appDiscountType { functionId title }
    }
    userErrors { field message }
  }
}`;

export const M_DISCOUNT_UPDATE = `mutation DUpdate($id: ID!, $input: DiscountAutomaticAppInput!) {
  discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $input) {
    automaticAppDiscount { discountId title status startsAt endsAt }
    userErrors { field message }
  }
}`;

export const Q_DISCOUNT = `query Discount($id: ID!) {
  automaticDiscountNode(id: $id) {
    id
    automaticDiscount {
      ... on DiscountAutomaticApp {
        title status startsAt endsAt
        appDiscountType { functionId title }
      }
    }
    metafield(namespace: "$app", key: "config") { jsonValue }
  }
}`;

export const M_CUSTOMER_CREATE = `mutation CCreate($input: CustomerInput!) {
  customerCreate(input: $input) {
    customer {
      id email firstName lastName
      defaultAddress { firstName lastName company address1 address2 city provinceCode zip countryCode }
    }
    userErrors { field message }
  }
}`;

export const Q_CUSTOMER_MF = `query Cmf($id: ID!) {
  customer(id: $id) {
    id email
    metafield(namespace: "$app", key: "ship_elig") { id jsonValue compareDigest }
  }
}`;
