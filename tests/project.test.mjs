import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { createXlsx } from "../lib/xlsx.ts";
import { isSupportedProductLink, isWebProductLink, productLinkSchema } from "../lib/product-link.ts";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { beijingDate, formatProductSku, formatSampleCode, nextProductSampleCode, nextProductSku, SkuGenerationError } from "../lib/sku.ts";
import { cosineSimilarity } from "../lib/cosine.ts";
import { extractSampleCode } from "../lib/scan-code.ts";

test("系统包含核心样品流转数据结构", async () => {
  const migration = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
  for (const table of ["products", "samples", "sample_movements", "audit_logs", "users", "roles", "departments", "locations"]) {
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
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /production-dependencies/);
  assert.match(dockerfile, /node_modules/);
  const updateScript = await readFile(new URL("../update.sh", import.meta.url), "utf8");
  assert.match(updateScript, /ADMIN_PASSWORD=.*BOOTSTRAP_PLACEHOLDER/);
  assert.match(updateScript, /8800 8000 8080 8008/);
  assert.match(updateScript, /model-init vision indexer app backup/);
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
  const manifest = await readFile(new URL("../app/manifest.ts", import.meta.url), "utf8");
  assert.match(manifest, /short_name: "狐掌柜"/);
  await readFile(new URL("../public/brand/huzhanggui-logo.png", import.meta.url));
  await readFile(new URL("../app/favicon.ico", import.meta.url));
});

test("网页更新仅允许超级管理员并由宿主机受控执行", async () => {
  const route = await readFile(new URL("../app/api/system/update/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireSuperAdmin/);
  assert.match(route, /system\.update_requested/);
  const installer = await readFile(new URL("../scripts/install-web-updater.sh", import.meta.url), "utf8");
  assert.match(installer, /PathExists=\/var\/lib\/huzhanggui-updater\/request/);
  const worker = await readFile(new URL("../scripts/web-update-worker.sh", import.meta.url), "utf8");
  assert.match(worker, /flock -n/);
  assert.match(worker, /"\$INSTALL_DIR\/update\.sh"/);
});

test("Excel 导出文件包含中文表头和数据", () => {
  const archive = createXlsx("实物样品", [{ header: "货号", key: "sku" }, { header: "当前位置", key: "location" }], [{ sku: "HZG-2026-0001", location: "商务部 · A 货架" }]);
  const files = unzipSync(archive);
  assert.ok(files["xl/workbook.xml"]);
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /货号/);
  assert.match(sheet, /商务部 · A 货架/);
});

test("商品链接支持标准网址和视频号内部格式", () => {
  assert.equal(productLinkSchema.parse("weixinstorehs/28512353738164"), "weixinstorehs/28512353738164");
  assert.equal(productLinkSchema.parse("https://example.com/product/1"), "https://example.com/product/1");
  assert.equal(isSupportedProductLink("javascript:alert(1)"), false);
  assert.equal(isWebProductLink("weixinstorehs/28512353738164"), false);
});

test("扫码可读取条形码编号并兼容旧二维码网址", () => {
  assert.equal(extractSampleCode("HZG-2026-0001-001"), "HZG-2026-0001-001");
  assert.equal(extractSampleCode("https://example.com/s/HZG-2026-0001-001?from=label"), "HZG-2026-0001-001");
  assert.equal(extractSampleCode("https://example.com/s/OLD%2D001"), "OLD-001");
  assert.equal(extractSampleCode("  "), "");
});

test("自动货号使用 HZG 两级编号", async () => {
  assert.equal(beijingDate(new Date("2026-08-01T16:30:00.000Z")), "2026-08-02");
  assert.equal(formatProductSku("2026-08-02", 7), "HZG-2026-0007");
  assert.equal(formatProductSku("2026-12-31", 9999), "HZG-2026-9999");
  assert.throws(() => formatProductSku("2026-12-31", 10000), /9999/);
  assert.equal(formatSampleCode("HZG-2026-0007", 2), "HZG-2026-0007-002");
  assert.throws(() => formatProductSku("2026-08-02", Number.NaN), SkuGenerationError);
  assert.throws(() => formatSampleCode("SP-20260802-007", 1), SkuGenerationError);

  let productSequence = 0; let sampleSequence = 0; const sequenceDates = [];
  const tx = { unsafe: async (query, params) => {
    if (query.includes("product_sku_sequences")) sequenceDates.push(params[0]);
    if (query.includes("product_sku_sequences")) return [{ sequence: ++productSequence }];
    if (query.includes("product_sample_sequences")) return [{ sequence: ++sampleSequence }];
    return [];
  } };
  assert.equal(await nextProductSku(tx, "2026-08-04"), "HZG-2026-0001");
  assert.equal(await nextProductSku(tx, "2026-12-31"), "HZG-2026-0002");
  assert.deepEqual(sequenceDates, ["2026-01-01", "2026-01-01"]);
  assert.equal(await nextProductSampleCode(tx, "00000000-0000-0000-0000-000000000001", "HZG-2026-0001"), "HZG-2026-0001-001");
  assert.equal(await nextProductSampleCode(tx, "00000000-0000-0000-0000-000000000001", "HZG-2026-0001"), "HZG-2026-0001-002");
  await assert.rejects(nextProductSku({ unsafe: async () => [{ lastValue: 1 }] }, "2026-08-04"), SkuGenerationError);
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
  assert.match(route, /image_embedding_cache/);
  assert.match(route, /embedding_vector <=>/);
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
    const repairedProduct = await database.query("SELECT sku FROM products WHERE name='升级前商品'");
    assert.equal(repairedProduct.rows[0].sku, "HZG-2026-0001");
    const repairedSamples = await database.query("SELECT code FROM samples ORDER BY created_at");
    assert.deepEqual(repairedSamples.rows.map((row) => row.code), ["HZG-2026-0001-001", "HZG-2026-0001-002"]);
    const oldCodeAlias = await database.query("SELECT count(*)::int AS count FROM sample_code_aliases");
    assert.equal(oldCodeAlias.rows[0].count, 4);
    const oldSkuAliases = await database.query("SELECT alias FROM product_sku_aliases ORDER BY alias");
    assert.deepEqual(oldSkuAliases.rows.map((row) => row.alias), ["HZG-20260804-001", "SP-20260804-NaN"]);
    const sampleSequence = await database.query("SELECT last_value FROM product_sample_sequences");
    assert.equal(sampleSequence.rows[0].last_value, 2);
    const emptyStatusFilter = await database.query("SELECT count(*)::int AS count FROM samples s WHERE ($1::text IS NULL OR s.status=$2)", [null, null]);
    assert.equal(emptyStatusFilter.rows[0].count, 2);
  } finally {
    await database.close();
  }
});
