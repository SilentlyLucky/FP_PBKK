import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabaseClient } from "./index.js";

const connectionString = process.env.PROMPTLAB_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "Set PROMPTLAB_DATABASE_URL to an isolated PromptLab database before migrating.",
  );
}

const { db, pool } = createDatabaseClient(connectionString);

try {
  await migrate(db, {
    migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
  });
  process.stdout.write("PromptLab migrations applied.\n");
} finally {
  await pool.end();
}
