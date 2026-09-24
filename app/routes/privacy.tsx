import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy — MergeShip" },
  { name: "description", content: "Privacy Policy for MergeShip" },
];

export default function PrivacyPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Privacy Policy — MergeShip</title>
      </head>
      <body
        style={{
          margin: 0,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          background: "#f6f6f7",
          color: "#202223",
          lineHeight: 1.6,
        }}
      >
        <main
          style={{
            maxWidth: "720px",
            margin: "0 auto",
            padding: "48px 24px",
          }}
        >
          <div
            style={{
              background: "#ffffff",
              padding: "40px",
              borderRadius: "12px",
              boxShadow: "0 1px 4px rgba(0, 0, 0, 0.08)",
            }}
          >
            <h1 style={{ fontSize: "28px", margin: "0 0 8px 0" }}>
              Privacy Policy for MergeShip
            </h1>
            <p style={{ color: "#5c5f62", margin: "0 0 32px 0" }}>
              Last updated: September 24, 2026
            </p>

            <p style={{ marginTop: 0 }}>
              MergeShip (&quot;we&quot;, &quot;our&quot;, or &quot;the app&quot;) provides automated order
              consolidation services to merchants who use Shopify. This Privacy
              Policy describes how personal and store data is collected, used,
              and handled when you install or use the app.
            </p>

            <h2 style={{ fontSize: "20px", marginTop: "32px" }}>
              1. Information We Collect
            </h2>
            <p>
              When you install MergeShip, we access certain store information
              via authorized Shopify APIs:
            </p>
            <ul>
              <li>
                <strong>Store Information:</strong> Shop name, store email,
                myshopify domain, and billing status.
              </li>
              <li>
                <strong>Order and Customer Data:</strong> Order numbers, line
                items, customer names, shipping addresses, shipping method
                names, financial status, and fulfillment status.
              </li>
            </ul>

            <h2 style={{ fontSize: "20px", marginTop: "32px" }}>
              2. How We Use Information
            </h2>
            <p>We use collected information only to run core MergeShip features:</p>
            <ul>
              <li>Detecting duplicate unfulfilled orders placed by the same customer.</li>
              <li>Consolidating eligible orders into a primary order.</li>
              <li>Updating order notes, tags, and item quantities.</li>
              <li>Tracking consolidated packages to calculate estimated shipping savings.</li>
            </ul>
            <p>We do not sell, rent, or monetize your store data or customer data.</p>

            <h2 style={{ fontSize: "20px", marginTop: "32px" }}>
              3. Data Storage and Security
            </h2>
            <ul>
              <li>All operational data is stored in secured, encrypted databases.</li>
              <li>Order details are kept only as long as needed to show consolidation logs and provide support.</li>
              <li>
                If you uninstall MergeShip, your access tokens are revoked
                immediately, and store records are purged in line with Shopify
                guidelines.
              </li>
            </ul>

            <h2 style={{ fontSize: "20px", marginTop: "32px" }}>
              4. Shopify Mandatory Compliance
            </h2>
            <p>MergeShip complies with Shopify mandatory compliance webhooks:</p>
            <ul>
              <li>
                <strong>Customers Data Request:</strong> We provide stored customer data upon verified request.
              </li>
              <li>
                <strong>Customers Redact:</strong> We erase personal customer data upon verified request.
              </li>
              <li>
                <strong>Shop Redact:</strong> We erase all stored data for your store within 48 hours of receiving Shopify uninstall notifications.
              </li>
            </ul>

            <h2 style={{ fontSize: "20px", marginTop: "32px" }}>
              5. Contact Us
            </h2>
            <p>
              For privacy questions or data deletion requests, contact:{" "}
              <a
                href="mailto:support@mergeship.app"
                style={{ color: "#2c6ecb", textDecoration: "none" }}
              >
                support@mergeship.app
              </a>
            </p>
          </div>
        </main>
      </body>
    </html>
  );
}
