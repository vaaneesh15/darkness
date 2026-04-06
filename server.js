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
  // Таблица пользователей
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
  // Добавляем колонку is_admin, если её нет
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;`);
  
  // Таблица сообщений (общий чат)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      full_nick VARCHAR(55) NOT NULL,
      text TEXT NOT NULL,
      edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Таблица лайков (общий чат)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS likes (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      full_nick VARCHAR(55) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(message_id, full_nick)
    );
  `);
  // Таблица приватных комнат
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      created_by VARCHAR(55) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Таблица участников приватных комнат
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_members (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      full_nick VARCHAR(55) NOT NULL,
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(room_id, full_nick)
    );
  `);
  // Таблица сообщений в приватных комнатах
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_messages (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      full_nick VARCHAR(55) NOT NULL,
      text TEXT NOT NULL,
      edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Таблица лайков в приватных комнатах
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_likes (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
      full_nick VARCHAR(55) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(message_id, full_nick)
    );
  `);
  // Создаём админа по умолчанию (Ваниш#131), если его нет
  const adminFull = 'Ваниш#131';
  const adminNick = 'Ваниш';
  const adminTag = '#131';
  const existingAdmin = await pool.query('SELECT id FROM users WHERE full_nick = $1', [adminFull]);
  if (existingAdmin.rows.length === 0) {
    const pinHash = await bcrypt.hash('0000', 10);
    const token = uuidv4();
    await pool.query(
      'INSERT INTO users (nick, tag, full_nick, pin_hash, token, is_admin) VALUES ($1, $2, $3, $4, $5, $6)',
      [adminNick, adminTag, adminFull, pinHash, token, true]
    );
    console.log('✅ Администратор Ваниш#131 создан (PIN: 0000)');
  } else {
    // Убедимся, что у него есть права админа
    await pool.query('UPDATE users SET is_admin = TRUE WHERE full_nick = $1', [adminFull]);
  }
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

async function isAdmin(full_nick) {
  const res = await pool.query('SELECT is_admin FROM users WHERE full_nick = $1', [full_nick]);
  return res.rows.length > 0 && res.rows[0].is_admin;
}

// Авторизация (с PIN)
app.post('/auth', async (req, res) => {
  const { nick, pin } = req.body;
  if (!nick || nick.trim() === '' || !pin || pin.length !== 4 || !/^\d+$/.test(pin)) {
    return res.status(400).json({ success: false, error: 'Неверный ник или PIN (4 цифры)' });
  }
  const cleanNick = nick.trim();
  const existing = await pool.query('SELECT id, full_nick, pin_hash, is_admin FROM users WHERE nick = $1', [cleanNick]);
  if (existing.rows.length > 0) {
    const valid = await bcrypt.compare(pin, existing.rows[0].pin_hash);
    if (!valid) return res.json({ success: false, error: 'Неверный PIN' });
    const token = uuidv4();
    await pool.query('UPDATE users SET token = $1 WHERE id = $2', [token, existing.rows[0].id]);
    return res.json({ success: true, full_nick: existing.rows[0].full_nick, token, is_admin: existing.rows[0].is_admin });
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
      'INSERT INTO users (nick, tag, full_nick, pin_hash, token, is_admin) VALUES ($1, $2, $3, $4, $5, $6)',
      [cleanNick, tag, full_nick, pinHash, token, false]
    );
    return res.json({ success: true, full_nick, token, is_admin: false });
  }
});

app.post('/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: false });
  const user = await pool.query('SELECT full_nick, is_admin FROM users WHERE token = $1', [token]);
  if (user.rows.length > 0) res.json({ success: true, full_nick: user.rows[0].full_nick, is_admin: user.rows[0].is_admin });
  else res.json({ success: false });
});

// Смена ника (без PIN)
app.post('/change-nick', async (req, res) => {
  const { token, newNick } = req.body;
  if (!token || !newNick || newNick.trim() === '') {
    return res.status(400).json({ success: false, error: 'Данные неполные' });
  }
  const user = await pool.query('SELECT full_nick, nick, is_admin FROM users WHERE token = $1', [token]);
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
  await pool.query('UPDATE rooms SET created_by = $1 WHERE created_by = $2', [newFullNick, oldFullNick]);
  await pool.query('UPDATE room_members SET full_nick = $1 WHERE full_nick = $2', [newFullNick, oldFullNick]);
  await pool.query('UPDATE room_messages SET full_nick = $1 WHERE full_nick = $2', [newFullNick, oldFullNick]);
  await pool.query('UPDATE room_likes SET full_nick = $1 WHERE full_nick = $2', [newFullNick, oldFullNick]);
  io.emit('nick changed', { oldFullNick, newFullNick });
  res.json({ success: true, newFullNick });
});

// Смена PIN
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

// ========== ОБЩИЙ ЧАТ ==========
app.get('/messages', async (req, res) => {
  const { full_nick, page = 1 } = req.query;
  const limit = 25;
  const offset = (page - 1) * limit;
  const result = await pool.query(`
    SELECT m.id, m.full_nick, m.text, m.edited, m.created_at,
           COALESCE(l.likes_count, 0) as likes_count,
           EXISTS(SELECT 1 FROM likes WHERE message_id = m.id AND full_nick = $1) as is_liked,
           u.is_admin
    FROM messages m
    LEFT JOIN (
      SELECT message_id, COUNT(*) as likes_count
      FROM likes
      GROUP BY message_id
    ) l ON m.id = l.message_id
    LEFT JOIN users u ON m.full_nick = u.full_nick
    ORDER BY m.created_at ASC
    LIMIT $2 OFFSET $3
  `, [full_nick || '', limit, offset]);
  const total = await pool.query('SELECT COUNT(*) FROM messages');
  res.json({ messages: result.rows, total: parseInt(total.rows[0].count), page: parseInt(page) });
});

app.post('/delete-message', async (req, res) => {
  const { full_nick, messageId, isAdmin } = req.body;
  if (!full_nick || !messageId) return res.status(400).json({ success: false });
  let canDelete = false;
  if (isAdmin) {
    canDelete = true;
  } else {
    const msg = await pool.query('SELECT full_nick FROM messages WHERE id = $1', [messageId]);
    if (msg.rows.length > 0 && msg.rows[0].full_nick === full_nick) canDelete = true;
  }
  if (!canDelete) return res.json({ success: false });
  const result = await pool.query('DELETE FROM messages WHERE id = $1 RETURNING id', [messageId]);
  if (result.rowCount > 0) {
    io.emit('message deleted', messageId);
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

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

app.post('/like', async (req, res) => {
  const { messageId, full_nick, isRoom, roomId } = req.body;
  if (!messageId || !full_nick) return res.status(400).json({ success: false });
  if (isRoom) {
    try {
      await pool.query('INSERT INTO room_likes (message_id, full_nick) VALUES ($1, $2)', [messageId, full_nick]);
      const countRes = await pool.query('SELECT COUNT(*) as count FROM room_likes WHERE message_id = $1', [messageId]);
      io.emit('room_like_updated', { roomId, messageId, full_nick, likes_count: parseInt(countRes.rows[0].count), is_liked: true });
      res.json({ success: true, likes_count: parseInt(countRes.rows[0].count) });
    } catch (err) {
      if (err.code === '23505') {
        await pool.query('DELETE FROM room_likes WHERE message_id = $1 AND full_nick = $2', [messageId, full_nick]);
        const countRes = await pool.query('SELECT COUNT(*) as count FROM room_likes WHERE message_id = $1', [messageId]);
        io.emit('room_like_updated', { roomId, messageId, full_nick, likes_count: parseInt(countRes.rows[0].count), is_liked: false });
        res.json({ success: true, likes_count: parseInt(countRes.rows[0].count) });
      } else {
        res.status(500).json({ success: false });
      }
    }
  } else {
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
  }
});

// ========== ПРИВАТНЫЕ КОМНАТЫ ==========
app.get('/rooms', async (req, res) => {
  const { full_nick } = req.query;
  if (!full_nick) return res.status(400).json([]);
  const result = await pool.query(`
    SELECT r.id, r.name, r.created_by,
           EXISTS(SELECT 1 FROM room_members WHERE room_id = r.id AND full_nick = $1) as is_member
    FROM rooms r
    WHERE r.created_by = $1 OR EXISTS(SELECT 1 FROM room_members WHERE room_id = r.id AND full_nick = $1)
  `, [full_nick]);
  res.json(result.rows);
});

app.post('/create-room', async (req, res) => {
  const { name, created_by, members } = req.body;
  if (!name || !created_by) return res.status(400).json({ success: false, error: 'Не указано название' });
  const roomRes = await pool.query('INSERT INTO rooms (name, created_by) VALUES ($1, $2) RETURNING id', [name, created_by]);
  const roomId = roomRes.rows[0].id;
  await pool.query('INSERT INTO room_members (room_id, full_nick) VALUES ($1, $2)', [roomId, created_by]);
  if (members && members.length) {
    for (const member of members) {
      const userExists = await pool.query('SELECT full_nick FROM users WHERE full_nick = $1', [member]);
      if (userExists.rows.length > 0) {
        await pool.query('INSERT INTO room_members (room_id, full_nick) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roomId, member]);
      }
    }
  }
  io.emit('room_created', { roomId, name, created_by });
  res.json({ success: true, roomId });
});

app.post('/add-room-member', async (req, res) => {
  const { roomId, full_nick, admin_nick } = req.body;
  if (!roomId || !full_nick || !admin_nick) return res.status(400).json({ success: false });
  const isAdminUser = await isAdmin(admin_nick);
  const room = await pool.query('SELECT created_by FROM rooms WHERE id = $1', [roomId]);
  if (room.rows.length === 0) return res.json({ success: false, error: 'Комната не найдена' });
  if (room.rows[0].created_by !== admin_nick && !isAdminUser) {
    return res.json({ success: false, error: 'Нет прав' });
  }
  const userExists = await pool.query('SELECT full_nick FROM users WHERE full_nick = $1', [full_nick]);
  if (userExists.rows.length === 0) return res.json({ success: false, error: 'Пользователь не найден' });
  await pool.query('INSERT INTO room_members (room_id, full_nick) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roomId, full_nick]);
  io.emit('room_member_added', { roomId, full_nick });
  res.json({ success: true });
});

app.get('/room-messages', async (req, res) => {
  const { roomId, full_nick, page = 1 } = req.query;
  if (!roomId || !full_nick) return res.status(400).json([]);
  const member = await pool.query('SELECT id FROM room_members WHERE room_id = $1 AND full_nick = $2', [roomId, full_nick]);
  if (member.rows.length === 0) return res.status(403).json([]);
  const limit = 25;
  const offset = (page - 1) * limit;
  const result = await pool.query(`
    SELECT rm.id, rm.full_nick, rm.text, rm.edited, rm.created_at,
           COALESCE(l.likes_count, 0) as likes_count,
           EXISTS(SELECT 1 FROM room_likes WHERE message_id = rm.id AND full_nick = $1) as is_liked,
           u.is_admin
    FROM room_messages rm
    LEFT JOIN (
      SELECT message_id, COUNT(*) as likes_count
      FROM room_likes
      GROUP BY message_id
    ) l ON rm.id = l.message_id
    LEFT JOIN users u ON rm.full_nick = u.full_nick
    WHERE rm.room_id = $2
    ORDER BY rm.created_at ASC
    LIMIT $3 OFFSET $4
  `, [full_nick, roomId, limit, offset]);
  const total = await pool.query('SELECT COUNT(*) FROM room_messages WHERE room_id = $1', [roomId]);
  res.json({ messages: result.rows, total: parseInt(total.rows[0].count), page: parseInt(page) });
});

app.post('/delete-room-message', async (req, res) => {
  const { messageId, full_nick, isAdmin, roomId } = req.body;
  if (!messageId || !full_nick) return res.status(400).json({ success: false });
  let canDelete = false;
  if (isAdmin) {
    canDelete = true;
  } else {
    const msg = await pool.query('SELECT full_nick FROM room_messages WHERE id = $1', [messageId]);
    if (msg.rows.length > 0 && msg.rows[0].full_nick === full_nick) canDelete = true;
  }
  if (!canDelete) return res.json({ success: false });
  const result = await pool.query('DELETE FROM room_messages WHERE id = $1 RETURNING id', [messageId]);
  if (result.rowCount > 0) {
    io.emit('room_message_deleted', { roomId, messageId });
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.post('/edit-room-message', async (req, res) => {
  const { messageId, full_nick, newText, roomId } = req.body;
  if (!messageId || !full_nick || !newText || newText.trim() === '') {
    return res.status(400).json({ success: false });
  }
  const result = await pool.query(
    'UPDATE room_messages SET text = $1, edited = TRUE WHERE id = $2 AND full_nick = $3 RETURNING id',
    [newText.trim(), messageId, full_nick]
  );
  if (result.rowCount > 0) {
    io.emit('room_message_edited', { roomId, messageId, newText: newText.trim() });
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// Админ: список пользователей
app.get('/users', async (req, res) => {
  const { admin_nick } = req.query;
  if (!admin_nick) return res.status(400).json([]);
  const isAdminUser = await isAdmin(admin_nick);
  if (!isAdminUser) return res.status(403).json([]);
  const result = await pool.query('SELECT full_nick, is_admin FROM users ORDER BY created_at');
  res.json(result.rows);
});

app.post('/toggle-admin', async (req, res) => {
  const { admin_nick, target_full_nick } = req.body;
  if (!admin_nick || !target_full_nick) return res.status(400).json({ success: false });
  const isAdminUser = await isAdmin(admin_nick);
  if (!isAdminUser) return res.status(403).json({ success: false, error: 'Нет прав' });
  const target = await pool.query('SELECT is_admin FROM users WHERE full_nick = $1', [target_full_nick]);
  if (target.rows.length === 0) return res.json({ success: false, error: 'Пользователь не найден' });
  const newStatus = !target.rows[0].is_admin;
  await pool.query('UPDATE users SET is_admin = $1 WHERE full_nick = $2', [newStatus, target_full_nick]);
  io.emit('admin_toggled', { full_nick: target_full_nick, is_admin: newStatus });
  res.json({ success: true, is_admin: newStatus });
});

// Онлайн
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
  // Общий чат
  socket.on('new message', async (data) => {
    const { full_nick, text } = data;
    if (!full_nick || !text || text.trim() === '') return;
    const user = await pool.query('SELECT is_admin FROM users WHERE full_nick = $1', [full_nick]);
    const is_admin = user.rows.length > 0 ? user.rows[0].is_admin : false;
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
      is_liked: false,
      is_admin
    };
    io.emit('message received', newMsg);
  });
  // Приватные комнаты
  socket.on('join room', (roomId) => {
    socket.join(`room_${roomId}`);
  });
  socket.on('leave room', (roomId) => {
    socket.leave(`room_${roomId}`);
  });
  socket.on('new room message', async (data) => {
    const { roomId, full_nick, text } = data;
    if (!roomId || !full_nick || !text || text.trim() === '') return;
    const member = await pool.query('SELECT id FROM room_members WHERE room_id = $1 AND full_nick = $2', [roomId, full_nick]);
    if (member.rows.length === 0) return;
    const user = await pool.query('SELECT is_admin FROM users WHERE full_nick = $1', [full_nick]);
    const is_admin = user.rows.length > 0 ? user.rows[0].is_admin : false;
    const result = await pool.query(
      'INSERT INTO room_messages (room_id, full_nick, text) VALUES ($1, $2, $3) RETURNING id, created_at',
      [roomId, full_nick, text.trim()]
    );
    const newMsg = {
      id: result.rows[0].id,
      full_nick,
      text: text.trim(),
      edited: false,
      created_at: result.rows[0].created_at,
      likes_count: 0,
      is_liked: false,
      is_admin
    };
    io.to(`room_${roomId}`).emit('room message received', { roomId, message: newMsg });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));