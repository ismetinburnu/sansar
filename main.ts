import express from "express";
import { Server } from "socket.io";
import TelegramBot from "node-telegram-bot-api";
import cors from "cors";
import http from "node:http";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());
app.use("/app", express.static("public"));

const token = Deno.env.get("BOT_TOKEN")!;
const checkGroup1 = Deno.env.get("CHECK_GROUP_1")!;
const checkGroup2 = Deno.env.get("CHECK_GROUP_2")!;
const announceGroup = Deno.env.get("ANNOUNCE_GROUP")!;
const adminIds = Deno.env.get("ADMIN_IDS")!.split(',');
const projectUrl = Deno.env.get("PROJECT_URL")!;
const mongoUri = Deno.env.get("MONGO_URI")!;

const client = new MongoClient(mongoUri);
await client.connect();
const db = client.db("sansar_app");
const usersCol = db.collection("users");
const giveawaysCol = db.collection("giveaways");
const participantsCol = db.collection("participants");

const bot = new TelegramBot(token, { webHook: true });
bot.setWebHook(`https://${projectUrl}/bot${token}`);

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

let onlineUsers = 0;
io.on("connection", (socket) => {
  onlineUsers++;
  io.emit("live_stats", { online: onlineUsers });
  socket.on("disconnect", () => {
    onlineUsers--;
    io.emit("live_stats", { online: onlineUsers });
  });
});

const broadcastUpdate = () => { io.emit('data_updated'); };

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const webAppUrl = `https://${projectUrl}/app/index.html`;
  bot.sendMessage(chatId, "🚀 SANSAR Sistemine Hoş Geldin!", {
    reply_markup: { inline_keyboard: [[{ text: "💎 SANSAR'ı Aç", web_app: { url: webAppUrl } }]] }
  });
});

app.post('/api/auth', async (req, res) => {
  const { userId, username, firstName } = req.body;
  try {
    const isAdmin = adminIds.includes(userId.toString());
    const member1 = await bot.getChatMember(checkGroup1, userId).catch(() => ({ status: 'left' }));
    const member2 = await bot.getChatMember(checkGroup2, userId).catch(() => ({ status: 'left' }));
    const valid = ['member', 'administrator', 'creator'];
    const hasAccess = valid.includes(member1.status) || valid.includes(member2.status) || isAdmin;
    
    if (hasAccess) {
      await usersCol.updateOne({ id: userId }, { $set: { username, first_name: firstName, is_admin: isAdmin, last_login: new Date() } }, { upsert: true });
      res.json({ success: true, isAdmin });
    } else {
      res.json({ success: false, message: "Erişim reddedildi." });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: "Auth hatası." });
  }
});

app.get('/api/giveaways/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const allG = await giveawaysCol.find().sort({ created_at: -1 }).toArray();
  const result = await Promise.all(allG.map(async (g) => {
    const stringId = g._id.toString();
    const count = await participantsCol.countDocuments({ giveaway_id: stringId });
    const joined = await participantsCol.findOne({ giveaway_id: stringId, user_id: userId });
    return { ...g, id: stringId, total_participants: count, is_joined: !!joined };
  }));
  res.json(result);
});

app.post('/api/join', async (req, res) => {
  const { giveawayId, userId } = req.body;
  const g = await giveawaysCol.findOne({ _id: new ObjectId(giveawayId) });
  if (g && g.status === 'active') {
    const exists = await participantsCol.findOne({ giveaway_id: giveawayId, user_id: userId });
    if (!exists) {
      await participantsCol.insertOne({ giveaway_id: giveawayId, user_id: userId, joined_at: new Date() });
      broadcastUpdate();
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  } else {
    res.json({ success: false });
  }
});

app.get('/api/profile/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const parts = await participantsCol.find({ user_id: userId }).sort({ joined_at: -1 }).toArray();
  const participated = await Promise.all(parts.map(async (p) => {
    const g = await giveawaysCol.findOne({ _id: new ObjectId(p.giveaway_id) });
    return g ? { ...g, id: g._id.toString() } : null;
  }));
  res.json({ participated: participated.filter(g => g !== null) });
});

app.post('/api/admin/action', async (req, res) => {
  const { action, adminId, data } = req.body;
  if (!adminIds.includes(adminId.toString())) return res.status(403).json({ success: false });

  if (action === 'create') {
    await giveawaysCol.insertOne({
      title: data.title, description: data.description, winner_count: data.winnerCount,
      creator_id: adminId, creator_name: data.creatorName, creator_photo: data.creatorPhoto,
      status: 'active', winners_data: null, created_at: new Date()
    });
    bot.sendMessage(announceGroup, `🎊 *SANSAR YENİ ÇEKİLİŞ!*\n\n💎 *${data.title}*\n📝 ${data.description}\n🏆 ${data.winnerCount} Kazanan\n\n👇 Mini App üzerinden hemen katıl!`, {
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🎁 Katıl", url: `https://t.me/${projectUrl.split('.')[0]}_bot/app` }]] }
    });
    broadcastUpdate();
    res.json({ success: true });
  } 
  else if (action === 'status') {
    await giveawaysCol.updateOne({ _id: new ObjectId(data.id) }, { $set: { status: data.status } });
    broadcastUpdate();
    res.json({ success: true });
  }
  else if (action === 'roll' || action === 'reroll') {
    const parts = await participantsCol.find({ giveaway_id: data.id }).toArray();
    if (parts.length === 0) return res.json({ success: false });
    const users = await Promise.all(parts.map(async p => {
      const u = await usersCol.findOne({ id: p.user_id });
      return u ? { id: u.id, name: u.username ? `@${u.username}` : u.first_name } : null;
    }));
    let validUsers = users.filter(u => u !== null);
    let winners = [];
    const g = await giveawaysCol.findOne({ _id: new ObjectId(data.id) });
    let count = action === 'reroll' ? data.rerollCount : (g ? g.winner_count : 1);
    for (let i = 0; i < count; i++) {
      if (validUsers.length === 0) break;
      let idx = Math.floor(Math.random() * validUsers.length);
      winners.push(validUsers[idx]);
      validUsers.splice(idx, 1);
    }
    await giveawaysCol.updateOne({ _id: new ObjectId(data.id) }, { $set: { status: 'ended', winners_data: JSON.stringify(winners) } });
    let winnerText = winners.map(w => w.name).join(', ');
    bot.sendMessage(announceGroup, `🏆 *ÇEKİLİŞ SONUÇLANDI!*\n\n🎉 Kazanan(lar): ${winnerText}`);
    broadcastUpdate();
    res.json({ success: true, winners });
  }
});

server.listen(8000);
