console.log('BOOT v4 - server.js loaded, node ' + process.version);
process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path);

const app = express();
const PORT = process.env.PORT || 3000;
const E = (k) => (process.env[k] || '').trim();
const ELEVEN_API_KEY = E('ELEVEN_API_KEY'), REPLICATE_API_TOKEN = E('REPLICATE_API_TOKEN');
const NP_KEY = E('NOWPAYMENTS_API_KEY'), NP_IPN_SECRET = E('NOWPAYMENTS_IPN_SECRET');
const ANTHROPIC_KEY = E('ANTHROPIC_API_KEY'), ADMIN_KEY = E('ADMIN_KEY');
const TG_TOKEN = E('TELEGRAM_BOT_TOKEN'), TG_CHAT = E('TELEGRAM_CHAT_ID');
const PAY_INFO = process.env.PAY_INFO || ''; // تعليمات الدفع اليدوي (محفظة، حساب...) تظهر للزبون
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
if (!ADMIN_KEY) console.warn('⚠️ عيّن ADMIN_KEY لتفعيل لوحة الإدارة /admin.html');

const PLANS = {
  trial:   { name: 'تجربة 3 أيام', price: 3,   days: 3,   daily: 3,  tools: 30 },
  monthly: { name: 'شهري',         price: 29,  days: 30,  daily: 10, tools: 150 },
  yearly:  { name: 'سنوي',         price: 249, days: 365, daily: 15, tools: 300 }
};

// ---------- قاعدة بيانات JSON ----------
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
db.codes = db.codes || {}; db.orders = db.orders || {}; db.trialContacts = db.trialContacts || {};
function saveDb() { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }

const today = () => new Date().toISOString().slice(0, 10);
const norm = (s) => String(s || '').trim().toLowerCase().replace(/[\s\-+()]/g, '');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- الدخول بكود الاشتراك (بدون حساب) ----------
function auth(req, res, next) {
  const code = String(req.headers.authorization || '').replace('Bearer ', '').trim().toUpperCase();
  const u = db.codes[code];
  if (!u || u.revoked) return res.status(401).json({ error: 'كود غير صحيح أو ملغى' });
  req.user = u; next();
}
function status(u) {
  const active = !u.revoked && u.expires > Date.now();
  const used = u.usage && u.usage.date === today() ? u.usage.count : 0;
  return { name: u.name, active, plan: u.plan, expires: u.expires, surveyDone: true, usedToday: used,
    dailyLimit: active ? PLANS[u.plan].daily : 0, toolsUsed: u.usage && u.usage.date === today() ? (u.usage.tools || 0) : 0,
    toolLimit: active ? PLANS[u.plan].tools : 0 };
}
function gate(req, res, next) {
  const s = status(req.user);
  if (!s.active) return res.status(402).json({ error: 'انتهى اشتراكك. اطلب كوداً جديداً', code: 'EXPIRED' });
  if (s.usedToday >= s.dailyLimit) return res.status(429).json({ error: 'بلغت الحد اليومي لخطتك', code: 'LIMIT' });
  next();
}
function adminAuth(req, res, next) {
  const k = String(req.headers['x-admin-key'] || '');
  if (!ADMIN_KEY || !same(k, ADMIN_KEY)) return setTimeout(() => res.status(401).json({ error: 'مفتاح الإدارة خاطئ' }), 700);
  next();
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// احتياط: إذا رُفع index.html / admin.html في المجلد الرئيسي بدل public
const findPage = (names) => names.map((n) => path.join(__dirname, n)).find((f) => fs.existsSync(f));
app.get('/', (req, res, next) => { const f = findPage(['public/index.html', 'index.html', 'index__1_.html']); f ? res.sendFile(f) : next(); });
app.get('/admin.html', (req, res, next) => { const f = findPage(['public/admin.html', 'admin.html']); f ? res.sendFile(f) : next(); });
console.log('pages:', ['public/index.html', 'index.html', 'index__1_.html', 'public/admin.html', 'admin.html'].map((n) => n + '=' + fs.existsSync(path.join(__dirname, n))).join(' '));
const TEMP_DIR = path.join(__dirname, 'temp');
fs.mkdirSync(TEMP_DIR, { recursive: true });
const safeId = (s) => /^job_\d+$/.test(s || '');

// ---------- الخطط والطلبات ----------
app.get('/api/plans', (req, res) => res.json({ plans: PLANS, payInfo: PAY_INFO, online: !!(NP_KEY && BASE_URL) }));

async function notifyAdmin(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try { await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text }) }); } catch (e) {}
}
function markPaid(o, ref) {
  if (o.status !== 'new') return;
  o.status = 'paid'; o.paidAt = Date.now(); if (ref) o.ref = ref;
  saveDb();
  notifyAdmin(`💰 دفعة جديدة\n${o.name} (${o.contact})\nالخطة: ${PLANS[o.plan].name} — ${o.price}$\nأكّدها من لوحة الإدارة`);
}

app.post('/api/order', async (req, res) => {
  try {
    const plan = PLANS[req.body.plan];
    const name = String(req.body.name || '').trim().slice(0, 80);
    const contact = String(req.body.contact || '').trim().slice(0, 80);
    if (!plan) return res.status(400).json({ error: 'خطة غير معروفة' });
    if (name.length < 2 || contact.length < 5) return res.status(400).json({ error: 'اكتب اسمك ورقم واتساب/تلغرام صحيح' });
    if (req.body.plan === 'trial' && db.trialContacts[norm(contact)]) return res.status(400).json({ error: 'استخدمت التجربة المجانية سابقاً' });
    const id = crypto.randomBytes(9).toString('hex');
    const o = db.orders[id] = { id, name, contact, business: String(req.body.business || '').slice(0, 200),
      plan: req.body.plan, price: plan.price, status: 'new', created: Date.now() };
    let url = null;
    if (NP_KEY && BASE_URL) {
      const r = await fetch('https://api.nowpayments.io/v1/invoice', { method: 'POST',
        headers: { 'x-api-key': NP_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ price_amount: plan.price, price_currency: 'usd', order_id: id, order_description: plan.name,
          ipn_callback_url: BASE_URL + '/api/nowpayments-ipn', success_url: BASE_URL + '/?order=' + id, cancel_url: BASE_URL + '/?order=' + id }) });
      const inv = await r.json();
      if (r.ok && inv.invoice_url) url = inv.invoice_url;
    }
    saveDb();
    res.json({ orderId: id, invoiceUrl: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// الزبون يضغط "دفعت" (للدفع اليدوي) → إشعار للإدارة
app.post('/api/order/:id/claim', (req, res) => {
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  markPaid(o, String(req.body.ref || '').slice(0, 200));
  res.json({ status: o.status });
});
app.get('/api/order/:id', (req, res) => {
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  res.json({ status: o.status, plan: o.plan, code: o.status === 'approved' ? o.code : undefined });
});
app.post('/api/login-code', auth, (req, res) => res.json({ me: status(req.user) }));
app.get('/api/me', auth, (req, res) => res.json(status(req.user)));

const sortObj = (o) => Array.isArray(o) ? o.map(sortObj)
  : o && typeof o === 'object' ? Object.keys(o).sort().reduce((a, k) => (a[k] = sortObj(o[k]), a), {}) : o;
app.post('/api/nowpayments-ipn', (req, res) => {
  const sig = String(req.headers['x-nowpayments-sig'] || '');
  const calc = crypto.createHmac('sha512', NP_IPN_SECRET).update(JSON.stringify(sortObj(req.body))).digest('hex');
  if (!NP_IPN_SECRET || sig.length !== calc.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc)))
    return res.status(401).send('bad signature');
  const o = db.orders[req.body.order_id];
  if (o && req.body.payment_status === 'finished') markPaid(o, 'NOWPayments ' + (req.body.payment_id || ''));
  res.send('ok');
});

// ---------- لوحة الإدارة ----------
function makeCode() { const h = () => crypto.randomBytes(2).toString('hex').toUpperCase(); return `AD-${h()}-${h()}`; }
function issue(planKey, name, contact, orderId) {
  const code = makeCode(), p = PLANS[planKey];
  db.codes[code] = { id: code, code, name, contact, plan: planKey, orderId: orderId || null,
    created: Date.now(), expires: Date.now() + p.days * 864e5, revoked: false };
  return code;
}
app.get('/api/admin/orders', adminAuth, (req, res) => res.json({
  orders: Object.values(db.orders).sort((a, b) => b.created - a.created).slice(0, 200),
  codes: Object.values(db.codes).sort((a, b) => b.created - a.created).slice(0, 200).map((c) => ({ ...c, ...status(c) })) }));
app.post('/api/admin/orders/:id/approve', adminAuth, (req, res) => {
  const o = db.orders[req.params.id];
  if (!o || o.status === 'approved' || o.status === 'rejected') return res.status(400).json({ error: 'لا يمكن اعتماد هذا الطلب' });
  o.code = issue(o.plan, o.name, o.contact, o.id); o.status = 'approved'; o.approvedAt = Date.now();
  if (o.plan === 'trial') db.trialContacts[norm(o.contact)] = true;
  saveDb(); res.json({ code: o.code });
});
app.post('/api/admin/orders/:id/reject', adminAuth, (req, res) => {
  const o = db.orders[req.params.id];
  if (!o || o.status === 'approved') return res.status(400).json({ error: 'لا يمكن رفض هذا الطلب' });
  o.status = 'rejected'; saveDb(); res.json({ ok: true });
});
app.post('/api/admin/codes', adminAuth, (req, res) => { // إنشاء كود يدوي
  if (!PLANS[req.body.plan]) return res.status(400).json({ error: 'خطة غير معروفة' });
  const code = issue(req.body.plan, String(req.body.name || 'يدوي').slice(0, 80), String(req.body.contact || '').slice(0, 80));
  saveDb(); res.json({ code });
});
app.post('/api/admin/codes/:code/revoke', adminAuth, (req, res) => {
  const c = db.codes[req.params.code]; if (!c) return res.status(404).json({ error: 'غير موجود' });
  c.revoked = !c.revoked; saveDb(); res.json({ revoked: c.revoked });
});

// ---------- أدوات النص بالذكاء الاصطناعي (بعد الدفع) ----------
function bump(u, k) {
  if (!u.usage || u.usage.date !== today()) u.usage = { date: today(), count: 0, tools: 0 };
  u.usage[k] = (u.usage[k] || 0) + 1;
}
const TOOLS = {
  ad_copy:    ['✍️', 'نص إعلان مبيعات', 'اكتب 3 نصوص إعلانية قصيرة قوية لفيسبوك/إنستغرام مع Hook وعرض ودعوة لاتخاذ إجراء.'],
  headlines:  ['🎯', 'عناوين إعلانية A/B', 'اكتب 10 عناوين إعلانية مختلفة الزوايا (خوف من الفوات، فائدة، فضول، سعر...) للاختبار A/B.'],
  video_script:['🎬', 'سيناريو فيديو 15 ثانية', 'اكتب سيناريو إعلان فيديو 15 ثانية: Hook في أول 3 ثوانٍ، ثم المنتج، ثم العرض، ثم الدعوة. مع وصف المشاهد.'],
  caption:    ['📸', 'كابشن إنستغرام', 'اكتب 5 كابشنات جذابة مع إيموجي و10 هاشتاغات مناسبة.'],
  post:       ['📘', 'منشور فيسبوك', 'اكتب 3 منشورات فيسبوك تفاعلية تبني الثقة وتدفع للتواصل.'],
  desc:       ['🛍️', 'وصف منتج', 'اكتب وصف منتج مقنعاً: فوائد، مواصفات بنقاط، وسؤال شائع وجوابه.'],
  slogan:     ['💡', 'شعارات وأسماء', 'اقترح 10 شعارات ونصف دزينة أسماء تجارية قصيرة وسهلة النطق مع سبب مختصر لكل واحد.'],
  whatsapp:   ['💬', 'ردود واتساب للبيع', 'اكتب رد ترحيب، ورد على سؤال السعر، ورد على الاعتراض (غالي)، ورد إغلاق الصفقة.'],
  offers:     ['🔥', 'أفكار عروض', 'اقترح 7 عروض وحملات (خصم، باقة، ضمان، حصرية) مع حساب بسيط للربحية إن توفرت الأرقام.'],
  audience:   ['👥', 'تحديد الجمهور', 'حدد 5 شرائح جمهور مستهدف لإعلانات ميتا مع الاهتمامات والعمر والموقع ورسالة لكل شريحة.'],
  calendar:   ['📅', 'خطة محتوى 30 يوماً', 'اكتب جدول محتوى 30 يوماً (يوم/فكرة/نوع المنشور/هدفه) متنوعاً بين تعليمي وبيعي وتفاعلي.'],
  competitor: ['🔍', 'تحليل منافسين', 'حلّل السوق والمنافسين الذين يذكرهم المستخدم: نقاط قوتهم وضعفهم وفرص التميز وزاوية تسويقية مقترحة.'],
  reviews:    ['⭐', 'ردود على التقييمات', 'اكتب ردوداً مهذبة واحترافية على التقييمات المذكورة، السلبية منها بحل واعتذار، والإيجابية بشكر وتشجيع.'],
  email:      ['📧', 'رسائل بريد/SMS', 'اكتب رسالة ترويجية بريدية مع 3 عناوين وصيغة SMS قصيرة.']
};
const DIALECTS = ['العراقية', 'الخليجية', 'المصرية', 'الشامية', 'المغاربية', 'الفصحى المبسطة'];

app.get('/api/tools', auth, (req, res) => res.json({
  dialects: DIALECTS, tools: Object.entries(TOOLS).map(([id, t]) => ({ id, icon: t[0], name: t[1] }))
}));

app.post('/api/tool/run', auth, gate, async (req, res) => {
  try {
    const t = TOOLS[req.body.tool];
    const brief = String(req.body.brief || '').trim().slice(0, 2000);
    const dialect = DIALECTS.includes(req.body.dialect) ? req.body.dialect : DIALECTS[0];
    if (!t) return res.status(400).json({ error: 'أداة غير معروفة' });
    if (brief.length < 5) return res.status(400).json({ error: 'اكتب وصفاً أطول قليلاً' });
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
    const s = status(req.user);
    if (s.toolsUsed >= s.toolLimit) return res.status(429).json({ error: 'بلغت حد الأدوات اليومي', code: 'LIMIT' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6', max_tokens: 3000,
        system: `أنت خبير تسويق رقمي عربي محترف. اكتب باللهجة ${dialect} الطبيعية (وليس بالفصحى الجامدة) بأسلوب بشري مقنع. ` +
          `لا تبالغ بوعود كاذبة ولا تختلق أرقاماً. قدّم أكثر من خيار متنوع، ورتّب النتيجة بعناوين قصيرة وإيموجي، واختم بنصيحة تطبيق واحدة وبأفضل خيار توصي به ولماذا. أخرج النتيجة جاهزة للاستخدام بدون مقدمات. المهمة: ${t[2]}`,
        messages: [{ role: 'user', content: brief }]
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: d.error?.message || 'خطأ في خدمة الذكاء الاصطناعي' });
    bump(req.user, 'tools');
    saveDb();
    res.json({ text: (d.content || []).map((c) => c.text || '').join('\n'), me: status(req.user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- إنتاج الإعلان ----------
function downloadFile(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    https.get(url, (r) => {
      if ([301, 302].includes(r.statusCode)) return downloadFile(r.headers.location, dest, hops + 1).then(resolve, reject);
      if (r.statusCode !== 200) return reject(new Error('download failed ' + r.statusCode));
      const f = fs.createWriteStream(dest);
      r.pipe(f);
      f.on('finish', () => f.close(resolve));
    }).on('error', reject);
  });
}

app.post('/api/start-production', auth, gate, async (req, res) => {
  try {
    const { imageBase64, productName, offer, script, voiceId, musicType, customMusicBase64 } = req.body;
    if (!REPLICATE_API_TOKEN) return res.status(500).json({ error: 'REPLICATE_API_TOKEN غير مضبوط' });
    if (!imageBase64) return res.status(400).json({ error: 'يرجى رفع صورة المنتج أولاً.' });
    if (!script) return res.status(400).json({ error: 'يرجى كتابة نص السيناريو.' });

    const taskId = 'job_' + Date.now();
    const taskDir = path.join(TEMP_DIR, taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    const voiceJob = (async () => {
      if (!ELEVEN_API_KEY) return;
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId || 'nPczCjzI2devNBz1zQrb'}`, {
        method: 'POST',
        headers: { 'xi-api-key': ELEVEN_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: script, model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.4, similarity_boost: 0.88, style: 0.4, use_speaker_boost: true } })
      });
      if (r.ok) fs.writeFileSync(path.join(taskDir, 'voice.mp3'), Buffer.from(await r.arrayBuffer()));
    })().catch((e) => console.error('TTS', e.message));

    const prompt = `Cinematic commercial video showcase, professional model holding and gracefully displaying ${productName || 'luxury product'} close-up to camera, elegant luxury studio lighting, 4k ultra-detailed, slow motion, crisp reflections, realistic textures.`;
    const repJob = fetch('https://api.replicate.com/v1/models/minimax/video-01/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { prompt, first_frame_image: imageBase64, prompt_optimizer: true } })
    });

    // ننتظر الاثنين معاً حتى لا يبدأ المونتاج قبل جاهزية الصوت (كانت هذه مشكلة في النسخة القديمة)
    const [repResp] = await Promise.all([repJob, voiceJob]);
    const prediction = await repResp.json();
    if (!repResp.ok || prediction.error) {
      return res.status(repResp.status || 500).json({ error: prediction.detail || prediction.error || 'خطأ في Replicate' });
    }
    if (customMusicBase64) {
      fs.writeFileSync(path.join(taskDir, 'custom_music.mp3'),
        Buffer.from(customMusicBase64.replace(/^data:audio\/\w+;base64,/, ''), 'base64'));
    }
    fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({
      id: taskId, uid: req.user.id, predictionId: prediction.id, productName, offer,
      musicType: musicType || 'luxury', status: 'processing', created: Date.now() }));

    const u = req.user;
    bump(u, 'count');
    saveDb();
    res.json({ success: true, taskId, predictionId: prediction.id });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

function loadTask(req, res) {
  const { taskId } = req.query;
  const p = safeId(taskId) && path.join(TEMP_DIR, taskId, 'task.json');
  if (!p || !fs.existsSync(p)) { res.status(404).json({ error: 'Task not found' }); return null; }
  const t = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (t.uid !== req.user.id) { res.status(403).json({ error: 'غير مسموح' }); return null; }
  return { t, p };
}

app.get('/api/check-task-status', auth, async (req, res) => {
  try {
    const x = loadTask(req, res);
    if (!x) return;
    const { t, p } = x;
    const save = () => fs.writeFileSync(p, JSON.stringify(t));
    if (t.status === 'completed') return res.json({ status: 'completed', videoUrl: `/api/download-ad?taskId=${t.id}` });
    if (t.status === 'failed') return res.json({ status: 'failed', error: t.error || 'فشلت المعالجة' });
    if (t.status === 'rendering_ffmpeg') return res.json({ status: 'rendering_ffmpeg', message: 'جاري دمج الصوت والموسيقى...' });

    const pred = await (await fetch(`https://api.replicate.com/v1/predictions/${t.predictionId}`,
      { headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` } })).json();

    if (pred.status === 'succeeded' && pred.output) {
      t.status = 'rendering_ffmpeg'; save();
      processVideo(t.id, Array.isArray(pred.output) ? pred.output[0] : pred.output)
        .then(() => { t.status = 'completed'; save(); })
        .catch((e) => { console.error('FFmpeg', e); t.status = 'failed'; t.error = e.message; save(); });
      return res.json({ status: 'rendering_ffmpeg', message: 'جاري دمج الصوت والموسيقى...' });
    }
    if (['failed', 'canceled'].includes(pred.status)) {
      t.status = 'failed'; t.error = pred.error || 'فشل توليد المشهد'; save();
      return res.json({ status: 'failed', error: t.error });
    }
    res.json({ status: 'processing', message: 'جاري توليد المشاهد البصرية...' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function processVideo(taskId, rawUrl) {
  const dir = path.join(TEMP_DIR, taskId);
  const raw = path.join(dir, 'raw.mp4'), voice = path.join(dir, 'voice.mp3'),
    music = path.join(dir, 'custom_music.mp3'), out = path.join(dir, 'final_ad.mp4');
  await downloadFile(rawUrl, raw);
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(raw).inputOptions(['-stream_loop', '3']);
    const hasV = fs.existsSync(voice), hasM = fs.existsSync(music);
    if (hasV) cmd.input(voice);
    if (hasM) cmd.input(music).inputOptions(['-stream_loop', '-1']);
    if (hasV && hasM) {
      cmd.complexFilter(['[1:a]volume=1.0[v]', '[2:a]volume=0.22[m]', '[v][m]amix=inputs=2:duration=first[a]'])
        .outputOptions(['-map', '0:v', '-map', '[a]']);
    } else if (hasV || hasM) cmd.outputOptions(['-map', '0:v', '-map', '1:a']);
    cmd.outputOptions(['-t', '15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'])
      .save(out).on('end', resolve).on('error', reject);
  });
}

app.get('/api/download-ad', auth, (req, res) => {
  const x = loadTask(req, res);
  if (!x) return;
  const f = path.join(TEMP_DIR, x.t.id, 'final_ad.mp4');
  if (!fs.existsSync(f)) return res.status(404).send('الفيديو غير جاهز.');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="ad_15s.mp4"');
  fs.createReadStream(f).pipe(res);
});

// تنظيف المهام الأقدم من 24 ساعة
setInterval(() => {
  for (const d of fs.readdirSync(TEMP_DIR)) {
    const full = path.join(TEMP_DIR, d);
    if (Date.now() - fs.statSync(full).mtimeMs > 864e5) fs.rmSync(full, { recursive: true, force: true });
  }
}, 36e5);

app.get('/healthz', (req, res) => res.send('ok'));
app.listen(PORT, '0.0.0.0', () => console.log('AdStudio online on port ' + PORT));
// END OF FILE v4

