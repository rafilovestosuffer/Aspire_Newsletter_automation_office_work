import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export async function migrate(databaseUrl: string): Promise<void> {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for migrate");
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const dir = join(root, "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE id=$1", [file]);
      if (applied.rowCount) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

const isDirect = process.argv[1]?.replaceAll("\\", "/").endsWith("/src/db/migrate.ts");
if (isDirect) {
  migrate(process.env.DATABASE_URL ?? "").catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
