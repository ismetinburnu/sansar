const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());
app.use('/app', express.static(path.join(__dirname, 'app')));

const token = process.env.BOT_TOKEN;
const checkGroup1 = process.env.CHECK_GROUP_1;
const checkGroup2 = process.env.CHECK_GROUP_2;
const announceGroup = process.env.ANNOUNCE_GROUP;
const adminIds = process.env.ADMIN_IDS.split(',');

const bot = new TelegramBot(token, { polling: true });
const db = new sqlite3.Database('.data/sqlite.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, is_admin INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS giveaways (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, winner_count INTEGER DEFAULT 1, creator_id INTEGER, creator_name TEXT, creator_photo TEXT, status TEXT DEFAULT 'active', winners_data TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS participants (giveaway_id INTEGER, user_id INTEGER, joined_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(giveaway_id, user_id))`);
});

const broadcastUpdate = () => {
  io.emit('data_updated');
};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const webAppUrl = `https://${process.env.PROJECT_DOMAIN}.glitch.me/app/index.html`;
  bot.sendMessage(chatId, "Sansar Yönetim & Çekiliş Sistemine Hoş Geldin!", {
    reply_markup: { inline_keyboard: [[{ text: "🚀 SANSAR'ı Aç", web_app: { url: webAppUrl } }]] }
  });
});

app.post('/api/auth', async (req, res) => {
  const { userId, username, firstName } = req.body;
  try {
    const isAdmin = adminIds.includes(userId.toString()) ? 1 : 0;
    const member1 = await bot.getChatMember(checkGroup1, userId).catch(() => ({ status: 'left' }));
    const member2 = await bot.getChatMember(checkGroup2, userId).catch(() => ({ status: 'left' }));
    
    const valid = ['member', 'administrator', 'creator'];
    const hasAccess = valid.includes(member1.status) || valid.includes(member2.status) || isAdmin === 1;
    
    if (hasAccess) {
      db.run(`INSERT OR REPLACE INTO users (id, username, first_name, is_admin) VALUES (?, ?, ?, ?)`, [userId, username, firstName, isAdmin]);
      res.json({ success: true, isAdmin: isAdmin === 1 });
    } else {
      res.json({ success: false, message: "Sansar gruplarında yoksan giremezsin." });
    }
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/giveaways/:userId', (req, res) => {
  const userId = req.params.userId;
  db.all(`SELECT g.*, 
    (SELECT COUNT(*) FROM participants p WHERE p.giveaway_id = g.id AND p.user_id = ?) as is_joined,
    (SELECT COUNT(*) FROM participants p WHERE p.giveaway_id = g.id) as total_participants 
    FROM giveaways g ORDER BY g.id DESC`, [userId], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/join', (req, res) => {
  const { giveawayId, userId } = req.body;
  db.get(`SELECT status FROM giveaways WHERE id = ?`, [giveawayId], (err, row) => {
    if(row.status !== 'active') return res.json({ success: false });
    db.run(`INSERT INTO participants (giveaway_id, user_id) VALUES (?, ?)`, [giveawayId, userId], function(err) {
      if (!err) {
        broadcastUpdate();
        res.json({ success: true });
      } else res.json({ success: false });
    });
  });
});

app.get('/api/profile/:userId', (req, res) => {
  const userId = req.params.userId;
  db.all(`SELECT g.title, g.status, g.winners_data FROM giveaways g JOIN participants p ON g.id = p.giveaway_id WHERE p.user_id = ? ORDER BY p.joined_at DESC`, [userId], (err, rows) => {
    res.json({ participated: rows || [] });
  });
});

app.post('/api/admin/action', (req, res) => {
  const { action, adminId, data } = req.body;
  if (!adminIds.includes(adminId.toString())) return res.status(403).json({ success: false });

  if (action === 'create') {
    db.run(`INSERT INTO giveaways (title, description, winner_count, creator_id, creator_name, creator_photo) VALUES (?, ?, ?, ?, ?, ?)`, 
    [data.title, data.description, data.winnerCount, adminId, data.creatorName, data.creatorPhoto], function(err) {
      if(!err) {
        bot.sendMessage(announceGroup, `🎊 *YENİ ÇEKİLİŞ!*\n\n💎 *${data.title}*\n📝 ${data.description}\n🏆 ${data.winnerCount} Kazanan\n\n👇 Mini App üzerinden katıl!`, {
          parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🎁 Katıl", url: `https://t.me/${process.env.PROJECT_DOMAIN}_bot/app` }]] }
        });
        broadcastUpdate();
        res.json({ success: true });
      }
    });
  } 
  else if (action === 'edit') {
    db.run(`UPDATE giveaways SET title = ?, description = ?, winner_count = ? WHERE id = ?`, [data.title, data.description, data.winnerCount, data.id], () => { broadcastUpdate(); res.json({ success: true }); });
  }
  else if (action === 'status') {
    db.run(`UPDATE giveaways SET status = ? WHERE id = ?`, [data.status, data.id], () => { broadcastUpdate(); res.json({ success: true }); });
  }
  else if (action === 'roll' || action === 'reroll') {
    db.all(`SELECT p.user_id, u.username, u.first_name FROM participants p JOIN users u ON p.user_id = u.id WHERE p.giveaway_id = ?`, [data.id], (err, participants) => {
      if (participants.length === 0) return res.json({ success: false, message: "Katılımcı yok." });
      
      let winners = [];
      let pool = [...participants];
      let count = action === 'reroll' ? data.rerollCount : data.winnerCount;
      
      for(let i=0; i < count; i++) {
        if(pool.length === 0) break;
        let idx = Math.floor(Math.random() * pool.length);
        winners.push({ id: pool[idx].user_id, name: pool[idx].username ? `@${pool[idx].username}` : pool[idx].first_name });
        pool.splice(idx, 1);
      }
      
      let winnersJson = JSON.stringify(winners);
      db.run(`UPDATE giveaways SET status = 'ended', winners_data = ? WHERE id = ?`, [winnersJson, data.id], () => {
        let winnerText = winners.map(w => w.name).join(', ');
        bot.sendMessage(announceGroup, `🏆 *ÇEKİLİŞ SONUÇLANDI!*\n\n🎉 Kazanan(lar): ${winnerText}`);
        broadcastUpdate();
        res.json({ success: true, winners });
      });
    });
  }
});

server.listen(3000, () => console.log('SANSAR Live Server Active'));
