// db-pg.js — Versión PostgreSQL para producción (Neon.tech, Supabase, etc.)
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const query = (text, params) => pool.query(text, params);
const run   = (text, params) => pool.query(text, params);

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_ip TEXT,
      last_login TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS topics (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT DEFAULT '📚',
      order_index INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS challenges (
      id SERIAL PRIMARY KEY,
      topic_id INTEGER NOT NULL REFERENCES topics(id),
      title TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      order_index INTEGER DEFAULT 0,
      time_limit INTEGER DEFAULT 1800
    );
    CREATE TABLE IF NOT EXISTS user_progress (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      challenge_id INTEGER NOT NULL REFERENCES challenges(id),
      best_score REAL DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      best_time INTEGER,
      completed INTEGER DEFAULT 0,
      last_attempt_at TIMESTAMP,
      UNIQUE(user_id, challenge_id)
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      ip_address TEXT,
      login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
  if (!rows.length) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query('INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, 1)', ['admin', hash]);
    console.log('Admin creado: admin / admin123');
  }

  const { rows: tr } = await pool.query('SELECT COUNT(*) as c FROM topics');
  if (parseInt(tr[0].c) === 0) await seedTopics();
}

// La función seedTopics es idéntica a db.js pero usando await pool.query(...)
// Por brevedad se omite aquí — cópiala de db.js sustituyendo:
//   db.prepare('INSERT ...').run(a,b)  →  await pool.query('INSERT ... VALUES ($1,$2)', [a,b])
//   db.prepare('SELECT ...').get(a)    →  (await pool.query('SELECT ... WHERE id=$1',[a])).rows[0]
//   db.prepare('SELECT ...').all()     →  (await pool.query('SELECT ...')).rows

module.exports = { pool, query, run, initDb };
