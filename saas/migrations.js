import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_MIGRATIONS_DIR = resolve(process.cwd(), "migrations");

export async function runMigrations(pool, options = {}) {
  const migrationsDir = resolve(options.migrationsDir || DEFAULT_MIGRATIONS_DIR);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d+.*\.sql$/i.test(file))
    .sort();
  const applied = await pool.query("SELECT filename FROM schema_migrations");
  const appliedSet = new Set(applied.rows.map((row) => row.filename));
  const appliedNow = [];

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = await readFile(resolve(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await pool.query("COMMIT");
      appliedNow.push(file);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }

  return { applied: appliedNow, total: files.length };
}

export async function migrationStatus(pool, options = {}) {
  const migrationsDir = resolve(options.migrationsDir || DEFAULT_MIGRATIONS_DIR);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d+.*\.sql$/i.test(file))
    .sort();
  const applied = await pool.query("SELECT filename FROM schema_migrations");
  const appliedSet = new Set(applied.rows.map((row) => row.filename));
  const pending = files.filter((file) => !appliedSet.has(file));
  return { ok: pending.length === 0, pending, total: files.length };
}
