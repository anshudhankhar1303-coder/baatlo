const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e4 });
app.use(express.static('public'));

const users = new Map();   // socket.id -> {name, age, gender, last}
const blocks = new Map();  // socket.id -> Set of ids blocked

const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);
const opposite = g => (g === 'male' ? 'female' : 'male');

function visibleTo(id) {
  const me = users.get(id);
  if (!me) return [];
  const mine = blocks.get(id) || new Set();
  const out = [];
  for (const [uid, u] of users) {
    if (uid === id || u.gender !== opposite(me.gender)) continue;
    if (mine.has(uid) || (blocks.get(uid) || new Set()).has(id)) continue;
    out.push({ id: uid, name: u.name, age: u.age });
  }
  return out;
}
const refresh = () => { for (const id of users.keys()) io.to(id).emit('users', visibleTo(id)); };

io.on('connection', socket => {
  socket.on('join', (d, ack) => {
    const age = parseInt(d && d.age, 10);
    const gender = d && d.gender;
    if (!(age >= 18 && age <= 99)) return ack && ack({ error: 'Only 18+ users are allowed.' });
    if (!['male', 'female'].includes(gender)) return ack && ack({ error: 'Please select your gender.' });
    const name = clean(d.name, 20) || 'Guest' + Math.floor(1000 + Math.random() * 9000);
    users.set(socket.id, { name, age, gender, last: 0 });
    ack && ack({ ok: true, name });
    refresh();
  });

  socket.on('msg', ({ to, text } = {}) => {
    const me = users.get(socket.id), you = users.get(to);
    text = clean(text, 500);
    if (!me || !you || !text || you.gender === me.gender) return;
    if ((blocks.get(to) || new Set()).has(socket.id)) return;
    const now = Date.now();
    if (now - me.last < 600) return;  // basic spam limit
    me.last = now;
    io.to(to).emit('msg', { from: socket.id, name: me.name, age: me.age, text });
  });

  socket.on('block', id => {
    if (!users.has(socket.id)) return;
    if (!blocks.has(socket.id)) blocks.set(socket.id, new Set());
    blocks.get(socket.id).add(id);
    refresh();
  });

  socket.on('report', id => {
    console.log('REPORT:', id, users.get(id));
  });

  socket.on('disconnect', () => { users.delete(socket.id); blocks.delete(socket.id); refresh(); });
});

server.listen(process.env.PORT || 3000, () => console.log('Running on port', process.env.PORT || 3000));
