// e2-campaign.ts — E2 pipeline measurement skeleton for handoff 2.
// Prereq: tunnel-webhooks.ts running (subscriptions live), founder signed in.
// Per trial: browser completes a bogus-gateway order (automation clicks pay),
// then records T1 order.processedAt (Admin), T2 webhook receipt (jsonl log),
// T3 metafield write completion (seed script timing), T4 first poll where the
// discount appears in a fresh checkout (browser poll 1-2s).
// NOTE: this script drives a REAL order through the test gateway only on the
// spike store; run only with lead approval in handoff 2.
import { runTrial } from "./checkout-trial";
import { saveEvidence } from "./lib";

async function main() {
  const n = Number(process.env.SPIKE_TRIALS ?? 3);
  const trials: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = new Date().toISOString();
    const ev = await runTrial({ scenario: `e2-t${i}` });
    // order-completion click is intentionally NOT automated yet — see report;
    // measure T4: poll a fresh checkout until the discount appears
    const polls: { ts: string; found: boolean }[] = [];
    for (let p = 0; p < 30; p++) {
      const probe = await runTrial({ scenario: `e2-t${i}-poll${p}`, fillAddr: false });
      const found = /discount|FREE/i.test(JSON.stringify(probe.scraped));
      polls.push({ ts: new Date().toISOString(), found });
      if (found) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    trials.push({ trial: i, t0, polls, scraped: ev.scraped });
  }
  saveEvidence("e2-trials.json", { trials });
  console.log(JSON.stringify({ trials }, null, 1).slice(0, 3000));
}
main().catch((e) => { console.error(e); process.exit(1); });
