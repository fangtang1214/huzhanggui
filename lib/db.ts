import postgres from "postgres";

const globalForDb = globalThis as unknown as {
  siyuanSql?: ReturnType<typeof postgres>;
};

export function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("数据库尚未配置，请设置 DATABASE_URL");
  }
  if (!globalForDb.siyuanSql) {
    globalForDb.siyuanSql = postgres(process.env.DATABASE_URL, {
      max: process.env.NODE_ENV === "production" ? 10 : 3,
      idle_timeout: 20,
      connect_timeout: 10,
      transform: postgres.camel,
      onnotice: () => {},
    });
  }
  return globalForDb.siyuanSql;
}

