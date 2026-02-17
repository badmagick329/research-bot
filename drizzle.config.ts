import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/infra/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.POSTGRES_URL ??
      "postgres://postgres:postgres@localhost:5432/research_bot",
  },
});
