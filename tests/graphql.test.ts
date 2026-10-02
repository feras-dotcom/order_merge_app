import { describe, expect, it, vi } from "vitest";
import { gql, ShopifyGraphqlError } from "../app/lib/graphql.server";

const client = (body: unknown) => ({
  graphql: async () => new Response(JSON.stringify(body)),
});

async function capture(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as ShopifyGraphqlError;
  }
  throw new Error("expected gql to throw");
}

describe("gql", () => {
  it("returns the payload on success", async () => {
    const payload = { order: { id: "1" }, userErrors: [] };
    await expect(gql(client({ data: { orderUpdate: payload } }), "t", "q", {}, "orderUpdate")).resolves.toEqual(payload);
  });

  it("throws (outcome unknown) on top-level GraphQL errors even when data is present", async () => {
    const err = await capture(
      gql(client({ errors: [{ message: "Access denied" }], data: { orderUpdate: { userErrors: [] } } }), "t", "q", {}, "orderUpdate"),
    );
    expect(err).toBeInstanceOf(ShopifyGraphqlError);
    expect(err.rejected).toBe(false);
    expect(err.message).toContain("Access denied");
  });

  it("throws (rejected) on userErrors", async () => {
    const err = await capture(
      gql(client({ data: { orderUpdate: { userErrors: [{ message: "Invalid" }] } } }), "t", "q", {}, "orderUpdate"),
    );
    expect(err.rejected).toBe(true);
  });

  it("uses a custom userErrors key", async () => {
    const err = await capture(
      gql(client({ data: { orderCancel: { orderCancelUserErrors: [{ message: "No" }] } } }), "t", "q", {}, "orderCancel", "orderCancelUserErrors"),
    );
    expect(err.rejected).toBe(true);
  });

  it("throws when the payload is missing", async () => {
    const err = await capture(gql(client({ data: {} }), "t", "q", {}, "orderUpdate"));
    expect(err.rejected).toBe(false);
  });

  it("throws (outcome unknown) when the client throws", async () => {
    const failing = {
      graphql: async () => {
        throw new Error("socket hang up");
      },
    };
    const err = await capture(gql(failing, "t", "q", {}, "orderUpdate"));
    expect(err.rejected).toBe(false);
    expect(err.message).toContain("socket hang up");
  });

  it("aborts a call that only resolves on abort", async () => {
    let aborted = false;
    const hanging = {
      graphql: (_q: string, options?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("The operation was aborted."));
          });
        }),
    };
    const err = await capture(gql(hanging, "t", "q", {}, "orderUpdate", "userErrors", 20));
    expect(err).toBeInstanceOf(ShopifyGraphqlError);
    expect(err.rejected).toBe(false);
    expect(aborted).toBe(true);
  });

  it("times out even if the client ignores the abort signal", async () => {
    const hanging = { graphql: () => new Promise<Response>(() => {}) };
    const err = await capture(gql(hanging, "t", "q", {}, "orderUpdate", "userErrors", 20));
    expect(err).toBeInstanceOf(ShopifyGraphqlError);
    expect(err.rejected).toBe(false);
    expect(err.message).toContain("timed out");
  });

  it("caps a stalled response body read without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const stalled = {
        // The request resolves; the body read never does. The timeout firing
        // inside res.json() must reject gql and must not go unhandled.
        graphql: async () => ({ json: () => new Promise<unknown>(() => {}) }) as Response,
      };
      const err = await capture(gql(stalled, "t", "q", {}, "orderUpdate", "userErrors", 20));
      expect(err).toBeInstanceOf(ShopifyGraphqlError);
      expect(err.rejected).toBe(false);
      expect(err.message).toContain("timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
