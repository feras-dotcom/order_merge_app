# Shipping v0 Phase 2 evidence archive — G-AGREEMENT / A-NEG campaign

Run: 2026-11-03 (UTC). Store `ordermergetest2.myshopify.com`, pinned API
`2026-04`, verified app id `gid://shopify/App/426185785345`. The A-NEG
experiment was executed and independently checked by the operator, read-only
against the repository-pinned `Q-RECONCILE`, `Q-REFUND-DETAIL` and
`Q-AGREEMENTS` documents (sha256 values in each record and in
`validation-register.json`), after the 15-minute visibility window. No
mutation was sent during the readback. Manifest: `MANIFEST.sha256` covers
every file. Line endings pinned by `.gitattributes` (`docs/evidence/**
-text`), so the hashed bytes are identical on every checkout. The accepted
`shipping-v0` and `shipping-v0-e7` archives are unchanged and are
cross-referenced by file sha256, not duplicated.

## Controls (12.8.1)

| Control | Subject | Result |
|---|---|---|
| BASE | `gid://shopify/Order/8052786135287` — MergeShip-cancelled secondary | zero refunds, zero `RefundAgreements`; one `OrderAgreement/ORDER` with our app id |
| POS | `#1133` refund `gid://shopify/Refund/1126385221879` — created by `refundCreate` under MergeShip's own credentials (G-E7) | exactly one `RefundAgreement`/`REFUND`, `app.id` = Q-APPID, $1.00 USD shipping-only |
| NEG | `#1134` refund `gid://shopify/Refund/1126665912567` — created by a staff member via Shopify Admin | exactly one `RefundAgreement`/`REFUND`, `app.id` = `gid://shopify/App/1830279`, **different** from MergeShip's id |

## Outcome (12.8.2)

- **Part A: CONFIRMED.** BASE recorded; POS satisfies every field; NEG is a
  comparable-shape staff control with a linked `RefundAgreement` read after
  the visibility window whose `app` differs from MergeShip's id; the typed
  match holds for POS. No NEGATIVE or INCONCLUSIVE condition applies
  (`g-agreement-verdict.json`).
- **Part B: CONFIRMED.** The G-E7 refund is the first app-created refund on
  the dev store; its archived readback plus the NEG now on record satisfy the
  requirement. The §12.8.3 wording "the first refund the dispatcher actually
  creates" was clarified to "the first refund created with MergeShip's own
  app credentials" — see `g-agreement-verdict.json` for the resolution.
- `ATTRIBUTION_STATUS` remains `UNVERIFIED`; the constant may move only via
  the separately reviewed transition of 12.3.1/12.8.4.

## Preserved limitation

BASE: the exact Protocol v2 cancellation command (orderCancel arguments /
execution-path record) was not completely recovered. BasicEvents show a
MergeShip-labelled cancel and restock at `cancelledAt`, attributed by display
title, not app GID. This limitation is carried forward unchanged from the
accepted shipping-v0 archive.

## Files

- `aneg-neg-order1134.json` — NEG readback record and checks
- `aneg-pos-order1133.json` — POS readback record (cross-references the e7 archive)
- `aneg-base-order8052786135287.json` — BASE record (cross-references the shipping-v0 archive)
- `neg-refund-1126665912567-provenance.json` — NEG provenance
- `g-agreement-verdict.json` — the 12.8.2 outcome determination for A and B
- `validation-register.json` — document/file/verdict register
- `MANIFEST.sha256` — sha256 of every file above
