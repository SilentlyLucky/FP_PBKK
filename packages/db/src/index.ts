import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema.ts";

export { schema };
export * from "./knowledge.ts";
export * from "./knowledge-embeddings.ts";
export * from "./graphify-export.ts";
export * from "./graphify-import.ts";
export * from "./graph-retrieval.ts";
export * from "./workspace-source-manifest.ts";
export * from "./workspace-conversations.ts";
export type DatabaseQuery = Pick<
  Database,
  "select" | "insert" | "update" | "delete"
>;
export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  db: Database;
  pool: Pool;
}

export function createDatabaseClient(connectionString: string): DatabaseClient {
  if (!connectionString.trim()) {
    throw new Error("PROMPTLAB_DATABASE_URL is required");
  }

  const pool = new Pool({
    connectionString,
    max: 6,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    application_name: "promptlab-local",
  });

  return { db: drizzle(pool, { schema }), pool };
}

export function getDatabaseClient(): DatabaseClient {
  const connectionString = process.env.PROMPTLAB_DATABASE_URL;
  if (!connectionString) {
    throw new Error("PROMPTLAB_DATABASE_URL is not configured");
  }

  const globalForPromptLab = globalThis as typeof globalThis & {
    promptLabDatabaseClient?: DatabaseClient;
  };

  globalForPromptLab.promptLabDatabaseClient ??=
    createDatabaseClient(connectionString);
  return globalForPromptLab.promptLabDatabaseClient;
}
