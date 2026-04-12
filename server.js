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
      pin_hash TEXT NOT NULL,
      token TEXT UNIQUE,
      badge VARCHAR(10) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const columnsToDrop = ['description', 'visibility', 'who_can_write', 'online_visible', 'who_can_voice', 'description_visible', 'who_can_invite'];
  for (const col of columnsToDrop) {
    try { await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS ${col}`); } catch (e) {}
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      type VARCHAR(20) NOT NULL CHECK (type = 'public'),
      name VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      nick VARCHAR(50) NOT NULL,
      text TEXT,
      reply_to_id INTEGER DEFAULT NULL,
      edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      nick VARCHAR(50) NOT NULL,
      reaction VARCHAR(10) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(message_id, nick, reaction)
    );
  `);

  const tablesToDrop = ['contacts', 'blocked_users', 'deleted_chats', 'chat_participants'];
  for (const table of tablesToDrop) {
    try { await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`); } catch (e) {}
  }

  const publicChat = await pool.query(`SELECT id FROM chats WHERE type = 'public'`);
  if (publicChat.rows.length === 0) {
    await pool.query(`INSERT INTO chats (type, name) VALUES ('public', 'Общий чат')`);
  } else {
    await pool.query(`UPDATE chats SET name = 'Общий чат' WHERE type = 'public' AND name IS NULL`);
  }

  console.log('✅ База данных готова (ChatX Lite)');
}
initDB();

app.post('/auth', async (req, res) => {
  const { nick, pin } = req.body;
  if (!nick || nick.trim() === '' || !pin || pin.length !== 4 || !/^\d+$/.test(pin)) {
    return res.status(400).json({ success: false, error: 'Неверный ник или PIN (4 цифры)' });
  }
  const cleanNick = nick.trim();
  const existing = await pool.query('SELECT nick, pin_hash, badge FROM users WHERE nick = $1', [cleanNick]);
  if (existing.rows.length > 0) {
    const valid = await bcrypt.compare(pin, existing.rows[0].pin_hash);
    if (!valid) return res.json({ success: false, error: 'Неверный PIN' });
    const token = uuidv4();
    await pool.query('UPDATE users SET token = $1 WHERE nick = $2', [token, cleanNick]);
    return res.json({ success: true, nick: cleanNick, badge: existing.rows[0].badge || '', token });
  } else {
    const pinHash = await bcrypt.hash(pin, 10);
    const token = uuidv4();
    await pool.query('INSERT INTO users (nick, pin_hash, token, badge) VALUES ($1, $2, $3, $4)', [cleanNick, pinHash, token, '']);
    return res.json({ success: true, nick: cleanNick, badge: '', token });
  }
});

app.post('/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: false });
  const user = await pool.query('SELECT nick, badge FROM users WHERE token = $1', [token]);
  if (user.rows.length > 0) res.json({ success: true, nick: user.rows[0].nick, badge: user.rows[0].badge || '' });
  else res.json({ success: false });
});

app.post('/change-nick', async (req, res) => {
  const { token, newNick } = req.body;
  if (!token || !newNick || newNick.trim() === '') return res.status(400).json({ success: false, error: 'Данные неполные' });
  const user = await pool.query('SELECT nick FROM users WHERE token = $1', [token]);
  if (user.rows.length === 0) return res.json({ success: false, error: 'Сессия недействительна' });
  const oldNick = user.rows[0].nick;
  if (newNick === oldNick) return res.json({ success: true, newNick: oldNick });
  const existing = await pool.query('SELECT nick FROM users WHERE nick = $1', [newNick]);
  if (existing.rows.length > 0) return res.json({ success: false, error: 'Ник уже существует' });
  await pool.query('UPDATE users SET nick = $1 WHERE token = $2', [newNick, token]);
  await pool.query('UPDATE messages SET nick = $1 WHERE nick = $2', [newNick, oldNick]);
  await pool.query('UPDATE message_reactions SET nick = $1 WHERE nick = $2', [newNick, oldNick]);
  io.emit('nick changed', { oldNick, newNick });
  res.json({ success: true, newNick });
});

app.post('/change-pin', async (req, res) => {
  const { token, oldPin, newPin } = req.body;
  if (!token || !oldPin || !newPin || newPin.length !== 4 || !/^\d+$/.test(newPin)) return res.status(400).json({ success: false, error: 'Некорректные данные' });
  const user = await pool.query('SELECT pin_hash FROM users WHERE token = $1', [token]);
  if (user.rows.length === 0) return res.json({ success: false, error: 'Сессия недействительна' });
  const valid = await bcrypt.compare(oldPin, user.rows[0].pin_hash);
  if (!valid) return res.json({ success: false, error: 'Неверный старый PIN' });
  const newHash = await bcrypt.hash(newPin, 10);
  await pool.query('UPDATE users SET pin_hash = $1 WHERE token = $2', [newHash, token]);
  res.json({ success: true });
});

app.post('/update-badge', async (req, res) => {
  const { token, badge } = req.body;
  if (!token) return res.status(400).json({ success: false });
  await pool.query('UPDATE users SET badge = $1 WHERE token = $2', [badge || '', token]);
  res.json({ success: true });
});

app.delete('/delete-account', async (req, res) => {
  const { token, pin } = req.body;
  if (!token || !pin) return res.status(400).json({ success: false, error: 'Требуется PIN' });
  const user = await pool.query('SELECT nick, pin_hash FROM users WHERE token = $1', [token]);
  if (user.rows.length === 0) return res.json({ success: false, error: 'Сессия недействительна' });
  const valid = await bcrypt.compare(pin, user.rows[0].pin_hash);
  if (!valid) return res.json({ success: false, error: 'Неверный PIN' });
  await pool.query('DELETE FROM users WHERE nick = $1', [user.rows[0].nick]);
  res.json({ success: true });
});

app.get('/public-chat-id', async (req, res) => {
  const result = await pool.query(`SELECT id FROM chats WHERE type = 'public'`);
  if (result.rows.length) res.json({ chatId: result.rows[0].id });
  else res.status(500).json({ error: 'Нет публичного чата' });
});

app.get('/chat-messages', async (req, res) => {
  const { chat_id, nick } = req.query;
  if (!chat_id || !nick) return res.json([]);
  const result = await pool.query(`
    SELECT m.id, m.chat_id, m.nick, m.text, m.reply_to_id, m.edited, m.created_at,
           COALESCE(r.reactions, '[]'::json) as reactions,
           rep.nick as reply_nick, rep.text as reply_text,
           (SELECT array_agg(reaction) FROM message_reactions WHERE message_id = m.id AND nick = $2) as user_reactions,
           u.badge as user_badge
    FROM messages m
    LEFT JOIN users u ON m.nick = u.nick
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('reaction', reaction, 'count', cnt)) as reactions
      FROM (SELECT reaction, COUNT(*) as cnt FROM message_reactions WHERE message_id = m.id GROUP BY reaction) sub
    ) r ON true
    LEFT JOIN messages rep ON m.reply_to_id = rep.id
    WHERE m.chat_id = $1
    ORDER BY m.created_at ASC
  `, [chat_id, nick]);
  res.json(result.rows);
});

app.post('/chat-message', async (req, res) => {
  const { chat_id, nick, text, reply_to_id } = req.body;
  if (!chat_id || !nick) return res.status(400).json({ success: false });
  const result = await pool.query(
    `INSERT INTO messages (chat_id, nick, text, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [chat_id, nick, text || null, reply_to_id || null]
  );
  const newMsg = { id: result.rows[0].id, chat_id, nick, text, reply_to_id: reply_to_id || null, edited: false, created_at: result.rows[0].created_at, reactions: [], user_reactions: [] };
  if (reply_to_id) {
    const replyMsg = await pool.query('SELECT nick, text FROM messages WHERE id = $1', [reply_to_id]);
    if (replyMsg.rows.length) { newMsg.reply_nick = replyMsg.rows[0].nick; newMsg.reply_text = replyMsg.rows[0].text; }
  }
  io.to(`chat:${chat_id}`).emit('chat message received', newMsg);
  res.json({ success: true, message: newMsg });
});

app.post('/add-reaction', async (req, res) => {
  const { messageId, nick, reaction, isRoom } = req.body;
  if (isRoom) return res.status(400).json({ success: false });
  if (!messageId || !nick || !reaction) return res.status(400).json({ success: false });
  try {
    await pool.query(`INSERT INTO message_reactions (message_id, nick, reaction) VALUES ($1, $2, $3)`, [messageId, nick, reaction]);
    const reactionsRes = await pool.query(`SELECT reaction, COUNT(*) as count FROM message_reactions WHERE message_id = $1 GROUP BY reaction`, [messageId]);
    const reactions = reactionsRes.rows;
    const msg = await pool.query('SELECT chat_id FROM messages WHERE id = $1', [messageId]);
    if (msg.rows.length) io.to(`chat:${msg.rows[0].chat_id}`).emit('reaction updated', { messageId, reactions });
    res.json({ success: true, reactions });
  } catch (err) {
    if (err.code === '23505') {
      await pool.query(`DELETE FROM message_reactions WHERE message_id = $1 AND nick = $2 AND reaction = $3`, [messageId, nick, reaction]);
      const reactionsRes = await pool.query(`SELECT reaction, COUNT(*) as count FROM message_reactions WHERE message_id = $1 GROUP BY reaction`, [messageId]);
      const reactions = reactionsRes.rows;
      const msg = await pool.query('SELECT chat_id FROM messages WHERE id = $1', [messageId]);
      if (msg.rows.length) io.to(`chat:${msg.rows[0].chat_id}`).emit('reaction updated', { messageId, reactions });
      res.json({ success: true, reactions });
    } else res.status(500).json({ success: false });
  }
});

app.post('/delete-message', async (req, res) => {
  const { nick, messageId } = req.body;
  if (!nick || !messageId) return res.status(400).json({ success: false });
  const msg = await pool.query('SELECT nick, chat_id FROM messages WHERE id = $1', [messageId]);
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

  socket.on('user online', async (nick) => {
    currentNick = nick;
    const result = await pool.query(`SELECT id FROM chats WHERE type = 'public'`);
    if (result.rows.length) socket.join(`chat:${result.rows[0].id}`);
  });

  socket.on('join chat', (chatId) => { socket.join(`chat:${chatId}`); });

  socket.on('typing', ({ chatId, nick }) => { socket.to(`chat:${chatId}`).emit('user typing', { chatId, nick }); });
  socket.on('stop typing', ({ chatId }) => { socket.to(`chat:${chatId}`).emit('user stop typing', { chatId }); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
