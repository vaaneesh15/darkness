const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Хранилища в памяти
let messages = [];
const users = new Map(); // key: nick, value: { nick, password }

// Регистрация / вход
app.post('/auth', (req, res) => {
  const { nick, key } = req.body;
  if (!nick || !key) return res.status(400).json({ success: false, error: 'Неизвестно' });

  if (users.has(nick)) {
    // Проверяем пароль
    if (users.get(nick).password === key) {
      res.json({ success: true, nick });
    } else {
      res.json({ success: false, error: 'Неизвестно' });
    }
  } else {
    // Регистрируем нового пользователя
    users.set(nick, { nick, password: key });
    console.log(`✅ Новый пользователь: ${nick}`);
    res.json({ success: true, nick });
  }
});

// История сообщений
app.get('/messages', (req, res) => {
  res.json(messages.slice(-100));
});

// WebSocket
io.on('connection', (socket) => {
  console.log('Клиент подключился');
  socket.on('new message', (data) => {
    const { nick, text } = data;
    if (!nick || !text || !text.trim()) return;
    const newMsg = { id: Date.now(), nick, text: text.trim(), created_at: new Date() };
    messages.push(newMsg);
    io.emit('message received', newMsg);
  });
  socket.on('disconnect', () => console.log('Клиент отключился'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер чата запущен на порту ${PORT}`));