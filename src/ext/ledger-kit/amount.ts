/** Exact fixed-point conversion. Decimal input never passes through a float. */
export function assertPrecision(precision: number): void {
  if (!Number.isInteger(precision) || precision < 0 || precision > 4) {
    throw new Error("precision must be an integer between 0 and 4");
  }
}

export function parseUnits(amount: string, precision: number): number {
  assertPrecision(precision);
  if (typeof amount !== "string" || amount.length > 32 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(amount)) {
    throw new Error("amount must be a nonnegative decimal string");
  }
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > precision) throw new Error("amount exceeds account precision");
  const units = Number(whole + fraction.padEnd(precision, "0"));
  if (!Number.isSafeInteger(units)) throw new Error("amount exceeds safe integer range");
  return units;
}

export function formatUnits(units: number, precision: number): string {
  assertPrecision(precision);
  if (!Number.isSafeInteger(units)) throw new Error("invalid stored units");
  const sign = units < 0 ? "-" : "";
  const digits = String(Math.abs(units)).padStart(precision + 1, "0");
  return sign + (precision === 0 ? digits : `${digits.slice(0, -precision)}.${digits.slice(-precision)}`);
}
