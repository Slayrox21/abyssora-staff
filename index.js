const express = require('express');
const session = require('express-session');
const axios = require('axios');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'abyssora-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 86400000 }
}));

// ── MONGODB ──
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(e => console.error('❌ MongoDB erreur:', e.message));

const AvisSchema = new mongoose.Schema({
  rank: String, target: String, mainStar: Number,
  crits: Object, text: String,
  author: String, authorAvatar: String, authorId: String,
  date: String,
}, { timestamps: true });

const Avis = mongoose.model('Avis', AvisSchema);

const CLIENT_ID     = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BOT_TOKEN     = process.env.BOT_TOKEN;
const GUILD_ID      = '1492966941743124540';
const REDIRECT_URI  = process.env.REDIRECT_URI;
const OWNER_ROLE_ID = '1494764552838058145';

const ROLES = {
  'Owner':               { id: '1494764552838058145', color: '#ffd700', icon: '👑', tier: 1 },
  'Co-Owner':            { id: '1494764731519467531', color: '#ffb347', icon: '🥇', tier: 2 },
  'Admin':               { id: '1495068523083468860', color: '#ff4444', icon: '⚡', tier: 3 },
  'Resp. Modération':    { id: '1495073992162414762', color: '#ff2cf5', icon: '🛡️', tier: 4 },
  'Resp. Gestionnaires': { id: '1495063665496293428', color: '#c471ed', icon: '📋', tier: 5 },
  'Resp. Animation':     { id: '1495074131266244718', color: '#00d4ff', icon: '🎪', tier: 6 },
  'Animateur':           { id: '1495098846110290001', color: '#0fff6e', icon: '🎉', tier: 7 },
  'Modérateur':          { id: '1495098531638284288', color: '#5b8fff', icon: '🔨', tier: 8 },
  'Gestionnaire':        { id: '1495098683283210372', color: '#a0a0c0', icon: '⚙️', tier: 9 },
};

let membersCache = [];
let lastFetch = 0;

async function fetchGuildMembers() {
  if (Date.now() - lastFetch < 30000) return membersCache;
  try {
    let all = [];
    let after = '0';
    while (true) {
      const res = await axios.get(
        `https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000&after=${after}`,
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
      );
      all = all.concat(res.data);
      if (res.data.length < 1000) break;
      after = res.data[res.data.length - 1].user.id;
    }
    membersCache = all;
    lastFetch = Date.now();
    console.log(`✅ ${all.length} membres chargés`);
    return all;
  } catch (e) {
    console.error('Erreur fetch membres:', e.message);
    return membersCache;
  }
}

// ── AUTH DISCORD ──
app.get('/auth/login', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify+guilds.members.read`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    req.session.user = {
      id: userRes.data.id,
      username: userRes.data.username,
      avatar: userRes.data.avatar
        ? `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`,
      discriminator: userRes.data.discriminator || '0'
    };
    res.redirect('/');
  } catch (e) {
    console.error('Auth error:', e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/api/me', async (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  const members = await fetchGuildMembers();
  const member = members.find(m => m.user.id === req.session.user.id);
  const isOwner = !!(member && member.roles.includes(OWNER_ROLE_ID));
  res.json({ loggedIn: true, user: req.session.user, isOwner });
});

// ── API ROLES ──
app.get('/api/roles', async (req, res) => {
  const members = await fetchGuildMembers();
  const result = {};
  for (const [name, role] of Object.entries(ROLES)) {
    const roleMembers = members.filter(m => m.roles && m.roles.includes(role.id));
    result[name] = {
      ...role,
      count: roleMembers.length,
      members: roleMembers.map(m => ({
        id: m.user.id,
        username: m.nick || m.user.global_name || m.user.username,
        avatar: m.user.avatar
          ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
          : `https://cdn.discordapp.com/embed/avatars/0.png`
      }))
    };
  }
  res.json(result);
});

// ── API AVIS ──
app.get('/api/avis', async (req, res) => {
  const avis = await Avis.find().sort({ createdAt: -1 });
  res.json(avis);
});

app.post('/api/avis', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const { rank, target, mainStar, crits, text } = req.body;
  if (!rank || !target || !mainStar || !text)
    return res.status(400).json({ error: 'Champs manquants' });
  const avis = await Avis.create({
    rank, target, mainStar, crits, text,
    author: req.session.user.username,
    authorAvatar: req.session.user.avatar,
    authorId: req.session.user.id,
    date: new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
  });
  res.json({ success: true, avis });
});

// ── SUPPRIMER AVIS (Owner uniquement) ──
app.delete('/api/avis/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  const members = await fetchGuildMembers();
  const member = members.find(m => m.user.id === req.session.user.id);
  if (!member || !member.roles.includes(OWNER_ROLE_ID))
    return res.status(403).json({ error: 'Non autorisé' });
  await Avis.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.post('/api/refresh', async (req, res) => {
  lastFetch = 0;
  await fetchGuildMembers();
  res.json({ success: true, count: membersCache.length });
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.listen(process.env.PORT || 3000, () => { 
  console.log('🚀 Abyssora Staff running on port 3000');
  fetchGuildMembers();
  setInterval(() => { lastFetch = 0; fetchGuildMembers(); }, 60000);
});
