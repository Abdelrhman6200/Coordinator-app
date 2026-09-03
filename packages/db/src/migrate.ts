/**
 * Migration runner. Expand/contract discipline (docs/10 §38): migrations are
 * applied in order, recorded, and never re-run. A rollback is a new migration,
 * never an in-place edit of an applied one.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './client.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(): Promise<string[]> {
  const db = pool();
  const applied: string[] = [];
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        checksum    text NOT NULL
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = String(sql.length);
      const { rows } = await db.query('SELECT checksum FROM schema_migration WHERE name = $1', [
        file,
      ]);
      if (rows.length > 0) {
        if (rows[0].checksum !== checksum) {
          throw new Error(
            `migration ${file} has changed after being applied; add a new migration instead`,
          );
        }
        continue;
      }
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
    return applied;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  migrate()
    .then((applied) => {
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
