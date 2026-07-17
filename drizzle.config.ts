const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

if (!url) {
  throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required for Drizzle migrations.");
}

export default {
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
} as const;
