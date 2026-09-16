# Local D1 ledger transactions

Server-side kit for code extensions that keep exact balances, such as prepaid credit or per-SKU stock, with atomic reservations. Requires core API 1.36.0; signed adjustments require 1.37.0. Tables are installed by each extension's migrations, not by importing the kit.

## Transaction guarantees

- `commitLedgerOperations` submits all prepared operations in one D1 batch. Database CHECK constraints reject failed preconditions; zero-row UPDATE is never interpreted as transaction failure on its own.
- Each command stores a fingerprint of the complete ordered participant list, normalized amounts, actor and reason. An exact retry is a no-op; changed input with the same ID throws `LedgerConflict("idempotency_conflict")`.
- IDs are scoped by participating extension tables. Namespace them by action and source, such as `order:123:reserve`. Separate deployments and disjoint extensions do not share a global ID registry.
- Capture/release requires a held reservation. A full refund requires a captured reservation. A repeated transition with a new command ID fails; retrying the original ID returns `replayed`.
- Every balance movement records before/after snapshots and the command's actor/reason. Account creation starts at zero and records a command receipt without a monetary ledger entry.
- Account reads and mutations match ID, owner type/ID, unit and precision. Caller-owned references are copied during preparation.
- All participants must use the same D1 binding object. Preparation does no writes. Each commit accepts 1–50 prepared actions.

## Exact amounts

Amount inputs are decimal strings. Precision is explicit per account (0–4), fixed at creation. Decimal digits are concatenated into integer units, with `Number.MAX_SAFE_INTEGER` as the maximum gross credit. For example, `"1.4"` at precision 4 becomes 14,000 units. Excessive precision, exponential notation, whitespace and overflow are rejected, not rounded.

Balances are fixed-precision strings. `available + held + consumed = credited`; all components are nonnegative. `consumed` is net consumption after refunds. `credited` is gross incoming credit, without counting refunds again. D1 has no native DECIMAL column type; projects that require one need a different database.

## Integration

An extension exposes its ledger through a provider (`provides`). Like any code extension it must be compiled into `extensions/registry.ts` and enabled; resolve providers by explicit ID and do not assume they are active.

```ts
import { commitLedgerOperations, createLedgerProvider } from "@/ext/ledger-kit";
import type { LedgerAccount } from "@/ext/ledger-kit";

type LedgerProvider = ReturnType<typeof createLedgerProvider>;

const credit = services.providers.getById<LedgerProvider>("credit", "credit");
const stock = services.providers.getById<LedgerProvider>("stock", "stock");
if (!credit || !stock) throw new Error("required ledger providers are disabled");

// Resolve accounts, permissions, prices and quantities on the server first.
// Create/fund these accounts separately before reserving against them.
const sku: LedgerAccount = { id: "sku-123", owner: { type: "sku", id: "sku-123" }, unit: "item", precision: 0 };
await commitLedgerOperations(
  { id: "order:123:reserve", actor: { type: "user", id: authenticatedUser.id }, reason: "Reserve authorized order 123" },
  [
    credit.prepareReserve(account, "order:123:credit", "1.4", { type: "order", id: "123" }),
    stock.prepareReserve(sku, "order:123:sku-123", "1", { type: "order", id: "123" }),
  ],
);
```

## Current boundary

This is a trusted internal API, not an authorization system. A caller with a genuine account reference can use it; an authenticated API built on it must take the owner from the server-side session and enforce business roles. The kit itself exposes no HTTP endpoints or UI.

`prepareTransaction` contributes extension-owned inserts, updates and explicit guards to the same batch. `transactionSchema` supplies its receipt table. An order extension can commit its order rows, ledger reservations and outbox rows together. SQL predicates are trusted server code and values are bound; a required update must have an explicit precondition guard. Partial refunds, balance imports and external ledgers are outside the kit.

Stock return is explicit: a financial refund does not establish that goods can be restocked. The caller decides whether to combine a credit refund with a stock return.

No DROP TABLE uninstall is declared; reapplying migrations retains balances. Code extensions can declare `requiresExtensions` and atomic `canDisable` predicates (core API 1.36.0), for example refusing to disable while reservations are held, and `canUninstall: false` (core API 1.37.0). Do not remove or restore individual participant receipt tables independently.

## Validation

`test/ledger-kit.test.ts` applies `ledgerSchema` and `ledgerAdjustmentSchema` to a local Cloudflare D1 binding for a 4-decimal credit ledger and an integer stock ledger. It tests exact fractions/overflow, owner isolation, insufficient balance/stock rollback, simultaneous orders, confirm/reject races, replay/conflicts, signed adjustments and audit snapshots.

## Core API 1.37：人工調整與升級

`prepareAdjustment(account, "-0.25")` 或 `"+1.4"` 提供獨立人工調整；呼叫端必須驗證管理員及操作原因，負調整只能動用可用額度，不能扣預留。`balance.adjusted` 為淨修正，`credited` 仍為累計儲值，`consumed` 為扣除退款後使用量。

既有 0001 migration 以 `ledgerSchema(prefix, { adjustments: false })` 保持原 SQL；0002 使用 `ledgerAdjustmentSchema(prefix)` 升級並保留所有帳戶、預留與舊流水帳。新使用者可直接 `ledgerSchema(prefix)` 建立完整 schema。持久化 accounts.credited 為淨資金總額，API 將它減去 adjusted 得到 gross top-ups；不可直接把該 DB 欄位當作累計儲值報表。對帳式為 available + held + consumed = API credited + adjusted。
