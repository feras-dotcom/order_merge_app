-- Onboarding state for first-install setup.
ALTER TABLE "Settings" ADD COLUMN "onboardingStartedAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);

-- Established stores must not be sent back through setup. A store counts as
-- established if automatic merging is on, was ever acknowledged, or MergeShip
-- has already combined orders for it.
UPDATE "Settings"
SET "onboardingStartedAt" = COALESCE("autoMergeAcknowledgedAt", CURRENT_TIMESTAMP),
    "onboardingCompletedAt" = COALESCE("autoMergeAcknowledgedAt", CURRENT_TIMESTAMP)
WHERE "autoMergeEnabled" = true
   OR "autoMergeAcknowledgedAt" IS NOT NULL
   OR "shop" IN (SELECT DISTINCT "shop" FROM "MergeRecord");
