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
      nick VARCHAR(50) NOT NULL,
      tag VARCHAR(4) NOT NULL,
      full_nick VARCHAR(55) UNIQUE NOT NULL,
      pin_hash TEXT NOT NULL,
      token TEXT UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      full_nick VARCHAR(55) NOT NULL,
      text TEXT NOT NULL,
      edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS likes (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      full_nick VARCHAR(55) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(message_id, full_nick)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mails (
      id SERIAL PRIMARY KEY,
      from_full_nick VARCHAR(55) NOT NULL,
      to_full_nick VARCHAR(55) NOT NULL,
      text TEXT NOT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ База данных готова');
}
initDB();

function generateTag() {
  return '#' + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
}

async function isFullNickUnique(fullNick) {
  const res = await pool.query('SELECT id FROM users WHERE full_nick = $1', [fullNick]);
  return res.rows.length === 0;
}

// АВТОРИЗАЦИЯ (с PIN)
app.post('/auth', async (req, res) => {
  const { nick, pin } = req.body;
  if (!nick || nick.trim() === '' || !pin || pin.length !== 4 || !/^\d+$/.test(pin)) {
    return res.status(400).json({ success: false, error: 'Неверный ник или PIN (4 цифры)' });
  }
  const cleanNick = nick.trim();
  const existing = await pool.query('SELECT id, full_nick, pin_hash FROM users WHERE nick = $1', [cleanNick]);
  if (existing.rows.length > 0) {
    const valid = await bcrypt.compare(pin, existing.rows[0].pin_hash);
    if (!valid) return res.json({ success: false, error: 'Неверный PIN' });
    const token = uuidv4();
    await pool.query('UPDATE users SET token = $1 WHERE id = $2', [token, existing.rows[0].id]);
    return res.json({ success: true, full_nick: existing.rows[0].full_nick, token });
  } else {
    let tag;
    let full_nick;
    let unique = false;
    let attempts = 0;
    while (!unique && attempts < 20) {
      tag = generateTag();
      full_nick = `${cleanNick}${tag}`;
      unique = await isFullNickUnique(full_nick);
      attempts++;
    }
    if (!unique) return res.status(500).json({ success: false, error: 'Ошибка генерации тега' });
    const pinHash = await bcrypt.hash(pin, 10);
    const token = uuidv4();
    await pool.query(
      'INSERT INTO users (nick, tag, full_nick, pin_hash, token) VALUES ($1, $2, $3, $4, $5)',
      [cleanNick, tag, full_nick, pinHash, token]
    );
    return res.json({ success: true, full_nick, token });
  }
});

app.post('/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: false });
  const user = await pool.query('SELECT full_nick FROM users WHERE token = $1', [token]);
  if (user.rows.length > 0) res.json({ success: true, full_nick: user.rows[0].full_nick });
  else res.json({ success: false });
});

// СМЕНА НИКА (без PIN)
app.post('/change-nick', async (req, res) => {
  const { token, newNick } = req.body;
  if (!token || !newNick || newNick.trim() === '') {
    return res.status(400).json({ success: false, error: 'Данные неполные' });
  }
  const user = await pool.query('SELECT full_nick, nick FROM users WHERE token = $1', [token]);
  if (user.rows.length === 0) return res.json({ success: false, error: 'Сессия недействительна' });
  const oldFullNick = user.rows[0].full_nick;
  const oldNick = user.rows[0].nick;
  if (newNick === oldNick) return res.json({ success: true, newFullNick: oldFullNick });
  const tag = oldFullNick.substring(oldNick.length);
  const newFullNick = `${newNick}${tag}`;
  const existing = await pool.query('SELECT id FROM users WHERE full_nick = $1', [newFullNick]);
  if (existing.rows.length > 0) {
    return res.json({ success: false, error: 'Ник уже существует' });
  }
  await pool.query('UPDATE users SET nick = $1, full_nick = $2 WHERE token = $3', [newNick, newFullNick, token]);
  await pool.query('UPDATE messages SET full_nick = $1 WHERE full_nick = $2', [newFullNick, oldFullNick]);
  await pool.query('UPDATE likes SET full_nick = $1 WHERE full_nick = $2', [newFullNick, oldFullNick]);
  await pool.query('UPDATE mails SET from_full_nick = $1 WHERE from_full_nick = $2', [newFullNick, oldFullNick]);
  await pool.query('UPDATE mails SET to_full_nick = $1 WHERE to_full_nick = $2', [newFullNick, oldFullNick]);
  io.emit('nick changed', { oldFullNick, newFullNick });
  res.json({ success: true, newFullNick });
});

// СМЕНА PIN
app.post('/change-pin', async (req, res) => {
  const { token, oldPin, newPin } = req.body;
  if (!token || !oldPin || !newPin || newPin.length !== 4 || !/^\d+$/.test(newPin)) {
    return res.status(400).json({ success: false, error: 'Некорректные данные' });
  }
  const user = await pool.query('SELECT pin_hash FROM users WHERE token = $1', [token]);
  if (user.rows.length === 0) return res.json({ success: false, error: 'Сессия недействительна' });
  const valid = await bcrypt.compare(oldPin, user.rows[0].pin_hash);
  if (!valid) return res.json({ success: false, error: 'Неверный старый PIN' });
  const newHash = await bcrypt.hash(newPin, 10);
  await pool.query('UPDATE users SET pin_hash = $1 WHERE token = $2', [newHash, token]);
  res.json({ success: true });
});

// РЕДАКТИРОВАНИЕ СООБЩЕНИЯ
app.post('/edit-message', async (req, res) => {
  const { messageId, full_nick, newText } = req.body;
  if (!messageId || !full_nick || !newText || newText.trim() === '') {
    return res.status(400).json({ success: false });
  }
  const result = await pool.query(
    'UPDATE messages SET text = $1, edited = TRUE WHERE id = $2 AND full_nick = $3 RETURNING id',
    [newText.trim(), messageId, full_nick]
  );
  if (result.rowCount > 0) {
    io.emit('message edited', { messageId, newText: newText.trim() });
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// СООБЩЕНИЯ
app.get('/messages', async (req, res) => {
  const { full_nick } = req.query;
  const result = await pool.query(`
    SELECT m.id, m.full_nick, m.text, m.edited, m.created_at,
           COALESCE(l.likes_count, 0) as likes_count,
           EXISTS(SELECT 1 FROM likes WHERE message_id = m.id AND full_nick = $1) as is_liked
    FROM messages m
    LEFT JOIN (
      SELECT message_id, COUNT(*) as likes_count
      FROM likes
      GROUP BY message_id
    ) l ON m.id = l.message_id
    ORDER BY m.created_at ASC LIMIT 200
  `, [full_nick || '']);
  res.json(result.rows);
});

app.post('/delete-message', async (req, res) => {
  const { full_nick, messageId } = req.body;
  if (!full_nick || !messageId) return res.status(400).json({ success: false });
  const result = await pool.query('DELETE FROM messages WHERE id = $1 AND full_nick = $2 RETURNING id', [messageId, full_nick]);
  if (result.rowCount > 0) {
    io.emit('message deleted', messageId);
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// ЛАЙКИ
app.post('/like', async (req, res) => {
  const { messageId, full_nick } = req.body;
  if (!messageId || !full_nick) return res.status(400).json({ success: false });
  try {
    await pool.query('INSERT INTO likes (message_id, full_nick) VALUES ($1, $2)', [messageId, full_nick]);
    const countRes = await pool.query('SELECT COUNT(*) as count FROM likes WHERE message_id = $1', [messageId]);
    io.emit('like updated', { messageId, full_nick, likes_count: parseInt(countRes.rows[0].count), is_liked: true });
    res.json({ success: true, likes_count: parseInt(countRes.rows[0].count) });
  } catch (err) {
    if (err.code === '23505') {
      await pool.query('DELETE FROM likes WHERE message_id = $1 AND full_nick = $2', [messageId, full_nick]);
      const countRes = await pool.query('SELECT COUNT(*) as count FROM likes WHERE message_id = $1', [messageId]);
      io.emit('like updated', { messageId, full_nick, likes_count: parseInt(countRes.rows[0].count), is_liked: false });
      res.json({ success: true, likes_count: parseInt(countRes.rows[0].count) });
    } else {
      res.status(500).json({ success: false });
    }
  }
});

// ПИСЬМА
app.get('/mails', async (req, res) => {
  const { full_nick } = req.query;
  if (!full_nick) return res.status(400).json([]);
  const result = await pool.query(`
    SELECT id, from_full_nick, to_full_nick, text, is_read, created_at
    FROM mails
    WHERE to_full_nick = $1
    ORDER BY created_at DESC
  `, [full_nick]);
  res.json(result.rows);
});

app.post('/send-mail', async (req, res) => {
  const { from_full_nick, to_full_nick, text } = req.body;
  if (!from_full_nick || !to_full_nick || !text || text.trim() === '') {
    return res.status(400).json({ success: false, error: 'Не все поля заполнены' });
  }
  const userExists = await pool.query('SELECT full_nick FROM users WHERE full_nick = $1', [to_full_nick]);
  if (userExists.rows.length === 0) {
    return res.json({ success: false, error: 'Пользователь не найден' });
  }
  const result = await pool.query(
    'INSERT INTO mails (from_full_nick, to_full_nick, text, is_read) VALUES ($1, $2, $3, $4) RETURNING id',
    [from_full_nick, to_full_nick, text.trim(), false]
  );
  io.emit('new mail', { to_full_nick });
  res.json({ success: true, mailId: result.rows[0].id });
});

app.post('/read-mail', async (req, res) => {
  const { mailId, full_nick } = req.body;
  if (!mailId || !full_nick) return res.status(400).json({ success: false });
  await pool.query('UPDATE mails SET is_read = TRUE WHERE id = $1 AND to_full_nick = $2', [mailId, full_nick]);
  res.json({ success: true });
});

app.post('/delete-mail', async (req, res) => {
  const { mailId, full_nick } = req.body;
  if (!mailId || !full_nick) return res.status(400).json({ success: false });
  await pool.query('DELETE FROM mails WHERE id = $1 AND to_full_nick = $2', [mailId, full_nick]);
  res.json({ success: true });
});

app.post('/reply-mail', async (req, res) => {
  const { from_full_nick, to_full_nick, replyText } = req.body;
  if (!from_full_nick || !to_full_nick || !replyText || replyText.trim() === '') {
    return res.status(400).json({ success: false, error: 'Не все поля заполнены' });
  }
  const result = await pool.query(
    'INSERT INTO mails (from_full_nick, to_full_nick, text, is_read) VALUES ($1, $2, $3, $4) RETURNING id',
    [from_full_nick, to_full_nick, replyText.trim(), false]
  );
  io.emit('new mail', { to_full_nick });
  res.json({ success: true, mailId: result.rows[0].id });
});

// SOCKET.IO
io.on('connection', (socket) => {
  socket.on('new message', async (data) => {
    const { full_nick, text } = data;
    if (!full_nick || !text || text.trim() === '') return;
    const result = await pool.query(
      'INSERT INTO messages (full_nick, text) VALUES ($1, $2) RETURNING id, created_at',
      [full_nick, text.trim()]
    );
    const newMsg = {
      id: result.rows[0].id,
      full_nick,
      text: text.trim(),
      edited: false,
      created_at: result.rows[0].created_at,
      likes_count: 0,
      is_liked: false
    };
    io.emit('message received', newMsg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
