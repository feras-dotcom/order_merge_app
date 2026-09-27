import type {
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "@remix-run/node";
import { redirect } from "@remix-run/node";

import styles from "./styles.module.css";

const title = "MergeShip | Automatically combine repeat Shopify orders";
const description =
  "MergeShip automatically finds eligible repeat Shopify orders and combines them before fulfillment.";

export const meta: MetaFunction = () => [
  { title },
  { name: "description", content: description },
  { name: "theme-color", content: "#070b14" },
  { property: "og:title", content: title },
  { property: "og:description", content: description },
  { property: "og:type", content: "website" },
];

export const links: LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "16x16 32x32 48x48" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  {
    rel: "preload",
    as: "image",
    href: "/brand/mergeship-mark-480.png",
    imageSrcSet:
      "/brand/mergeship-mark-480.png 480w, /brand/mergeship-mark.png 808w",
    imageSizes: "200px",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

const contactEmail = "support@mergeship.app";
const contactHref = `mailto:${contactEmail}`;

const orders = [
  { id: "#1842", tone: "violet" },
  { id: "#1847", tone: "blue" },
] as const;

const useCases = [
  {
    title: "Product drops",
    text: "Customers come back for another item minutes later.",
  },
  {
    title: "Preorders",
    text: "Separate orders placed long before anything ships.",
  },
  {
    title: "Live sales",
    text: "Repeat checkouts during a single stream.",
  },
  {
    title: "Limited releases",
    text: "Quick second purchases in a short window.",
  },
];

const steps = [
  {
    title: "Detect",
    text: "MergeShip looks for eligible orders from the same customer.",
  },
  {
    title: "Check",
    text: "Only orders that meet your merge rules are selected.",
  },
  {
    title: "Combine",
    text: "Eligible orders are combined before fulfillment.",
  },
];

export default function Index() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={`${styles.wrap} ${styles.headerInner}`}>
          <a className={styles.brand} href="/">
            <img
              src="/brand/mergeship-mark-96.png"
              alt=""
              width={142}
              height={96}
            />
            <span>MergeShip</span>
          </a>
          <a className={styles.navLink} href={contactHref}>
            Contact us
          </a>
        </div>
      </header>

      <main>
        <section className={`${styles.wrap} ${styles.split} ${styles.hero}`}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Built for Shopify merchants</p>
            <h1>Stop shipping the same customer twice.</h1>
            <p className={styles.lead}>
              MergeShip automatically finds eligible repeat Shopify orders and
              combines them before fulfillment.
            </p>
            <div className={styles.actions}>
              <a className={styles.button} href={contactHref}>
                Contact us
                <span aria-hidden="true">→</span>
              </a>
              <a className={styles.emailLink} href={contactHref}>
                {contactEmail}
              </a>
            </div>
          </div>

          <figure
            className={styles.flow}
            aria-label="Two eligible orders from the same customer are combined into one shipment"
          >
            <p className={styles.flowLabel}>Before fulfillment</p>
            <div className={styles.flowBody}>
              <div className={styles.orders}>
                {orders.map((order) => (
                  <div
                    key={order.id}
                    className={`${styles.order} ${styles[order.tone]}`}
                  >
                    <div className={styles.orderTop}>
                      <strong>Order {order.id}</strong>
                      <span>Paid</span>
                    </div>
                    <span className={styles.orderMeta}>Sam Carter</span>
                    <span className={styles.orderMeta}>Standard shipping</span>
                  </div>
                ))}
              </div>

              <svg
                className={`${styles.connector} ${styles.connectorH}`}
                viewBox="0 0 56 176"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <defs>
                  <linearGradient id="flowH" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#7a52f0" />
                    <stop offset="1" stopColor="#2a9df4" />
                  </linearGradient>
                </defs>
                <path
                  d="M0 40 C28 40 28 88 56 88 M0 136 C28 136 28 88 56 88"
                  fill="none"
                  stroke="url(#flowH)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <svg
                className={`${styles.connector} ${styles.connectorV}`}
                viewBox="0 0 100 40"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <defs>
                  <linearGradient id="flowV" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#7a52f0" />
                    <stop offset="1" stopColor="#2a9df4" />
                  </linearGradient>
                </defs>
                <path
                  d="M25 0 C25 20 50 20 50 40 M75 0 C75 20 50 20 50 40"
                  fill="none"
                  stroke="url(#flowV)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>

              <div className={styles.result}>
                <img
                  className={styles.mark}
                  src="/brand/mergeship-mark-480.png"
                  srcSet="/brand/mergeship-mark-480.png 480w, /brand/mergeship-mark.png 808w"
                  sizes="200px"
                  width={808}
                  height={545}
                  alt=""
                />
                <strong>One shipment</strong>
                <span>#1842 + #1847</span>
              </div>
            </div>
          </figure>
        </section>

        <section className={styles.section}>
          <div className={`${styles.wrap} ${styles.split}`}>
            <div className={styles.intro}>
              <p className={styles.eyebrow}>Made for repeat-order moments</p>
              <h2>Built for stores where customers order more than once</h2>
              <p className={styles.body}>
                Product drops, preorders, live sales and limited releases can
                lead the same customer to check out multiple times before
                anything ships. MergeShip helps reduce the manual work of
                finding and combining those orders.
              </p>
            </div>
            <ul className={styles.useCases}>
              {useCases.map((useCase) => (
                <li key={useCase.title}>
                  <h3>{useCase.title}</h3>
                  <p>{useCase.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className={styles.section}>
          <div className={`${styles.wrap} ${styles.split}`}>
            <div className={styles.intro}>
              <p className={styles.eyebrow}>How it works</p>
              <h2>Three steps, before fulfillment.</h2>
            </div>
            <ol className={styles.steps}>
              {steps.map((step, index) => (
                <li className={styles.step} key={step.title}>
                  <span className={styles.stepNode}>{index + 1}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className={styles.wrap}>
          <div className={styles.cta}>
            <div>
              <h2>Spend less time finding repeat orders.</h2>
              <p>
                Questions? Email{" "}
                <a href={contactHref}>{contactEmail}</a>
              </p>
            </div>
            <a className={styles.button} href={contactHref}>
              Contact us
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </section>
      </main>

      <footer className={`${styles.wrap} ${styles.footer}`}>
        <div className={styles.footerBrand}>
          <img
            src="/brand/mergeship-mark-96.png"
            alt=""
            width={142}
            height={96}
          />
          <span>MergeShip</span>
        </div>
        <nav className={styles.footerLinks} aria-label="Footer">
          <a href={contactHref}>{contactEmail}</a>
          <a href="/privacy">Privacy</a>
        </nav>
      </footer>
    </div>
  );
}
