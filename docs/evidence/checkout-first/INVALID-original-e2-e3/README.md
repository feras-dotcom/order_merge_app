# INVALID experiments — retained for the record, do not cite

These files are the original E2 latency campaign and the first E3 runs. They are INVALID as measurements of the
MergeShip shipping discount and must not be used for any decision.

Why (see `../e3-attribution.md` and `../orders-audit.json`):

* They ran on the $629.95 snowboard cart (variant 68100324327791). On that cart the store's own native shipping rate makes
  Standard free ($0.00 before any MergeShip discount), so there was nothing for the Function to discount and no way for
  "discount appeared" to mean "MergeShip discount appeared".
* The E2 campaign (`e2-pipeline.json`, orders #1011-#1036) also seeded a SYNTHETIC eligibility record after the webhook
  instead of deriving the record from the real paid order, and its success signal was a loose text match.
* The "~72 s" propagation figure therefore does NOT measure Function visibility. Retracted.
* `e3-guest.json` (first guest run) showed free Standard because of the native rate, not an authorization defect.
  `e3-signed-in-control.json` and `e3-partial.json` have the same flaw.

Valid evidence: E1 (`../trial-e1-*.json`, `../e1-matrix.json`), E6 (`../e6-order.json`, orders #1001/#1002 on the $9.95
cart) and the controlled attribution runs (`../e3-attrib-*.json`).
