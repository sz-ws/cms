export interface LedgerOwner {
  type: string;
  id: string;
}

/** Caller must resolve this identity from a trusted server-side ownership check. */
export interface LedgerAccount {
  id: string;
  owner: LedgerOwner;
  unit: string;
  precision: number;
}

export interface LedgerCommand {
  /** Stable across retries, unique for a business command within this deployment. */
  id: string;
  actor: LedgerOwner;
  reason: string;
}

export interface LedgerBalance {
  available: string;
  held: string;
  /** Net consumed, reduced by refunds. Not gross historical consumption. */
  consumed: string;
  /** Gross credits. Refunds move consumed back to available, not into credits. */
  credited: string;
  /** Signed manual corrections, separate from top-ups and consumption. */
  adjusted: string;
  unit: string;
  precision: number;
}

export type ReservationState = "held" | "captured" | "released" | "refunded";

export interface LedgerReservation {
  id: string;
  amount: string;
  state: ReservationState;
  source: LedgerOwner;
}

declare const operationBrand: unique symbol;
/** Opaque preparation token. Only tokens created by this kit can be committed. */
export interface LedgerOperation {
  readonly [operationBrand]: true;
}

export interface LedgerEntry {
  id: string;
  operationId: string;
  kind: "adjust" | "credit" | "reserve" | "capture" | "release" | "refund";
  reservationId: string | null;
  before: LedgerBalance;
  after: LedgerBalance;
  actor: LedgerOwner;
  reason: string;
  createdAt: number;
}
