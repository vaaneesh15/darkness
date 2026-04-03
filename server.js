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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
      room VARCHAR(100) NOT NULL,
      nick VARCHAR(50) NOT NULL,
      text TEXT NOT NULL,
      reply_to_id INTEGER DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ База данных готова');
}
initDB();

async function findUserByToken(token) {
  if (!token) return null;
  const res = await pool.query('SELECT id, nick FROM users WHERE token = $1', [token]);
  return res.rows[0] || null;
}

// Авторизация / регистрация
app.post('/auth', async (req, res) => {
  const { nick, key } = req.body;
  if (!nick || !key) return res.status(400).json({ success: false, error: 'Заполните поля' });
  const existing = await pool.query('SELECT id, password_hash FROM users WHERE nick = $1', [nick]);
  if (existing.rows.length > 0) {
    const valid = await bcrypt.compare(key, existing.rows[0].password_hash);
    if (!valid) return res.json({ success: false, error: 'Неверный ключ' });
    const token = uuidv4();
    await pool.query('UPDATE users SET token = $1 WHERE id = $2', [token, existing.rows[0].id]);
    return res.json({ success: true, nick, token });
  } else {
    const hash = await bcrypt.hash(key, 10);
    const token = uuidv4();
    await pool.query('INSERT INTO users (nick, password_hash, token) VALUES ($1, $2, $3)', [nick, hash, token]);
    return res.json({ success: true, nick, token });
  }
});

app.post('/verify', async (req, res) => {
  const { token } = req.body;
  const user = await findUserByToken(token);
  if (user) res.json({ success: true, nick: user.nick });
  else res.json({ success: false });
});

app.post('/logout', async (req, res) => {
  const { token } = req.body;
  if (token) await pool.query('UPDATE users SET token = NULL WHERE token = $1', [token]);
  res.json({ success: true });
});

// Смена ника
app.post('/change-nick', async (req, res) => {
  const { token, newNick } = req.body;
  if (!token || !newNick) return res.status(400).json({ success: false, error: 'Данные неполные' });
  const user = await findUserByToken(token);
  if (!user) return res.json({ success: false, error: 'Сессия недействительна' });
  const existing = await pool.query('SELECT id FROM users WHERE nick = $1', [newNick]);
  if (existing.rows.length > 0) return res.json({ success: false, error: 'Ник уже занят' });
  await pool.query('UPDATE users SET nick = $1 WHERE token = $2', [newNick, token]);
  await pool.query('UPDATE messages SET nick = $1 WHERE nick = $2', [newNick, user.nick]);
  res.json({ success: true, newNick });
});

// Удаление аккаунта
app.post('/delete-account', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ success: false, error: 'Заполните поля' });
  const userRes = await pool.query('SELECT id, password_hash, nick FROM users WHERE token = $1', [token]);
  if (userRes.rows.length === 0) return res.json({ success: false, error: 'Сессия недействительна' });
  const user = userRes.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.json({ success: false, error: 'Неверный пароль' });
  await pool.query('DELETE FROM messages WHERE nick = $1', [user.nick]);
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  res.json({ success: true });
});

// Удаление сообщения
app.post('/delete-message', async (req, res) => {
  const { token, messageId } = req.body;
  if (!token || !messageId) return res.status(400).json({ success: false });
  const user = await findUserByToken(token);
  if (!user) return res.json({ success: false });
  const msgRes = await pool.query('SELECT nick FROM messages WHERE id = $1', [messageId]);
  if (msgRes.rows.length === 0) return res.json({ success: false });
  if (msgRes.rows[0].nick !== user.nick) return res.json({ success: false });
  await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
  io.emit('message deleted', { messageId });
  res.json({ success: true });
});

// Получение списка комнат
app.get('/rooms', async (req, res) => {
  const result = await pool.query('SELECT name, created_by FROM rooms ORDER BY created_at ASC');
  res.json(result.rows);
});

// Создание комнаты
app.post('/rooms', async (req, res) => {
  const { name, token } = req.body;
  if (!name || !token) return res.status(400).json({ success: false });
  const user = await findUserByToken(token);
  if (!user) return res.json({ success: false });
  try {
    await pool.query('INSERT INTO rooms (name, created_by) VALUES ($1, $2)', [name, user.nick]);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: 'Комната уже существует' });
  }
});

// Получение сообщений комнаты
app.get('/messages/:room', async (req, res) => {
  const { room } = req.params;
  const result = await pool.query(`
    SELECT m.id, m.nick, m.text, m.reply_to_id, m.created_at,
           r.nick as reply_nick, r.text as reply_text
    FROM messages m
    LEFT JOIN messages r ON m.reply_to_id = r.id
    WHERE m.room = $1
    ORDER BY m.created_at ASC LIMIT 200
  `, [room]);
  const messages = result.rows.map(row => ({
    id: row.id,
    nick: row.nick,
    text: row.text,
    reply_to_id: row.reply_to_id,
    created_at: row.created_at,
    reply: row.reply_to_id ? { nick: row.reply_nick, text: row.reply_text } : null
  }));
  res.json(messages);
});

// Socket.IO с поддержкой комнат
io.on('connection', (socket) => {
  console.log('Клиент подключился');
  socket.on('join room', (room) => {
    socket.join(room);
  });
  socket.on('leave room', (room) => {
    socket.leave(room);
  });
  socket.on('new message', async (data) => {
    const { room, nick, text, reply_to_id } = data;
    if (!room || !nick || !text || !text.trim()) return;
    const result = await pool.query(
      'INSERT INTO messages (room, nick, text, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
      [room, nick, text.trim(), reply_to_id || null]
    );
    const newMsgId = result.rows[0].id;
    let replyData = null;
    if (reply_to_id) {
      const replyRes = await pool.query('SELECT nick, text FROM messages WHERE id = $1', [reply_to_id]);
      if (replyRes.rows.length) {
        replyData = { nick: replyRes.rows[0].nick, text: replyRes.rows[0].text };
      }
    }
    const newMsg = {
      id: newMsgId,
      nick,
      text: text.trim(),
      reply_to_id: reply_to_id || null,
      created_at: result.rows[0].created_at,
      reply: replyData
    };
    io.to(room).emit('message received', newMsg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер на порту ${PORT}`));
