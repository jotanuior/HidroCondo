import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000
});

pool.on('error', (error) => {
  console.error('[db] erro inesperado no pool', error);
});
