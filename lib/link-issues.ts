export const LINK_ISSUE_STATUSES = ["pending", "replaced", "no_change", "unresolved", "cancelled"] as const;

export type LinkIssueStatus = (typeof LINK_ISSUE_STATUSES)[number];

export const LINK_ISSUE_STATUS_META: Record<LinkIssueStatus, { label: string; tone: string }> = {
  pending: { label: "待处理", tone: "amber" },
  replaced: { label: "已更换链接", tone: "green" },
  no_change: { label: "无需更换", tone: "blue" },
  unresolved: { label: "无法处理", tone: "red" },
  cancelled: { label: "已撤销", tone: "gray" },
};

