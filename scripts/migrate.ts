import { migrate } from "../src/db/migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
await migrate(url);
console.log("migrated");
