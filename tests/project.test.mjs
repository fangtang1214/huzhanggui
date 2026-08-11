import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { createXlsx } from "../lib/xlsx.ts";
import { isSupportedProductLink, isWebProductLink, productLinkSchema } from "../lib/product-link.ts";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { beijingDate, formatProductSku, formatSampleCode, isProductSkuForDate, nextProductSampleCode, nextProductSku, productSkuPrefix, SkuGenerationError, suggestNextProductSku } from "../lib/sku.ts";
import { cosineSimilarity } from "../lib/cosine.ts";
import { extractSampleCode } from "../lib/scan-code.ts";
import { formatCommission, normalizeCommission } from "../lib/commission.ts";
import { DEFAULT_PRODUCT_COPY_CONFIG, normalizeProductCopyConfig } from "../lib/product-copy.ts";
import { SAMPLE_STATUSES, statusLabel } from "../lib/constants.ts";
import { syncProductImageQueue, urlHash } from "../lib/image-matching.ts";

test("系统包含核心样品流转数据结构", async () => {
  const migration = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
  for (const table of ["products", "samples", "sample_movements", "audit_logs", "users", "departments", "locations"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /sample_code_seq/);
  assert.match(migration, /returned/);
  assert.match(migration, /scrapped/);
});

test("系统使用中文名称并提供一键部署文件", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /狐掌柜-直播样品管理系统/);
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.name, "huzhanggui-sample-management");
  assert.equal(packageJson.dependencies.sharp, packageJson.overrides.sharp);
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /production-dependencies/);
  assert.match(dockerfile, /node_modules/);
  const updateScript = await readFile(new URL("../update.sh", import.meta.url), "utf8");
  assert.match(updateScript, /ADMIN_PASSWORD=.*BOOTSTRAP_PLACEHOLDER/);
  assert.match(updateScript, /8800 8000 8080 8008/);
  assert.match(updateScript, /model-init vision indexer league-sync wecom-sync app backup/);
  assert.match(updateScript, /ALTER DATABASE siyuan RENAME TO huzhanggui/);
  assert.match(updateScript, /ALTER ROLE siyuan RENAME TO huzhanggui/);
  assert.match(updateScript, /copy_volume .*huzhanggui_database_data/);
  assert.match(updateScript, /ln -s "\$INSTALL_DIR" "\$LEGACY_DIR"/);
  assert.match(updateScript, /HUZHANGGUI_UPDATE_REEXEC/);
  assert.match(updateScript, /升级前数据库备份已创建/);
  const installScript = await readFile(new URL("../install.sh", import.meta.url), "utf8");
  assert.match(installScript, /8800 8000 8080 8008/);
  assert.match(installScript, /systemctl is-active --quiet nginx/);
  assert.match(installScript, /POSTGRES_DB=huzhanggui/);
  assert.match(installScript, /fangtang1214\/huzhanggui/);
  const nginxCompose = await readFile(new URL("../docker-compose.nginx.yml", import.meta.url), "utf8");
  assert.match(nginxCompose, /127\.0\.0\.1:\$\{APP_PORT:-8800\}:3000/);
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /pgvector\/pgvector:0\.8\.2-pg15/);
  assert.match(compose, /VISION_DTYPE: q8/);
  assert.match(compose, /SYSTEM_UPDATE_ENABLED: "true"/);
  assert.match(compose, /\/var\/lib\/huzhanggui-updater:\/updates/);
  assert.match(compose, /wecom-sync:/);
  assert.match(compose, /scripts\/wecom-smartsheet-sync\.mjs/);
  const manifest = await readFile(new URL("../app/manifest.ts", import.meta.url), "utf8");
  assert.match(manifest, /short_name: "狐掌柜"/);
  await readFile(new URL("../public/brand/huzhanggui-logo.png", import.meta.url));
  await readFile(new URL("../app/favicon.ico", import.meta.url));
});

test("网页更新仅允许超级管理员并由宿主机受控执行", async () => {
  const route = await readFile(new URL("../app/api/system/update/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireSuperAdmin/);
  assert.match(route, /system\.update_requested/);
  assert.match(route, /readFailureReason/);
  const installer = await readFile(new URL("../scripts/install-web-updater.sh", import.meta.url), "utf8");
  assert.match(installer, /PathExists=\/var\/lib\/huzhanggui-updater\/request/);
  const worker = await readFile(new URL("../scripts/web-update-worker.sh", import.meta.url), "utf8");
  assert.match(worker, /flock -n/);
  assert.match(worker, /bash "\$INSTALL_DIR\/update\.sh"/);
  assert.match(worker, /exitCode.*\$RESULT/);
  assert.match(worker, /chown 1001:1001 "\$LOG_PATH"/);
});

test("商品与样品导出逐行包含当前信息", async () => {
  const archive = createXlsx("商品与样品明细", [
    { header: "货号", key: "sku" },
    { header: "实物编号", key: "sampleCode" },
    { header: "当前状态", key: "sampleStatus" },
    { header: "当前位置", key: "location" },
  ], [
    { sku: "26080001", sampleCode: "26080001-001", sampleStatus: "在用/在库", location: "商务部 · A 货架" },
    { sku: "26080001", sampleCode: "26080001-002", sampleStatus: "已退样", location: "已退样" },
    { sku: "26080002", sampleCode: "", sampleStatus: "", location: "" },
  ]);
  const files = unzipSync(archive);
  assert.ok(files["xl/workbook.xml"]);
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /货号/);
  assert.match(sheet, /实物编号/);
  assert.match(sheet, /当前状态/);
  assert.equal((sheet.match(/26080001/g) || []).length, 4);
  assert.match(sheet, /26080001-001/);
  assert.match(sheet, /26080001-002/);
  assert.match(sheet, /26080002/);
  assert.match(sheet, /商务部 · A 货架/);

  const exportRoute = await readFile(new URL("../app/api/export/route.ts", import.meta.url), "utf8");
  assert.match(exportRoute, /LEFT JOIN samples s ON s\.product_id = p\.id AND s\.archived = false/);
  assert.match(exportRoute, /s\.code AS sample_code/);
  assert.match(exportRoute, /sampleStatusText/);
  assert.match(exportRoute, /samplePlace/);
  assert.doesNotMatch(exportRoute, /header: "样品总数"/);

  const productsView = await readFile(new URL("../components/views/products-view.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(productsView, /ProductApiIdSummary/);
  assert.doesNotMatch(productsView, /当前商品 ID/);
});

test("商品链接支持标准网址和视频号内部格式", () => {
  assert.equal(productLinkSchema.parse("weixinstorehs/28512353738164"), "weixinstorehs/28512353738164");
  assert.equal(productLinkSchema.parse("https://example.com/product/1"), "https://example.com/product/1");
  assert.equal(productLinkSchema.parse("v1=HAOHK025pGFF8tBx69zbwNpU473uiTNa5MOHrs_Hknqa_-Cjk9IbBHMHeKh5rSnIrQ"), "v1=HAOHK025pGFF8tBx69zbwNpU473uiTNa5MOHrs_Hknqa_-Cjk9IbBHMHeKh5rSnIrQ");
  assert.equal(isSupportedProductLink("javascript:alert(1)"), false);
  assert.equal(isWebProductLink("weixinstorehs/28512353738164"), false);
  assert.equal(isWebProductLink("v1=HAOHK025pGFF8tBx69zbwNpU473uiTNa5MOHrs"), false);
});

test("扫码可读取条形码编号并兼容旧二维码网址", () => {
  assert.equal(extractSampleCode("HZG-2026-0001-001"), "HZG-2026-0001-001");
  assert.equal(extractSampleCode("https://example.com/s/HZG-2026-0001-001?from=label"), "HZG-2026-0001-001");
  assert.equal(extractSampleCode("https://example.com/s/OLD%2D001"), "OLD-001");
  assert.equal(extractSampleCode("  "), "");
});

test("批量扫码支持部分成功、统一权限、重复提交保护和本地草稿", async () => {
  const batchRoute = await readFile(new URL("../app/api/samples/batch/route.ts", import.meta.url), "utf8");
  assert.match(batchRoute, /requireUser\("samples:move"\)/);
  assert.match(batchRoute, /max\(100/);
  assert.match(batchRoute, /batchId/);
  assert.match(batchRoute, /results/);
  const scanRoute = await readFile(new URL("../app/api/samples/scan/route.ts", import.meta.url), "utf8");
  assert.match(scanRoute, /sample_code_aliases/);
  const scanner = await readFile(new URL("../components/views/batch-scanner.tsx", import.meta.url), "utf8");
  assert.match(scanner, /huzhanggui:batch-scan:/);
  assert.match(scanner, /navigator\.vibrate/);
  assert.match(scanner, /本批已达到 100 件上限/);
  const productForm = await readFile(new URL("../components/views/products-view.tsx", import.meta.url), "utf8");
  assert.match(productForm, /huzhanggui:product-draft:/);
  assert.match(productForm, /PRODUCT_DRAFT_LIFETIME/);
  const migration = await readFile(new URL("../migrations/006_batch_scan.sql", import.meta.url), "utf8");
  assert.match(migration, /permissions - 'samples:batch'/);
  assert.match(migration, /sample_movements_batch_sample_unique/);
});

test("链接报障支持公共待办、商务处理、历史提醒和重新提交", async () => {
  const migration = await readFile(new URL("../migrations/007_link_issues.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE link_issues/);
  assert.match(migration, /previous_issue_id/);
  assert.match(migration, /WHERE status = 'pending'/);
  const listRoute = await readFile(new URL("../app/api/link-issues/route.ts", import.meta.url), "utf8");
  assert.match(listRoute, /previousIssueId/);
  assert.match(listRoute, /CASE WHEN li\.id = \$\{focusId\}/);
  const actionRoute = await readFile(new URL("../app/api/link-issues/[id]/route.ts", import.meta.url), "utf8");
  assert.match(actionRoute, /departmentKind !== "business"/);
  assert.match(actionRoute, /link_issue\.update_result/);
  assert.match(actionRoute, /UPDATE products SET product_url/);
  const view = await readFile(new URL("../components/views/link-issues-view.tsx", import.meta.url), "utf8");
  assert.match(view, /此问题已在\{handledAgo/);
  assert.match(view, /重新提交报障/);
  assert.match(view, /处理后链接/);
});

test("账号直接授权并限制普通管理员扩大权限", async () => {
  const policy = await readFile(new URL("../lib/account-permissions.ts", import.meta.url), "utf8");
  assert.match(policy, /不能修改自己的账号权限/);
  assert.match(policy, /只有超级管理员可以授予或移除管理账号权限/);
  assert.match(policy, /actor\.permissions\.includes\(permission\)/);
  const navigation = await readFile(new URL("../components/huzhanggui-app.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(navigation, /href: "\/roles"/);
  const migration = await readFile(new URL("../migrations/008_user_permissions.sql", import.meta.url), "utf8");
  assert.match(migration, /ALTER TABLE users ADD COLUMN permissions/);
  assert.match(migration, /DROP TABLE roles/);
  for (const file of ["auth.ts", "../app/api/dashboard/route.ts", "../app/api/products/route.ts", "../app/api/samples/route.ts", "../app/api/movements/route.ts", "../app/api/export/route.ts"]) {
    const source = await readFile(new URL(file.startsWith("..") ? file : `../lib/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /dataScope|scopedDepartment/);
  }
});

test("自动货号使用年月加流水编号", async () => {
  assert.equal(beijingDate(new Date("2026-08-01T16:30:00.000Z")), "2026-08-02");
  assert.equal(productSkuPrefix("2026-08-02"), "2608");
  assert.equal(isProductSkuForDate("26080001", "2026-08-02"), true);
  assert.equal(isProductSkuForDate("26080000", "2026-08-02"), false);
  assert.equal(isProductSkuForDate("26070001", "2026-08-02"), false);
  assert.equal(isProductSkuForDate("2608A001", "2026-08-02"), false);
  assert.equal(formatProductSku("2026-08-02", 7), "26080007");
  assert.equal(formatProductSku("2026-12-31", 9999), "26129999");
  assert.throws(() => formatProductSku("2026-12-31", 10000), /9999/);
  assert.equal(formatSampleCode("26080007", 2), "26080007-002");
  assert.throws(() => formatProductSku("2026-08-02", Number.NaN), SkuGenerationError);
  assert.throws(() => formatSampleCode("SP-20260802-007", 1), SkuGenerationError);

  let productSequence = 0; let sampleSequence = 0; const sequenceDates = [];
  function makeTx() {
    const txFn = async (strings, ...values) => {
      const query = strings.join("?");
      if (query.includes("product_sku_sequences")) {
        if (values.length) sequenceDates.push(String(values[0]));
        return [{ sequence: ++productSequence }];
      }
      if (query.includes("product_sample_sequences")) return [{ sequence: ++sampleSequence }];
      return [];
    };
    txFn.unsafe = async (query, params) => {
      if (query.includes("lastValue")) return [{ lastValue: 1 }];
      if (query.includes("product_sku_sequences")) { if (params) sequenceDates.push(params[0]); return [{ sequence: ++productSequence }]; }
      if (query.includes("product_sample_sequences")) return [{ sequence: ++sampleSequence }];
      return [];
    };
    return txFn;
  }
  const tx = makeTx();
  assert.equal(await nextProductSku(tx, "2026-08-04"), "26080001");
  assert.equal(await nextProductSku(tx, "2026-12-31"), "26120002");
  assert.deepEqual(sequenceDates, ["2026-08-01", "2026-12-01"]);
  assert.equal(await nextProductSampleCode(tx, "00000000-0000-0000-0000-000000000001", "26080001"), "26080001-001");
  assert.equal(await nextProductSampleCode(tx, "00000000-0000-0000-0000-000000000001", "26080001"), "26080001-002");
  await assert.rejects(async () => { const badTx = async () => [{ lastValue: 1 }]; await nextProductSku(badTx, "2026-08-04"); }, SkuGenerationError);

  const suggestTx = async (strings) => {
    const query = strings.join("?");
    if (query.includes("generate_series(1, 9999)")) return [{ sequence: 2 }];
    return [];
  };
  assert.equal(await suggestNextProductSku(suggestTx, "2026-08-04"), "26080002");
});

test("新商品货号允许修改后四位并进行前后端查重", async () => {
  const productsRoute = await readFile(new URL("../app/api/products/route.ts", import.meta.url), "utf8");
  assert.match(productsRoute, /requestedSku/);
  assert.match(productsRoute, /isProductSkuForDate\(requestedSku/);
  assert.match(productsRoute, /SELECT 1 FROM products WHERE lower\(sku\) = lower\(\$\{requestedSku\}\)/);
  assert.match(productsRoute, /ProductSkuConflictError/);

  const availabilityRoute = await readFile(new URL("../app/api/products/sku/route.ts", import.meta.url), "utf8");
  assert.match(availabilityRoute, /requireUser\("products:create"\)/);
  assert.match(availabilityRoute, /suggestNextProductSku/);
  assert.match(availabilityRoute, /SELECT id, archived FROM products/);
  assert.doesNotMatch(availabilityRoute, /archived = false/);
  const skuLibrary = await readFile(new URL("../lib/sku.ts", import.meta.url), "utf8");
  assert.match(skuLibrary, /generate_series\(1, 9999\)/);
  assert.match(skuLibrary, /ORDER BY candidate/);
  assert.doesNotMatch(skuLibrary, /const firstSequence = row/);

  const form = await readFile(new URL("../components/views/products-view.tsx", import.meta.url), "utf8");
  assert.match(form, /skuPrefix/);
  assert.match(form, /商品货号后四位/);
  assert.match(form, /后四位请输入 0001–9999/);
  assert.match(form, /skuAvailability\.status !== "available"/);
  assert.match(form, /requestedSku: recognition\.decision === "matched" \? null : form\.sku/);
});

test("样品列表空筛选可安全加载，商品档案提供价格多选和排序", async () => {
  const samplesRoute = await readFile(new URL("../app/api/samples/route.ts", import.meta.url), "utf8");
  assert.equal((samplesRoute.match(/\$\{status\}::text IS NULL/g) || []).length, 2);
  const productsRoute = await readFile(new URL("../app/api/products/route.ts", import.meta.url), "utf8");
  assert.match(productsRoute, /getAll\("price"\)/);
  assert.match(productsRoute, /priceOptions/);
  assert.match(productsRoute, /p\.price ASC NULLS LAST/);
  assert.match(productsRoute, /p\.price DESC NULLS LAST/);
  const productsView = await readFile(new URL("../components/views/products-view.tsx", import.meta.url), "utf8");
  for (const step of ["01", "02", "03", "04"]) assert.match(productsView, new RegExp(`section-number">${step}`));
  assert.match(productsView, /className="arrival-submit"/);
  assert.match(productsView, /已选 \$\{prices\.length\} 个价格/);
});

test("商品档案可通过当前及历史商品 ID 搜索", async () => {
  const searchLibrary = await readFile(new URL("../lib/search.ts", import.meta.url), "utf8");
  assert.match(searchLibrary, /FROM product_api_ids pai WHERE pai\.product_id=p\.id AND pai\.value ILIKE/);
  assert.doesNotMatch(searchLibrary, /product_api_ids pai[^\n]*is_current/);

  const productsView = await readFile(new URL("../components/views/products-view.tsx", import.meta.url), "utf8");
  assert.equal((productsView.match(/搜索(?:已归档商品的)?货号、商品 ID/g) || []).length, 2);
});

test("图片特征使用余弦相似度比较", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("图片识别使用预热的 Q8 模型与前后台优先队列", async () => {
  const vision = await readFile(new URL("../scripts/vision-server.mjs", import.meta.url), "utf8");
  assert.match(vision, /dtype: modelDtype/);
  assert.match(vision, /warmModel/);
  assert.match(vision, /interactiveQueue\.shift\(\) \|\| backgroundQueue\.shift\(\)/);
  const route = await readFile(new URL("../app/api/image-matching/route.ts", import.meta.url), "utf8");
  assert.match(route, /image_subject_cache/);
  assert.match(route, /subject_embedding_vector <=>/);
});

test("同商品 ID 或主图链接直接关联，主体相似候选仍需人工确认", async () => {
  const route = await readFile(new URL("../app/api/image-matching/route.ts", import.meta.url), "utf8");
  assert.ok(route.indexOf("exactIdMatch(input.apiProductId)") < route.indexOf("getGlmRuntime()"));
  assert.ok(route.indexOf("exactImageMatches([primary], input.excludeProductIds)") < route.indexOf("getGlmRuntime()"));
  assert.match(route, /canonicalImageResourceUrl/);
  assert.match(route, /regexp_replace\(trim\(stored\.image_url\), '\[\?\]imageView2\/\.\*\$'/);
  assert.match(route, /status: "exact_match"/);
  assert.match(route, /subject_embedding_vector <=>/);
  assert.match(route, /slice\(0, 5\)/);
  assert.match(route, /matchedImageCount/);
  assert.match(route, /primaryUncached \? \[\[primaryUncached\]\] : \[\]/);
  assert.match(route, /groupsOf\(remainingUncached, SUBJECT_BATCH_SIZE\)/);
  assert.match(route, /primaryProcessed: vectors\.some/);
  assert.ok(route.indexOf("if (candidates.length)") < route.indexOf("if (!collected.primaryProcessed)"));
  assert.match(route, /主图未能完成主体定位与本地比对/);
  assert.match(route, /REALTIME_TOTAL_TIMEOUT_MS = 10_000/);
  assert.match(route, /REALTIME_WORK_TIMEOUT_MS = REALTIME_TOTAL_TIMEOUT_MS - 1_000/);
  assert.match(route, /REALTIME_IMAGE_LIMIT = 8/);
  assert.match(route, /collectSubjectVectors/);
  assert.match(route, /Promise\.all\(embeddingTasks\)/);
  assert.match(route, /failedImageCount/);
  assert.match(route, /failureReasons, timings/);
  assert.doesNotMatch(route, /reviewCandidates/);
  assert.doesNotMatch(route, /1-\(embedding_vector <=>/);
  assert.match(route, /manual: z\.boolean/);
  const productsRoute = await readFile(new URL("../app/api/products/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(productsRoute, /pai\.is_current = true AND p\.archived = false/);
  const migration = await readFile(new URL("../migrations/025_glm_subject_matching.sql", import.meta.url), "utf8");
  assert.match(migration, /subject_embedding_vector vector\(512\)/);
  assert.match(migration, /image_subject_cache/);
  const modelMigration = await readFile(new URL("../migrations/026_glm_model_selection.sql", import.meta.url), "utf8");
  assert.match(modelMigration, /subject_model varchar\(120\)/);
  const manualBoxMigration = await readFile(new URL("../migrations/027_manual_subject_box.sql", import.meta.url), "utf8");
  assert.match(manualBoxMigration, /subject_box_source/);
  assert.match(manualBoxMigration, /subject_corrected_by/);
  assert.match(manualBoxMigration, /box_source/);
  const recognitionRoute = await readFile(new URL("../app/api/recognition/route.ts", import.meta.url), "utf8");
  assert.match(recognitionRoute, /glm-4\.6v-flashx/);
  assert.match(recognitionRoute, /glm_reindex_all/);
  assert.match(recognitionRoute, /ON CONFLICT\(key\) DO UPDATE SET value=excluded\.value,updated_at=now\(\)\s+RETURNING value/);
  assert.match(recognitionRoute, /savedModel !== input\.model/);
  const recognitionView = await readFile(new URL("../components/views/recognition-view.tsx", import.meta.url), "utf8");
  assert.match(recognitionView, /服务器当前已生效/);
  assert.match(recognitionView, /保存并立即生效/);
  const productsView = await readFile(new URL("../components/views/products-view.tsx", import.meta.url), "utf8");
  assert.match(productsView, /正在优先识别主图并进行本地比对/);
  assert.match(productsView, /相同主图链接/);
  assert.match(productsView, /result\.status === "id_match" \|\| result\.status === "exact_match"/);
  assert.match(productsView, /主图链接完全一致，已直接关联/);
  assert.match(productsView, /商品 ID 或主图链接相同会直接关联/);
  assert.match(productsView, /phase === "ready"[\s\S]*recognition\.failureReasons\.length > 0/);
  const resultRoute = await readFile(new URL("../app/api/recognition/subject-index/route.ts", import.meta.url), "utf8");
  assert.match(resultRoute, /subject_box/);
  assert.match(resultRoute, /subject_model/);
  assert.match(resultRoute, /subject_box_source='manual'/);
  assert.match(resultRoute, /image\.subject_box_corrected/);
  const resultView = await readFile(new URL("../components/views/subject-index-results.tsx", import.meta.url), "utf8");
  assert.match(resultView, /绿色是 GLM 自动框/);
  assert.match(resultView, /主体框坐标/);
  assert.match(resultView, /纠正主体框/);
  assert.match(resultView, /人工已纠正/);
  const indexer = await readFile(new URL("../scripts/image-indexer.mjs", import.meta.url), "utf8");
  assert.match(indexer, /subject_box_source === "manual"/);
  assert.match(indexer, /p\.name AS product_name/);
  assert.match(indexer, /defaultGlmModel/);
  const glmVision = await readFile(new URL("../lib/glm-vision.ts", import.meta.url), "utf8");
  assert.match(glmVision, /analyzeSubjectWithFallback/);
  assert.match(glmVision, /analyzeSubjectsWithFallback/);
  assert.match(glmVision, /SUBJECT_HEDGE_DELAY_MS = 3_000/);
  assert.match(glmVision, /SUBJECT_STAGE_TIMEOUT_MS = 7_000/);
});

test("问题处理、商品复制、流转图片和状态精简按新流程实现", async () => {
  assert.equal(normalizeCommission("20"), "20%");
  assert.equal(normalizeCommission("20%"), "20%");
  assert.equal(formatCommission("12.5"), "12.5%");
  const copyConfig = normalizeProductCopyConfig({ order: ["productUrl", "image"], enabled: ["image", "sku"] });
  assert.deepEqual(copyConfig.order.slice(0, 2), ["productUrl", "image"]);
  assert.deepEqual(copyConfig.enabled, ["image", "sku"]);
  assert.deepEqual(DEFAULT_PRODUCT_COPY_CONFIG.enabled, ["image", "price", "productUrl"]);

  const searchLib = await readFile(new URL("../lib/search.ts", import.meta.url), "utf8");
  assert.match(searchLib, /right\(p\.sku, 4\)/);
  assert.match(searchLib, /product_url ILIKE/);
  const productsRoute = await readFile(new URL("../app/api/products/route.ts", import.meta.url), "utf8");
  assert.match(productsRoute, /p\.cooperation_mechanism, p\.notes/);
  const productsView = await readFile(new URL("../components/views/products-view.tsx", import.meta.url), "utf8");
  assert.match(productsView, /设置一键复制内容/);
  assert.match(productsView, /粘贴后的单元格顺序/);
  assert.match(productsView, /添加其他内容/);
  assert.match(productsView, /copyProductToClipboard/);
  assert.match(productsView, /copyProduct/);
  assert.match(productsView, /一键复制/);
  assert.match(productsView, /\/api\/auth\/product-copy/);
  assert.match(productsView, /draggable/);
  assert.match(productsView, /className="table-place"><MapPin/);
  assert.match(productsView, /<th>价格<\/th><th>佣金<\/th>/);

  const copyRoute = await readFile(new URL("../app/api/auth/product-copy/route.ts", import.meta.url), "utf8");
  assert.match(copyRoute, /UPDATE users SET product_copy_config/);
  assert.match(copyRoute, /export async function GET/);
  const clipboardHelper = await readFile(new URL("../lib/product-copy-clipboard.ts", import.meta.url), "utf8");
  assert.match(clipboardHelper, /ClipboardItem/);
  const copyImageRoute = await readFile(new URL("../app/api/products/[id]/copy-image/route.ts", import.meta.url), "utf8");
  assert.match(copyImageRoute, /SELECT image_urls FROM products/);
  const restoreRoute = await readFile(new URL("../app/api/products/[id]/restore/route.ts", import.meta.url), "utf8");
  assert.match(restoreRoute, /requireUser\("products:archive"\)/);
  assert.match(restoreRoute, /archived_with_product = true/);
  assert.match(restoreRoute, /product\.restore/);
  const restoreMigration = await readFile(new URL("../migrations/011_product_restore.sql", import.meta.url), "utf8");
  assert.match(restoreMigration, /ADD COLUMN IF NOT EXISTS archived_with_product/);
  const archiveView = await readFile(new URL("../components/views/products-view.tsx", import.meta.url), "utf8");
  assert.match(archiveView, /在用商品/);
  assert.match(archiveView, /已归档商品/);
  assert.match(archiveView, /恢复商品/);

  const issueRoute = await readFile(new URL("../app/api/link-issues/route.ts", import.meta.url), "utf8");
  assert.match(issueRoute, /p\.supply_chain/);
  assert.match(searchLib, /product_link_history/);
  const productDetailRoute = await readFile(new URL("../app/api/products/[id]/route.ts", import.meta.url), "utf8");
  assert.match(productDetailRoute, /source, changed_by/);
  assert.match(productDetailRoute, /linkHistory/);
  const linkHistoryMigration = await readFile(new URL("../migrations/012_product_link_history.sql", import.meta.url), "utf8");
  assert.match(linkHistoryMigration, /CREATE TABLE product_link_history/);
  assert.doesNotMatch(linkHistoryMigration, /INSERT INTO product_link_history/);
  const issueView = await readFile(new URL("../components/views/link-issues-view.tsx", import.meta.url), "utf8");
  assert.match(issueView, /供应链：/);
  assert.match(issueView, /等待商务处理/);
  assert.match(issueView, /const processedLink/);
  assert.doesNotMatch(issueView, /商品档案当前链接/);
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /\.issue-card\s*\{[\s\S]*?overflow:\s*hidden[\s\S]*?border-radius:\s*12px/);
  assert.match(styles, /\.issue-note-box\.issue-note-resolution/);

  const movementRoute = await readFile(new URL("../app/api/movements/route.ts", import.meta.url), "utf8");
  assert.match(movementRoute, /p\.image_urls/);
  const movementView = await readFile(new URL("../components/views/movements-view.tsx", import.meta.url), "utf8");
  assert.match(movementView, /<ProductImage urls=\{item\.imageUrls\}/);
  assert.deepEqual(SAMPLE_STATUSES.map((item) => item.value), ["active", "returned", "damaged", "lost", "gifted"]);
  assert.equal(statusLabel("consumed"), "已消耗（历史）");
  assert.equal(statusLabel("scrapped"), "已报废（历史）");
});

test("数据库迁移可在 PostgreSQL 引擎中完整执行", async () => {
  const database = new PGlite({ extensions: { vector } });
  try {
    const directory = new URL("../migrations/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    for (const file of files) {
      if (file === "003_image_matching_performance.sql") await database.exec(`
        INSERT INTO products (sku, name, image_urls, created_at) VALUES ('SP-20260804-NaN', '升级前商品', '["https://example.com/old.jpg"]', '2026-08-04T02:00:00Z');
        INSERT INTO product_sku_sequences(sku_date,last_value) VALUES ('2026-08-04',1);
        INSERT INTO product_image_features (product_id, image_url, url_hash, embedding, status)
        SELECT id, 'https://example.com/old.jpg', repeat('a', 64), ARRAY[1,0]::real[], 'ready' FROM products WHERE sku='SP-20260804-NaN';
        INSERT INTO samples(code,product_id,arrived_at,created_at)
        SELECT 'SY-20260804-000001',id,'2026-08-04','2026-08-04T02:01:00Z' FROM products WHERE sku='SP-20260804-NaN';
        INSERT INTO samples(code,product_id,arrived_at,created_at)
        SELECT 'SY-20260804-000002',id,'2026-08-04','2026-08-04T02:02:00Z' FROM products WHERE sku='SP-20260804-NaN';
      `);
      if (file === "008_user_permissions.sql") await database.exec(`
        INSERT INTO departments(name,kind) VALUES ('迁移测试部门','management');
        INSERT INTO roles(name,permissions,data_scope) VALUES ('旧普通角色','["products:view","samples:view","roles:view"]','department');
        INSERT INTO users(username,name,password_hash,department_id,role_id)
        SELECT 'migration-user','迁移用户','test',d.id,r.id FROM departments d,roles r WHERE d.name='迁移测试部门' AND r.name='旧普通角色';
        INSERT INTO roles(name,permissions,data_scope,is_system) VALUES ('旧超级管理员','["*"]','all',true);
        INSERT INTO users(username,name,password_hash,department_id,role_id)
        SELECT 'migration-admin','迁移管理员','test',d.id,r.id FROM departments d,roles r WHERE d.name='迁移测试部门' AND r.name='旧超级管理员';
      `);
      if (file === "009_product_workflow_optimizations.sql") await database.exec(`
        UPDATE samples SET status='consumed' WHERE id=(SELECT id FROM samples ORDER BY created_at LIMIT 1);
      `);
      if (file === "032_league_directory_sync_recovery.sql") await database.exec(`
        INSERT INTO league_accounts(name,appid,app_secret,active)
        VALUES('同步恢复测试机构','wx-sync-recovery','secret',true);
        INSERT INTO league_cooperative_cache_state(league_account_id,item_count,synced_at,sync_status,sync_started_at)
        SELECT id,1599,now()-interval '1 hour','running',now()-interval '10 minutes'
        FROM league_accounts WHERE appid='wx-sync-recovery';
      `);
      await database.exec(await readFile(new URL(file, directory), "utf8"));
    }
    await database.exec(`
      INSERT INTO departments (name, kind) VALUES ('商务部', 'business')
      ON CONFLICT ((lower(name))) DO UPDATE SET active = true;
      INSERT INTO departments (name, kind) VALUES ('商务部', 'business')
      ON CONFLICT ((lower(name))) DO UPDATE SET active = true;
    `);
    const result = await database.query("SELECT count(*)::int AS count FROM departments WHERE name = '商务部'");
    assert.equal(result.rows[0].count, 1);
    await database.query("INSERT INTO products(sku,name,archived) VALUES('26089999','归档货号占用测试',true)");
    await assert.rejects(database.query("INSERT INTO products(sku,name) VALUES('26089999','重复货号测试')"), /duplicate key|unique constraint/i);
    await database.query("DELETE FROM products WHERE sku='26089999'");
    await database.query("INSERT INTO products(sku,name) VALUES('26080001','最小货号测试一'),('26080003','最小货号测试三')");
    const pgliteTag = async (strings, ...values) => {
      const query = strings.reduce((source, part, index) => source + (index ? `$${index}` : "") + part, "");
      return (await database.query(query, values)).rows;
    };
    assert.equal(await suggestNextProductSku(pgliteTag, "2026-08-04"), "26080002");
    await database.query("DELETE FROM products WHERE sku IN ('26080001','26080003')");
    const settings = await database.query("SELECT value->>'mode' AS mode FROM app_settings WHERE key = 'image_matching'");
    assert.equal(settings.rows[0].mode, "standard");
    const model = await database.query("SELECT value->>'model' AS model FROM app_settings WHERE key = 'image_matching'");
    assert.equal(model.rows[0].model, "Xenova/clip-vit-base-patch32:q8");
    const vectorColumn = await database.query("SELECT data_type FROM information_schema.columns WHERE table_name='product_image_features' AND column_name='embedding_vector'");
    assert.equal(vectorColumn.rows[0].data_type, "USER-DEFINED");
    const vectorIndex = await database.query("SELECT indexname FROM pg_indexes WHERE indexname='product_image_features_embedding_hnsw_idx'");
    assert.equal(vectorIndex.rows[0].indexname, "product_image_features_embedding_hnsw_idx");
    const upgradedFeature = await database.query("SELECT model,status,embedding,embedding_vector FROM product_image_features LIMIT 1");
    assert.equal(upgradedFeature.rows[0].model, "Xenova/clip-vit-base-patch32:q8");
    assert.equal(upgradedFeature.rows[0].status, "pending");
    assert.equal(upgradedFeature.rows[0].embedding, null);
    assert.equal(upgradedFeature.rows[0].embedding_vector, null);
    const repairedProduct = await database.query("SELECT id,sku FROM products WHERE name='升级前商品'");
    assert.equal(repairedProduct.rows[0].sku, "HZG-2026-0001");
    const repairedSamples = await database.query("SELECT code FROM samples ORDER BY created_at");
    assert.deepEqual(repairedSamples.rows.map((row) => row.code), ["HZG-2026-0001-001", "HZG-2026-0001-002"]);
    const oldCodeAlias = await database.query("SELECT count(*)::int AS count FROM sample_code_aliases");
    assert.equal(oldCodeAlias.rows[0].count, 4);
    const oldSkuAliases = await database.query("SELECT alias FROM product_sku_aliases ORDER BY alias");
    assert.deepEqual(oldSkuAliases.rows.map((row) => row.alias), ["HZG-20260804-001", "SP-20260804-NaN"]);
    const sampleSequence = await database.query("SELECT last_value FROM product_sample_sequences");
    assert.equal(sampleSequence.rows[0].last_value, 2);
    const removedIdColumns = await database.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE (table_name = 'product_api_ids' AND column_name = 'id_type')
         OR (table_name = 'talent_window_products' AND column_name IN ('promotion_product_id', 'promotion_out_product_id'))
         OR (table_name = 'talent_window_promotion_candidates' AND column_name IN ('product_id', 'out_product_id'))
         OR (table_name = 'product_link_correction_items' AND column_name = 'api_out_product_id')
    `);
    assert.deepEqual(removedIdColumns.rows, []);
    const sourceProductIdColumn = await database.query("SELECT data_type FROM information_schema.columns WHERE table_name='talent_window_products' AND column_name='out_product_id'");
    assert.equal(sourceProductIdColumn.rows[0].data_type, "text");
    const talentAccount = await database.query("INSERT INTO talent_accounts(name,appid,app_secret) VALUES('ID测试账号','wx-id-test','secret') RETURNING id");
    await database.query("INSERT INTO talent_window_products(account_id,product_id,out_product_id,product_source) VALUES($1,'14000813361261','10001176563660',2)", [talentAccount.rows[0].id]);
    const effectiveWindowId = await database.query("SELECT coalesce(out_product_id,product_id) AS product_id FROM talent_window_products WHERE account_id=$1", [talentAccount.rows[0].id]);
    assert.equal(effectiveWindowId.rows[0].product_id, "10001176563660");
    await database.query("INSERT INTO product_api_ids(product_id,value,is_current) VALUES($1,'10001213105308',true)", [repairedProduct.rows[0].id]);
    const currentProductId = await database.query("SELECT value FROM product_api_ids WHERE product_id=$1 AND is_current=true", [repairedProduct.rows[0].id]);
    assert.equal(currentProductId.rows[0].value, "10001213105308");
    const emptyStatusFilter = await database.query("SELECT count(*)::int AS count FROM samples s WHERE ($1::text IS NULL OR s.status=$2)", [null, null]);
    assert.equal(emptyStatusFilter.rows[0].count, 2);
    const batchIndex = await database.query("SELECT indexname FROM pg_indexes WHERE indexname='sample_movements_batch_sample_unique'");
    assert.equal(batchIndex.rows[0].indexname, "sample_movements_batch_sample_unique");
    const product = await database.query("SELECT id FROM products WHERE name='升级前商品'");
    const department = await database.query("SELECT id FROM departments WHERE name='商务部'");
    const firstIssue = await database.query(`INSERT INTO link_issues(product_id,reported_department_id,report_note)
      VALUES($1,$2,'链接已下架') RETURNING id`, [product.rows[0].id, department.rows[0].id]);
    await assert.rejects(database.query(`INSERT INTO link_issues(product_id,reported_department_id,report_note)
      VALUES($1,$2,'重复报障')`, [product.rows[0].id, department.rows[0].id]), /unique|duplicate/i);
    await database.query("UPDATE link_issues SET status='replaced',new_product_url='weixinstorehs/200',resolved_at=now() WHERE id=$1", [firstIssue.rows[0].id]);
    await database.query(`INSERT INTO link_issues(product_id,previous_issue_id,reported_department_id,old_product_url,report_note)
      VALUES($1,$2,$3,'weixinstorehs/200','最新链接仍不可用')`, [product.rows[0].id, firstIssue.rows[0].id, department.rows[0].id]);
    const issues = await database.query("SELECT status,previous_issue_id FROM link_issues ORDER BY created_at,id");
    assert.equal(issues.rows.length, 2);
    assert.equal(issues.rows[0].status, "replaced");
    assert.equal(issues.rows[1].previous_issue_id, firstIssue.rows[0].id);
    const migratedUser = await database.query("SELECT permissions,is_super_admin FROM users WHERE username='migration-user'");
    assert.deepEqual(migratedUser.rows[0].permissions, ["products:view", "samples:view"]);
    assert.equal(migratedUser.rows[0].is_super_admin, false);
    const migratedAdmin = await database.query("SELECT permissions,is_super_admin FROM users WHERE username='migration-admin'");
    assert.deepEqual(migratedAdmin.rows[0].permissions, []);
    assert.equal(migratedAdmin.rows[0].is_super_admin, true);
    const rolesTable = await database.query("SELECT to_regclass('roles') AS name");
    assert.equal(rolesTable.rows[0].name, null);
    const copyPreferences = await database.query('SELECT product_copy_config AS "productCopyConfig" FROM users WHERE username=\'migration-user\'');
    assert.deepEqual(copyPreferences.rows[0].productCopyConfig.enabled, ["image", "price", "productUrl"]);
    const legacyStatuses = await database.query("SELECT status FROM samples ORDER BY created_at LIMIT 1");
    assert.equal(legacyStatuses.rows[0].status, "consumed");
    const restoreColumn = await database.query("SELECT data_type FROM information_schema.columns WHERE table_name='samples' AND column_name='archived_with_product'");
    assert.equal(restoreColumn.rows[0].data_type, "boolean");
    const historyTable = await database.query("SELECT to_regclass('product_link_history') AS name");
    assert.equal(historyTable.rows[0].name, "product_link_history");
    const wecomRecordsTable = await database.query("SELECT to_regclass('wecom_smartsheet_product_records') AS name");
    assert.equal(wecomRecordsTable.rows[0].name, "wecom_smartsheet_product_records");
    const wecomState = await database.query("SELECT sync_status FROM wecom_smartsheet_sync_state WHERE singleton=true");
    assert.equal(wecomState.rows[0].sync_status, "idle");
    const wecomImageColumns = await database.query("SELECT column_name FROM information_schema.columns WHERE table_name='wecom_smartsheet_sync_state' AND column_name IN ('image_failed_count','image_error') ORDER BY column_name");
    assert.deepEqual(wecomImageColumns.rows.map((row) => row.column_name), ["image_error", "image_failed_count"]);
    const existingHistory = await database.query("SELECT count(*)::int AS count FROM product_link_history");
    assert.equal(existingHistory.rows[0].count, 0);
    const exactImageMatch = await database.query(`
      WITH incoming(image_url, image_order) AS (
        SELECT trim(value), ordinality::int
        FROM unnest($1::text[]) WITH ORDINALITY AS input(value, ordinality)
      )
      SELECT p.id AS product_id
      FROM incoming
      JOIN products p ON EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(p.image_urls) AS stored(image_url)
        WHERE trim(stored.image_url) = incoming.image_url
      )
      WHERE NOT(p.id=ANY($2::uuid[]))
    `, [["https://example.com/old.jpg"], []]);
    assert.equal(exactImageMatch.rows[0].product_id, repairedProduct.rows[0].id);
    const directoryCacheColumns = await database.query("SELECT column_name FROM information_schema.columns WHERE table_name='league_cooperative_item_cache' ORDER BY column_name");
    assert.deepEqual(directoryCacheColumns.rows.map((row) => row.column_name), ["cooperative_item_id", "head_supplier_item_link", "league_account_id", "link_type", "product_id", "promotion_detail_link", "synced_at"]);
    const promotionCandidateTypeColumn = await database.query("SELECT column_name FROM information_schema.columns WHERE table_name='talent_window_promotion_candidates' AND column_name='link_type'");
    assert.deepEqual(promotionCandidateTypeColumn.rows.map((row) => row.column_name), ["link_type"]);
    const directoryStateColumns = await database.query("SELECT column_name FROM information_schema.columns WHERE table_name='league_cooperative_cache_state' AND column_name IN ('sync_status','sync_requested_at','sync_started_at','sync_error','sync_progress_count','sync_heartbeat_at') ORDER BY column_name");
    assert.deepEqual(directoryStateColumns.rows.map((row) => row.column_name), ["sync_error", "sync_heartbeat_at", "sync_progress_count", "sync_requested_at", "sync_started_at", "sync_status"]);
    const recoveredDirectorySync = await database.query("SELECT sync_status,sync_requested_at,sync_started_at,sync_progress_count FROM league_cooperative_cache_state state JOIN league_accounts account ON account.id=state.league_account_id WHERE account.appid='wx-sync-recovery'");
    assert.equal(recoveredDirectorySync.rows[0].sync_status, "pending");
    assert.ok(recoveredDirectorySync.rows[0].sync_requested_at);
    assert.equal(recoveredDirectorySync.rows[0].sync_started_at, null);
    assert.equal(recoveredDirectorySync.rows[0].sync_progress_count, 0);
    const lookupThrottleTable = await database.query("SELECT to_regclass('league_product_lookup_throttles') AS name");
    assert.equal(lookupThrottleTable.rows[0].name, "league_product_lookup_throttles");
    await database.query("INSERT INTO product_link_history(product_id,url,replaced_by_url,source) VALUES($1,'https://example.com/old-product-link','https://example.com/latest-product-link','product_edit')", [product.rows[0].id]);
    const fuzzyHistory = await database.query("SELECT count(*)::int AS count FROM products p WHERE EXISTS (SELECT 1 FROM product_link_history history WHERE history.product_id=p.id AND history.url ILIKE $1)", ["%old-product%"]);
    assert.equal(fuzzyHistory.rows[0].count, 1);
    const recognizedImageUrl = "https://example.com/realtime-recognized.jpg";
    const recognizedVector = `[${Array.from({ length: 512 }, () => "0.01").join(",")}]`;
    await database.query(`INSERT INTO image_subject_cache(url_hash,model,image_url,subject_box,embedding,box_source)
      VALUES($1,'glm-4.6v-flash',$2,'[10,20,900,950]'::jsonb,$3::vector,'glm')`, [urlHash(recognizedImageUrl), recognizedImageUrl, recognizedVector]);
    await syncProductImageQueue(product.rows[0].id, [recognizedImageUrl], {
      unsafe: async (query, parameters = []) => (await database.query(query, parameters)).rows,
    });
    const reusedSubject = await database.query("SELECT subject_status,subject_box,subject_model,subject_box_source,subject_embedding_vector IS NOT NULL AS has_embedding FROM product_image_features WHERE product_id=$1 AND url_hash=$2", [product.rows[0].id, urlHash(recognizedImageUrl)]);
    assert.equal(reusedSubject.rows[0].subject_status, "ready");
    assert.deepEqual(reusedSubject.rows[0].subject_box, [10, 20, 900, 950]);
    assert.equal(reusedSubject.rows[0].subject_model, "glm-4.6v-flash");
    assert.equal(reusedSubject.rows[0].subject_box_source, "glm");
    assert.equal(reusedSubject.rows[0].has_embedding, true);
  } finally {
    await database.close();
  }
});

test("橱窗选品登记需要带货账号配置与官方接口同步", async () => {
  const migration = await readFile(new URL("../migrations/015_talent_window.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS talent_accounts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS talent_window_products/);
  assert.match(migration, /UNIQUE \(account_id, product_id\)/);
  const api = await readFile(new URL("../lib/talent-window.ts", import.meta.url), "utf8");
  assert.match(api, /\/cgi-bin\/token\?appid=/);
  assert.match(api, /\/channels\/ec\/talent\/window\/product\/list\/get/);
  assert.match(api, /\/channels\/ec\/talent\/window\/product\/get/);
  assert.match(api, /40164/);
  assert.match(api, /out_product_id/);
  const accountsRoute = await readFile(new URL("../app/api/talent-accounts/route.ts", import.meta.url), "utf8");
  assert.match(accountsRoute, /requireSuperAdmin/);
  assert.match(accountsRoute, /RETURNING id, name, appid, active, sync_status, synced_at, created_at/);
  assert.doesNotMatch(accountsRoute, /SELECT a\.id, a\.name, a\.appid, a\.app_secret/);
  const syncRoute = await readFile(new URL("../app/api/talent-accounts/[id]/sync/route.ts", import.meta.url), "utf8");
  assert.match(syncRoute, /products:create/);
  assert.match(syncRoute, /sync_status <> 'syncing'/);
  const productsRoute = await readFile(new URL("../app/api/window-products/route.ts", import.meta.url), "utf8");
  assert.match(productsRoute, /requireUser\("products:create"\)/);
  assert.match(productsRoute, /promotion_candidates/);
  assert.doesNotMatch(productsRoute, /'weixinstorehs\/' \|\| w\.product_id/);
  assert.match(productsRoute, /fetchLeagueProductDetail\(qualityAccount/);
  assert.match(productsRoute, /qualitySource\.leagueAccountId/);
  assert.match(productsRoute, /qualitySource\.productId/);
  assert.match(productsRoute, /coalesce\(w\.out_product_id, w\.product_id\)/);
  assert.match(productsRoute, /LEFT JOIN product_api_ids pai/);
  assert.match(productsRoute, /pai\.value = coalesce\(w\.out_product_id, w\.product_id\)/);
  assert.match(productsRoute, /LIMIT \$\{pageSize\} OFFSET \$\{offset\}/);
  assert.match(productsRoute, /pendingPromotions/);
  assert.match(productsRoute, /params\.get\("status"\) === "1"/);
  assert.match(productsRoute, /'\[\]'::json AS promotion_candidates/);
  assert.doesNotMatch(productsRoute, /FROM products candidate_product/);
  assert.doesNotMatch(productsRoute, /candidate_product\.product_url = w\.promotion_link/);
  assert.doesNotMatch(productsRoute, /id_type/);
  const leagueProduct = await readFile(new URL("../lib/league-product.ts", import.meta.url), "utf8");
  assert.match(leagueProduct, /pai\.value = \$\{effectiveProductId\}/);
  assert.doesNotMatch(leagueProduct, /pai\.value IN \(\$\{effectiveProductId\}, \$\{String\(row\.productId\)\}\)/);
  assert.doesNotMatch(leagueProduct, /p\.product_url = \$\{safeText\(row\.promotionLink\)\}/);
  const form = await readFile(new URL("../components/views/products-view.tsx", import.meta.url), "utf8");
  assert.match(form, /draftCandidate/);
  assert.match(form, /仅更新商品信息/);
  assert.match(form, /value="update_only"/);
  assert.match(form, /imageSearchMode === "url"/);
  assert.match(form, /setImageSearchMode\("upload"\)/);
  assert.match(form, /imagePasteRef\.current\?\.focus\(\)/);
  assert.match(form, /剪贴板中没有图片，请先复制一张图片/);
  assert.match(form, /onDrop=\{handleImageDrop\}/);
  assert.match(form, /选择、粘贴或拖放要搜索的图片/);
  assert.match(form, /!result\.updatedOnly && result\.codes\.length === 1/);
  assert.match(form, /router\.push\(`\/samples\/\$\{result\.codes\[0\]\}`\)/);
  assert.match(form, /router\.push\(`\/products\/\$\{result\.id\}`\)/);
  assert.doesNotMatch(form, /result\.updatedOnly \|\| !returnUrl/);
  const registrationRoute = await readFile(new URL("../app/api/products/route.ts", import.meta.url), "utf8");
  assert.match(registrationRoute, /submissionMode: z\.enum\(\["add_samples", "update_only"\]\)/);
  assert.match(registrationRoute, /if \(!updateOnly\)/);
  assert.match(registrationRoute, /updatedOnly: updateOnly/);
  assert.match(registrationRoute, /coalesce\(w\.out_product_id, w\.product_id\)/);
  assert.doesNotMatch(registrationRoute, /apiOutProductId|id_type/);
  const navigation = await readFile(new URL("../components/huzhanggui-app.tsx", import.meta.url), "utf8");
  assert.match(navigation, /\/talent-accounts/);
  assert.match(navigation, /\/window-products/);
  assert.match(navigation, /ShoppingBag/);
  const windowView = await readFile(new URL("../components/views/window-products-view.tsx", import.meta.url), "utf8");
  assert.match(windowView, /同步橱窗/);
  assert.match(windowView, /待人工确认推广链接/);
  assert.match(windowView, /startRegistration/);
  assert.match(windowView, /goodEvaluationRatio/);
  assert.match(windowView, /shopScore/);
  assert.match(windowView, /<Pagination page=/);
  assert.match(windowView, /status=1&accountId=/);
  assert.doesNotMatch(windowView, /filteredProducts/);
  assert.match(windowView, /supplyChain: ""/);
  assert.doesNotMatch(windowView, /supplyChain: product\.promotionAccountName/);
  assert.doesNotMatch(windowView, /outProductId|apiOutProductId|promotionProductId/);
  const listPerformanceMigration = await readFile(new URL("../migrations/028_window_product_list_performance.sql", import.meta.url), "utf8");
  assert.match(listPerformanceMigration, /talent_window_products_account_synced_product_idx/);
  assert.match(listPerformanceMigration, /talent_window_products_pending_promotion_idx/);
  const leagueApi = await readFile(new URL("../lib/league-product.ts", import.meta.url), "utf8");
  assert.match(leagueApi, /\/channels\/ec\/league\/headsupplier\/productdetail\/get/);
  assert.match(leagueApi, /\/channels\/ec\/league\/headsupplier\/cooperativeitem\/list\/get/);
  assert.match(leagueApi, /\/channels\/ec\/league\/headsupplier\/subitem\/list\/get/);
  assert.match(leagueApi, /\/channels\/ec\/league\/headsupplier\/item\/promotiondetail\/get/);
  assert.match(leagueApi, /cooperative_item_id/);
  assert.match(leagueApi, /institution_assigned/);
  assert.match(leagueApi, /head_supplier_item_link/);
  assert.match(leagueApi, /fetchLeagueCooperativeItemLinks/);
  assert.match(leagueApi, /const coopLink = safeText\(headSupplierItemLink\)/);
  assert.doesNotMatch(leagueApi, /`weixinstorehs\/\$\{/);
  assert.match(leagueApi, /commission_info/);
  assert.match(leagueApi, /good_evaluation_ratio/);
  assert.match(leagueApi, /shop\.score/);
  assert.match(leagueApi, /payload\.product \|\| payload\.item/);
  assert.match(leagueApi, /accounts\.find\(\(account\) => account\.id === selection\.selected\?\.accountId\)/);
  assert.match(leagueApi, /effectiveWindowProductId\(row\.productId, row\.outProductId\)/);
  assert.doesNotMatch(leagueApi, /id_type/);
  const linkMigration = await readFile(new URL("../migrations/017_window_promotion_link.sql", import.meta.url), "utf8");
  assert.match(linkMigration, /promotion_link/);
  const commissionMigration = await readFile(new URL("../migrations/019_window_commission.sql", import.meta.url), "utf8");
  assert.match(commissionMigration, /commission_ratio/);
  const idsMigration = await readFile(new URL("../migrations/021_product_api_ids_and_link_corrections.sql", import.meta.url), "utf8");
  assert.match(idsMigration, /CREATE TABLE IF NOT EXISTS product_api_ids/);
  assert.match(idsMigration, /is_primary/);
  assert.match(idsMigration, /product_link_correction_runs/);
  const promotionMigration = await readFile(new URL("../migrations/022_authoritative_league_promotions.sql", import.meta.url), "utf8");
  assert.match(promotionMigration, /product_id, id_type/);
  assert.match(promotionMigration, /talent_window_promotion_candidates/);
  assert.match(promotionMigration, /needs_replacement/);
  const singleIdMigration = await readFile(new URL("../migrations/023_single_window_product_id.sql", import.meta.url), "utf8");
  assert.match(singleIdMigration, /DELETE FROM product_api_ids WHERE id_type = 'out_product_id'/);
  assert.match(singleIdMigration, /DROP COLUMN IF EXISTS id_type/);
  assert.match(singleIdMigration, /DROP COLUMN IF EXISTS out_product_id/);
  assert.match(singleIdMigration, /DROP COLUMN IF EXISTS promotion_product_id/);
  const sourceIdMigration = await readFile(new URL("../migrations/024_talent_source_product_id.sql", import.meta.url), "utf8");
  assert.match(sourceIdMigration, /ADD COLUMN IF NOT EXISTS out_product_id text/);
  const correctionRoute = await readFile(new URL("../app/api/league-accounts/link-corrections/route.ts", import.meta.url), "utf8");
  assert.match(correctionRoute, /requireSuperAdmin/);
  assert.match(correctionRoute, /action: z\.enum\(\["start", "retry"\]\)/);
  const accountView = await readFile(new URL("../components/views/league-accounts-view.tsx", import.meta.url), "utf8");
  assert.match(accountView, /主账号/);
  assert.match(accountView, /重试失败商品/);
  const productIds = await readFile(new URL("../lib/product-api-ids.ts", import.meta.url), "utf8");
  assert.match(productIds, /is_current/);
  const leagueMigration = await readFile(new URL("../migrations/016_league_quality.sql", import.meta.url), "utf8");
  assert.match(leagueMigration, /CREATE TABLE IF NOT EXISTS league_accounts/);
  assert.match(leagueMigration, /good_evaluation_ratio/);
  assert.match(leagueMigration, /shop_score/);
});

test("登记到样支持通过 out_product_id 或推广链接查询联盟资料并继续疑似同款判断", async () => {
  const route = await readFile(new URL("../app/api/product-id-lookup/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireUser\("products:create"\)/);
  assert.match(route, /lookupLeagueProductCandidates\(outProductId\)/);
  assert.match(route, /lookupLeagueProductCandidatesByPromotionLink\(promotionLink\)/);
  assert.match(route, /normalizeLeaguePromotionLink\(input\.query\)/);
  assert.match(route, /未在已同步的联盟机构商品目录中找到该推广链接/);
  assert.match(route, /promotionLink \? candidates : preferredLeaguePromotionCandidates/);
  assert.match(route, /preferredLeaguePromotionCandidates/);
  assert.match(route, /existingProduct/);
  assert.match(route, /cacheHits: lookup\.cacheHits/);
  assert.match(route, /refreshedAccounts: lookup\.refreshedAccounts/);
  assert.match(route, /primaryScanLimited: lookup\.scanLimited/);
  assert.match(route, /该商品未与任何已启用机构合作/);
  assert.doesNotMatch(route, /INSERT INTO talent_window_products/);

  const league = await readFile(new URL("../lib/league-product.ts", import.meta.url), "utf8");
  assert.match(league, /export async function lookupLeagueProductCandidates/);
  assert.match(league, /export async function lookupLeagueProductCandidatesByPromotionLink/);
  assert.match(league, /loadCachedLeagueCooperativeItemsByLink/);
  assert.match(league, /head_supplier_item_link = \$\{promotionLink\}/);
  assert.match(league, /同一推广链接对应多个机构账号或商品 ID/);
  assert.match(league, /fetchLeagueCooperativeItemLinks\(account\)/);
  assert.match(league, /refreshLeagueCooperativeItemCache/);
  assert.match(league, /loadCachedLeagueCooperativeItems/);
  assert.match(league, /Promise\.all\(\[0, 1\]\.map/);
  assert.match(league, /fetchLeagueInstitutionPromotionLinks/);
  assert.match(league, /match\.promotionDetailLink/);
  assert.match(league, /primaryResult\?\.candidates\.some\(isInstitutionAssignedLink\)/);
  assert.match(league, /fetchLeagueCooperativeProductMatches/);
  assert.match(league, /reservePrimaryProductScan/);
  assert.match(league, /interval '5 minutes'/);
  assert.match(league, /attempt_count < 3/);
  assert.match(league, /lookupLeagueAccountProductCandidates\(primary, productId, true\)/);
  assert.match(league, /lookupLeagueAccountProductCandidates\(account, productId, true\)/);
  assert.match(league, /if \(allowTargetedScan && needsInstitutionPromotionRefresh\(resolved\.candidates\)\)/);
  assert.match(league, /fetchLeagueItemPromotion\(account, match\.promotionDetailLink\)/);
  assert.match(league, /fetchLeagueProductDetail\(account, preliminary\.shopAppid, productId\)/);
  assert.doesNotMatch(league, /cached\.image_urls/);
  assert.doesNotMatch(league, /page < 500/);

  const cacheMigration = await readFile(new URL("../migrations/029_league_cooperative_item_cache.sql", import.meta.url), "utf8");
  assert.match(cacheMigration, /CREATE TABLE IF NOT EXISTS league_cooperative_item_cache/);
  assert.match(cacheMigration, /PRIMARY KEY \(league_account_id, product_id, head_supplier_item_link\)/);
  assert.match(cacheMigration, /CREATE TABLE IF NOT EXISTS league_cooperative_cache_state/);
  const directoryMigration = await readFile(new URL("../migrations/031_league_cooperative_directory_sync.sql", import.meta.url), "utf8");
  assert.match(directoryMigration, /DROP COLUMN IF EXISTS image_urls/);
  assert.match(directoryMigration, /sync_status/);
  assert.match(directoryMigration, /CREATE TABLE IF NOT EXISTS league_product_lookup_throttles/);
  const recoveryMigration = await readFile(new URL("../migrations/032_league_directory_sync_recovery.sql", import.meta.url), "utf8");
  assert.match(recoveryMigration, /sync_progress_count/);
  assert.match(recoveryMigration, /sync_heartbeat_at/);
  assert.match(recoveryMigration, /state\.sync_status = 'running'/);
  const institutionLinkMigration = await readFile(new URL("../migrations/033_institution_assigned_promotion_links.sql", import.meta.url), "utf8");
  assert.match(institutionLinkMigration, /promotion_detail_link/);
  assert.match(institutionLinkMigration, /institution_assigned/);
  const institutionCacheRefreshMigration = await readFile(new URL("../migrations/034_refresh_institution_promotion_cache.sql", import.meta.url), "utf8");
  assert.match(institutionCacheRefreshMigration, /sync_status = 'pending'/);
  assert.match(institutionCacheRefreshMigration, /DELETE FROM league_product_lookup_throttles/);
  const linkLookupMigration = await readFile(new URL("../migrations/037_league_promotion_link_lookup.sql", import.meta.url), "utf8");
  assert.match(linkLookupMigration, /league_cooperative_item_link_idx/);
  assert.match(linkLookupMigration, /head_supplier_item_link, league_account_id/);

  const directoryWorker = await readFile(new URL("../scripts/league-directory-sync.mjs", import.meta.url), "utf8");
  assert.match(directoryWorker, /primaryIntervalMinutes = 30/);
  assert.match(directoryWorker, /secondaryIntervalMinutes = 180/);
  assert.match(directoryWorker, /account\.is_primary THEN interval '30 minutes' ELSE interval '3 hours'/);
  assert.match(directoryWorker, /league_cooperative_item_cache/);
  assert.doesNotMatch(directoryWorker, /image_urls/);
  assert.doesNotMatch(directoryWorker, /page < 500/);
  assert.match(directoryWorker, /recoverInterruptedSyncs/);
  assert.match(directoryWorker, /syncTimeoutMinutes = 20/);
  assert.match(directoryWorker, /updateSyncProgress/);
  assert.match(directoryWorker, /\/channels\/ec\/league\/headsupplier\/subitem\/list\/get/);
  assert.match(directoryWorker, /sync_heartbeat_at,state\.sync_started_at\)<now\(\)-interval '5 minutes'/);
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /league-sync:/);
  assert.match(compose, /scripts\/league-directory-sync\.mjs/);
  const updateScript = await readFile(new URL("../update.sh", import.meta.url), "utf8");
  assert.match(updateScript, /model-init vision indexer league-sync wecom-sync app backup/);

  const accountRoute = await readFile(new URL("../app/api/league-accounts/route.ts", import.meta.url), "utf8");
  assert.match(accountRoute, /directory_item_count/);
  assert.match(accountRoute, /directory_sync_status/);
  assert.match(accountRoute, /directory_sync_progress_count/);
  assert.match(accountRoute, /directory_sync_started_at/);
  const manualSyncRoute = await readFile(new URL("../app/api/league-accounts/[id]/cooperative-sync/route.ts", import.meta.url), "utf8");
  assert.match(manualSyncRoute, /requireSuperAdmin/);
  assert.match(manualSyncRoute, /sync_requested_at=now\(\)/);
  const accountView = await readFile(new URL("../components/views/league-accounts-view.tsx", import.meta.url), "utf8");
  assert.match(accountView, /合作商品目录/);
  assert.match(accountView, /同步目录/);
  assert.match(accountView, /主机构目录每 30 分钟自动同步/);
  assert.match(accountView, /已扫描/);
  assert.match(accountView, /已保存/);
  assert.match(accountView, /开始于/);

  const form = await readFile(new URL("../components/views/products-view.tsx", import.meta.url), "utf8");
  assert.match(form, /选择登记方式/);
  assert.match(form, /填写商品 ID 或推广链接获取资料/);
  assert.match(form, /weixinstorehs\/\.\.\./);
  assert.match(form, /weixinstoresubhs\/\.\.\./);
  assert.match(form, /\/api\/product-id-lookup/);
  assert.match(form, /apiProductId: result\.outProductId/);
  assert.match(form, /registrationMode === "product-id"/);
  assert.match(form, /正在核验商品 ID 和疑似同款/);
  assert.match(form, /更换登记方式/);
  assert.match(form, /function removeProductImage\(index: number\)/);
  assert.match(form, /nextRecognitionKey/);
  assert.match(form, /disabled=\{imageUrls\.length <= 1\}/);
  assert.match(form, /至少保留一张商品图片/);
  assert.match(form, /imageUrls\.map\(\(url, index\)/);
  assert.doesNotMatch(form, /imageUrls\.slice\(0, 6\)/);
  const productUpdateRoute = await readFile(new URL("../app/api/products/[id]/route.ts", import.meta.url), "utf8");
  assert.match(productUpdateRoute, /imageUrls: z\.array\(imageUrlSchema\)\.min\(1, "请至少保留一张商品图片"\)/);
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /\.image-preview-delete/);
});

test("登记时已完成的 GLM 主体识别会直接复用到正式索引", async () => {
  const matching = await readFile(new URL("../lib/image-matching.ts", import.meta.url), "utf8");
  assert.match(matching, /FROM product_image_features feature[\s\S]*JOIN image_subject_cache cache/);
  assert.match(matching, /cache\.model IN \(setting\.model, 'glm-4\.6v-flash'\)/);
  assert.match(matching, /subject_status = 'ready'/);
  assert.match(matching, /subject_embedding_vector = cached\.embedding/);
  assert.match(matching, /subject_box_source = cached\.box_source/);
  const backfill = await readFile(new URL("../migrations/030_reuse_realtime_subject_cache.sql", import.meta.url), "utf8");
  assert.match(backfill, /WHERE feature\.subject_status IN \('waiting', 'pending'\)/);
  assert.match(backfill, /UPDATE product_image_features feature/);
});
