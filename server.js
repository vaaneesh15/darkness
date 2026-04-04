const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Инициализация таблиц
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      nick VARCHAR(50) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      token TEXT UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      nick VARCHAR(50) NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ База данных готова');
}
initDB();

// Авторизация (только ник, без пароля – упрощённо, но сохраняем совместимость)
app.post('/auth', async (req, res) => {
  const { nick } = req.body;
  if (!nick || nick.trim() === '') {
    return res.status(400).json({ success: false, error: 'Ник не может быть пустым' });
  }
  // Ищем пользователя
  let user = await pool.query('SELECT id, nick FROM users WHERE nick = $1', [nick.trim()]);
  if (user.rows.length === 0) {
    // Создаём нового пользователя с пустым паролем (упрощённо)
    const hash = await bcrypt.hash('', 10);
    const token = uuidv4();
    await pool.query('INSERT INTO users (nick, password_hash, token) VALUES ($1, $2, $3)', [nick.trim(), hash, token]);
    res.json({ success: true, nick: nick.trim(), token });
  } else {
    // Обновляем токен
    const token = uuidv4();
    await pool.query('UPDATE users SET token = $1 WHERE id = $2', [token, user.rows[0].id]);
    res.json({ success: true, nick: user.rows[0].nick, token });
  }
});

app.post('/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: false });
  const user = await pool.query('SELECT nick FROM users WHERE token = $1', [token]);
  if (user.rows.length > 0) res.json({ success: true, nick: user.rows[0].nick });
  else res.json({ success: false });
});

app.get('/messages', async (req, res) => {
  const result = await pool.query('SELECT id, nick, text, created_at FROM messages ORDER BY created_at ASC LIMIT 200');
  res.json(result.rows);
});

app.post('/delete-message', async (req, res) => {
  const { nick, messageId } = req.body;
  if (!nick || !messageId) return res.status(400).json({ success: false });
  const result = await pool.query('DELETE FROM messages WHERE id = $1 AND nick = $2 RETURNING id', [messageId, nick]);
  if (result.rowCount > 0) {
    io.emit('message deleted', messageId);
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// Смена ника
app.post('/change-nick', async (req, res) => {
  const { token, newNick } = req.body;
  if (!token || !newNick) return res.status(400).json({ success: false });
  const user = await pool.query('SELECT nick FROM users WHERE token = $1', [token]);
  if (user.rows.length === 0) return res.json({ success: false });
  const oldNick = user.rows[0].nick;
  await pool.query('UPDATE users SET nick = $1 WHERE token = $2', [newNick, token]);
  await pool.query('UPDATE messages SET nick = $1 WHERE nick = $2', [newNick, oldNick]);
  res.json({ success: true, newNick });
});

io.on('connection', (socket) => {
  socket.on('new message', async (data) => {
    const { nick, text } = data;
    if (!nick || !text || text.trim() === '') return;
    const result = await pool.query(
      'INSERT INTO messages (nick, text) VALUES ($1, $2) RETURNING id, created_at',
      [nick, text.trim()]
    );
    const newMsg = {
      id: result.rows[0].id,
      nick,
      text: text.trim(),
      created_at: result.rows[0].created_at
    };
    io.emit('message received', newMsg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
