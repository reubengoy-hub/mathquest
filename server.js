const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const { pool, q, qOne, initDb } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mathquest-secret-dev',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const getIp = req =>
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

// ── AUTH ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || username.length < 3 || password.length < 4)
      return res.status(400).json({ error: 'Usuario mín. 3 chars, contraseña mín. 4 chars' });

    const existing = await qOne('SELECT id FROM users WHERE username = $1', [username]);
    if (existing) return res.status(400).json({ error: 'El usuario ya existe' });

    const hash = bcrypt.hashSync(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, hash]
    );
    const id = rows[0].id;
    req.session.userId = id;
    req.session.username = username;
    req.session.isAdmin = false;
    await pool.query('INSERT INTO user_sessions (user_id, ip_address) VALUES ($1, $2)', [id, getIp(req)]);
    res.json({ success: true, username, isAdmin: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await qOne('SELECT * FROM users WHERE username = $1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    req.session.userId  = user.id;
    req.session.username = user.username;
    req.session.isAdmin  = user.is_admin === 1;
    await pool.query('UPDATE users SET last_ip=$1, last_login=CURRENT_TIMESTAMP WHERE id=$2', [getIp(req), user.id]);
    await pool.query('INSERT INTO user_sessions (user_id, ip_address) VALUES ($1,$2)', [user.id, getIp(req)]);
    res.json({ success: true, username: user.username, isAdmin: user.is_admin === 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  res.json({ userId: req.session.userId, username: req.session.username, isAdmin: req.session.isAdmin });
});

// ── TOPICS ───────────────────────────────────────────────────────────────────

app.get('/api/topics', requireAuth, async (req, res) => {
  try {
    const topics = await q('SELECT * FROM topics ORDER BY order_index, id');
    const uid = req.session.userId;

    const result = await Promise.all(topics.map(async t => {
      const total     = await qOne('SELECT COUNT(*)::int as c FROM challenges WHERE topic_id=$1', [t.id]);
      const completed = await qOne(
        `SELECT COUNT(*)::int as c FROM user_progress
         WHERE user_id=$1 AND completed=1
           AND challenge_id IN (SELECT id FROM challenges WHERE topic_id=$2)`, [uid, t.id]);
      const avg = await qOne(
        `SELECT AVG(best_score) as avg FROM user_progress
         WHERE user_id=$1 AND completed=1
           AND challenge_id IN (SELECT id FROM challenges WHERE topic_id=$2)`, [uid, t.id]);
      return {
        ...t,
        totalChallenges:     total.c,
        completedChallenges: completed.c,
        avgScore: Math.round(avg.avg || 0)
      };
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/topics/:id/challenges', requireAuth, async (req, res) => {
  try {
    const topic = await qOne('SELECT * FROM topics WHERE id=$1', [req.params.id]);
    if (!topic) return res.status(404).json({ error: 'Tema no encontrado' });

    const challenges = await q(
      'SELECT id,topic_id,title,description,type,order_index FROM challenges WHERE topic_id=$1 ORDER BY order_index,id',
      [req.params.id]
    );
    const uid = req.session.userId;
    const list = await Promise.all(challenges.map(async c => ({
      ...c,
      progress: await qOne('SELECT * FROM user_progress WHERE user_id=$1 AND challenge_id=$2', [uid, c.id]) || null
    })));
    res.json({ topic, challenges: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/challenges/:id', requireAuth, async (req, res) => {
  try {
    const challenge = await qOne('SELECT * FROM challenges WHERE id=$1', [req.params.id]);
    if (!challenge) return res.status(404).json({ error: 'Desafío no encontrado' });
    const progress = await qOne(
      'SELECT * FROM user_progress WHERE user_id=$1 AND challenge_id=$2',
      [req.session.userId, challenge.id]
    );
    res.json({ ...challenge, content: JSON.parse(challenge.content), progress: progress || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/challenges/:id/submit', requireAuth, async (req, res) => {
  try {
    const { score, timeSpent } = req.body;
    const challengeId = parseInt(req.params.id);
    const uid = req.session.userId;

    if (!await qOne('SELECT id FROM challenges WHERE id=$1', [challengeId]))
      return res.status(404).json({ error: 'Desafío no encontrado' });

    const s = Math.min(100, Math.max(0, Number(score) || 0));
    const completed = s >= 50 ? 1 : 0;
    const t = Number(timeSpent) || 0;

    const existing = await qOne(
      'SELECT * FROM user_progress WHERE user_id=$1 AND challenge_id=$2', [uid, challengeId]
    );

    if (existing) {
      const newBest = Math.max(existing.best_score, s);
      const newTime = existing.best_time
        ? (completed ? Math.min(existing.best_time, t) : existing.best_time)
        : (completed ? t : null);
      await pool.query(`
        UPDATE user_progress
        SET best_score=$1, attempts=attempts+1, best_time=$2,
            last_attempt_at=CURRENT_TIMESTAMP,
            completed=CASE WHEN $3=1 THEN 1 ELSE completed END
        WHERE user_id=$4 AND challenge_id=$5`,
        [newBest, newTime, completed, uid, challengeId]
      );
    } else {
      await pool.query(`
        INSERT INTO user_progress (user_id,challenge_id,best_score,attempts,best_time,completed,last_attempt_at)
        VALUES ($1,$2,$3,1,$4,$5,CURRENT_TIMESTAMP)`,
        [uid, challengeId, s, completed ? t : null, completed]
      );
    }

    const progress = await qOne(
      'SELECT * FROM user_progress WHERE user_id=$1 AND challenge_id=$2', [uid, challengeId]
    );
    res.json({ success: true, score: s, completed: completed === 1, progress });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ────────────────────────────────────────────────────────────────────

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [users, topics, challenges, completed] = await Promise.all([
      qOne('SELECT COUNT(*)::int as c FROM users WHERE is_admin=0'),
      qOne('SELECT COUNT(*)::int as c FROM topics'),
      qOne('SELECT COUNT(*)::int as c FROM challenges'),
      qOne('SELECT COUNT(*)::int as c FROM user_progress WHERE completed=1')
    ]);
    res.json({ totalUsers: users.c, totalTopics: topics.c, totalChallenges: challenges.c, completedChallenges: completed.c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await q(`
      SELECT u.id, u.username, u.created_at, u.last_ip, u.last_login,
             COUNT(DISTINCT up.challenge_id)::int as attempted,
             COUNT(DISTINCT CASE WHEN up.completed=1 THEN up.challenge_id END)::int as completed,
             ROUND(AVG(up.best_score)::numeric,1) as avg_score,
             COALESCE(SUM(up.attempts),0)::int as total_attempts,
             COALESCE(SUM(up.best_time),0)::int as total_time
      FROM users u
      LEFT JOIN user_progress up ON u.id=up.user_id
      WHERE u.is_admin=0
      GROUP BY u.id ORDER BY u.created_at DESC
    `);

    const result = await Promise.all(users.map(async u => ({
      ...u,
      sessions: await q(
        'SELECT ip_address, login_at FROM user_sessions WHERE user_id=$1 ORDER BY login_at DESC LIMIT 10',
        [u.id]
      ),
      topicProgress: await q(`
        SELECT t.name, t.icon,
               COUNT(DISTINCT c.id)::int as total,
               COUNT(DISTINCT CASE WHEN up.completed=1 THEN up.challenge_id END)::int as done,
               ROUND(AVG(up.best_score)::numeric,1) as avg,
               COALESCE(SUM(up.best_time),0)::int as time_spent
        FROM topics t
        LEFT JOIN challenges c ON c.topic_id=t.id
        LEFT JOIN user_progress up ON up.challenge_id=c.id AND up.user_id=$1
        GROUP BY t.id ORDER BY t.order_index`, [u.id]
      )
    })));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/topics', requireAdmin, async (req, res) => {
  try {
    const topics = await q('SELECT * FROM topics ORDER BY order_index, id');
    const result = await Promise.all(topics.map(async t => ({
      ...t,
      challenges: await q(
        'SELECT id, title, type, order_index FROM challenges WHERE topic_id=$1 ORDER BY order_index',
        [t.id]
      )
    })));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/topics', requireAdmin, async (req, res) => {
  try {
    const { name, description, icon } = req.body;
    if (!name) return res.status(400).json({ error: 'El nombre es requerido' });
    const maxRow = await qOne('SELECT MAX(order_index) as m FROM topics');
    const { rows } = await pool.query(
      'INSERT INTO topics (name, description, icon, order_index) VALUES ($1,$2,$3,$4) RETURNING id',
      [name, description || '', icon || '📚', (maxRow.m || 0) + 1]
    );
    res.json({ success: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/topics/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query('DELETE FROM user_progress WHERE challenge_id IN (SELECT id FROM challenges WHERE topic_id=$1)', [id]);
    await pool.query('DELETE FROM challenges WHERE topic_id=$1', [id]);
    await pool.query('DELETE FROM topics WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/topics/:id/challenges', requireAdmin, async (req, res) => {
  try {
    const { title, description, questions } = req.body;
    if (!title || !questions?.length)
      return res.status(400).json({ error: 'Título y preguntas son requeridos' });
    const maxRow = await qOne('SELECT MAX(order_index) as m FROM challenges WHERE topic_id=$1', [req.params.id]);
    const { rows } = await pool.query(
      'INSERT INTO challenges (topic_id,title,description,type,content,order_index) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.params.id, title, description || '', 'quiz', JSON.stringify({ intro: description || title, questions }), (maxRow.m || 0) + 1]
    );
    res.json({ success: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/challenges/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_progress WHERE challenge_id=$1', [req.params.id]);
    await pool.query('DELETE FROM challenges WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SEED TRANSFORM GAME (one-shot) ───────────────────────────────────────────

app.post('/api/admin/seed-transform', requireAdmin, async (req, res) => {
  try {
    const existing = await qOne("SELECT id FROM challenges WHERE title = 'Laboratorio de Transformaciones'");
    if (existing) {
      await pool.query('DELETE FROM user_progress WHERE challenge_id = $1', [existing.id]);
      await pool.query("DELETE FROM challenges WHERE id = $1", [existing.id]);
    }
    const topic = await qOne("SELECT id FROM topics WHERE name = 'Matrices' LIMIT 1");
    if (!topic) return res.status(404).json({ error: 'Tema Matrices no encontrado' });

    const content = {
      intro: 'Descubre que transformacion matricial produce cada efecto visual. Manipula la realidad con matematicas!',
      levels: [
        { name: 'Escalado Doble', desc: 'Esta matriz duplica el tamano de la figura en ambas dimensiones. Puedes descubrir sus valores?', matrix: [2,0,0,2], hint: 'Los valores en la diagonal controlan el escalado. Si quieres duplicar, pon 2 en la diagonal.' },
        { name: 'Reflexion Horizontal', desc: 'Esta matriz crea un efecto espejo: la figura se voltea sobre el eje X.', matrix: [1,0,0,-1], hint: 'Un valor negativo en d invierte el eje Y. El eje X no cambia.' },
        { name: 'Rotacion 90 grados', desc: 'Esta matriz rota la figura 90 grados en sentido antihorario. Las coordenadas se mezclan.', matrix: [0,-1,1,0], hint: 'En una rotacion de 90 grados: x nuevo es -y, y nuevo es x. Asi: a=0, b=-1, c=1, d=0' },
        { name: 'Cizalladura Shear', desc: 'Esta matriz inclina la figura. Convierte un rectangulo en un paralelogramo.', matrix: [1,1,0,1], hint: 'La cizalladura usa un valor fuera de la diagonal. Prueba b=1 manteniendo el resto como identidad.' },
        { name: 'Escalado No Uniforme', desc: 'Esta matriz estira en X y aplana en Y. Los ejes escalan de forma diferente!', matrix: [2,0,0,0.5], hint: 'Puedes escalar cada eje de forma independiente usando distintos valores en la diagonal.' }
      ]
    };

    const maxRow = await qOne('SELECT MAX(order_index) as m FROM challenges WHERE topic_id = $1', [topic.id]);
    await pool.query(
      'INSERT INTO challenges (topic_id, title, description, type, content, order_index) VALUES ($1,$2,$3,$4,$5,$6)',
      [topic.id, 'Laboratorio de Transformaciones', 'Descubre el poder visual de las matrices manipulando formas geometricas en tiempo real', 'transform_game', JSON.stringify(content), (maxRow.m || 5) + 1]
    );
    res.json({ success: true, message: 'Desafio insertado correctamente' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN USER DETAIL ────────────────────────────────────────────────────────

app.get('/api/admin/users/:id/progress', requireAdmin, async (req, res) => {
  try {
    const topics = await q('SELECT * FROM topics ORDER BY order_index');
    const result = await Promise.all(topics.map(async t => {
      const challenges = await q(`
        SELECT c.id, c.title, c.type, c.order_index,
               up.best_score, up.attempts, up.best_time,
               up.completed, up.last_attempt_at
        FROM challenges c
        LEFT JOIN user_progress up ON up.challenge_id = c.id AND up.user_id = $1
        WHERE c.topic_id = $2
        ORDER BY c.order_index, c.id
      `, [req.params.id, t.id]);
      return { ...t, challenges };
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SEED SLOPE HUNTER ────────────────────────────────────────────────────────

app.post('/api/admin/seed-slope-hunter', requireAdmin, async (req, res) => {
  try {
    const TITLE = 'Cazador de Puntos Criticos';
    const existing = await qOne('SELECT id FROM challenges WHERE title = $1', [TITLE]);
    if (existing) {
      await pool.query('DELETE FROM user_progress WHERE challenge_id = $1', [existing.id]);
      await pool.query('DELETE FROM challenges WHERE id = $1', [existing.id]);
    }
    const topic = await qOne("SELECT id FROM topics WHERE name = 'Derivadas' LIMIT 1");
    if (!topic) return res.status(404).json({ error: 'Tema Derivadas no encontrado' });

    const content = {
      intro: 'Usa la recta tangente para cazar los puntos criticos. Donde la pendiente es 0, hay un maximo o minimo!',
      levels: [
        { name: 'Parabola', desc: 'f(x) = -x2 + 4', fType: 'parabola_neg', criticals: [0], xRange: [-3, 3], hint: 'La derivada es f\'(x) = -2x. Vale 0 cuando x = 0. Busca donde la tangente sea horizontal.' },
        { name: 'Cubica Clasica', desc: 'f(x) = x3 - 3x', fType: 'cubic_classic', criticals: [-1, 1], xRange: [-2.5, 2.5], hint: 'f\'(x) = 3x2 - 3 = 0 implica x2 = 1, es decir x = +1 y x = -1. Hay 2 puntos criticos.' },
        { name: 'Doble Valle', desc: 'f(x) = x4 - 4x2', fType: 'quartic_double', criticals: [-1.414, 0, 1.414], xRange: [-2.5, 2.5], hint: 'f\'(x) = 4x(x2-2) = 0. Tres puntos: x = 0 y x = mas/menos raiz de 2 (aprox 1.41 y -1.41).' },
        { name: 'Optimizacion', desc: 'f(x) = x3 - 6x2 + 9x', fType: 'cubic_optim', criticals: [1, 3], xRange: [-0.5, 4.5], hint: 'f\'(x) = 3x2 - 12x + 9 = 3(x-1)(x-3) = 0. Dos puntos criticos en x = 1 y x = 3.' },
        { name: 'Funcion Seno', desc: 'f(x) = sin(x)', fType: 'sine', criticals: [-1.5708, 1.5708], xRange: [-3.1416, 3.1416], hint: 'f\'(x) = cos(x) = 0 cuando x = pi/2 o x = -pi/2, es decir aproximadamente 1.57 y -1.57.' }
      ]
    };

    const maxRow = await qOne('SELECT MAX(order_index) as m FROM challenges WHERE topic_id = $1', [topic.id]);
    await pool.query(
      'INSERT INTO challenges (topic_id, title, description, type, content, order_index) VALUES ($1,$2,$3,$4,$5,$6)',
      [topic.id, TITLE, 'Encuentra los maximos y minimos usando la recta tangente en tiempo real', 'slope_hunter', JSON.stringify(content), (maxRow.m || 5) + 1]
    );
    res.json({ success: true, message: 'Cazador de Puntos Criticos insertado correctamente' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor en http://localhost:${PORT}`);
      console.log('Admin: usuario "admin", contraseña "admin123"');
    });
  })
  .catch(err => {
    console.error('Error al inicializar la base de datos:', err.message);
    process.exit(1);
  });
