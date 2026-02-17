import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Builds both typed ORM and raw SQL clients so repositories can use the right persistence abstraction per use case.
 */
export const createDb = (connectionString: string) => {
  const sql = postgres(connectionString, { max: 10 });
  const db = drizzle(sql);
  return { db, sql };
};
