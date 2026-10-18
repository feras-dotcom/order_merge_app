import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { canonicalJson } from "../app/lib/shipping-shadow.server";
import { sha256Hex } from "../app/lib/shipping-refund-contract";
import {
  IDEMPOTENCY_KEY_PLACEHOLDER,
  MARKER_PREFIX,
  REFUND_DOCUMENT_SHA256,
  REFUND_DOCUMENT_TEMPLATE_SHA256,
  REFUND_MUTATION_VERSION,
  buildFrozenWireContract,
  buildRefundInput,
  buildWireVariables,
  computeWireHash,
  generateIdempotencyKey,
  generateMarker,
  isStrictUuidV4,
  isValidIdempotencyKey,
  isValidMarker,
  renderRefundDocumentTemplate,
  shippingRefundMutationDocument,
  shippingRefundMutationDocumentTemplate,
  validateRefundInput,
  type ShippingRefundInput,
} from "../app/lib/shipping-refund-contract";

const SOURCE_GID = "gid://shopify/Order/4002";
const PRIMARY_GID = "gid://shopify/Order/4001";
const PARENT_TXN = "gid://shopify/OrderTransaction/9001";
const KEY = "123e4567-e89b-42d3-a456-426614174000";
const KEY2 = "123e4567-e89b-42d3-a456-426614174001";
const MARKER = `${MARKER_PREFIX}${KEY}`;

const GOOD = {
  sourceOrderId: SOURCE_GID,
  parentTransactionId: PARENT_TXN,
  gateway: "bogus",
  plannedShippingMinor: "50",
  currencyCode: "USD",
  marker: MARKER,
};

describe("mutation document (10.1, 3.2 rules 5 and 8)", () => {
  it("matches the section 10.1 text exactly and pins its sha256", () => {
    expect(shippingRefundMutationDocument()).toBe(
      `mutation MergeShipShippingRefund($input: RefundInput!, $idempotencyKey: String!) {
  refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
    refund {
      id
      note
      createdAt
      totalRefundedSet { presentmentMoney { amount currencyCode } }
    }
    userErrors { field message }
  }
}`,
    );
    expect(REFUND_DOCUMENT_SHA256).toBe(
      "10c8b9ce918f20febb8c58cb36227547834a5421d914fa23b92e76272f4d77cf",
    );
    expect(sha256Hex(shippingRefundMutationDocument())).toBe(REFUND_DOCUMENT_SHA256);
    // Normalized: LF endings, no trailing whitespace, userErrors selects only
    // field and message (F11: `code` is deliberately not selected).
    expect(shippingRefundMutationDocument()).not.toContain("\r");
    expect(shippingRefundMutationDocument()).not.toMatch(/[ \t]+\n/);
    expect(shippingRefundMutationDocument()).toContain("userErrors { field message }");
    expect(shippingRefundMutationDocument()).not.toMatch(/userErrors[^}]*\bcode\b/);
  });

  it("exposes the text through the accessor only — no document constant is exported", () => {
    const src = readFileSync(
      join(__dirname, "../app/lib/shipping-refund-contract.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/export const REFUND_DOCUMENT\b/);
    expect(src).not.toMatch(/export const REFUND_DOCUMENT_TEMPLATE\b/);
  });
});

describe("template fallback (10.3)", () => {
  it("pins the unrendered template and carries exactly one placeholder", () => {
    const tpl = shippingRefundMutationDocumentTemplate();
    expect(REFUND_DOCUMENT_TEMPLATE_SHA256).toBe(
      "46565ec2702baf95b69f853061db304e1a9a5f6083d8aa9d8ec814d09798526a",
    );
    expect(tpl.split(IDEMPOTENCY_KEY_PLACEHOLDER).length - 1).toBe(1);
    expect(tpl).not.toContain("$idempotencyKey");
  });

  it("renders only for a strict UUIDv4 key and differs only at the placeholder", () => {
    // eslint-disable-next-line testing-library/render-result-naming-convention -- not a Testing Library render
    const rendered = renderRefundDocumentTemplate(KEY);
    const tpl = shippingRefundMutationDocumentTemplate();
    const [before, after] = tpl.split(IDEMPOTENCY_KEY_PLACEHOLDER);
    expect(rendered).toBe(before + KEY + after);
    // The rendered document differs from the template only at that position.
    expect(rendered.replace(KEY, IDEMPOTENCY_KEY_PLACEHOLDER)).toBe(tpl);
    // documentSha256 is the hash of the RENDERED document.
    expect(sha256Hex(rendered)).not.toBe(REFUND_DOCUMENT_TEMPLATE_SHA256);
  });

  it.each([
    ["not a uuid", "garbage"],
    ["uuid v1 (wrong variant)", "123e4567-e89b-12d3-a456-426614174000"],
    ["uuid v4, bad variant nibble", "123e4567-e89b-42d3-c456-426614174000"],
    ["uuidv4 uppercase", "123E4567-E89B-42D3-A456-426614174000"],
    ["uuidv5", "123e4567-e89b-52d3-a456-426614174000"],
    ["empty", ""],
  ])("refuses %s", (_label, key) => {
    expect(() => renderRefundDocumentTemplate(key)).toThrow(/strict UUIDv4/);
    expect(isStrictUuidV4(key)).toBe(false);
  });
});

describe("key and marker generation (5.1)", () => {
  it("generates strict-v4 UUID keys and MS-SHIPREFUND-<uuid> markers", () => {
    const key = generateIdempotencyKey();
    const marker = generateMarker();
    expect(isStrictUuidV4(key)).toBe(true);
    expect(isValidIdempotencyKey(key)).toBe(true);
    expect(isValidMarker(marker)).toBe(true);
    expect(marker.startsWith(MARKER_PREFIX)).toBe(true);
    expect(generateIdempotencyKey()).not.toBe(key);
    expect(generateMarker()).not.toBe(marker);
    // Loose-but-malformed keys still refuse.
    expect(isValidIdempotencyKey("123e4567e89b42d3a456426614174000")).toBe(false);
    expect(isValidMarker(`${MARKER_PREFIX}not-a-uuid`)).toBe(false);
  });
});

describe("buildRefundInput (10.4)", () => {
  it("produces exactly the key sets the shape trigger accepts", () => {
    const input = buildRefundInput(GOOD);
    expect(Object.keys(input).sort()).toEqual(
      ["currency", "note", "notify", "orderId", "shipping", "transactions"].sort(),
    );
    expect(Object.keys(input.shipping).sort()).toEqual(["amount", "fullRefund"]);
    expect(input.transactions).toHaveLength(1);
    expect(Object.keys(input.transactions[0]).sort()).toEqual(
      ["amount", "gateway", "kind", "orderId", "parentId"].sort(),
    );
    expect(input.notify).toBe(false);
    expect(input.shipping.fullRefund).toBe(false);
    expect(input.transactions[0].kind).toBe("REFUND");
    expect(input.note).toContain(MARKER);
    expect(input.orderId).toBe(SOURCE_GID);
    expect(input.transactions[0].orderId).toBe(SOURCE_GID);
    expect(input.transactions[0].parentId).toBe(PARENT_TXN);
    expect(input.transactions[0].gateway).toBe("bogus");
    expect(input.shipping.amount).toBe(input.transactions[0].amount);
  });

  it("formats the amount at the currency's established precision", () => {
    expect(buildRefundInput(GOOD).shipping.amount).toBe("0.50");
    expect(buildRefundInput({ ...GOOD, currencyCode: "JPY" }).shipping.amount).toBe("50");
    expect(
      buildRefundInput({ ...GOOD, currencyCode: "JOD", plannedShippingMinor: "1234" }).shipping.amount,
    ).toBe("1.234");
    expect(
      buildRefundInput({ ...GOOD, plannedShippingMinor: "1200" }).shipping.amount,
    ).toBe("12.00");
  });

  it.each([
    ["a non-GID order id", { sourceOrderId: "not-a-gid" }],
    ["a numeric order id", { sourceOrderId: 4002 }],
    ["a primary-shaped but non-transaction parent", { parentTransactionId: PRIMARY_GID }],
    ["an empty gateway", { gateway: "" }],
    ["a non-string gateway", { gateway: 7 }],
    ["a zero planned amount", { plannedShippingMinor: "0" }],
    ["a leading-zero planned amount", { plannedShippingMinor: "050" }],
    ["a decimal planned amount", { plannedShippingMinor: "12.5" }],
    ["a negative planned amount", { plannedShippingMinor: "-50" }],
    ["a 41-digit planned amount", { plannedShippingMinor: "1".padEnd(41, "0") }],
    ["a lowercase currency", { currencyCode: "usd" }],
    ["an unknown currency", { currencyCode: "ZZZ" }],
    ["XXX (no established precision)", { currencyCode: "XXX" }],
    ["a malformed marker", { marker: "MS-SHIPREFUND-nope" }],
  ])("refuses %s", (_label, patch) => {
    expect(() => buildRefundInput({ ...GOOD, ...(patch as object) } as typeof GOOD)).toThrow();
  });
});

describe("validateRefundInput (shape-trigger parity)", () => {
  const good = (): ShippingRefundInput => buildRefundInput(GOOD);

  it("accepts the builder output and the expected row bindings", () => {
    expect(validateRefundInput(good()).ok).toBe(true);
    expect(
      validateRefundInput(good(), {
        orderId: SOURCE_GID,
        parentTransactionId: PARENT_TXN,
        gateway: "bogus",
        currencyCode: "USD",
        plannedShippingMinor: "50",
        marker: MARKER,
      }).ok,
    ).toBe(true);
  });

  const malformed = (mutate: (i: any) => void): any => {
    const input: any = { ...good() };
    input.shipping = { ...input.shipping };
    input.transactions = [{ ...input.transactions[0] }];
    mutate(input);
    return input;
  };

  it.each([
    ["an extra input key", (i: any) => { i.refundLineItems = []; }],
    ["restock", (i: any) => { i.restock = true; }],
    ["allowOverRefunding", (i: any) => { i.allowOverRefunding = true; }],
    ["a missing input key", (i: any) => { delete i.note; }],
    ["notify true", (i: any) => { i.notify = true; }],
    ["fullRefund true", (i: any) => { i.shipping.fullRefund = true; }],
    ["an extra shipping key", (i: any) => { i.shipping.tax = "1.00"; }],
    ["two transactions", (i: any) => { i.transactions.push({ ...i.transactions[0] }); }],
    ["an extra transaction key", (i: any) => { i.transactions[0].test = false; }],
    ["kind JSON null", (i: any) => { i.transactions[0].kind = null; }],
    ["kind missing", (i: any) => { delete i.transactions[0].kind; }],
    ["wrong kind", (i: any) => { i.transactions[0].kind = "SALE"; }],
    ["kind wrong case", (i: any) => { i.transactions[0].kind = "refund"; }],
    ["mismatched txn orderId", (i: any) => { i.transactions[0].orderId = PRIMARY_GID; }],
    ["mismatched amounts", (i: any) => { i.transactions[0].amount = "0.49"; }],
    ["amount exponent", (i: any) => { i.shipping.amount = "1e2"; i.transactions[0].amount = "1e2"; }],
    ["amount zero", (i: any) => { i.shipping.amount = "0.00"; i.transactions[0].amount = "0.00"; }],
    ["amount negative", (i: any) => { i.shipping.amount = "-1"; i.transactions[0].amount = "-1"; }],
    ["amount leading zeros", (i: any) => { i.shipping.amount = "01.5"; i.transactions[0].amount = "01.5"; }],
    ["amount 5 decimals", (i: any) => { i.shipping.amount = "1.23456"; i.transactions[0].amount = "1.23456"; }],
    ["amount non-numeric", (i: any) => { i.shipping.amount = "abc"; i.transactions[0].amount = "abc"; }],
    ["amount JSON number", (i: any) => { i.shipping.amount = 0.5; i.transactions[0].amount = 0.5; }],
    ["an empty note", (i: any) => { i.note = ""; }],
    ["a non-object input", () => "not an object" as any],
    ["a null input", () => null],
    ["an array input", () => [] as any],
  ])("rejects %s", (_label, mutate) => {
    const candidate =
      mutate.length === 0 ? (mutate as () => unknown)() : malformed(mutate);
    expect(validateRefundInput(candidate).ok).toBe(false);
  });

  it("rejects row-binding mismatches when expected values are supplied", () => {
    const input = good();
    for (const expected of [
      { orderId: PRIMARY_GID },
      { parentTransactionId: "gid://shopify/OrderTransaction/9999" },
      { gateway: "shopify_payments" },
      { currencyCode: "EUR" },
      { plannedShippingMinor: "51", currencyCode: "USD" },
      { marker: `${MARKER_PREFIX}123e4567-e89b-42d3-a456-426614174999` },
    ]) {
      expect(validateRefundInput(input, expected).ok).toBe(false);
    }
  });
});

describe("wireHash (10.2)", () => {
  const contract = () =>
    buildFrozenWireContract({ ...GOOD, idempotencyKey: KEY });

  it("equals sha256 of canonicalJson({documentSha256, variables})", () => {
    const c = contract();
    const manual = sha256Hex(
      canonicalJson({ documentSha256: c.documentSha256, variables: c.wireVariables }),
    );
    expect(c.wireHash).toBe(manual);
    expect(c.documentSha256).toBe(REFUND_DOCUMENT_SHA256);
    expect(c.mutationVersion).toBe(REFUND_MUTATION_VERSION);
    expect(c.wireVariables.idempotencyKey).toBe(KEY);
    expect(Object.keys(c.wireVariables).sort()).toEqual(["idempotencyKey", "input"]);
  });

  it("is deterministic", () => {
    expect(contract().wireHash).toBe(contract().wireHash);
    expect(contract().wireVariables).toEqual(contract().wireVariables);
  });

  it("is sensitive to the key, the document hash and every input field", () => {
    const base = contract().wireHash;
    const different = (patch: object) =>
      buildFrozenWireContract({ ...GOOD, idempotencyKey: KEY, ...patch }).wireHash;
    expect(different({ idempotencyKey: KEY2 })).not.toBe(base);
    expect(different({ sourceOrderId: "gid://shopify/Order/4003" })).not.toBe(base);
    expect(different({ parentTransactionId: "gid://shopify/OrderTransaction/9002" })).not.toBe(base);
    expect(different({ gateway: "shopify_payments" })).not.toBe(base);
    expect(different({ plannedShippingMinor: "51" })).not.toBe(base);
    expect(different({ currencyCode: "EUR" })).not.toBe(base);
    expect(
      different({ marker: `${MARKER_PREFIX}123e4567-e89b-42d3-a456-426614174999` }),
    ).not.toBe(base);
    // A different document hash (template-rendered form) changes the hash too.
    const renderedKey = "223e4567-e89b-42d3-a456-426614174000";
    // eslint-disable-next-line testing-library/render-result-naming-convention -- not a Testing Library render
    const rendered = renderRefundDocumentTemplate(renderedKey);
    const templateHash = sha256Hex(rendered);
    const c = contract();
    expect(computeWireHash(templateHash, c.wireVariables)).not.toBe(base);
    expect(computeWireHash(c.documentSha256, c.wireVariables)).toBe(base);
  });

  it("rejects malformed wire variables", () => {
    const input = buildRefundInput(GOOD);
    expect(() => buildWireVariables("not-a-uuid", input)).toThrow();
    expect(() =>
      computeWireHash("z".repeat(64), buildWireVariables(KEY, input)),
    ).toThrow();
    expect(() =>
      computeWireHash(REFUND_DOCUMENT_SHA256, {
        idempotencyKey: KEY,
        input,
        extra: true,
      } as any),
    ).toThrow(/forbidden keys/);
    expect(() =>
      computeWireHash(REFUND_DOCUMENT_SHA256, { input } as any),
    ).toThrow(/missing keys/);
  });
});

describe("module isolation", () => {
  it("contains no Shopify client, transport or scheduler references", () => {
    const src = readFileSync(
      join(__dirname, "../app/lib/shipping-refund-contract.ts"),
      "utf8",
    );
    for (const token of [
      "admin.graphql",
      "shopify.server",
      "graphql.server",
      "db.server",
      "DispatchPermit",
      "setTimeout",
      "setInterval",
    ]) {
      expect(src).not.toContain(token);
    }
  });
});
