export const SAMPLE_STATUSES = [
  { value: "active", label: "在用/在库", tone: "green" },
  { value: "returned", label: "已退样", tone: "blue" },
  { value: "damaged", label: "已损坏", tone: "red" },
  { value: "lost", label: "已丢失", tone: "red" },
  { value: "gifted", label: "已赠送", tone: "purple" },
] as const;

const LEGACY_SAMPLE_STATUS_LABELS: Record<string, string> = {
  consumed: "已消耗（历史）",
  scrapped: "已报废（历史）",
};

export const DEPARTMENT_KINDS = [
  { value: "business", label: "商务部" },
  { value: "live_room", label: "直播间" },
  { value: "management", label: "管理部门" },
  { value: "other", label: "其他部门" },
] as const;

export const statusLabel = (value: string) =>
  SAMPLE_STATUSES.find((item) => item.value === value)?.label || LEGACY_SAMPLE_STATUS_LABELS[value] || value;

export function activeLocationLabel(row: {
  status: string;
  department_name?: string | null;
  location_name?: string | null;
}) {
  if (row.status !== "active") return statusLabel(row.status);
  return [row.department_name, row.location_name].filter(Boolean).join(" · ") || "位置待确认";
}
