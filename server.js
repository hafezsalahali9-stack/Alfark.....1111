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
