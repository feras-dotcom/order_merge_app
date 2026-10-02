// Prints the WorkerInstance heartbeat rows, newest first (spec §11).
//
//   npx vite-node scripts/worker-instances.ts

import "./require-database-url";
import { prismaOperationStore } from "../app/lib/operation-store.server";

const rows = await prismaOperationStore.listRecentInstances();
if (!rows.length) {
  console.log("No worker heartbeats recorded.");
} else {
  console.log("instanceId                             deployment                            startedAt                  heartbeatAt                version");
  for (const r of rows) {
    const cell = (v: unknown, w: number) => String(v ?? "").padEnd(w).slice(0, w);
    console.log(
      `${cell(r.instanceId, 37)}${cell(r.railwayDeploymentId, 37)}${cell(r.startedAt?.toISOString?.() ?? r.startedAt, 27)}${cell(r.heartbeatAt?.toISOString?.() ?? r.heartbeatAt, 27)}${r.version ?? ""}`,
    );
  }
}
