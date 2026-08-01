import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { createXlsx } from "../lib/xlsx.ts";
import { PGlite } from "@electric-sql/pglite";

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
  assert.match(layout, /斯源直播样品管理系统/);
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.name, "siyuan-sample-management");
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /node_modules\/postgres/);
  assert.match(dockerfile, /node_modules\/bcryptjs/);
  const updateScript = await readFile(new URL("../update.sh", import.meta.url), "utf8");
  assert.match(updateScript, /ADMIN_PASSWORD=.*BOOTSTRAP_PLACEHOLDER/);
  assert.match(updateScript, /8800 8000 8080 8008/);
  const installScript = await readFile(new URL("../install.sh", import.meta.url), "utf8");
  assert.match(installScript, /8800 8000 8080 8008/);
  assert.match(installScript, /systemctl is-active --quiet nginx/);
  const nginxCompose = await readFile(new URL("../docker-compose.nginx.yml", import.meta.url), "utf8");
  assert.match(nginxCompose, /127\.0\.0\.1:\$\{APP_PORT:-8800\}:3000/);
});

test("Excel 导出文件包含中文表头和数据", () => {
  const archive = createXlsx("实物样品", [{ header: "货号", key: "sku" }, { header: "当前位置", key: "location" }], [{ sku: "SY-001", location: "商务部 · A 货架" }]);
  const files = unzipSync(archive);
  assert.ok(files["xl/workbook.xml"]);
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /货号/);
  assert.match(sheet, /商务部 · A 货架/);
});

test("数据库迁移可在 PostgreSQL 引擎中完整执行", async () => {
  const database = new PGlite();
  try {
    const migration = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
    await database.exec(migration);
    await database.exec(`
      INSERT INTO departments (name, kind) VALUES ('商务部', 'business')
      ON CONFLICT ((lower(name))) DO UPDATE SET active = true;
      INSERT INTO departments (name, kind) VALUES ('商务部', 'business')
      ON CONFLICT ((lower(name))) DO UPDATE SET active = true;
    `);
    const result = await database.query("SELECT count(*)::int AS count FROM departments WHERE name = '商务部'");
    assert.equal(result.rows[0].count, 1);
  } finally {
    await database.close();
  }
});
