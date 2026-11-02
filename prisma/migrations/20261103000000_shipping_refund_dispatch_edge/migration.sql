-- S2 migration (section 21): replaces ONLY the transition-graph trigger
-- function to add the single PREPARED -> DISPATCHING edge. No tables, no
-- data changes, no other trigger or CHECK; the evidence-integrity trigger
-- (which names this same update for dispatchToken/dispatchedAt first-set)
-- and every other guard stay exactly as the S1 migration defined them.
CREATE OR REPLACE FUNCTION shipping_refund_fn_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    IF OLD."status" IN ('OBSERVED','SKIPPED','INELIGIBLE','ABORTED','VERIFIED','RESOLVED') THEN
        RAISE EXCEPTION 'ShippingRefund: terminal status % is immutable', OLD."status";
    END IF;
    IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
        RETURN NEW;
    END IF;
    IF OLD."status" = 'QUEUED' AND NEW."status" = 'PREPARED' AND OLD."lane" = 'EXECUTE' THEN RETURN NEW; END IF;
    IF OLD."status" = 'QUEUED' AND NEW."status" = 'OBSERVED' AND OLD."lane" = 'OBSERVE' THEN RETURN NEW; END IF;
    IF OLD."status" = 'QUEUED' AND NEW."status" IN ('SKIPPED','INELIGIBLE','ABORTED','REVIEW_REQUIRED') THEN RETURN NEW; END IF;
    -- S2: the single dispatch edge. Entering DISPATCHING also needs the
    -- evidence-integrity trigger's first-set condition (dispatchToken and
    -- dispatchedAt set in this same update), which this function does not
    -- relax.
    IF OLD."status" = 'PREPARED' AND NEW."status" = 'DISPATCHING' THEN RETURN NEW; END IF;
    IF OLD."status" = 'PREPARED' AND NEW."status" IN ('ABORTED','REVIEW_REQUIRED') THEN RETURN NEW; END IF;
    IF OLD."status" = 'DISPATCHING' AND NEW."status" IN ('REFUND_RECORDED','IN_DOUBT') THEN RETURN NEW; END IF;
    IF OLD."status" = 'IN_DOUBT' AND NEW."status" IN ('REFUND_RECORDED','REVIEW_REQUIRED') THEN RETURN NEW; END IF;
    IF OLD."status" = 'REFUND_RECORDED' AND NEW."status" IN ('VERIFIED','REVIEW_REQUIRED') THEN RETURN NEW; END IF;
    IF OLD."status" = 'REVIEW_REQUIRED' AND NEW."status" = 'RESOLVED' THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'ShippingRefund: illegal transition % -> %', OLD."status", NEW."status";
END;
$fn$;
