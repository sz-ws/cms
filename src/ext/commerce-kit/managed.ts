import type { OrderManager } from "./order-manager";

/**
 * @deprecated 1.63.0 — remove in 2.0. Use OrderManager from "./order-manager" (the same contract, plus
 * the optional storefront() and reportTransfer()). Ownership moved from the `<table>_managed` marker
 * table to the orders row's managed_by column (see ./legacy-ownership.ts for the shim).
 */
export type ManagedCommerceProvider = OrderManager;
