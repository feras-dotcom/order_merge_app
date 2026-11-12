import { adminGraphql } from "./lib";
async function main() {
  const r = await adminGraphql(`query { a: __type(name: "ShippingLine") { fields { name } } b: __type(name: "DiscountApplication") { fields { name } possibleTypes { name } } c: __type(name: "Order") { fields { name } } }`) as { a:{fields:{name:string}[]}; b:{fields:{name:string}[];possibleTypes:{name:string}[]}; c:{fields:{name:string}[]} };
  console.log("ShippingLine:", r.a.fields.map((f)=>f.name).join(","));
  console.log("DiscountApplication:", r.b.fields.map((f)=>f.name).join(","), "| types:", r.b.possibleTypes.map((t)=>t.name).join(","));
  console.log("Order(discount-ish):", r.c.fields.map((f)=>f.name).filter((n)=>/discount|shipping/i.test(n)).join(","));
}
main().catch((e) => { console.error(String(e).slice(0,400)); process.exit(1); });
