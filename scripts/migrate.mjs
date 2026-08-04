import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("缺少 DATABASE_URL 环境变量");

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const migrationsDir = path.join(process.cwd(), "migrations");

try {
  await sql.unsafe(`
    DO $$
    BEGIN
      IF to_regclass('_huzhanggui_migrations') IS NULL AND to_regclass('_siyuan_migrations') IS NOT NULL THEN
        ALTER TABLE _siyuan_migrations RENAME TO _huzhanggui_migrations;
      END IF;
    END $$
  `);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _huzhanggui_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const applied = await sql`SELECT name FROM _huzhanggui_migrations`;
  const done = new Set(applied.map((row) => row.name));
  const files = (await fs.readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

  for (const file of files) {
    if (done.has(file)) continue;
    const source = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(source);
      await tx`INSERT INTO _huzhanggui_migrations (name) VALUES (${file})`;
    });
    console.log(`已执行数据库升级：${file}`);
  }
} finally {
  await sql.end();
}
