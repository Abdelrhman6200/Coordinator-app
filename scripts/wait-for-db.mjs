import pg from 'pg';
const url = process.env.DATABASE_URL ?? 'postgres://coordinator:coordinator@localhost:5433/coordinator';
for (let i = 0; i < 60; i++) {
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
    await c.end();
    console.log('db ready');
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
console.error('db did not become ready');
process.exit(1);
