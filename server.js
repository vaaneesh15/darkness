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
  // Пользователи
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

  // Чаты (общий, личные, блокноты)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      type VARCHAR(20) NOT NULL CHECK (type IN ('public', 'private', 'notebook')),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Участники чатов
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_participants (
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      full_nick VARCHAR(55) REFERENCES users(full_nick) ON DELETE CASCADE,
      PRIMARY KEY (chat_id, full_nick)
    );
  `);

  // Сообщения
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      full_nick VARCHAR(55) NOT NULL,
      text TEXT NOT NULL,
      reply_to_id INTEGER DEFAULT NULL,
      edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Реакции
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      full_nick VARCHAR(55) NOT NULL,
      reaction VARCHAR(10) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(message_id, full_nick, reaction)
    );
  `);

  // Друзья
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id SERIAL PRIMARY KEY,
      user_full_nick VARCHAR(55) NOT NULL REFERENCES users(full_nick) ON DELETE CASCADE,
      friend_full_nick VARCHAR(55) NOT NULL REFERENCES users(full_nick) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'accepted')),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_full_nick, friend_full_nick)
    );
  `);

  // Удалённые чаты (для мягкого удаления)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_chats (
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      full_nick VARCHAR(55) REFERENCES users(full_nick) ON DELETE CASCADE,
      PRIMARY KEY (chat_id, full_nick)
    );
  `);

  // Создаём публичный чат, если его нет
  const publicChat = await pool.query(`SELECT id FROM chats WHERE type = 'public'`);
  if (publicChat.rows.length === 0) {
    await pool.query(`INSERT INTO chats (type) VALUES ('public')`);
  }

  console.log('✅ База данных готова (использованы существующие таблицы)');
}
initDB();

function generateTag() {
  return '#' + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
}

async function isFullNickUnique(fullNick) {
  const res = await pool.query('SELECT id FROM users WHERE full_nick = $1', [fullNick]);
  return res.rows.length === 0;
}

async function getOrCreateNotebook(fullNick) {
  let notebook = await pool.query(
    `SELECT c.id FROM chats c
     JOIN chat_participants cp ON cp.chat_id = c.id
     WHERE c.type = 'notebook' AND cp.full_nick = $1`,
    [fullNick]
  );
  if (notebook.rows.length === 0) {
    const newChat = await pool.query(
      `INSERT INTO chats (type) VALUES ('notebook') RETURNING id`
    );
    const chatId = newChat.rows[0].id;
    await pool.query(
      `INSERT INTO chat_participants (chat_id, full_nick) VALUES ($1, $2)`,
      [chatId, fullNick]
    );
    return chatId;
  }
  return notebook.rows[0].id;
}

// --- API ---
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
    let tag, full_nick, unique = false, attempts = 0;
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
  await pool.query('UPDATE message_reactions SET full_nick = $1 WHERE full_nick = $2', [newFullNick, oldFullNick]);
  await pool.query('UPDATE friendships SET user_full_nick = $1 WHERE user_full_nick = $2', [newFullNick, oldFullNick]);
  await pool.query('UPDATE friendships SET friend_full_nick = $1 WHERE friend_full_nick = $2', [newFullNick, oldFullNick]);
  io.emit('nick changed', { oldFullNick, newFullNick });
  res.json({ success: true, newFullNick });
});

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

app.delete('/delete-account', async (req, res) => {
  const { token, pin } = req.body;
  if (!token || !pin) return res.status(400).json({ success: false, error: 'Требуется PIN' });
  const user = await pool.query('SELECT full_nick, pin_hash FROM users WHERE token = $1', [token]);
  if (user.rows.length === 0) return res.json({ success: false, error: 'Сессия недействительна' });
  const valid = await bcrypt.compare(pin, user.rows[0].pin_hash);
  if (!valid) return res.json({ success: false, error: 'Неверный PIN' });
  await pool.query('DELETE FROM users WHERE full_nick = $1', [user.rows[0].full_nick]);
  res.json({ success: true });
});

// Друзья
app.get('/friends', async (req, res) => {
  const { full_nick, filter } = req.query;
  if (!full_nick) return res.json([]);
  let query;
  if (filter === 'accepted') {
    query = `
      SELECT u.full_nick, u.nick, u.tag
      FROM friendships f
      JOIN users u ON (f.user_full_nick = u.full_nick OR f.friend_full_nick = u.full_nick)
      WHERE (f.user_full_nick = $1 OR f.friend_full_nick = $1)
        AND f.status = 'accepted'
        AND u.full_nick != $1
    `;
  } else if (filter === 'pending_incoming') {
    query = `
      SELECT u.full_nick, u.nick, u.tag
      FROM friendships f
      JOIN users u ON f.user_full_nick = u.full_nick
      WHERE f.friend_full_nick = $1 AND f.status = 'pending'
    `;
  } else if (filter === 'pending_outgoing') {
    query = `
      SELECT u.full_nick, u.nick, u.tag
      FROM friendships f
      JOIN users u ON f.friend_full_nick = u.full_nick
      WHERE f.user_full_nick = $1 AND f.status = 'pending'
    `;
  } else {
    return res.json([]);
  }
  const result = await pool.query(query, [full_nick]);
  res.json(result.rows);
});

app.post('/friend-request', async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || from === to) return res.status(400).json({ success: false });
  try {
    await pool.query(
      `INSERT INTO friendships (user_full_nick, friend_full_nick, status) VALUES ($1, $2, 'pending')`,
      [from, to]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') res.json({ success: false, error: 'Запрос уже существует' });
    else res.status(500).json({ success: false });
  }
});

app.post('/friend-respond', async (req, res) => {
  const { full_nick, from, action } = req.body;
  if (!full_nick || !from) return res.status(400).json({ success: false });
  if (action === 'accept') {
    await pool.query(
      `UPDATE friendships SET status = 'accepted' WHERE user_full_nick = $1 AND friend_full_nick = $2`,
      [from, full_nick]
    );
  } else {
    await pool.query(
      `DELETE FROM friendships WHERE user_full_nick = $1 AND friend_full_nick = $2`,
      [from, full_nick]
    );
  }
  res.json({ success: true });
});

// Статус дружбы
app.get('/friendship-status', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.json({ status: 'none' });
  const result = await pool.query(
    `SELECT status, user_full_nick FROM friendships WHERE (user_full_nick = $1 AND friend_full_nick = $2) OR (user_full_nick = $2 AND friend_full_nick = $1)`,
    [from, to]
  );
  if (result.rows.length === 0) return res.json({ status: 'none' });
  const row = result.rows[0];
  const status = row.status;
  const isOutgoing = row.user_full_nick === from;
  res.json({ status, isOutgoing });
});

// Поиск пользователей
app.get('/search-users', async (req, res) => {
  const { q, full_nick } = req.query;
  if (!q || !full_nick) return res.json([]);
  const result = await pool.query(
    `SELECT full_nick, nick, tag FROM users
     WHERE (nick ILIKE $1 OR full_nick ILIKE $1) AND full_nick != $2
     LIMIT 20`,
    [`%${q}%`, full_nick]
  );
  res.json(result.rows);
});

// Чаты
app.get('/chats', async (req, res) => {
  const { full_nick } = req.query;
  if (!full_nick) return res.json([]);
  
  const publicChat = await pool.query(`SELECT id FROM chats WHERE type = 'public'`);
  const publicChatId = publicChat.rows[0]?.id;
  
  const notebookId = await getOrCreateNotebook(full_nick);
  
  const privateChats = await pool.query(`
    SELECT c.id, c.type, u.full_nick as other_full_nick, u.nick, u.tag
    FROM chats c
    JOIN chat_participants cp1 ON cp1.chat_id = c.id AND cp1.full_nick = $1
    JOIN chat_participants cp2 ON cp2.chat_id = c.id AND cp2.full_nick != $1
    JOIN users u ON u.full_nick = cp2.full_nick
    WHERE c.type = 'private'
      AND NOT EXISTS (SELECT 1 FROM deleted_chats dc WHERE dc.chat_id = c.id AND dc.full_nick = $1)
  `, [full_nick]);
  
  const chats = [
    { id: publicChatId, type: 'public', name: 'Общий чат', other: null },
    { id: notebookId, type: 'notebook', name: 'Блокнот', other: null }
  ];
  privateChats.rows.forEach(row => {
    chats.push({
      id: row.id,
      type: 'private',
      name: `${row.nick}${row.tag}`,
      other: row.other_full_nick
    });
  });
  
  for (let chat of chats) {
    const lastMsg = await pool.query(`
      SELECT text, full_nick, created_at FROM messages
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
  const existing = await pool.query(`
    SELECT c.id FROM chats c
    JOIN chat_participants cp1 ON cp1.chat_id = c.id AND cp1.full_nick = $1
    JOIN chat_participants cp2 ON cp2.chat_id = c.id AND cp2.full_nick = $2
    WHERE c.type = 'private'
  `, [user1, user2]);
  if (existing.rows.length > 0) {
    return res.json({ success: true, chatId: existing.rows[0].id });
  }
  const newChat = await pool.query(`INSERT INTO chats (type) VALUES ('private') RETURNING id`);
  const chatId = newChat.rows[0].id;
  await pool.query(`INSERT INTO chat_participants (chat_id, full_nick) VALUES ($1, $2), ($1, $3)`, [chatId, user1, user2]);
  res.json({ success: true, chatId });
});

app.post('/delete-chat', async (req, res) => {
  const { chat_id, full_nick } = req.body;
  if (!chat_id || !full_nick) return res.status(400).json({ success: false });
  await pool.query(
    `INSERT INTO deleted_chats (chat_id, full_nick) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [chat_id, full_nick]
  );
  res.json({ success: true });
});

app.get('/chat-messages', async (req, res) => {
  const { chat_id, full_nick } = req.query;
  if (!chat_id || !full_nick) return res.json([]);
  const result = await pool.query(`
    SELECT m.id, m.chat_id, m.full_nick, m.text, m.reply_to_id, m.edited, m.created_at,
           COALESCE(r.reactions, '[]'::json) as reactions,
           rep.full_nick as reply_nick, rep.text as reply_text,
           (SELECT array_agg(reaction) FROM message_reactions WHERE message_id = m.id AND full_nick = $2) as user_reactions
    FROM messages m
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('reaction', reaction, 'count', cnt)) as reactions
      FROM (
        SELECT reaction, COUNT(*) as cnt
        FROM message_reactions
        WHERE message_id = m.id
        GROUP BY reaction
      ) sub
    ) r ON true
    LEFT JOIN messages rep ON m.reply_to_id = rep.id
    WHERE m.chat_id = $1
    ORDER BY m.created_at ASC
  `, [chat_id, full_nick]);
  res.json(result.rows);
});

app.post('/chat-message', async (req, res) => {
  const { chat_id, full_nick, text, reply_to_id } = req.body;
  if (!chat_id || !full_nick || !text?.trim()) return res.status(400).json({ success: false });
  const result = await pool.query(
    'INSERT INTO messages (chat_id, full_nick, text, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
    [chat_id, full_nick, text.trim(), reply_to_id || null]
  );
  const newMsg = {
    id: result.rows[0].id,
    chat_id,
    full_nick,
    text: text.trim(),
    reply_to_id: reply_to_id || null,
    edited: false,
    created_at: result.rows[0].created_at,
    reactions: [],
    user_reactions: []
  };
  if (reply_to_id) {
    const replyMsg = await pool.query('SELECT full_nick, text FROM messages WHERE id = $1', [reply_to_id]);
    if (replyMsg.rows.length) {
      newMsg.reply_nick = replyMsg.rows[0].full_nick;
      newMsg.reply_text = replyMsg.rows[0].text;
    }
  }
  io.to(`chat:${chat_id}`).emit('chat message received', newMsg);
  res.json({ success: true, message: newMsg });
});

app.post('/add-reaction', async (req, res) => {
  const { messageId, full_nick, reaction, isRoom } = req.body;
  if (isRoom) return res.status(400).json({ success: false });
  if (!messageId || !full_nick || !reaction) return res.status(400).json({ success: false });
  try {
    await pool.query(
      `INSERT INTO message_reactions (message_id, full_nick, reaction) VALUES ($1, $2, $3)`,
      [messageId, full_nick, reaction]
    );
    const reactionsRes = await pool.query(
      `SELECT reaction, COUNT(*) as count FROM message_reactions WHERE message_id = $1 GROUP BY reaction`,
      [messageId]
    );
    const reactions = reactionsRes.rows;
    const msg = await pool.query('SELECT chat_id FROM messages WHERE id = $1', [messageId]);
    if (msg.rows.length) {
      io.to(`chat:${msg.rows[0].chat_id}`).emit('reaction updated', { messageId, reactions });
    }
    res.json({ success: true, reactions });
  } catch (err) {
    if (err.code === '23505') {
      await pool.query(
        `DELETE FROM message_reactions WHERE message_id = $1 AND full_nick = $2 AND reaction = $3`,
        [messageId, full_nick, reaction]
      );
      const reactionsRes = await pool.query(
        `SELECT reaction, COUNT(*) as count FROM message_reactions WHERE message_id = $1 GROUP BY reaction`,
        [messageId]
      );
      const reactions = reactionsRes.rows;
      const msg = await pool.query('SELECT chat_id FROM messages WHERE id = $1', [messageId]);
      if (msg.rows.length) {
        io.to(`chat:${msg.rows[0].chat_id}`).emit('reaction updated', { messageId, reactions });
      }
      res.json({ success: true, reactions });
    } else {
      res.status(500).json({ success: false });
    }
  }
});

app.post('/delete-message', async (req, res) => {
  const { full_nick, messageId } = req.body;
  if (!full_nick || !messageId) return res.status(400).json({ success: false });
  const msg = await pool.query('SELECT full_nick, chat_id FROM messages WHERE id = $1', [messageId]);
  if (msg.rows.length === 0) return res.json({ success: false });
  if (msg.rows[0].full_nick !== full_nick) return res.json({ success: false });
  const result = await pool.query('DELETE FROM messages WHERE id = $1 RETURNING id, chat_id', [messageId]);
  if (result.rowCount > 0) {
    io.to(`chat:${result.rows[0].chat_id}`).emit('message deleted', messageId);
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.post('/edit-message', async (req, res) => {
  const { messageId, full_nick, newText } = req.body;
  if (!messageId || !full_nick || !newText?.trim()) return res.status(400).json({ success: false });
  const result = await pool.query(
    'UPDATE messages SET text = $1, edited = TRUE WHERE id = $2 AND full_nick = $3 RETURNING id, chat_id',
    [newText.trim(), messageId, full_nick]
  );
  if (result.rowCount > 0) {
    io.to(`chat:${result.rows[0].chat_id}`).emit('message edited', { messageId, newText: newText.trim() });
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// Онлайн статус
const onlineUsers = new Map();

io.on('connection', (socket) => {
  let currentFullNick = null;

  socket.on('user online', async (full_nick) => {
    currentFullNick = full_nick;
    if (!onlineUsers.has(full_nick)) onlineUsers.set(full_nick, new Set());
    onlineUsers.get(full_nick).add(socket.id);
    io.emit('online status', { full_nick, online: true });
    
    const chats = await pool.query(`
      SELECT c.id FROM chats c
      JOIN chat_participants cp ON cp.chat_id = c.id
      WHERE cp.full_nick = $1
      UNION
      SELECT id FROM chats WHERE type = 'public'
    `, [full_nick]);
    chats.rows.forEach(row => socket.join(`chat:${row.id}`));
  });

  socket.on('join chat', (chatId) => {
    socket.join(`chat:${chatId}`);
  });

  socket.on('leave chat', (chatId) => {
    socket.leave(`chat:${chatId}`);
  });

  socket.on('typing', ({ chatId, full_nick }) => {
    socket.to(`chat:${chatId}`).emit('user typing', { chatId, full_nick });
  });

  socket.on('stop typing', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('user stop typing', { chatId });
  });

  socket.on('disconnect', () => {
    if (currentFullNick) {
      const sockets = onlineUsers.get(currentFullNick);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(currentFullNick);
          io.emit('online status', { full_nick: currentFullNick, online: false });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
