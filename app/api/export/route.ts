import { apiError } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { activeLocationLabel, statusLabel } from "@/lib/constants";
import { createXlsx } from "@/lib/xlsx";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const type = url.searchParams.get("type") || "samples";
    const permission = type === "products" ? "products:export" : "samples:export";
    await requireUser(permission); const sql = getDb();
    let workbook: Uint8Array;
    if (type === "products") {
      const rows = await sql`
        SELECT p.sku, p.name, c.name AS category_name, u.name AS business_contact_name, p.store_name, p.price,
               p.product_url,
               (SELECT pai.value FROM product_api_ids pai WHERE pai.product_id = p.id AND pai.id_type = 'product_id' AND pai.is_current = true LIMIT 1) AS api_product_id,
               (SELECT pai.value FROM product_api_ids pai WHERE pai.product_id = p.id AND pai.id_type = 'out_product_id' AND pai.is_current = true LIMIT 1) AS api_out_product_id,
               p.commission, p.store_rating, p.supply_chain, p.cooperation_mechanism,
               p.notes AS product_notes, p.created_at AS product_created_at, p.updated_at AS product_updated_at,
               (SELECT string_agg(DISTINCT department.name, '、')
                  FROM product_departments selected
                  JOIN departments department ON department.id = selected.department_id
                 WHERE selected.product_id = p.id) AS departments,
               (SELECT string_agg(DISTINCT tag.name, '、')
                  FROM product_tags selected_tag
                  JOIN tags tag ON tag.id = selected_tag.tag_id
                 WHERE selected_tag.product_id = p.id) AS tags,
               s.code AS sample_code, s.spec AS sample_spec, s.arrived_at AS sample_arrived_at,
               s.status AS sample_status, s.note AS sample_note, s.updated_at AS sample_updated_at,
               sample_department.name AS sample_department_name, sample_location.name AS sample_location_name
        FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN users u ON u.id = p.business_contact_id
        LEFT JOIN samples s ON s.product_id = p.id AND s.archived = false
        LEFT JOIN departments sample_department ON sample_department.id = s.current_department_id
        LEFT JOIN locations sample_location ON sample_location.id = s.current_location_id
        WHERE p.archived = false
        ORDER BY p.created_at DESC, s.created_at, s.code
        LIMIT 50000
      `;
      const formatted = rows.map((row) => ({
        ...row,
        sampleStatusText: row.sampleCode && row.sampleStatus ? statusLabel(String(row.sampleStatus)) : "",
        samplePlace: row.sampleCode && row.sampleStatus ? activeLocationLabel({
          status: String(row.sampleStatus),
          department_name: row.sampleDepartmentName ? String(row.sampleDepartmentName) : null,
          location_name: row.sampleLocationName ? String(row.sampleLocationName) : null,
        }) : "",
      }));
      workbook = createXlsx("商品与样品明细", [
        { header: "货号", key: "sku", width: 18 }, { header: "商品名称", key: "name", width: 28 }, { header: "分类", key: "categoryName", width: 14 },
        { header: "选品部门", key: "departments", width: 24 }, { header: "商务对接人", key: "businessContactName", width: 16 }, { header: "店铺名", key: "storeName", width: 22 },
        { header: "价格", key: "price", width: 12 }, { header: "商品链接", key: "productUrl", width: 36 }, { header: "product_id", key: "apiProductId", width: 20 }, { header: "out_product_id", key: "apiOutProductId", width: 20 }, { header: "佣金 / 服务费率", key: "commission", width: 16 },
        { header: "店铺评分", key: "storeRating", width: 12 }, { header: "供应链/机构", key: "supplyChain", width: 20 }, { header: "合作机制", key: "cooperationMechanism", width: 28 },
        { header: "标签", key: "tags", width: 18 }, { header: "商品备注", key: "productNotes", width: 28 }, { header: "商品创建时间", key: "productCreatedAt", width: 21 }, { header: "商品更新时间", key: "productUpdatedAt", width: 21 },
        { header: "实物编号", key: "sampleCode", width: 24 }, { header: "样品规格", key: "sampleSpec", width: 16 }, { header: "到样日期", key: "sampleArrivedAt", width: 14 },
        { header: "当前状态", key: "sampleStatusText", width: 14 }, { header: "当前位置", key: "samplePlace", width: 24 }, { header: "样品备注", key: "sampleNote", width: 28 }, { header: "样品最后更新", key: "sampleUpdatedAt", width: 21 },
      ], formatted as unknown as Record<string, unknown>[]);
    } else if (type === "movements") {
      const rows = await sql`
        SELECT m.created_at, s.code, p.sku, p.name AS product_name, m.from_status, m.to_status,
               fd.name AS from_department_name, fl.name AS from_location_name, td.name AS to_department_name,
               tl.name AS to_location_name, u.name AS operator_name, m.remark
        FROM sample_movements m JOIN samples s ON s.id = m.sample_id JOIN products p ON p.id = s.product_id
        LEFT JOIN departments fd ON fd.id = m.from_department_id LEFT JOIN locations fl ON fl.id = m.from_location_id
        LEFT JOIN departments td ON td.id = m.to_department_id LEFT JOIN locations tl ON tl.id = m.to_location_id LEFT JOIN users u ON u.id = m.operator_id
        ORDER BY m.created_at DESC
        LIMIT 50000
      `;
      const formatted = rows.map((row) => ({ ...row, fromStatusText: row.fromStatus ? statusLabel(String(row.fromStatus)) : "首次登记", toStatusText: statusLabel(String(row.toStatus)), fromPlace: [row.fromDepartmentName, row.fromLocationName].filter(Boolean).join(" · ") || "—", toPlace: row.toStatus === "active" ? [row.toDepartmentName, row.toLocationName].filter(Boolean).join(" · ") : statusLabel(String(row.toStatus)) }));
      workbook = createXlsx("流转记录", [
        { header: "操作时间", key: "createdAt", width: 21 }, { header: "实物编号", key: "code", width: 24 }, { header: "货号", key: "sku", width: 18 }, { header: "商品名称", key: "productName", width: 26 },
        { header: "原状态", key: "fromStatusText", width: 14 }, { header: "原位置", key: "fromPlace", width: 22 }, { header: "新状态", key: "toStatusText", width: 14 }, { header: "新位置", key: "toPlace", width: 22 },
        { header: "操作人", key: "operatorName", width: 14 }, { header: "备注", key: "remark", width: 28 },
      ], formatted as unknown as Record<string, unknown>[]);
    } else {
      const rows = await sql`
        SELECT s.code, s.arrived_at, s.status, s.note, s.spec, p.sku, p.name AS product_name, p.store_name,
               d.name AS department_name, l.name AS location_name, s.updated_at
        FROM samples s JOIN products p ON p.id = s.product_id LEFT JOIN departments d ON d.id = s.current_department_id LEFT JOIN locations l ON l.id = s.current_location_id
        WHERE s.archived = false AND p.archived = false
        ORDER BY s.updated_at DESC
        LIMIT 50000
      `;
      const formatted = rows.map((row) => ({ ...row, statusText: statusLabel(String(row.status)), place: activeLocationLabel({ status: String(row.status), department_name: row.departmentName ? String(row.departmentName) : null, location_name: row.locationName ? String(row.locationName) : null }) }));
      workbook = createXlsx("实物样品", [
        { header: "实物编号", key: "code", width: 24 }, { header: "货号", key: "sku", width: 18 }, { header: "商品名称", key: "productName", width: 28 }, { header: "店铺名", key: "storeName", width: 22 },
        { header: "规格", key: "spec", width: 14 }, { header: "到样日期", key: "arrivedAt", width: 14 }, { header: "状态", key: "statusText", width: 14 }, { header: "当前位置", key: "place", width: 24 }, { header: "备注", key: "note", width: 24 }, { header: "最后更新", key: "updatedAt", width: 21 },
      ], formatted as unknown as Record<string, unknown>[]);
    }
    const date = new Date().toISOString().slice(0, 10); const filename = encodeURIComponent(`狐掌柜样品-${type}-${date}.xlsx`);
    return new Response(Buffer.from(workbook), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename*=UTF-8''${filename}` } });
  } catch (error) { return apiError(error); }
}
