export const PERMISSION_GROUPS = [
  {
    label: "工作台",
    items: [{ key: "dashboard:view", label: "查看工作台" }],
  },
  {
    label: "商品档案",
    items: [
      { key: "products:view", label: "查看商品" },
      { key: "products:create", label: "登记商品与到样" },
      { key: "products:edit", label: "修改商品与追加样品" },
      { key: "products:archive", label: "归档商品" },
      { key: "products:correct_merge", label: "纠正误判同款" },
      { key: "products:export", label: "导出商品" },
    ],
  },
  {
    label: "实物样品",
    items: [
      { key: "samples:view", label: "查看样品与条形码" },
      { key: "samples:move", label: "修改位置或状态" },
      { key: "samples:archive", label: "归档样品" },
      { key: "samples:export", label: "导出样品" },
      { key: "movements:view", label: "查看流转记录" },
    ],
  },
  {
    label: "基础资料",
    items: [
      { key: "departments:view", label: "查看部门" },
      { key: "departments:manage", label: "管理部门" },
      { key: "locations:view", label: "查看位置" },
      { key: "locations:manage", label: "管理位置" },
      { key: "catalog:manage", label: "管理分类与标签" },
    ],
  },
  {
    label: "系统管理",
    items: [
      { key: "users:view", label: "查看账号" },
      { key: "users:manage", label: "管理账号" },
      { key: "roles:view", label: "查看角色" },
      { key: "roles:manage", label: "管理角色与权限" },
      { key: "audits:view", label: "查看操作日志" },
      { key: "backups:view", label: "查看备份" },
      { key: "backups:manage", label: "创建与下载备份" },
      { key: "image_matching:manage", label: "管理图片识别" },
    ],
  },
] as const;

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((group) =>
  group.items.map((item) => item.key),
);

export type PermissionKey = (typeof ALL_PERMISSIONS)[number];
