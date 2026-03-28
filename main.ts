import express from "express";
import { Server } from "socket.io";
import TelegramBot from "node-telegram-bot-api";
import cors from "cors";
import http from "node:http";

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

const kv = await Deno.openKv();

const bot = new TelegramBot(token, { webHook: true });
bot.setWebHook(`https://${projectUrl}/bot${token}`);

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const broadcastUpdate = () => { io.emit('data_updated'); };

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const webAppUrl = `https://${projectUrl}/app/index.html`;
  bot.sendMessage(chatId, "Sansar Yönetim & Çekiliş Sistemine Hoş Geldin! 🎉", {
    reply_markup: { inline_keyboard: [[{ text: "🚀 SANSAR'ı Aç", web_app: { url: webAppUrl } }]] }
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
      await kv.set(["users", userId], { username, first_name: firstName, is_admin: isAdmin });
      res.json({ success: true, isAdmin });
    } else {
      res.json({ success: false, message: "Sansar gruplarında yoksan giremezsin." });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: "Telegram API hatası." });
  }
});

app.get('/api/giveaways/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const giveaways = [];
  
  for await (const entry of kv.list({ prefix: ["giveaways"] })) {
    const g: any = entry.value;
    let total_participants = 0;
    let is_joined = false;
    
    for await (const p of kv.list({ prefix: ["participants", g.id] })) {
      total_participants++;
      if (p.key[2] === userId) is_joined = true;
    }
    giveaways.push({ ...g, total_participants, is_joined });
  }
  
  giveaways.sort((a, b) => b.id - a.id);
  res.json(giveaways);
});

app.post('/api/join', async (req, res) => {
  const { giveawayId, userId } = req.body;
  const g = await kv.get(["giveaways", giveawayId]);
  
  if(g.value && (g.value as any).status === 'active') {
    await kv.set(["participants", giveawayId, userId], { joinedAt: Date.now() });
    await kv.set(["user_joined", userId, giveawayId], { joinedAt: Date.now() });
    broadcastUpdate();
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.get('/api/profile/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const participated = [];
  
  for await (const entry of kv.list({ prefix: ["user_joined", userId] })) {
    const giveawayId = entry.key[2];
    const g = await kv.get(["giveaways", giveawayId]);
    if (g.value) participated.push(g.value);
  }
  
  participated.sort((a: any, b: any) => b.id - a.id);
  res.json({ participated });
});

app.post('/api/admin/action', async (req, res) => {
  const { action, adminId, data } = req.body;
  if (!adminIds.includes(adminId.toString())) return res.status(403).json({ success: false });

  if (action === 'create') {
    const id = Date.now();
    await kv.set(["giveaways", id], { 
      id, title: data.title, description: data.description, winner_count: data.winnerCount, 
      creator_id: adminId, creator_name: data.creatorName, creator_photo: data.creatorPhoto, 
      status: 'active', winners_data: null, created_at: Date.now() 
    });
    
    bot.sendMessage(announceGroup, `🎊 *YENİ ÇEKİLİŞ!*\n\n💎 *${data.title}*\n📝 ${data.description}\n🏆 ${data.winnerCount} Kazanan\n\n👇 Mini App üzerinden katıl!`, {
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🎁 Katıl", url: `https://t.me/${projectUrl.split('.')[0]}_bot/app` }]] }
    });
    broadcastUpdate();
    res.json({ success: true });
  } 
  else if (action === 'status') {
    const g = await kv.get(["giveaways", data.id]);
    if(g.value) {
      await kv.set(["giveaways", data.id], { ...(g.value as any), status: data.status });
      broadcastUpdate();
      res.json({ success: true });
    }
  }
  else if (action === 'roll' || action === 'reroll') {
    const participants = [];
    for await (const entry of kv.list({ prefix: ["participants", data.id] })) {
      const uId = entry.key[2];
      const user = await kv.get(["users", uId]);
      if(user.value) participants.push({ id: uId, ...user.value as any });
    }
    
    if (participants.length === 0) return res.json({ success: false, message: "Katılımcı yok." });
    
    let winners = [];
    let pool = [...participants];
    let count = action === 'reroll' ? data.rerollCount : (await kv.get(["giveaways", data.id])).value.winner_count;
    
    for(let i=0; i < count; i++) {
      if(pool.length === 0) break;
      let idx = Math.floor(Math.random() * pool.length);
      winners.push({ id: pool[idx].id, name: pool[idx].username ? `@${pool[idx].username}` : pool[idx].first_name });
      pool.splice(idx, 1);
    }
    
    const g = await kv.get(["giveaways", data.id]);
    await kv.set(["giveaways", data.id], { ...(g.value as any), status: 'ended', winners_data: JSON.stringify(winners) });
    
    let winnerText = winners.map(w => w.name).join(', ');
    bot.sendMessage(announceGroup, `🏆 *ÇEKİLİŞ SONUÇLANDI!*\n\n🎉 Kazanan(lar): ${winnerText}`);
    broadcastUpdate();
    res.json({ success: true, winners });
  }
});

server.listen(8000, () => console.log('SANSAR Deno Live Server Active'));
