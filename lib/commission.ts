export const COMMISSION_INPUT_PATTERN = /^\d+(?:\.\d+)?%?$/;

export function normalizeCommission(value?: string | null) {
  const trimmed = value?.trim() || "";
  return trimmed ? `${trimmed.replace(/%$/, "")}%` : null;
}

export function formatCommission(value?: string | null) {
  return normalizeCommission(value) || "—";
}
