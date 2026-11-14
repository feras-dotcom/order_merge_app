// Diagnostics for the checkout-discount pipeline: one-line structured JSON
// events through an injectable sink. Events carry shop, order GID, stable
// codes and counters ONLY — never addresses, names, e-mails, tokens or the
// record `dest` string.
export type DiagKind =
  | "PROJECTED"
  | "REFUSED"
  | "REVOKED"
  | "CONSUMED"
  | "OVERDRAW"
  | "NO_RECORD"
  | "RETRY"
  | "FAILED"
  | "FEATURE_OFF";

export interface DiagEvent {
  kind: DiagKind;
  shop: string;
  orderId: string;
  code?: string;
  attempts?: number;
  durationMs?: number;
  reason?: string;
}

export type Diag = (e: DiagEvent) => void;

export const defaultDiag: Diag = (e) => {
  console.log(JSON.stringify({ evt: "checkout_elig", ...e }));
};
