import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createImportTemplate } from "@/lib/xlsx";

export async function GET() {
  try {
    await requireUser("products:create");
    const sql = getDb();
    const [departments, categories, locations] = await Promise.all([
      sql`SELECT name FROM departments WHERE active = true ORDER BY name`,
      sql`SELECT name FROM categories WHERE active = true ORDER BY name`,
      sql`SELECT l.name, d.name AS department_name FROM locations l JOIN departments d ON d.id = l.department_id WHERE l.active = true AND d.active = true ORDER BY d.name, l.name`,
    ]);
    const deptNames = departments.map((d) => String(d.name));
    const catNames = categories.map((c) => String(c.name));
    const locNames = locations.map((l) => String(l.name));
    const deptLocs: Record<string, string[]> = {};
    for (const loc of locations) {
      const dn = String(loc.departmentName);
      (deptLocs[dn] ||= []).push(String(loc.name));
    }

    const templateColumns = [
      { header: "商品名称*", key: "name", width: 22 },
      { header: "选品直播间*", key: "departments", width: 24 },
      { header: "价格*", key: "price", width: 12 },
      { header: "商品链接*", key: "productUrl", width: 36 },
      { header: "佣金*", key: "commission", width: 12 },
      { header: "分类*", key: "category", width: 14 },
      { header: "供应链/机构*", key: "supplyChain", width: 20 },
      { header: "图片链接*", key: "imageUrls", width: 42 },
      { header: "到样数量*", key: "quantity", width: 12 },
      { header: "存放部门*", key: "dept", width: 18 },
      { header: "存放位置*", key: "location", width: 18 },
      { header: "店铺名*", key: "storeName", width: 22 },
      { header: "店铺评分", key: "storeRating", width: 12 },
      { header: "合作机制", key: "cooperationMechanism", width: 22 },
      { header: "备注", key: "notes", width: 24 },
    ];
    const templateRows = [{ name: "示例商品", departments: "选品A直播间, 选品B直播间", price: "99", productUrl: "https://example.com/item/123", commission: "20%", category: catNames[0] || "示例分类", supplyChain: "示例供应链", imageUrls: "https://example.com/img1.jpg, https://example.com/img2.jpg", quantity: "2", dept: deptNames[0] || "商务部", location: locNames[0] || "A货架", storeName: "示例店铺", storeRating: "4.8", cooperationMechanism: "", notes: "示例备注内容" }];

    const refColumns = [
      { header: "分类列表", key: "category", width: 14 },
      { header: "部门列表（直播间+管理）", key: "dept", width: 22 },
      { header: "位置列表", key: "location", width: 18 },
    ];
    const maxRef = Math.max(catNames.length, deptNames.length, locNames.length);
    const refRows: Record<string, string>[] = [];
    for (let i = 0; i < maxRef; i += 1) {
      refRows.push({ category: catNames[i] || "", dept: deptNames[i] || "", location: locNames[i] || "" });
    }

    const workbook = createImportTemplate([
      {
        name: "导入模板",
        columns: templateColumns,
        rows: templateRows,
        validations: [
          { column: 5, type: "list", formula1: `参考数据!$A$2:$A$${Math.max(2, catNames.length + 1)}` },
          { column: 8, type: "list", formula1: `参考数据!$B$2:$B$${Math.max(2, deptNames.length + 1)}` },
          { column: 9, type: "list", formula1: `参考数据!$C$2:$C$${Math.max(2, locNames.length + 1)}` },
        ],
      },
      { name: "参考数据", columns: refColumns, rows: refRows },
    ]);

    const date = new Date().toISOString().slice(0, 10);
    return new Response(Buffer.from(workbook), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("狐掌柜商品导入模板-" + date)}.xlsx`,
      },
    });
  } catch (error) {
    return Response.json({ ok: false, message: error instanceof Error ? error.message : "模板生成失败" }, { status: 500 });
  }
}
