// Step 4 — create C1/C2 with a strict-key shipping address.
import { adminGraphql, saveEvidence, log } from "./lib";
import { M_CUSTOMER_CREATE } from "./queries";

export const SPIKE_ADDRESS = {
  firstName: "Spike",
  lastName: "One",
  company: "Spike Co",
  address1: "100 Test Street",
  address2: "Unit 5",
  city: "Austin",
  provinceCode: "TX",
  zip: "78701",
  countryCode: "US",
};

async function createCustomer(email: string, firstName: string, lastName: string) {
  const input = {
    email,
    firstName,
    lastName,
    addresses: [{ ...SPIKE_ADDRESS, firstName, lastName }],
  };
  const res = await adminGraphql(M_CUSTOMER_CREATE, { input });
  const out = (res.customerCreate as Record<string, unknown>) ?? {};
  if ((out.userErrors as unknown[] | undefined)?.length) {
    throw new Error(`customerCreate userErrors: ${JSON.stringify(out.userErrors)}`);
  }
  return out.customer as { id: string };
}

async function main() {
  // Reuse if already created (idempotent-ish: query by email first)
  const find = async (email: string) => {
    const r = await adminGraphql(
      `query F($q: String!) { customers(first: 1, query: $q) { nodes { id email } } }`,
      { q: `email:${email}` },
    );
    return ((r.customers as { nodes: { id: string }[] }).nodes[0]?.id) ?? null;
  };
  const c1id = (await find("spike.c1@example.com")) ?? (await createCustomer("spike.c1@example.com", "Spike", "One")).id;
  const c2id = (await find("spike.c2@example.com")) ?? (await createCustomer("spike.c2@example.com", "Spike", "Two")).id;
  log("C1", c1id, "C2", c2id);
  saveEvidence("customers.json", { c1id, c2id, address: SPIKE_ADDRESS });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
