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
const ELEVEN_API_KEY = (process.env.ELEVEN_API_KEY || '').trim();
const REPLICATE_API_TOKEN = (process.env.REPLICATE_API_TOKEN || '').trim();
const NP_KEY = (process.env.NOWPAYMENTS_API_KEY || '').trim();
const NP_IPN_SECRET = (process.env.NOWPAYMENTS_IPN_SECRET || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.AUTH_SECRET) console.warn('⚠️ عيّن AUTH_SECRET وإلا ستنتهي الجلسات عند كل إعادة تشغيل');

// الخطط: trial مرة واحدة لكل مستخدم
const PLANS = {
  trial:   { name: 'تجربة 3 أيام', price: 3,   days: 3,   daily: 3, tools: 30 },
  monthly: { name: 'شهري',         price: 29,  days: 30,  daily: 10, tools: 150 },
  yearly:  { name: 'سنوي',         price: 249, days: 365, daily: 15, tools: 300 }
};

// ---------- قاعدة بيانات JSON بسيطة (للإنتاج الكبير استخدم PostgreSQL/SQLite) ----------
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : { users: {}, orders: {} };
function saveDb() {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}

// ---------- مصادقة ----------
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (p) => crypto.createHmac('sha256', AUTH_SECRET).update(p).digest('base64url');
function makeToken(uid) {
  const p = b64(JSON.stringify({ uid, exp: Date.now() + 30 * 864e5 }));
  return p + '.' + sign(p);
}
function readToken(t) {
  const [p, s] = (t || '').split('.');
  if (!p || !s || sign(p) !== s) return null;
  const d = JSON.parse(Buffer.from(p, 'base64url').toString());
  return d.exp > Date.now() ? d.uid : null;
}
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hashPw(pw, salt).split(':')[1], 'hex'));
}
function auth(req, res, next) {
  const uid = readToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!uid || !db.users[uid]) return res.status(401).json({ error: 'سجّل الدخول أولاً' });
  req.user = db.users[uid];
  next();
}

const today = () => new Date().toISOString().slice(0, 10);
function status(u) {
  const active = !!u.plan && u.expires > Date.now();
  const used = u.usage && u.usage.date === today() ? u.usage.count : 0;
  const limit = active ? PLANS[u.plan].daily : 0;
  return { email: u.email, surveyDone: !!u.survey, active, plan: u.plan || null, expires: u.expires || null,
    trialUsed: !!u.trialUsed, usedToday: used, dailyLimit: limit,
    toolsUsed: u.usage && u.usage.date === today() ? (u.usage.tools || 0) : 0, toolLimit: active ? PLANS[u.plan].tools : 0 };
}
// بوابة الإنتاج: استبيان مكتمل + اشتراك فعّال + حد يومي
function gate(req, res, next) {
  const s = status(req.user);
  if (!s.surveyDone) return res.status(403).json({ error: 'أكمل الاستبيان لتفعيل حسابك', code: 'SURVEY' });
  if (!s.active) return res.status(402).json({ error: 'يلزم اشتراك فعّال', code: 'SUBSCRIBE' });
  if (s.usedToday >= s.dailyLimit) return res.status(429).json({ error: 'بلغت الحد اليومي لخطتك', code: 'LIMIT' });
  next();
}

app.use(cors());
// IPN يحتاج الجسم كما هو بعد الفرز، فنحلله بشكل عادي
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // لا نعرض server.js ولا temp ولا data

const TEMP_DIR = path.join(__dirname, 'temp');
fs.mkdirSync(TEMP_DIR, { recursive: true });
const safeId = (s) => /^job_\d+$/.test(s || '');

// ---------- حسابات ----------
app.post('/api/register', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 8) return res.status(400).json({ error: 'بريد غير صالح أو كلمة مرور أقل من 8 أحرف' });
  if (Object.values(db.users).some((u) => u.email === email)) return res.status(409).json({ error: 'البريد مسجّل مسبقاً' });
  const id = crypto.randomUUID();
  db.users[id] = { id, email, pass: hashPw(pw), created: Date.now(), survey: null, plan: null, expires: 0, trialUsed: false };
  saveDb();
  res.json({ token: makeToken(id), me: status(db.users[id]) });
});
app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = Object.values(db.users).find((x) => x.email === email);
  if (!u || !checkPw(String(req.body.password || ''), u.pass)) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  res.json({ token: makeToken(u.id), me: status(u) });
});
app.get('/api/me', auth, (req, res) => res.json(status(req.user)));
app.get('/api/plans', (req, res) => res.json(PLANS));

// ---------- استبيان التفعيل ----------
app.post('/api/survey', auth, (req, res) => {
  const a = req.body.answers || {};
  const required = ['business', 'platform', 'budget', 'goal'];
  if (required.some((k) => !String(a[k] || '').trim())) return res.status(400).json({ error: 'أجب على جميع الأسئلة' });
  req.user.survey = Object.fromEntries(required.map((k) => [k, String(a[k]).slice(0, 300)]));
  saveDb();
  res.json(status(req.user));
});

// ---------- الدفع عبر NOWPayments ----------
app.post('/api/checkout', auth, async (req, res) => {
  try {
    const plan = PLANS[req.body.plan];
    if (!plan) return res.status(400).json({ error: 'خطة غير معروفة' });
    if (!status(req.user).surveyDone) return res.status(403).json({ error: 'أكمل الاستبيان أولاً', code: 'SURVEY' });
    if (req.body.plan === 'trial' && req.user.trialUsed) return res.status(400).json({ error: 'استخدمت التجربة مسبقاً' });
    if (!NP_KEY || !BASE_URL) return res.status(500).json({ error: 'إعدادات الدفع ناقصة (NOWPAYMENTS_API_KEY / BASE_URL)' });

    const orderId = `${req.user.id}_${req.body.plan}_${Date.now()}`;
    const r = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': NP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: plan.price, price_currency: 'usd', order_id: orderId,
        order_description: plan.name, ipn_callback_url: BASE_URL + '/api/nowpayments-ipn',
        success_url: BASE_URL + '/?paid=1', cancel_url: BASE_URL + '/?paid=0'
      })
    });
    const inv = await r.json();
    if (!r.ok || !inv.invoice_url) return res.status(502).json({ error: inv.message || 'تعذّر إنشاء فاتورة الدفع' });
    db.orders[orderId] = { uid: req.user.id, plan: req.body.plan, price: plan.price, done: false, created: Date.now() };
    saveDb();
    res.json({ url: inv.invoice_url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const sortObj = (o) => Array.isArray(o) ? o.map(sortObj)
  : o && typeof o === 'object' ? Object.keys(o).sort().reduce((a, k) => (a[k] = sortObj(o[k]), a), {}) : o;

app.post('/api/nowpayments-ipn', (req, res) => {
  const sig = String(req.headers['x-nowpayments-sig'] || '');
  const calc = crypto.createHmac('sha512', NP_IPN_SECRET).update(JSON.stringify(sortObj(req.body))).digest('hex');
  if (!NP_IPN_SECRET || sig.length !== calc.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc)))
    return res.status(401).send('bad signature');

  const o = db.orders[req.body.order_id];
  if (o && !o.done && req.body.payment_status === 'finished') {
    const u = db.users[o.uid];
    const p = PLANS[o.plan];
    if (u && p) {
      const base = u.expires > Date.now() ? u.expires : Date.now();
      u.plan = o.plan;
      u.expires = base + p.days * 864e5;
      if (o.plan === 'trial') u.trialUsed = true;
      o.done = true;
      saveDb();
    }
  }
  res.send('ok');
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
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6', max_tokens: 1500,
        system: `أنت خبير تسويق رقمي عربي محترف. اكتب باللهجة ${dialect} الطبيعية (وليس بالفصحى الجامدة) بأسلوب بشري مقنع. ` +
          `لا تبالغ بوعود كاذبة ولا تختلق أرقاماً. أخرج النتيجة جاهزة للاستخدام بدون مقدمات. المهمة: ${t[2]}`,
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

app.listen(PORT, () => console.log('AdStudio online on port ' + PORT));
