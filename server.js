const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { db, initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'math-gamification-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const getIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0].trim() ||
  req.socket.remoteAddress || '127.0.0.1';

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.userId || !req.session.isAdmin)
    return res.status(403).json({ error: 'Sin permisos de administrador' });
  next();
};

// ── AUTH ────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 4)
    return res.status(400).json({ error: 'Usuario mín. 3 chars, contraseña mín. 4 chars' });

  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username))
    return res.status(400).json({ error: 'El usuario ya existe' });

  const hash = bcrypt.hashSync(password, 10);
  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)'
  ).run(username, hash);

  req.session.userId = id;
  req.session.username = username;
  req.session.isAdmin = false;
  db.prepare('INSERT INTO user_sessions (user_id, ip_address) VALUES (?, ?)').run(id, getIp(req));
  res.json({ success: true, username, isAdmin: false });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin === 1;
  db.prepare('UPDATE users SET last_ip = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?')
    .run(getIp(req), user.id);
  db.prepare('INSERT INTO user_sessions (user_id, ip_address) VALUES (?, ?)').run(user.id, getIp(req));
  res.json({ success: true, username: user.username, isAdmin: user.is_admin === 1 });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  res.json({ userId: req.session.userId, username: req.session.username, isAdmin: req.session.isAdmin });
});

// ── TOPICS ──────────────────────────────────────────────────────────────────

app.get('/api/topics', requireAuth, (req, res) => {
  const topics = db.prepare('SELECT * FROM topics ORDER BY order_index, id').all();
  const uid = req.session.userId;

  const result = topics.map(t => {
    const total = db.prepare('SELECT COUNT(*) as c FROM challenges WHERE topic_id = ?').get(t.id).c;
    const completed = db.prepare(`
      SELECT COUNT(*) as c FROM user_progress
      WHERE user_id = ? AND completed = 1
        AND challenge_id IN (SELECT id FROM challenges WHERE topic_id = ?)
    `).get(uid, t.id).c;
    const avgRow = db.prepare(`
      SELECT AVG(best_score) as avg FROM user_progress
      WHERE user_id = ? AND completed = 1
        AND challenge_id IN (SELECT id FROM challenges WHERE topic_id = ?)
    `).get(uid, t.id);
    return { ...t, totalChallenges: total, completedChallenges: completed, avgScore: Math.round(avgRow.avg || 0) };
  });
  res.json(result);
});

app.get('/api/topics/:id/challenges', requireAuth, (req, res) => {
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Tema no encontrado' });

  const challenges = db.prepare(
    'SELECT id, topic_id, title, description, type, order_index FROM challenges WHERE topic_id = ? ORDER BY order_index, id'
  ).all(req.params.id);

  const uid = req.session.userId;
  const list = challenges.map(c => ({
    ...c,
    progress: db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND challenge_id = ?').get(uid, c.id) || null
  }));
  res.json({ topic, challenges: list });
});

app.get('/api/challenges/:id', requireAuth, (req, res) => {
  const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(req.params.id);
  if (!challenge) return res.status(404).json({ error: 'Desafío no encontrado' });
  const progress = db.prepare(
    'SELECT * FROM user_progress WHERE user_id = ? AND challenge_id = ?'
  ).get(req.session.userId, challenge.id);
  res.json({ ...challenge, content: JSON.parse(challenge.content), progress: progress || null });
});

app.post('/api/challenges/:id/submit', requireAuth, (req, res) => {
  const { score, timeSpent } = req.body;
  const challengeId = parseInt(req.params.id);
  const uid = req.session.userId;

  if (!db.prepare('SELECT id FROM challenges WHERE id = ?').get(challengeId))
    return res.status(404).json({ error: 'Desafío no encontrado' });

  const s = Math.min(100, Math.max(0, Number(score) || 0));
  const completed = s >= 50;
  const t = Number(timeSpent) || 0;

  const existing = db.prepare(
    'SELECT * FROM user_progress WHERE user_id = ? AND challenge_id = ?'
  ).get(uid, challengeId);

  if (existing) {
    const newBest = Math.max(existing.best_score, s);
    const newTime = existing.best_time
      ? (completed ? Math.min(existing.best_time, t) : existing.best_time)
      : (completed ? t : null);
    db.prepare(`
      UPDATE user_progress
      SET best_score = ?, attempts = attempts + 1, best_time = ?,
          last_attempt_at = CURRENT_TIMESTAMP,
          completed = CASE WHEN ? THEN 1 ELSE completed END
      WHERE user_id = ? AND challenge_id = ?
    `).run(newBest, newTime, completed ? 1 : 0, uid, challengeId);
  } else {
    db.prepare(`
      INSERT INTO user_progress (user_id, challenge_id, best_score, attempts, best_time, completed, last_attempt_at)
      VALUES (?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
    `).run(uid, challengeId, s, completed ? t : null, completed ? 1 : 0);
  }

  const progress = db.prepare(
    'SELECT * FROM user_progress WHERE user_id = ? AND challenge_id = ?'
  ).get(uid, challengeId);
  res.json({ success: true, score: s, completed, progress });
});

// ── ADMIN ────────────────────────────────────────────────────────────────────

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({
    totalUsers: db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin = 0').get().c,
    totalTopics: db.prepare('SELECT COUNT(*) as c FROM topics').get().c,
    totalChallenges: db.prepare('SELECT COUNT(*) as c FROM challenges').get().c,
    completedChallenges: db.prepare('SELECT COUNT(*) as c FROM user_progress WHERE completed = 1').get().c
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.created_at, u.last_ip, u.last_login,
           COUNT(DISTINCT up.challenge_id) as attempted,
           COUNT(DISTINCT CASE WHEN up.completed=1 THEN up.challenge_id END) as completed,
           ROUND(AVG(up.best_score),1) as avg_score,
           SUM(up.attempts) as total_attempts,
           SUM(up.best_time) as total_time
    FROM users u
    LEFT JOIN user_progress up ON u.id = up.user_id
    WHERE u.is_admin = 0
    GROUP BY u.id ORDER BY u.created_at DESC
  `).all();

  const result = users.map(u => ({
    ...u,
    sessions: db.prepare(
      'SELECT ip_address, login_at FROM user_sessions WHERE user_id = ? ORDER BY login_at DESC LIMIT 10'
    ).all(u.id),
    topicProgress: db.prepare(`
      SELECT t.name, t.icon,
             COUNT(DISTINCT c.id) as total,
             COUNT(DISTINCT CASE WHEN up.completed=1 THEN up.challenge_id END) as done,
             ROUND(AVG(up.best_score),1) as avg,
             SUM(up.best_time) as time_spent
      FROM topics t
      LEFT JOIN challenges c ON c.topic_id = t.id
      LEFT JOIN user_progress up ON up.challenge_id = c.id AND up.user_id = ?
      GROUP BY t.id ORDER BY t.order_index
    `).all(u.id)
  }));
  res.json(result);
});

app.get('/api/admin/topics', requireAdmin, (req, res) => {
  const topics = db.prepare('SELECT * FROM topics ORDER BY order_index, id').all();
  res.json(topics.map(t => ({
    ...t,
    challenges: db.prepare(
      'SELECT id, title, type, order_index FROM challenges WHERE topic_id = ? ORDER BY order_index'
    ).all(t.id)
  })));
});

app.post('/api/admin/topics', requireAdmin, (req, res) => {
  const { name, description, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'El nombre es requerido' });
  const max = db.prepare('SELECT MAX(order_index) as m FROM topics').get().m || 0;
  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO topics (name, description, icon, order_index) VALUES (?, ?, ?, ?)'
  ).run(name, description || '', icon || '📚', max + 1);
  res.json({ success: true, id });
});

app.delete('/api/admin/topics/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM user_progress WHERE challenge_id IN (SELECT id FROM challenges WHERE topic_id = ?)').run(req.params.id);
  db.prepare('DELETE FROM challenges WHERE topic_id = ?').run(req.params.id);
  db.prepare('DELETE FROM topics WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/topics/:id/challenges', requireAdmin, (req, res) => {
  const { title, description, questions } = req.body;
  if (!title || !questions?.length)
    return res.status(400).json({ error: 'Título y preguntas son requeridos' });
  const max = db.prepare('SELECT MAX(order_index) as m FROM challenges WHERE topic_id = ?').get(req.params.id).m || 0;
  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO challenges (topic_id, title, description, type, content, order_index) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.params.id, title, description || '', 'quiz', JSON.stringify({ intro: description || title, questions }), max + 1);
  res.json({ success: true, id });
});

app.delete('/api/admin/challenges/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM user_progress WHERE challenge_id = ?').run(req.params.id);
  db.prepare('DELETE FROM challenges WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── START ────────────────────────────────────────────────────────────────────
initDb();
app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
  console.log('Admin: usuario "admin", contraseña "admin123"');
});
