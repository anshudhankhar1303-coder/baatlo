const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });
app.use(express.static('public'));

const users = new Map();   // socket.id -> {name, age, gender, last}
const blocks = new Map();  // socket.id -> Set of ids blocked


const TRUTHS = [
  "What's the most embarrassing thing that has happened to you in public?",
  "What's your most unpopular opinion?",
  "What's the last lie you told?",
  "What's a secret talent nobody knows you have?",
  "Who was your first celebrity crush?",
  "What's the weirdest dream you can remember?",
  "What's the most childish thing you still do?",
  "If you could swap lives with anyone for a day, who would it be and why?",
  "What's a fear of yours that sounds silly?",
  "What's the worst gift you've ever received?",
  "Which song do you secretly love but would be embarrassed to admit?",
  "What's the craziest thing you've done for a crush?",
  "What's one thing about you that would surprise people?",
  "What's your most awkward first-meeting moment ever?",
  "If you had to delete one app forever, which one would it be?",
  "What's the pettiest reason you've stopped talking to someone?",
  "What's your go-to flirting line? Be honest!",
  "What's something you pretend to like but actually don't?",
  "What's the funniest nickname you've ever had?",
  "What's your biggest red flag?"
];
const DARES = [
  "Describe your day using only emojis.",
  "Write a 4-line poem about this chat, right now.",
  "Type your next 3 messages with your eyes closed.",
  "Share your cringiest pickup line and rate it out of 10.",
  "Describe me in exactly 3 words based on this chat.",
  "Use only one-word answers for the next 5 minutes.",
  "Invent a funny movie title about how we met.",
  "Say something nice about me in your mother tongue.",
  "Talk like a pirate for your next 3 messages.",
  "Tell a joke so bad that it makes me groan.",
  "Make up a dramatic backstory for your nickname.",
  "Invent a secret handshake for us and describe it.",
  "Write a one-line horoscope for me.",
  "Guess my favourite food and defend your answer.",
  "Do your best villain laugh in text.",
  "Share the last emoji you used and explain why.",
  "Speak only in rhymes for the next 3 messages.",
  "Act like a news anchor and announce our chat as breaking news.",
  "Pitch me a ridiculous startup idea in one sentence.",
  "Give me a fake award title and explain why I deserve it."
];
const pickOne = a => a[Math.floor(Math.random() * a.length)];

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

function allowed(a, b) {
  const x = users.get(a), y = users.get(b);
  return !!(x && y && x.gender !== y.gender &&
    !(blocks.get(b) || new Set()).has(a) && !(blocks.get(a) || new Set()).has(b));
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

  // Voice call signalling (WebRTC) - audio only
  socket.on('rtc', ({ to, data } = {}) => {
    if (!data || typeof data.t !== 'string' || !allowed(socket.id, to)) return;
    io.to(to).emit('rtc', { from: socket.id, data: { t: data.t, sdp: data.sdp, c: data.c } });
  });

  // Truth or Dare
  // Two Truths and a Lie
  socket.on('tl', ({ to, type, stmts, lie, guess } = {}) => {
    if (!allowed(socket.id, to)) return;
    if (['invite', 'accept', 'decline', 'next', 'end'].includes(type)) {
      io.to(to).emit('tl', { from: socket.id, type });
      return;
    }
    if (type === 'set') {
      const peerSock = io.sockets.sockets.get(to);
      if (!peerSock || !Array.isArray(stmts) || stmts.length !== 3 || !Number.isInteger(lie) || lie < 0 || lie > 2) return;
      const items = stmts.map((s, i) => ({ t: clean(s, 120), lie: i === lie }));
      if (items.some(x => !x.t)) return;
      items.sort(() => Math.random() - 0.5);
      peerSock.tlPending = { from: socket.id, stmts: items.map(x => x.t), lie: items.findIndex(x => x.lie) };
      io.to(to).emit('tl', { from: socket.id, type: 'guess', stmts: peerSock.tlPending.stmts });
      return;
    }
    if (type === 'guess') {
      const r = socket.tlPending;
      if (!r || r.from !== to || !Number.isInteger(guess) || guess < 0 || guess > 2) return;
      socket.tlPending = null;
      for (const id of [socket.id, to]) {
        io.to(id).emit('tl', { from: socket.id, type: 'result', stmts: r.stmts, lie: r.lie, guess, correct: guess === r.lie });
      }
    }
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
