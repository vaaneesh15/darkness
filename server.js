const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  // Удаляем старые таблицы, которые больше не нужны
  const tablesToDrop = [
    'contacts', 'blocked_users', 'deleted_chats', 'chat_participants',
    'message_reactions', 'posts', 'post_likes', 'chats'
  ];
  for (const table of tablesToDrop) {
    try { await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`); } catch (e) {}
  }

  // Таблица пользователей (только самое необходимое)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      nick VARCHAR(50) UNIQUE NOT NULL,
      pin_hash TEXT NOT NULL,
      token TEXT UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Удаляем все лишние колонки из users
  const userColsToDrop = ['badge', 'description', 'visibility', 'who_can_write', 'online_visible', 'who_can_voice', 'description_visible', 'who_can_invite'];
  for (const col of userColsToDrop) {
    try { await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS ${col}`); } catch (e) {}
  }

  // Таблица сообщений (без реакций)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      nick VARCHAR(50) NOT NULL,
      text TEXT,
      reply_to_id INTEGER DEFAULT NULL,
      edited BOOLEAN DEFAULT FALSE,
      type VARCHAR(20) DEFAULT 'text',
      file_url TEXT,
      file_name TEXT,
      file_size INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('✅ База данных готова');
}
initDB();

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false });
  res.json({ success: true, file: req.file });
});

app.post('/auth', async (req, res) => {
  const { nick, pin } = req.body;
  if (!nick || nick.trim() === '' || !pin || pin.length !== 4 || !/^\d+$/.test(pin)) {
    return res.status(400).json({ success: false, error: 'Неверный ник или PIN (4 цифры)' });
  }
  const cleanNick = nick.trim();
  const existing = await pool.query('SELECT nick, pin_hash FROM users WHERE nick = $1', [cleanNick]);
  if (existing.rows.length > 0) {
    const valid = await bcrypt.compare(pin, existing.rows[0].pin_hash);
    if (!valid) return res.json({ success: false, error: 'Неверный PIN' });
    const token = uuidv4();
    await pool.query('UPDATE users SET token = $1 WHERE nick = $2', [token, cleanNick]);
    return res.json({ success: true, nick: cleanNick, token });
  } else {
    const pinHash = await bcrypt.hash(pin, 10);
    const token = uuidv4();
    try {
      await pool.query('INSERT INTO users (nick, pin_hash, token) VALUES ($1, $2, $3)', [cleanNick, pinHash, token]);
      return res.json({ success: true, nick: cleanNick, token });
    } catch (err) {
      if (err.code === '23505') return res.status(400).json({ success: false, error: 'Ник уже занят' });
      throw err;
    }
  }
});

app.post('/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: false });
  const user = await pool.query('SELECT nick FROM users WHERE token = $1', [token]);
  if (user.rows.length > 0) res.json({ success: true, nick: user.rows[0].nick });
  else res.json({ success: false });
});

app.get('/public-chat-id', async (req, res) => {
  res.json({ chatId: 1 });
});

app.get('/chat-messages', async (req, res) => {
  const { chat_id, nick } = req.query;
  if (!chat_id || !nick) return res.json([]);
  const result = await pool.query(`
    SELECT m.id, m.chat_id, m.nick, m.text, m.reply_to_id, m.edited, m.type, m.file_url, m.file_name, m.file_size, m.created_at,
           rep.nick as reply_nick, rep.text as reply_text
    FROM messages m
    LEFT JOIN messages rep ON m.reply_to_id = rep.id
    WHERE m.chat_id = $1
    ORDER BY m.created_at ASC
  `, [chat_id]);
  res.json(result.rows);
});

app.post('/chat-message', async (req, res) => {
  const { chat_id, nick, text, reply_to_id, type, file_url, file_name, file_size } = req.body;
  if (!chat_id || !nick) return res.status(400).json({ success: false });
  const result = await pool.query(
    `INSERT INTO messages (chat_id, nick, text, reply_to_id, type, file_url, file_name, file_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
    [chat_id, nick, text || null, reply_to_id || null, type || 'text', file_url, file_name, file_size]
  );
  const newMsg = { id: result.rows[0].id, chat_id, nick, text, reply_to_id: reply_to_id || null, edited: false, type: type || 'text', file_url, file_name, file_size, created_at: result.rows[0].created_at };
  if (reply_to_id) {
    const replyMsg = await pool.query('SELECT nick, text FROM messages WHERE id = $1', [reply_to_id]);
    if (replyMsg.rows.length) { newMsg.reply_nick = replyMsg.rows[0].nick; newMsg.reply_text = replyMsg.rows[0].text; }
  }
  io.to(`chat:${chat_id}`).emit('chat message received', newMsg);
  res.json({ success: true, message: newMsg });
});

app.post('/delete-message', async (req, res) => {
  const { nick, messageId } = req.body;
  if (!nick || !messageId) return res.status(400).json({ success: false });
  const msg = await pool.query('SELECT nick FROM messages WHERE id = $1', [messageId]);
  if (msg.rows.length === 0) return res.json({ success: false });
  if (msg.rows[0].nick !== nick) return res.json({ success: false });
  const result = await pool.query('DELETE FROM messages WHERE id = $1 RETURNING id, chat_id', [messageId]);
  if (result.rowCount > 0) { io.to(`chat:${result.rows[0].chat_id}`).emit('message deleted', messageId); res.json({ success: true }); }
  else res.json({ success: false });
});

app.post('/edit-message', async (req, res) => {
  const { messageId, nick, newText } = req.body;
  if (!messageId || !nick || !newText?.trim()) return res.status(400).json({ success: false });
  const result = await pool.query('UPDATE messages SET text = $1, edited = TRUE WHERE id = $2 AND nick = $3 RETURNING id, chat_id', [newText.trim(), messageId, nick]);
  if (result.rowCount > 0) { io.to(`chat:${result.rows[0].chat_id}`).emit('message edited', { messageId, newText: newText.trim() }); res.json({ success: true }); }
  else res.json({ success: false });
});

io.on('connection', (socket) => {
  let currentNick = null;
  socket.on('user online', (nick) => { currentNick = nick; socket.join('chat:1'); });
  socket.on('join chat', (chatId) => { socket.join(`chat:${chatId}`); });
  socket.on('typing', ({ chatId, nick }) => { socket.to(`chat:${chatId}`).emit('user typing', { chatId, nick }); });
  socket.on('stop typing', ({ chatId }) => { socket.to(`chat:${chatId}`).emit('user stop typing', { chatId }); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
