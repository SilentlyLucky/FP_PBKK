import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.PROMPTLAB_DATABASE_URL ??
      "postgresql://promptlab:promptlab@127.0.0.1:55432/promptlab",
  },
  strict: true,
  verbose: true,
});
