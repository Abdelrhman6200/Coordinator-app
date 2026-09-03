import pg from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://coordinator:coordinator@localhost:5433/coordinator';

export function pool(): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
}
