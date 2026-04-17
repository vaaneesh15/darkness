const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
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
  // Удаляем таблицы, которые точно не нужны
  const tablesToDrop = [
    'contacts', 'blocked_users', 'deleted_chats', 'chat_participants',
    'message_reactions', 'posts', 'post_likes'
  ];
  for (const table of tablesToDrop) {
    try { await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`); } catch (e) {}
  }

  // Таблица users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      nick VARCHAR(50) PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Таблица chats
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      type VARCHAR(20) NOT NULL DEFAULT 'public'
    );
  `);

  // Удаляем возможные лишние колонки из chats
  const chatCols = ['name', 'owner_nick', 'created_at'];
  for (const col of chatCols) {
    try { await pool.query(`ALTER TABLE chats DROP COLUMN IF EXISTS ${col}`); } catch (e) {}
  }

  // Таблица messages
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
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

  // Удаляем ненужные колонки из messages
  const msgCols = ['duration', 'reply_nick', 'reply_text'];
  for (const col of msgCols) {
    try { await pool.query(`ALTER TABLE messages DROP COLUMN IF EXISTS ${col}`); } catch (e) {}
  }

  // Публичный чат
  const publicChat = await pool.query(`SELECT id FROM chats WHERE type = 'public'`);
  if (publicChat.rows.length === 0) {
    await pool.query(`INSERT INTO chats (type) VALUES ('public')`);
  }

  console.log('✅ База данных готова');
}
initDB();

// Эндпоинты
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false });
  res.json({ success: true, file: req.file });
});

app.get('/public-chat-id', async (req, res) => {
  const result = await pool.query(`SELECT id FROM chats WHERE type = 'public'`);
  if (result.rows.length) res.json({ chatId: result.rows[0].id });
  else res.status(500).json({ error: 'Нет публичного чата' });
});

app.get('/chat-messages', async (req, res) => {
  const { chat_id } = req.query;
  if (!chat_id) return res.json([]);
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

  await pool.query(`INSERT INTO users (nick) VALUES ($1) ON CONFLICT (nick) DO NOTHING`, [nick]);

  const result = await pool.query(
    `INSERT INTO messages (chat_id, nick, text, reply_to_id, type, file_url, file_name, file_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
    [chat_id, nick, text || null, reply_to_id || null, type || 'text', file_url, file_name, file_size]
  );
  const newMsg = {
    id: result.rows[0].id, chat_id, nick, text,
    reply_to_id: reply_to_id || null, edited: false,
    type: type || 'text', file_url, file_name, file_size,
    created_at: result.rows[0].created_at
  };
  if (reply_to_id) {
    const replyMsg = await pool.query('SELECT nick, text FROM messages WHERE id = $1', [reply_to_id]);
    if (replyMsg.rows.length) {
      newMsg.reply_nick = replyMsg.rows[0].nick;
      newMsg.reply_text = replyMsg.rows[0].text;
    }
  }
  io.to(`chat:${chat_id}`).emit('chat message received', newMsg);
  res.json({ success: true, message: newMsg });
});

app.post('/delete-message', async (req, res) => {
  const { nick, messageId } = req.body;
  if (!nick || !messageId) return res.status(400).json({ success: false });
  const msg = await pool.query('SELECT nick, chat_id FROM messages WHERE id = $1', [messageId]);
  if (msg.rows.length === 0) return res.json({ success: false });
  if (msg.rows[0].nick !== nick) return res.json({ success: false });
  const result = await pool.query('DELETE FROM messages WHERE id = $1 RETURNING id, chat_id', [messageId]);
  if (result.rowCount > 0) {
    io.to(`chat:${result.rows[0].chat_id}`).emit('message deleted', messageId);
    res.json({ success: true });
  } else res.json({ success: false });
});

app.post('/edit-message', async (req, res) => {
  const { messageId, nick, newText } = req.body;
  if (!messageId || !nick || !newText?.trim()) return res.status(400).json({ success: false });
  const result = await pool.query(
    'UPDATE messages SET text = $1, edited = TRUE WHERE id = $2 AND nick = $3 RETURNING id, chat_id',
    [newText.trim(), messageId, nick]
  );
  if (result.rowCount > 0) {
    io.to(`chat:${result.rows[0].chat_id}`).emit('message edited', { messageId, newText: newText.trim() });
    res.json({ success: true });
  } else res.json({ success: false });
});

// Сокеты
const typingUsers = new Map();

io.on('connection', (socket) => {
  let currentNick = null;
  let currentChatId = null;

  socket.on('user online', async (nick) => {
    currentNick = nick;
    const result = await pool.query(`SELECT id FROM chats WHERE type = 'public'`);
    if (result.rows.length) {
      currentChatId = result.rows[0].id;
      socket.join(`chat:${currentChatId}`);
    }
  });

  socket.on('join chat', (chatId) => {
    socket.join(`chat:${chatId}`);
    currentChatId = chatId;
  });

  socket.on('typing', ({ chatId, nick }) => {
    if (!typingUsers.has(chatId)) typingUsers.set(chatId, new Set());
    typingUsers.get(chatId).add(nick);
    socket.to(`chat:${chatId}`).emit('user typing', { chatId, nick });
  });

  socket.on('stop typing', ({ chatId, nick }) => {
    if (typingUsers.has(chatId)) {
      typingUsers.get(chatId).delete(nick);
      socket.to(`chat:${chatId}`).emit('user stop typing', { chatId, nick });
    }
  });

  socket.on('disconnect', () => {
    if (currentNick && currentChatId && typingUsers.has(currentChatId)) {
      typingUsers.get(currentChatId).delete(currentNick);
      io.to(`chat:${currentChatId}`).emit('user stop typing', { chatId: currentChatId, nick: currentNick });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
