-- Shipping v0 Phase 1.1 (shadow evaluator corrections) - additive only.
--
-- Three independent activation epochs replace the single merchant opt-in
-- timestamp as the retroactivity guard:
--   Settings.shippingRolloutAt   - stamped when the shop is ADDED to
--                                  AppControl.shippingAllowShops, cleared on
--                                  removal (setControl, same tx, DB wall clock)
--   AppControl.shippingEnabledAt - stamped on a false->true transition of the
--                                  shipping kill switch, cleared on disable
--   Settings.shippingAdjustmentEnabledAt - merchant opt-in epoch (existing)
-- The effective cutoff is the LATEST of the three; ShippingAdjustment rows
-- snapshot it in activationCutoffAt so a future dispatch gate can reject any
-- row whose activation state has since changed.
--
-- ShippingAdjustment.mode is 'SHADOW' forever under this CHECK - promoting
-- shadow evidence to an executable intent requires an authorized schema
-- change; nothing in Phase 1.1 can dispatch a refund.

ALTER TABLE "AppControl"
  ADD COLUMN "shippingEnabledAt" TIMESTAMP(3);

ALTER TABLE "Settings"
  ADD COLUMN "shippingRolloutAt" TIMESTAMP(3);

ALTER TABLE "ShippingAdjustment"
  ADD COLUMN "activationCutoffAt" TIMESTAMP(3),
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'SHADOW';

ALTER TABLE "ShippingAdjustment"
  ADD CONSTRAINT "ShippingAdjustment_mode_check" CHECK ("mode" = 'SHADOW');
