// Command dispatch for scripts/checkout-discount-control.ts — the
// print/dry-run/mutation decision that runs AFTER the admin client exists.
// Extracted + injectable so the dry-run boundary is unit-tested: without
// --apply NO mutation function may ever be reached (a regression once let
// shutdown/prepare-enable/activate fall through and execute).

import type { AdminClient } from "../graphql.server";
import type {
  activateCheckoutDiscount,
  createCheckoutDiscount,
  findExistingCheckoutDiscount,
  prepareEnable,
  readCheckoutDiscount,
  resolveCheckoutFunctionId,
  shutdownCheckoutDiscount,
} from "./discount-control.server";
import { CHECKOUT_DISCOUNT_MESSAGE } from "./config";

export interface CheckoutDiscountControl {
  readCheckoutDiscount: typeof readCheckoutDiscount;
  resolveCheckoutFunctionId: typeof resolveCheckoutFunctionId;
  findExistingCheckoutDiscount: typeof findExistingCheckoutDiscount;
  createCheckoutDiscount: typeof createCheckoutDiscount;
  shutdownCheckoutDiscount: typeof shutdownCheckoutDiscount;
  prepareEnable: typeof prepareEnable;
  activateCheckoutDiscount: typeof activateCheckoutDiscount;
}

export interface DispatchDeps {
  cmd: "status" | "shutdown" | "prepare-enable" | "activate" | "create";
  apply: boolean;
  admin: AdminClient;
  shop: string;
  discountId?: string;
  expectedWindowId?: string;
  functionId?: string;
  percentage?: string;
  windowDays?: number;
  control: CheckoutDiscountControl;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
}

type DiscountState = Awaited<ReturnType<CheckoutDiscountControl["readCheckoutDiscount"]>>;

/** Returns the process exit code: 0 ok / dry-run, 1 mutation error.
 *  (2 = usage is decided by the thin script before this is ever called.) */
export async function runCheckoutDiscountCommand(deps: DispatchDeps): Promise<number> {
  const { cmd, apply, admin, shop, discountId, control } = deps;
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;

  const print = (s: DiscountState) => {
    if (!s) {
      log(JSON.stringify({ found: false }));
      return;
    }
    log(
      JSON.stringify({
        found: true,
        status: s.status,
        windowId: s.windowId,
        percentageOk: s.percentage.length > 0,
        messageOk: s.message === CHECKOUT_DISCOUNT_MESSAGE,
        windowStartOk: s.windowStart.length > 0,
        windowEndOk: s.windowEnd.length > 0,
        functionId: s.functionId,
      }),
    );
  };

  if (cmd === "create") {
    // Dry-run: prove the Function resolves and no MergeShip discount already
    // exists, then stop — only --apply calls discountAutomaticAppCreate.
    const fnId = await control.resolveCheckoutFunctionId(admin, deps.functionId);
    const existing = await control.findExistingCheckoutDiscount(admin);
    log(
      JSON.stringify({
        action: "create",
        functionId: fnId,
        existingFound: existing !== null,
        existingId: existing?.id ?? null,
        wouldCreate: existing === null && apply,
      }),
    );
    if (!apply) return 0;
  }

  if (cmd === "status" || !apply) {
    print(await control.readCheckoutDiscount(admin, discountId!));
    // DRY-RUN BOUNDARY: status reports and every non-apply invocation end
    // here — the mutations below must only ever run with --apply.
    return 0;
  }

  try {
    if (cmd === "create") {
      const r = await control.createCheckoutDiscount({
        admin,
        shop,
        functionId: deps.functionId,
        percentage: deps.percentage,
        windowDays: deps.windowDays,
      });
      log(JSON.stringify({ action: "create", ...r }));
      if (r.created) {
        log(`record the id with: prepare-enable --shop ${shop} --discount-id ${r.id} --apply`);
      }
    } else if (cmd === "shutdown") {
      const r = await control.shutdownCheckoutDiscount({ admin, shop, discountId: discountId! });
      log(JSON.stringify({ action: "shutdown", ...r }));
    } else if (cmd === "prepare-enable") {
      const r = await control.prepareEnable({ admin, shop, discountId: discountId! });
      log(
        JSON.stringify({
          action: "prepare-enable",
          windowId: r.windowId,
          enabledAt: r.enabledAt.toISOString(),
        }),
      );
    } else if (cmd === "activate") {
      const r = await control.activateCheckoutDiscount({
        admin,
        shop,
        discountId: discountId!,
        expectedWindowId: deps.expectedWindowId!,
      });
      log(JSON.stringify({ action: "activate", ...r }));
    }
    return 0;
  } catch (err: any) {
    errorLog(`error: ${err?.name ?? "Error"}: ${err?.message ?? err}`);
    return 1;
  }
}
