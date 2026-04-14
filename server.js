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
  // Таблица users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      nick VARCHAR(50) UNIQUE NOT NULL,
      pin_hash TEXT NOT NULL,
      token TEXT UNIQUE,
      badge VARCHAR(10) DEFAULT '',
      description TEXT DEFAULT '',
      visibility VARCHAR(20) DEFAULT 'all',
      who_can_write VARCHAR(20) DEFAULT 'all',
      online_visible BOOLEAN DEFAULT true,
      who_can_voice VARCHAR(20) DEFAULT 'all',
      description_visible VARCHAR(20) DEFAULT 'all',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Удаляем колонку who_can_invite, если осталась
  try { await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS who_can_invite`); } catch (e) {}

  // Таблица chats (без owner_nick и типа 'group')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      type VARCHAR(20) NOT NULL CHECK (type IN ('public', 'private', 'notebook')),
      name VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  try { await pool.query(`ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_type_check`); } catch (e) {}
  try { await pool.query(`ALTER TABLE chats ADD CONSTRAINT chats_type_check CHECK (type IN ('public', 'private', 'notebook'))`); } catch (e) {}
  try { await pool.query(`ALTER TABLE chats DROP COLUMN IF EXISTS owner_nick`); } catch (e) {}

  // Таблица chat_participants
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_participants (
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      nick VARCHAR(50) REFERENCES users(nick) ON DELETE CASCADE,
      PRIMARY KEY (chat_id, nick)
    );
  `);

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
      duration INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Таблица message_reactions
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

  // Таблица contacts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      user_nick VARCHAR(50) NOT NULL REFERENCES users(nick) ON DELETE CASCADE,
      contact_nick VARCHAR(50) NOT NULL REFERENCES users(nick) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_nick, contact_nick)
    );
  `);

  // Таблица blocked_users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      user_nick VARCHAR(50) NOT NULL REFERENCES users(nick) ON DELETE CASCADE,
      blocked_nick VARCHAR(50) NOT NULL REFERENCES users(nick) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_nick, blocked_nick)
    );
  `);

  // Таблица deleted_chats
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_chats (
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      nick VARCHAR(50) REFERENCES users(nick) ON DELETE CASCADE,
      PRIMARY KEY (chat_id, nick)
    );
  `);

  // Удаляем таблицу group_participants, если осталась
  try { await pool.query(`DROP TABLE IF EXISTS group_participants CASCADE`); } catch (e) {}

  // Публичный чат
  const publicChat = await pool.query(`SELECT id FROM chats WHERE type = 'public'`);
  if (publicChat.rows.length === 0) {
    await pool.query(`INSERT INTO chats (type, name) VALUES ('public', 'Общий чат')`);
  } else {
    await pool.query(`UPDATE chats SET name = 'Общий чат' WHERE type = 'public' AND name IS NULL`);
  }

  console.log('✅ База данных готова');
}
initDB();

async function getOrCreateNotebook(nick) {
  let notebook = await pool.query(
    `SELECT c.id FROM chats c
     JOIN chat_participants cp ON cp.chat_id = c.id
     WHERE c.type = 'notebook' AND cp.nick = $1`,
    [nick]
  );
  if (notebook.rows.length === 0) {
    const newChat = await pool.query(`INSERT INTO chats (type, name) VALUES ('notebook', 'Блокнот') RETURNING id`);
    const chatId = newChat.rows[0].id;
    await pool.query(`INSERT INTO chat_participants (chat_id, nick) VALUES ($1, $2)`, [chatId, nick]);
    return chatId;
  }
  return notebook.rows[0].id;
}

// Эндпоинты
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
  const existing = await pool.query('SELECT nick, pin_hash, badge, description FROM users WHERE nick = $1', [cleanNick]);
  if (existing.rows.length > 0) {
    const valid = await bcrypt.compare(pin, existing.rows[0].pin_hash);
    if (!valid) return res.json({ success: false, error: 'Неверный PIN' });
    const token = uuidv4();
    await pool.query('UPDATE users SET token = $1 WHERE nick = $2', [token, cleanNick]);
    return res.json({ success: true, nick: cleanNick, badge: existing.rows[0].badge || '', description: existing.rows[0].description || '', token });
  } else {
    const pinHash = await bcrypt.hash(pin, 10);
    const token = uuidv4();
    try {
      await pool.query('INSERT INTO users (nick, pin_hash, token, badge, description) VALUES ($1, $2, $3, $4, $5)', [cleanNick, pinHash, token, '', '']);
      return res.json({ success: true, nick: cleanNick, badge: '', description: '', token });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(400).json({ success: false, error: 'Ник уже занят' });
      }
      throw err;
    }
  }
});

app.post('/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: false });
  const user = await pool.query('SELECT nick, badge, description FROM users WHERE token = $1', [token]);
  if (user.rows.length > 0) res.json({ success: true, nick: user.rows[0].nick, badge: user.rows[0].badge || '', description: user.rows[0].description || '' });
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
  await pool.query('UPDATE contacts SET user_nick = $1 WHERE user_nick = $2', [newNick, oldNick]);
  await pool.query('UPDATE contacts SET contact_nick = $1 WHERE contact_nick = $2', [newNick, oldNick]);
  await pool.query('UPDATE blocked_users SET user_nick = $1 WHERE user_nick = $2', [newNick, oldNick]);
  await pool.query('UPDATE blocked_users SET blocked_nick = $1 WHERE blocked_nick = $2', [newNick, oldNick]);
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

app.post('/update-description', async (req, res) => {
  const { token, description } = req.body;
  if (!token) return res.status(400).json({ success: false });
  await pool.query('UPDATE users SET description = $1 WHERE token = $2', [description || '', token]);
  res.json({ success: true });
});

app.post('/update-privacy', async (req, res) => {
  const { token, field, value } = req.body;
  if (!token || !field) return res.status(400).json({ success: false });
  const allowed = ['visibility', 'who_can_write', 'description_visible'];
  if (!allowed.includes(field)) return res.status(400).json({ success: false });
  await pool.query(`UPDATE users SET ${field} = $1 WHERE token = $2`, [value, token]);
  res.json({ success: true });
});

app.get('/privacy-settings', async (req, res) => {
  const { nick } = req.query;
  if (!nick) return res.json({});
  const user = await pool.query('SELECT visibility, who_can_write, description_visible FROM users WHERE nick = $1', [nick]);
  if (user.rows.length) res.json(user.rows[0]);
  else res.json({});
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

app.get('/contacts', async (req, res) => {
  const { nick } = req.query;
  if (!nick) return res.json([]);
  const result = await pool.query(`SELECT u.nick, u.badge FROM contacts c JOIN users u ON c.contact_nick = u.nick WHERE c.user_nick = $1 ORDER BY u.nick ASC`, [nick]);
  res.json(result.rows);
});

app.post('/contact-add', async (req, res) => {
  const { user, contact } = req.body;
  if (!user || !contact || user === contact) return res.status(400).json({ success: false });
  try {
    await pool.query(`INSERT INTO contacts (user_nick, contact_nick) VALUES ($1, $2)`, [user, contact]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') res.json({ success: false, error: 'Уже в контактах' });
    else res.status(500).json({ success: false });
  }
});

app.post('/contact-remove', async (req, res) => {
  const { user, contact } = req.body;
  if (!user || !contact) return res.status(400).json({ success: false });
  await pool.query(`DELETE FROM contacts WHERE user_nick = $1 AND contact_nick = $2`, [user, contact]);
  res.json({ success: true });
});

app.get('/contact-status', async (req, res) => {
  const { user, contact } = req.query;
  if (!user || !contact) return res.json({ inContacts: false });
  const result = await pool.query(`SELECT 1 FROM contacts WHERE user_nick = $1 AND contact_nick = $2`, [user, contact]);
  res.json({ inContacts: result.rows.length > 0 });
});

app.post('/block-user', async (req, res) => {
  const { user, blocked } = req.body;
  if (!user || !blocked) return res.status(400).json({ success: false });
  await pool.query(`INSERT INTO blocked_users (user_nick, blocked_nick) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user, blocked]);
  const chat = await pool.query(`SELECT c.id FROM chats c JOIN chat_participants cp1 ON cp1.chat_id = c.id AND cp1.nick = $1 JOIN chat_participants cp2 ON cp2.chat_id = c.id AND cp2.nick = $2 WHERE c.type = 'private'`, [user, blocked]);
  if (chat.rows.length > 0) await pool.query(`DELETE FROM chats WHERE id = $1`, [chat.rows[0].id]);
  res.json({ success: true });
});

app.post('/unblock-user', async (req, res) => {
  const { user, blocked } = req.body;
  if (!user || !blocked) return res.status(400).json({ success: false });
  await pool.query(`DELETE FROM blocked_users WHERE user_nick = $1 AND blocked_nick = $2`, [user, blocked]);
  res.json({ success: true });
});

app.get('/blocked-list', async (req, res) => {
  const { nick } = req.query;
  if (!nick) return res.json([]);
  const result = await pool.query(`SELECT blocked_nick FROM blocked_users WHERE user_nick = $1`, [nick]);
  res.json(result.rows);
});

app.get('/search-users', async (req, res) => {
  const { q, nick } = req.query;
  if (!q || !nick) return res.json([]);
  const result = await pool.query(`
    SELECT u.nick, u.badge FROM users u
    WHERE u.nick ILIKE $1 AND u.nick != $2
      AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.user_nick = $2 AND b.blocked_nick = u.nick) OR (b.user_nick = u.nick AND b.blocked_nick = $2))
      AND (u.visibility = 'all' OR (u.visibility = 'contacts' AND EXISTS (SELECT 1 FROM contacts c WHERE c.user_nick = u.nick AND c.contact_nick = $2)) OR u.nick = $2)
    LIMIT 20`, [`%${q}%`, nick]);
  res.json(result.rows);
});

app.get('/user-profile', async (req, res) => {
  const { nick } = req.query;
  if (!nick) return res.json({});
  const user = await pool.query('SELECT nick, badge, description FROM users WHERE nick = $1', [nick]);
  if (user.rows.length) res.json(user.rows[0]);
  else res.json({});
});

app.get('/chats', async (req, res) => {
  const { nick } = req.query;
  if (!nick) return res.json([]);
  
  const publicChat = await pool.query(`SELECT id, name FROM chats WHERE type = 'public'`);
  const publicChatId = publicChat.rows[0]?.id;
  
  const notebookId = await getOrCreateNotebook(nick);
  
  const privateChats = await pool.query(`
    SELECT c.id, c.type, u.nick as other_nick, u.badge as other_badge
    FROM chats c
    JOIN chat_participants cp1 ON cp1.chat_id = c.id AND cp1.nick = $1
    JOIN chat_participants cp2 ON cp2.chat_id = c.id AND cp2.nick != $1
    JOIN users u ON u.nick = cp2.nick
    WHERE c.type = 'private'
      AND NOT EXISTS (SELECT 1 FROM deleted_chats dc WHERE dc.chat_id = c.id AND dc.nick = $1)
      AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.user_nick = $1 AND b.blocked_nick = cp2.nick) OR (b.user_nick = cp2.nick AND b.blocked_nick = $1))
  `, [nick]);

  const chats = [
    { id: publicChatId, type: 'public', name: publicChat.rows[0]?.name || 'Общий чат', other: null }
  ];
  if (notebookId) {
    chats.push({ id: notebookId, type: 'notebook', name: 'Блокнот', other: null });
  }
  privateChats.rows.forEach(row => {
    chats.push({
      id: row.id,
      type: row.type,
      name: row.other_nick,
      other: row.other_nick
    });
  });
  
  for (let chat of chats) {
    const lastMsg = await pool.query(`
      SELECT id, text, nick, type, file_name, created_at FROM messages
      WHERE chat_id = $1
      ORDER BY created_at DESC LIMIT 1
    `, [chat.id]);
    chat.last_message = lastMsg.rows[0] || null;
  }
  
  chats.sort((a, b) => {
    if (a.type === 'public') return -1;
    if (b.type === 'public') return 1;
    if (a.type === 'notebook') return -1;
    if (b.type === 'notebook') return 1;
    const aTime = a.last_message ? new Date(a.last_message.created_at).getTime() : 0;
    const bTime = b.last_message ? new Date(b.last_message.created_at).getTime() : 0;
    return bTime - aTime;
  });
  
  res.json(chats);
});

app.post('/create-private-chat', async (req, res) => {
  const { user1, user2 } = req.body;
  if (!user1 || !user2 || user1 === user2) return res.status(400).json({ success: false });
  const target = await pool.query(`SELECT who_can_write FROM users WHERE nick = $1`, [user2]);
  if (target.rows.length > 0) {
    const setting = target.rows[0].who_can_write;
    if (setting === 'contacts') {
      const contact = await pool.query(`SELECT 1 FROM contacts WHERE user_nick = $1 AND contact_nick = $2`, [user2, user1]);
      if (contact.rows.length === 0) return res.status(403).json({ success: false, error: 'Пользователь ограничил круг лиц, которые могут ему написать' });
    } else if (setting === 'nobody') return res.status(403).json({ success: false, error: 'Пользователь ограничил круг лиц, которые могут ему написать' });
  }
  const blocked = await pool.query(`SELECT 1 FROM blocked_users WHERE (user_nick = $1 AND blocked_nick = $2) OR (user_nick = $2 AND blocked_nick = $1)`, [user1, user2]);
  if (blocked.rows.length > 0) return res.status(403).json({ success: false, error: 'Невозможно написать' });
  const existing = await pool.query(`SELECT c.id FROM chats c JOIN chat_participants cp1 ON cp1.chat_id = c.id AND cp1.nick = $1 JOIN chat_participants cp2 ON cp2.chat_id = c.id AND cp2.nick = $2 WHERE c.type = 'private'`, [user1, user2]);
  if (existing.rows.length > 0) {
    const deleted = await pool.query(`SELECT 1 FROM deleted_chats WHERE chat_id = $1 AND nick = $2`, [existing.rows[0].id, user1]);
    if (deleted.rows.length > 0) await pool.query(`DELETE FROM deleted_chats WHERE chat_id = $1 AND nick = $2`, [existing.rows[0].id, user1]);
    return res.json({ success: true, chatId: existing.rows[0].id });
  }
  const newChat = await pool.query(`INSERT INTO chats (type) VALUES ('private') RETURNING id`);
  const chatId = newChat.rows[0].id;
  await pool.query(`INSERT INTO chat_participants (chat_id, nick) VALUES ($1, $2), ($1, $3)`, [chatId, user1, user2]);
  res.json({ success: true, chatId });
});

app.post('/delete-chat', async (req, res) => {
  const { chat_id, nick } = req.body;
  if (!chat_id || !nick) return res.status(400).json({ success: false });
  await pool.query(`INSERT INTO deleted_chats (chat_id, nick) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [chat_id, nick]);
  res.json({ success: true });
});

app.get('/chat-messages', async (req, res) => {
  const { chat_id, nick } = req.query;
  if (!chat_id || !nick) return res.json([]);
  const result = await pool.query(`
    SELECT m.id, m.chat_id, m.nick, m.text, m.reply_to_id, m.edited, m.type, m.file_url, m.file_name, m.file_size, m.duration, m.created_at,
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
  const { chat_id, nick, text, reply_to_id, type, file_url, file_name, file_size, duration } = req.body;
  if (!chat_id || !nick) return res.status(400).json({ success: false });
  const result = await pool.query(
    `INSERT INTO messages (chat_id, nick, text, reply_to_id, type, file_url, file_name, file_size, duration) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
    [chat_id, nick, text || null, reply_to_id || null, type || 'text', file_url, file_name, file_size, duration]
  );
  const newMsg = { id: result.rows[0].id, chat_id, nick, text, reply_to_id: reply_to_id || null, edited: false, type: type || 'text', file_url, file_name, file_size, duration, created_at: result.rows[0].created_at, reactions: [], user_reactions: [] };
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

const usersInChat = new Map();

io.on('connection', (socket) => {
  let currentNick = null;

  socket.on('user online', async (nick) => {
    currentNick = nick;
    const chats = await pool.query(`SELECT c.id FROM chats c JOIN chat_participants cp ON cp.chat_id = c.id WHERE cp.nick = $1 UNION SELECT id FROM chats WHERE type = 'public'`, [nick]);
    chats.rows.forEach(row => socket.join(`chat:${row.id}`));
  });

  socket.on('join chat', (chatId) => {
    socket.join(`chat:${chatId}`);
    if (currentNick) { if (!usersInChat.has(chatId)) usersInChat.set(chatId, new Set()); usersInChat.get(chatId).add(currentNick); io.to(`chat:${chatId}`).emit('user joined chat', { chatId, nick: currentNick }); }
  });

  socket.on('leave chat', (chatId) => {
    socket.leave(`chat:${chatId}`);
    if (currentNick && usersInChat.has(chatId)) { usersInChat.get(chatId).delete(currentNick); io.to(`chat:${chatId}`).emit('user left chat', { chatId, nick: currentNick }); }
  });

  socket.on('typing', ({ chatId, nick }) => { socket.to(`chat:${chatId}`).emit('user typing', { chatId, nick }); });
  socket.on('stop typing', ({ chatId }) => { socket.to(`chat:${chatId}`).emit('user stop typing', { chatId }); });

  socket.on('disconnect', () => {
    if (currentNick) {
      for (const [chatId, users] of usersInChat.entries()) {
        if (users.has(currentNick)) { users.delete(currentNick); io.to(`chat:${chatId}`).emit('user left chat', { chatId, nick: currentNick }); }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));