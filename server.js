const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

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

// ========== ONESIGNAL (APP API KEY) ==========
const ONESIGNAL_APP_ID = '22366383-4ee8-4a91-b727-1c11e6bdc218';
// Используем ваш App API Key (начинается с os_v2_app_...)
const ONESIGNAL_API_KEY = 'os_v2_app_ei3gha2o5bfjdnzhdqi6npocddbjq34lgqau4puyxuwqha52uog4f4hblgnplww65zzid2uneqn3nfkoxigordrzcjzwzedh6qtkd5a';

const CHATS = [
  { id: 1, name: "Общий чат" },
  { id: 2, name: "Чат 1" },
  { id: 3, name: "Чат 2" }
];

// Функция отправки уведомления через OneSignal
async function sendOneSignalNotification(title, message, excludeUserId = null) {
  const data = {
    app_id: ONESIGNAL_APP_ID,
    contents: { en: message },
    headings: { en: title },
    included_segments: ['Subscribed Users']
  };
  // Исключаем отправителя (если передан external_user_id)
  if (excludeUserId) {
    data.filters = [
      { field: 'tag', key: 'external_user_id', relation: '!=', value: excludeUserId }
    ];
  }
  try {
    const response = await axios.post('https://onesignal.com/api/v1/notifications', data, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${ONESIGNAL_API_KEY}`
      }
    });
    console.log(`✅ Уведомление отправлено: ${title}`, response.data.id);
  } catch (err) {
    console.error('❌ Ошибка отправки уведомления:', err.response?.data || err.message);
  }
}

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
    CREATE TABLE IF NOT EXISTS global_chat_messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      full_nick VARCHAR(55) NOT NULL,
      text TEXT NOT NULL,
      reply_to_id INTEGER DEFAULT NULL,
      edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS global_chat_reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES global_chat_messages(id) ON DELETE CASCADE,
      full_nick VARCHAR(55) NOT NULL,
      reaction VARCHAR(10) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(message_id, full_nick, reaction)
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
  await pool.query('UPDATE global_chat_messages SET full_nick = $1 WHERE full_nick = $2', [newFullNick, oldFullNick]);
  await pool.query('UPDATE global_chat_reactions SET full_nick = $1 WHERE full_nick = $2', [newFullNick, oldFullNick]);
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

app.get('/chat-messages', async (req, res) => {
  const { chatId, full_nick } = req.query;
  if (!chatId || !full_nick) return res.status(400).json([]);
  const result = await pool.query(`
    SELECT m.id, m.full_nick, m.text, m.reply_to_id, m.edited, m.created_at,
           COALESCE(r.reactions, '[]'::json) as reactions,
           rep.full_nick as reply_nick, rep.text as reply_text,
           (SELECT array_agg(reaction) FROM global_chat_reactions WHERE message_id = m.id AND full_nick = $2) as user_reactions
    FROM global_chat_messages m
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('reaction', reaction, 'count', cnt)) as reactions
      FROM (
        SELECT reaction, COUNT(*) as cnt
        FROM global_chat_reactions
        WHERE message_id = m.id
        GROUP BY reaction
      ) sub
    ) r ON true
    LEFT JOIN global_chat_messages rep ON m.reply_to_id = rep.id
    WHERE m.chat_id = $1
    ORDER BY m.created_at ASC
  `, [chatId, full_nick]);
  res.json(result.rows);
});

app.post('/add-chat-reaction', async (req, res) => {
  const { messageId, full_nick, reaction, chatId } = req.body;
  if (!messageId || !full_nick || !reaction) return res.status(400).json({ success: false });
  try {
    await pool.query(
      `INSERT INTO global_chat_reactions (message_id, full_nick, reaction) VALUES ($1, $2, $3)`,
      [messageId, full_nick, reaction]
    );
    const reactionsRes = await pool.query(
      `SELECT reaction, COUNT(*) as count FROM global_chat_reactions WHERE message_id = $1 GROUP BY reaction`,
      [messageId]
    );
    const reactions = reactionsRes.rows;
    io.to(`chat_${chatId}`).emit('chat reaction updated', { chatId, messageId, reactions });
    res.json({ success: true, reactions });
  } catch (err) {
    if (err.code === '23505') {
      await pool.query(
        `DELETE FROM global_chat_reactions WHERE message_id = $1 AND full_nick = $2 AND reaction = $3`,
        [messageId, full_nick, reaction]
      );
      const reactionsRes = await pool.query(
        `SELECT reaction, COUNT(*) as count FROM global_chat_reactions WHERE message_id = $1 GROUP BY reaction`,
        [messageId]
      );
      const reactions = reactionsRes.rows;
      io.to(`chat_${chatId}`).emit('chat reaction updated', { chatId, messageId, reactions });
      res.json({ success: true, reactions });
    } else {
      res.status(500).json({ success: false });
    }
  }
});

app.post('/delete-chat-message', async (req, res) => {
  const { full_nick, messageId, chatId } = req.body;
  if (!full_nick || !messageId || !chatId) return res.status(400).json({ success: false });
  const msg = await pool.query('SELECT full_nick FROM global_chat_messages WHERE id = $1', [messageId]);
  if (msg.rows.length === 0) return res.json({ success: false });
  if (msg.rows[0].full_nick !== full_nick) return res.json({ success: false });
  const result = await pool.query('DELETE FROM global_chat_messages WHERE id = $1 RETURNING id', [messageId]);
  if (result.rowCount > 0) {
    io.to(`chat_${chatId}`).emit('chat message deleted', { chatId, messageId });
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.post('/edit-chat-message', async (req, res) => {
  const { messageId, full_nick, newText, chatId } = req.body;
  if (!messageId || !full_nick || !newText || newText.trim() === '') {
    return res.status(400).json({ success: false });
  }
  const result = await pool.query(
    'UPDATE global_chat_messages SET text = $1, edited = TRUE WHERE id = $2 AND full_nick = $3 RETURNING id',
    [newText.trim(), messageId, full_nick]
  );
  if (result.rowCount > 0) {
    io.to(`chat_${chatId}`).emit('chat message edited', { chatId, messageId, newText: newText.trim() });
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

const onlineUsers = new Set();
io.on('connection', (socket) => {
  let currentFullNick = null;

  socket.on('user online', (full_nick) => {
    currentFullNick = full_nick;
    onlineUsers.add(full_nick);
    io.emit('online count', onlineUsers.size);
  });

  socket.on('disconnect', () => {
    if (currentFullNick) {
      onlineUsers.delete(currentFullNick);
      io.emit('online count', onlineUsers.size);
    }
  });

  socket.on('join chat', (chatId) => {
    socket.join(`chat_${chatId}`);
  });
  socket.on('leave chat', (chatId) => {
    socket.leave(`chat_${chatId}`);
  });

  socket.on('join typing chat', (chatId) => {
    socket.join(`typing_chat_${chatId}`);
  });
  socket.on('leave typing chat', (chatId) => {
    socket.leave(`typing_chat_${chatId}`);
  });
  socket.on('chat typing', ({ chatId, full_nick }) => {
    socket.to(`chat_${chatId}`).emit('chat typing', { chatId, full_nick });
  });
  socket.on('chat stop typing', ({ chatId }) => {
    socket.to(`chat_${chatId}`).emit('chat stop typing', { chatId });
  });

  socket.on('new chat message', async (data) => {
    const { chatId, full_nick, text, reply_to_id } = data;
    if (!chatId || !full_nick || !text || text.trim() === '') return;
    const result = await pool.query(
      'INSERT INTO global_chat_messages (chat_id, full_nick, text, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
      [chatId, full_nick, text.trim(), reply_to_id || null]
    );
    const newMsg = {
      id: result.rows[0].id,
      full_nick,
      text: text.trim(),
      reply_to_id: reply_to_id || null,
      edited: false,
      created_at: result.rows[0].created_at,
      reactions: [],
      user_reactions: []
    };
    if (reply_to_id) {
      const replyMsg = await pool.query('SELECT full_nick, text FROM global_chat_messages WHERE id = $1', [reply_to_id]);
      if (replyMsg.rows.length) {
        newMsg.reply_nick = replyMsg.rows[0].full_nick;
        newMsg.reply_text = replyMsg.rows[0].text;
      }
    }
    io.to(`chat_${chatId}`).emit('chat message received', { chatId, message: newMsg });

    // Отправка уведомления через OneSignal (исключая отправителя)
    const chatName = CHATS.find(c => c.id === chatId)?.name || `Чат ${chatId}`;
    await sendOneSignalNotification(
      `Новое сообщение в ${chatName}`,
      `${full_nick}: ${text.substring(0, 100)}`,
      full_nick
    );
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));