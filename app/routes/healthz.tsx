// Deploy healthcheck (Railway healthcheckPath, request Host
// healthcheck.railway.app): deliberately no auth, no Shopify call,
// no session and no customer data — it must answer even when every app
// lever is off. It only proves the process is up and the DATABASE_URL pool
// can run SELECT 1 within a bounded time; a failed migration never reaches
// this (docker-start runs prisma migrate deploy before remix-serve).
import type { LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";

const DB_CHECK_TIMEOUT_MS = 3_000;
const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};

const respond = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });

export async function loader(_args: LoaderFunctionArgs) {
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("db check timed out")), DB_CHECK_TIMEOUT_MS),
      ),
    ]);
  } catch (err: any) {
    console.error(`[healthz] db check failed: ${err?.message ?? err}`);
    return respond({ ok: false }, 503);
  }
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
  return respond({ ok: true, commit }, 200);
}
