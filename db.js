const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const q    = (sql, p) => pool.query(sql, p).then(r => r.rows);
const qOne = (sql, p) => pool.query(sql, p).then(r => r.rows[0] || null);

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

  const admin = await qOne('SELECT id FROM users WHERE username = $1', ['admin']);
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query('INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, 1)', ['admin', hash]);
    console.log('Admin creado: admin / admin123');
  }

  const { rows } = await pool.query('SELECT COUNT(*)::int as c FROM topics');
  if (rows[0].c === 0) await seedTopics();
}

async function ins(sql, params) {
  const r = await pool.query(sql + ' RETURNING id', params);
  return r.rows[0].id;
}

async function seedTopics() {
  const matId = await ins(
    'INSERT INTO topics (name, description, icon, order_index) VALUES ($1,$2,$3,$4)',
    ['Matrices', 'Aprende sobre matrices, sus operaciones y aplicaciones', '🔢', 1]
  );

  const matChallenges = [
    {
      title: '¿Qué son las Matrices?', desc: 'Conceptos fundamentales sobre matrices',
      type: 'quiz', order: 1,
      content: {
        intro: '¡Bienvenido al mundo de las matrices! Responde estas preguntas para demostrar tu conocimiento básico.',
        questions: [
          { q: '¿Qué es una matriz?', opts: ['Una lista de números en horizontal', 'Una tabla rectangular de números en filas y columnas', 'Un número muy grande', 'Una ecuación matemática'], ans: 1, explain: 'Una matriz es una tabla rectangular de números organizados en filas y columnas.' },
          { q: '¿Cuál es la dimensión de la matriz [[1,2,3],[4,5,6]]?', opts: ['3×2', '2×3', '6×1', '1×6'], ans: 1, explain: 'La matriz tiene 2 filas y 3 columnas → dimensión 2×3.' },
          { q: 'El elemento a₁₂ de [[5,7,3],[2,8,1]] es:', opts: ['5', '2', '7', '8'], ans: 2, explain: 'a₁₂ = fila 1, columna 2. Primera fila: [5,7,3] → segundo elemento = 7.' },
          { q: '¿Qué es una matriz cuadrada?', opts: ['Una matriz con todos iguales', 'Una con el mismo nº de filas que columnas', 'Solo las de 2×2', 'Una con solo ceros'], ans: 1, explain: 'Una matriz cuadrada tiene igual número de filas que columnas (n×n).' },
          { q: '¿Qué es la matriz identidad?', opts: ['Una llena de unos', 'Diagonal de unos y resto ceros', 'Con unos en los bordes', 'La primera que se estudia'], ans: 1, explain: 'La identidad tiene 1s en la diagonal principal y 0s en el resto.' }
        ]
      }
    },
    {
      title: 'Suma de Matrices', desc: 'Practica la suma y resta de matrices',
      type: 'fill_blank', order: 2,
      content: {
        intro: 'Dadas A = [[3,1],[2,4]] y B = [[1,5],[3,2]], calcula los siguientes valores:',
        context: 'A = | 3  1 |    B = | 1  5 |\n    | 2  4 |        | 3  2 |',
        problems: [
          { q: 'Elemento [1,1] de A+B', ans: '4', hint: '3 + 1 = ?' },
          { q: 'Elemento [1,2] de A+B', ans: '6', hint: '1 + 5 = ?' },
          { q: 'Elemento [2,1] de A+B', ans: '5', hint: '2 + 3 = ?' },
          { q: 'Elemento [2,2] de A+B', ans: '6', hint: '4 + 2 = ?' },
          { q: 'Elemento [1,1] de A−B', ans: '2', hint: '3 - 1 = ?' },
          { q: 'Elemento [2,2] de A−B', ans: '2', hint: '4 - 2 = ?' }
        ]
      }
    },
    {
      title: 'Multiplicación de Matrices', desc: 'Aprende a multiplicar matrices',
      type: 'quiz', order: 3,
      content: {
        intro: 'La multiplicación de matrices sigue reglas especiales. ¡Comprueba que las dominas!',
        questions: [
          { q: '¿Cuándo es posible multiplicar A × B?', opts: ['Siempre que sean iguales', 'Cuando columnas de A = filas de B', 'Solo con matrices cuadradas', 'Cuando tienen la misma dimensión'], ans: 1, explain: 'Para A×B: el nº de columnas de A debe igualar el nº de filas de B.' },
          { q: 'Si A es 2×3 y B es 3×4, ¿cuál es la dimensión de A×B?', opts: ['3×3', '2×4', '4×2', '6×12'], ans: 1, explain: 'El resultado de m×n por n×p es m×p → aquí 2×4.' },
          { q: 'Para A=[[1,2],[3,4]] y B=[[1,0],[0,1]], ¿cuánto vale A×B?', opts: ['[[1,2],[3,4]] — la misma A', '[[0,0],[0,0]]', '[[1,0],[0,1]]', '[[2,4],[6,8]]'], ans: 0, explain: 'B es la matriz identidad. A × I = A siempre.' },
          { q: '¿La multiplicación de matrices es conmutativa?', opts: ['Sí, siempre', 'No, en general A×B ≠ B×A', 'Solo con cuadradas', 'Solo con enteros'], ans: 1, explain: 'La multiplicación matricial NO es conmutativa. A×B suele diferir de B×A.' },
          { q: 'A=[[2,1],[3,2]] → elemento [1,1] de A×A =', opts: ['4', '5', '7', '10'], ans: 2, explain: '[1,1] = fila1·col1 = 2×2 + 1×3 = 4 + 3 = 7.' }
        ]
      }
    },
    {
      title: 'Determinantes 2×2', desc: 'Calcula determinantes de matrices 2×2',
      type: 'fill_blank', order: 4,
      content: {
        intro: 'El determinante de [[a,b],[c,d]] = a·d − b·c. ¡Practica calculando!',
        context: 'Fórmula: det([[a,b],[c,d]]) = a × d − b × c',
        problems: [
          { q: 'det([[3,1],[2,4]])', ans: '10', hint: '3×4 − 1×2 = ?' },
          { q: 'det([[5,2],[3,1]])', ans: '-1', hint: '5×1 − 2×3 = ?' },
          { q: 'det([[2,0],[0,3]])', ans: '6',  hint: '2×3 − 0×0 = ?' },
          { q: 'det([[1,1],[1,1]])', ans: '0',  hint: '1×1 − 1×1 = ?' },
          { q: 'det([[4,3],[2,2]])', ans: '2',  hint: '4×2 − 3×2 = ?' }
        ]
      }
    },
    {
      title: 'Tipos de Matrices', desc: 'Relaciona cada tipo de matriz con su definición',
      type: 'matching', order: 5,
      content: {
        intro: '¡Une cada tipo de matriz con su definición! Haz clic en un elemento de la izquierda y luego en su pareja.',
        pairs: [
          { left: 'Matriz Identidad',          right: 'Diagonal de unos, resto ceros' },
          { left: 'Matriz Nula',               right: 'Todos sus elementos son cero' },
          { left: 'Matriz Diagonal',           right: 'Solo hay elementos en la diagonal' },
          { left: 'Matriz Simétrica',          right: 'Es igual a su transpuesta (A = Aᵀ)' },
          { left: 'Matriz Triangular Superior',right: 'Ceros por debajo de la diagonal' }
        ]
      }
    }
  ];

  for (const ch of matChallenges) {
    await pool.query(
      'INSERT INTO challenges (topic_id, title, description, type, content, order_index) VALUES ($1,$2,$3,$4,$5,$6)',
      [matId, ch.title, ch.desc, ch.type, JSON.stringify(ch.content), ch.order]
    );
  }

  const derId = await ins(
    'INSERT INTO topics (name, description, icon, order_index) VALUES ($1,$2,$3,$4)',
    ['Derivadas', 'Domina el cálculo diferencial: derivadas, reglas y aplicaciones', '📈', 2]
  );

  const derChallenges = [
    {
      title: '¿Qué son las Derivadas?', desc: 'Conceptos fundamentales del cálculo diferencial',
      type: 'quiz', order: 1,
      content: {
        intro: '¡Descubre el mundo de las derivadas! Comprueba tu conocimiento conceptual.',
        questions: [
          { q: '¿Qué mide la derivada de una función?', opts: ['El área bajo la curva', 'La tasa de cambio instantánea', 'El valor máximo', 'La distancia entre dos puntos'], ans: 1, explain: 'La derivada mide cómo cambia la función en un punto, es decir, su tasa de cambio instantánea.' },
          { q: '¿Cuál es la derivada de una constante? Ej: f(x) = 7', opts: ['7', 'x', '0', '1'], ans: 2, explain: 'La derivada de cualquier constante es 0, ya que no cambia con respecto a x.' },
          { q: 'Según la regla de la potencia, d/dx(xⁿ) =', opts: ['xⁿ⁻¹', 'n·xⁿ', 'n·xⁿ⁻¹', 'n·x'], ans: 2, explain: 'Regla de la potencia: d/dx(xⁿ) = n·xⁿ⁻¹.' },
          { q: '¿Cuál es la derivada de f(x) = 5x³?', opts: ['5x²', '15x', '15x²', '5x⁴'], ans: 2, explain: 'd/dx(5x³) = 5·3·x² = 15x².' },
          { q: '¿Cuál es la derivada de eˣ?', opts: ['x·eˣ⁻¹', 'eˣ', 'e', 'x·e'], ans: 1, explain: 'La derivada de eˣ es eˣ. ¡Es la única función que es su propia derivada!' }
        ]
      }
    },
    {
      title: 'Calcula la Derivada', desc: 'Practica derivando funciones simples',
      type: 'fill_blank', order: 2,
      content: {
        intro: 'Aplica las reglas de derivación y escribe el resultado numérico.',
        context: 'Reglas: d/dx(c) = 0  |  d/dx(xⁿ) = n·xⁿ⁻¹  |  d/dx(c·f) = c·f\'',
        problems: [
          { q: 'f(x) = x⁴ → coeficiente en f\'(x) = ?·x³', ans: '4',  hint: 'Baja el 4 como coeficiente' },
          { q: 'f(x) = 6x² → coeficiente en f\'(x) = ?·x', ans: '12', hint: '6 × 2 = ?' },
          { q: 'f(x) = 3x → f\'(x) = ?',                   ans: '3',  hint: 'La derivada de x es 1' },
          { q: 'f(x) = x² + x → f\'(1) = ?',               ans: '3',  hint: 'f\'(x) = 2x+1, evalúa en x=1' },
          { q: 'f(x) = 4x³ − 2x → f\'(0) = ?',             ans: '-2', hint: 'f\'(x) = 12x²−2, evalúa en x=0' },
          { q: 'f(x) = 10 → f\'(x) = ?',                   ans: '0',  hint: 'La derivada de una constante es...' }
        ]
      }
    },
    {
      title: 'Regla de la Cadena', desc: 'Domina la regla de la cadena para funciones compuestas',
      type: 'quiz', order: 3,
      content: {
        intro: 'Regla de la cadena: si h(x) = f(g(x)), entonces h\'(x) = f\'(g(x))·g\'(x)',
        questions: [
          { q: '¿Cuándo se usa la regla de la cadena?', opts: ['Para sumar derivadas', 'Para derivar funciones compuestas', 'Para integrar funciones', 'Para factorizar polinomios'], ans: 1, explain: 'La regla de la cadena se usa cuando hay una función dentro de otra (composición).' },
          { q: 'Para f(x) = (x²+1)³, ¿cuáles son la función exterior e interior?', opts: ['Exterior: u², Interior: x+1', 'Exterior: u³, Interior: x²+1', 'Exterior: x³, Interior: u²+1', 'No hay composición'], ans: 1, explain: 'La exterior es u³ (elevar al cubo) y la interior es x²+1.' },
          { q: 'd/dx[(3x+2)⁴] =', opts: ['4(3x+2)³', '12(3x+2)³', '4·3x³', '(3x+2)³'], ans: 1, explain: '4(3x+2)³ · 3 = 12(3x+2)³.' },
          { q: 'd/dx[sin(x²)] =', opts: ['cos(x²)', '2x·cos(x²)', '2x·cos(x)', 'sin(2x)'], ans: 1, explain: 'Exterior: cos(x²). Interior: 2x. Resultado: 2x·cos(x²).' },
          { q: 'd/dx[e^(2x)] =', opts: ['e^(2x)', '2·e^(2x)', '2x·e^(2x-1)', 'e^(2x-1)'], ans: 1, explain: 'eᵘ · 2 = 2e^(2x).' }
        ]
      }
    },
    {
      title: 'Funciones y sus Derivadas', desc: 'Relaciona cada función con su derivada',
      type: 'matching', order: 4,
      content: {
        intro: '¡Une cada función con su derivada correcta! Clic en la función, luego en su derivada.',
        pairs: [
          { left: 'f(x) = sin(x)', right: 'cos(x)' },
          { left: 'f(x) = cos(x)', right: '−sin(x)' },
          { left: 'f(x) = eˣ',     right: 'eˣ' },
          { left: 'f(x) = ln(x)',   right: '1/x' },
          { left: 'f(x) = x⁵',     right: '5x⁴' }
        ]
      }
    },
    {
      title: 'Aplicaciones de las Derivadas', desc: 'Resuelve problemas reales usando derivadas',
      type: 'fill_blank', order: 5,
      content: {
        intro: '¡Las derivadas tienen aplicaciones increíbles! Resuelve estos problemas reales.',
        context: 'Recuerda: si f\'(x) = 0 → posible máximo o mínimo',
        problems: [
          { q: 's(t) = t² + 3t → velocidad en t=2', ans: '7', hint: 's\'(t)=2t+3, evalúa en t=2' },
          { q: 'f(x) = x² − 4x + 1 → ¿en qué x es f\'(x) = 0?', ans: '2', hint: 'f\'(x)=2x−4=0 → x=?' },
          { q: 'f(x) = −x² + 6x → valor máximo de f(x)', ans: '9', hint: 'f\'(x)=−2x+6=0 → x=3, f(3)=?' },
          { q: 'f\'(x) = 3x² − 3 → ¿en cuántos puntos f\'(x) = 0?', ans: '2', hint: 'x²=1 → x=±1' }
        ]
      }
    }
  ];

  for (const ch of derChallenges) {
    await pool.query(
      'INSERT INTO challenges (topic_id, title, description, type, content, order_index) VALUES ($1,$2,$3,$4,$5,$6)',
      [derId, ch.title, ch.desc, ch.type, JSON.stringify(ch.content), ch.order]
    );
  }

  console.log('Datos de ejemplo creados: 2 temas con 5 desafíos cada uno.');
}

module.exports = { pool, q, qOne, initDb };
