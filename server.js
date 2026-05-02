// ============================================================
// HORUS BACKEND v3 — server.js
// ✅ Nodemailer + Gmail — vérification email réelle
// ✅ Admin unique: Policeair114@gmail.com
// ✅ Forgot password par email
// ✅ Vérification email à l'inscription
// ✅ Tous les systèmes précédents conservés
// ============================================================

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const Database   = require('better-sqlite3');
const crypto     = require('crypto');
const https      = require('https');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  JWT_SECRET:             process.env.JWT_SECRET || 'horus-secret-CHANGE-IN-PROD',
  NOWPAYMENTS_API_KEY:    process.env.NOWPAYMENTS_API_KEY || 'YOUR_API_KEY',
  NOWPAYMENTS_IPN_SECRET: process.env.NOWPAYMENTS_IPN_SECRET || 'YOUR_IPN_SECRET',
  BASE_URL:               process.env.BASE_URL || 'https://horus-backend-production.up.railway.app',
  PLATFORM_NAME:          'Horus',

  // ── Email (Gmail + Nodemailer) ──
  GMAIL_USER:     process.env.GMAIL_USER     || 'Policeair114@gmail.com',
  GMAIL_PASS:     process.env.GMAIL_APP_PASS || 'YOUR_GMAIL_APP_PASSWORD',

  // ── Admin unique ──
  ADMIN_EMAIL:    'policeair114@gmail.com',

  // ── Finance ──
  SIGNAL_PROFIT_PCT:  1.35,
  REF_PARRAIN_PCT:    10,
  REF_FILLEUL_PCT:    5,
  WITHDRAW_FEE_PCT:   19,
  MIN_DEPOSIT:        30,
  MIN_WITHDRAW:       20,
  SUB_PRICE:          4.99,

  // ── Code expiry ──
  CODE_EXPIRES_MIN: 15,
};

// ─── NODEMAILER SETUP ─────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: CONFIG.GMAIL_USER,
    pass: CONFIG.GMAIL_PASS,
  },
});

// Vérifier la connexion email au démarrage
transporter.verify((err, success) => {
  if (err) {
    console.error('❌ Email connection failed:', err.message);
    console.log('   → Check GMAIL_USER and GMAIL_APP_PASS in Railway variables');
  } else {
    console.log('✅ Email service ready — Gmail connected');
  }
});

// ─── EMAIL TEMPLATES ─────────────────────────────────────────
function emailTemplate(title, content) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><style>
  body{font-family:Arial,sans-serif;background:#0e0e0e;margin:0;padding:20px}
  .card{max-width:480px;margin:0 auto;background:#1e1e1e;border-radius:16px;border:1px solid #333;overflow:hidden}
  .header{background:linear-gradient(135deg,#1a1000,#2a1800);padding:28px 28px 20px;text-align:center;border-bottom:1px solid #f5a623}
  .logo{font-size:28px;font-weight:900;letter-spacing:6px;color:#f5a623;margin-bottom:4px}
  .logo-sub{font-size:10px;color:#888;letter-spacing:3px}
  .body{padding:28px}
  .title{font-size:20px;font-weight:700;color:#f0f0f0;margin-bottom:12px}
  .text{font-size:14px;color:#aaa;line-height:1.7;margin-bottom:16px}
  .code-box{background:#141414;border:2px solid #f5a623;border-radius:12px;padding:20px;text-align:center;margin:20px 0}
  .code{font-family:'Courier New',monospace;font-size:36px;font-weight:900;color:#f5a623;letter-spacing:10px}
  .code-note{font-size:12px;color:#666;margin-top:8px}
  .btn{display:inline-block;background:linear-gradient(135deg,#ffc84a,#f5a623);color:#000;font-weight:800;font-size:14px;padding:14px 32px;border-radius:10px;text-decoration:none;margin:16px 0}
  .footer{background:#141414;padding:16px 28px;text-align:center;font-size:11px;color:#555;border-top:1px solid #222}
  .divider{height:1px;background:#333;margin:16px 0}
  .highlight{color:#f5a623;font-weight:700}
  .warn{background:#1a0500;border:1px solid #f6465d;border-radius:8px;padding:12px;font-size:12px;color:#f6465d;margin-top:12px}
</style></head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo">HORUS</div>
      <div class="logo-sub">INVESTMENT PLATFORM</div>
    </div>
    <div class="body">
      <div class="title">${title}</div>
      ${content}
    </div>
    <div class="footer">
      © 2025 Horus Investment Platform • horuswealth.io<br/>
      This email was sent automatically. Do not reply.
    </div>
  </div>
</body>
</html>`;
}

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: `"Horus Platform 🦅" <${CONFIG.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`[EMAIL] Sent to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[EMAIL] Failed to ${to}:`, err.message);
    return false;
  }
}

// ─── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── DATABASE ─────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './horus.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id       TEXT UNIQUE NOT NULL,
    name             TEXT NOT NULL,
    email            TEXT UNIQUE NOT NULL,
    phone            TEXT,
    password_hash    TEXT NOT NULL,
    email_verified   INTEGER DEFAULT 0,
    kyc_status       TEXT DEFAULT 'pending',
    account_status   TEXT DEFAULT 'active',
    referral_code    TEXT UNIQUE NOT NULL,
    referred_by      TEXT,
    balance          REAL DEFAULT 0,
    invested         REAL DEFAULT 0,
    total_profit     REAL DEFAULT 0,
    role             TEXT DEFAULT 'user',
    has_subscription INTEGER DEFAULT 0,
    sub_expires_at   DATETIME,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login       DATETIME
  );
  CREATE TABLE IF NOT EXISTS email_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL,
    code       TEXT NOT NULL,
    type       TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    used       INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS deposits (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,
    payment_id          TEXT UNIQUE,
    order_id            TEXT,
    amount_usd          REAL NOT NULL,
    currency            TEXT DEFAULT 'USDT',
    pay_address         TEXT,
    network             TEXT,
    status              TEXT DEFAULT 'pending',
    confirmed_at        DATETIME,
    referral_bonus_paid INTEGER DEFAULT 0,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL,
    amount_usd     REAL NOT NULL,
    fee_usd        REAL NOT NULL,
    net_usd        REAL NOT NULL,
    currency       TEXT DEFAULT 'USDT',
    wallet_address TEXT NOT NULL,
    status         TEXT DEFAULT 'pending',
    admin_note     TEXT,
    processed_at   DATETIME,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset       TEXT NOT NULL,
    direction   TEXT NOT NULL,
    entry_price REAL,
    take_profit REAL,
    stop_loss   REAL,
    profit_pct  REAL NOT NULL DEFAULT 1.35,
    status      TEXT DEFAULT 'active',
    expires_at  DATETIME,
    result      TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS signal_confirmations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id    INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    profit_usd   REAL NOT NULL,
    auto_confirm INTEGER DEFAULT 0,
    confirmed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(signal_id, user_id),
    FOREIGN KEY (signal_id) REFERENCES signals(id),
    FOREIGN KEY (user_id)   REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    type          TEXT NOT NULL,
    amount        REAL NOT NULL,
    description   TEXT,
    ref_id        INTEGER,
    balance_after REAL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL UNIQUE,
    payment_id TEXT,
    amount_usd REAL DEFAULT 4.99,
    starts_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    status     TEXT DEFAULT 'active',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ─── HELPERS ─────────────────────────────────────────────────
function genAccountId() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const l1 = L[Math.floor(Math.random() * L.length)];
  const l2 = L[Math.floor(Math.random() * L.length)];
  const num = String(Math.floor(Math.random() * 9000) + 1000);
  return `HR-${l1}${l2}${num}`;
}
function genRefCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let c = 'HR-';
  for (let i = 0; i < 6; i++) c += L[Math.floor(Math.random() * L.length)];
  return c;
}
function gen6Code() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function logTx(uid, type, amount, desc, refId, balAfter) {
  db.prepare('INSERT INTO transactions(user_id,type,amount,description,ref_id,balance_after)VALUES(?,?,?,?,?,?)')
    .run(uid, type, amount, desc, refId || null, balAfter || 0);
}
function isAdmin(email) {
  return email?.toLowerCase() === CONFIG.ADMIN_EMAIL.toLowerCase();
}

// ─── NOWPAYMENTS HELPER ───────────────────────────────────────
function npRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.nowpayments.io',
      path: `/v1${path}`,
      method,
      headers: {
        'x-api-key': CONFIG.NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('NP JSON: ' + raw)); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(h.slice(7), CONFIG.JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Invalid token' }); }
}
function adminAuth(req, res, next) {
  auth(req, res, () => {
    const u = db.prepare('SELECT email FROM users WHERE id=?').get(req.user.id);
    if (!u || !isAdmin(u.email)) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ════════════════════════════════════════════════════════════
// ── EMAIL VERIFICATION ROUTES ────────────────────────────────
// ════════════════════════════════════════════════════════════

// POST /api/auth/send-verification — Envoyer code email
app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const code = gen6Code();
    const expiresAt = new Date(Date.now() + CONFIG.CODE_EXPIRES_MIN * 60 * 1000).toISOString();

    // Invalider anciens codes
    db.prepare("UPDATE email_codes SET used=1 WHERE email=? AND type='verification' AND used=0")
      .run(email.toLowerCase());

    // Sauvegarder nouveau code
    db.prepare('INSERT INTO email_codes(email,code,type,expires_at)VALUES(?,?,?,?)')
      .run(email.toLowerCase(), code, 'verification', expiresAt);

    // Envoyer email
    const html = emailTemplate('Email Verification 📧', `
      <p class="text">Welcome to <span class="highlight">Horus Investment Platform</span>! 🦅</p>
      <p class="text">Use the code below to verify your email address:</p>
      <div class="code-box">
        <div class="code">${code}</div>
        <div class="code-note">Expires in ${CONFIG.CODE_EXPIRES_MIN} minutes</div>
      </div>
      <p class="text">If you didn't create an account, please ignore this email.</p>
      <div class="warn">⚠️ Never share this code with anyone.</div>
    `);

    const sent = await sendEmail(email, '🦅 Horus — Verify your email', html);
    if (!sent) return res.status(500).json({ error: 'Failed to send email. Check GMAIL_APP_PASS.' });

    res.json({ message: 'Verification code sent', expiresIn: `${CONFIG.CODE_EXPIRES_MIN} minutes` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Email send failed' });
  }
});

// POST /api/auth/verify-code — Vérifier code
app.post('/api/auth/verify-code', (req, res) => {
  try {
    const { email, code, type = 'verification' } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

    const record = db.prepare(`
      SELECT * FROM email_codes
      WHERE email=? AND code=? AND type=? AND used=0 AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC LIMIT 1
    `).get(email.toLowerCase(), code.toString(), type);

    if (!record) return res.status(400).json({ error: 'Invalid or expired code' });

    // Marquer comme utilisé
    db.prepare('UPDATE email_codes SET used=1 WHERE id=?').run(record.id);

    // Si vérification d'inscription, marquer l'email comme vérifié
    if (type === 'verification') {
      db.prepare('UPDATE users SET email_verified=1 WHERE email=?').run(email.toLowerCase());
    }

    res.json({ message: 'Code verified successfully', verified: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ════════════════════════════════════════════════════════════
// ── REGISTER ────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, referralCode } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 characters' });
    if (!/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: 'Invalid email' });

    if (db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase()))
      return res.status(409).json({ error: 'Email already registered' });

    let referredBy = null;
    if (referralCode) {
      const ref = db.prepare('SELECT id FROM users WHERE referral_code=?').get(referralCode.toUpperCase());
      if (!ref) return res.status(400).json({ error: 'Invalid referral code' });
      referredBy = referralCode.toUpperCase();
    }

    const hash = await bcrypt.hash(password, 12);
    let aid, rc;
    do { aid = genAccountId(); } while (db.prepare('SELECT id FROM users WHERE account_id=?').get(aid));
    do { rc = genRefCode(); } while (db.prepare('SELECT id FROM users WHERE referral_code=?').get(rc));

    // Détection admin automatique
    const role = isAdmin(email) ? 'admin' : 'user';

    const result = db.prepare(`
      INSERT INTO users(account_id,name,email,password_hash,referral_code,referred_by,role)
      VALUES(?,?,?,?,?,?,?)
    `).run(aid, name.trim(), email.toLowerCase().trim(), hash, rc, referredBy, role);

    const token = jwt.sign({ id: result.lastInsertRowid, role }, CONFIG.JWT_SECRET, { expiresIn: '7d' });

    // Envoyer email de vérification automatiquement
    const code = gen6Code();
    const expiresAt = new Date(Date.now() + CONFIG.CODE_EXPIRES_MIN * 60 * 1000).toISOString();
    db.prepare('INSERT INTO email_codes(email,code,type,expires_at)VALUES(?,?,?,?)')
      .run(email.toLowerCase(), code, 'verification', expiresAt);

    const html = emailTemplate('Welcome to Horus! 🦅', `
      <p class="text">Hello <span class="highlight">${name}</span>, welcome to Horus Investment Platform!</p>
      <p class="text">Your account ID is: <span class="highlight">${aid}</span></p>
      <p class="text">Please verify your email with this code:</p>
      <div class="code-box">
        <div class="code">${code}</div>
        <div class="code-note">Expires in ${CONFIG.CODE_EXPIRES_MIN} minutes</div>
      </div>
      <div class="divider"></div>
      <p class="text">Start investing from <span class="highlight">$30 minimum</span> and earn <span class="highlight">+1.35% daily</span> with our professional signals.</p>
      <div class="warn">⚠️ Never share your account credentials or verification code with anyone.</div>
    `);
    sendEmail(email, '🦅 Welcome to Horus — Verify your email', html);

    res.status(201).json({
      message: 'Account created — check your email for verification code',
      token,
      user: {
        id: aid, name, email,
        refCode: rc,
        kycStatus: 'pending',
        role,
        emailVerified: false,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ════════════════════════════════════════════════════════════
// ── LOGIN ───────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email?.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.account_status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact support.' });
    if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });

    db.prepare('UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?').run(user.id);

    // Détection admin par email
    const role = isAdmin(user.email) ? 'admin' : user.role;
    const token = jwt.sign({ id: user.id, role }, CONFIG.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user.account_id,
        name: user.name,
        email: user.email,
        balance: user.balance,
        invested: user.invested,
        profit: user.total_profit,
        kycStatus: user.kyc_status,
        role,
        refCode: user.referral_code,
        hasSubscription: !!user.has_subscription,
        emailVerified: !!user.email_verified,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ════════════════════════════════════════════════════════════
// ── FORGOT PASSWORD ─────────────────────────────────────────
// ════════════════════════════════════════════════════════════

// POST /api/auth/forgot-password — Envoyer code reset
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase());
    // Toujours répondre OK (sécurité — ne pas révéler si email existe)
    if (!user) return res.json({ message: 'If this email exists, a reset code has been sent.' });

    const code = gen6Code();
    const expiresAt = new Date(Date.now() + CONFIG.CODE_EXPIRES_MIN * 60 * 1000).toISOString();

    // Invalider anciens codes reset
    db.prepare("UPDATE email_codes SET used=1 WHERE email=? AND type='reset' AND used=0")
      .run(email.toLowerCase());

    db.prepare('INSERT INTO email_codes(email,code,type,expires_at)VALUES(?,?,?,?)')
      .run(email.toLowerCase(), code, 'reset', expiresAt);

    const html = emailTemplate('Password Reset Request 🔐', `
      <p class="text">Hello <span class="highlight">${user.name}</span>,</p>
      <p class="text">We received a request to reset your Horus account password.</p>
      <p class="text">Use this code to reset your password:</p>
      <div class="code-box">
        <div class="code">${code}</div>
        <div class="code-note">Expires in ${CONFIG.CODE_EXPIRES_MIN} minutes</div>
      </div>
      <p class="text">If you did not request this, please ignore this email. Your password will remain unchanged.</p>
      <div class="warn">⚠️ Never share this code with anyone. Horus will never ask for your code.</div>
    `);

    const sent = await sendEmail(email, '🔐 Horus — Password Reset Code', html);
    if (!sent) return res.status(500).json({ error: 'Failed to send email' });

    res.json({ message: 'If this email exists, a reset code has been sent.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Reset request failed' });
  }
});

// POST /api/auth/reset-password — Réinitialiser mot de passe
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'All fields required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password min 6 characters' });

    const record = db.prepare(`
      SELECT * FROM email_codes
      WHERE email=? AND code=? AND type='reset' AND used=0 AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC LIMIT 1
    `).get(email.toLowerCase(), code.toString());

    if (!record) return res.status(400).json({ error: 'Invalid or expired code' });

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(hash, email.toLowerCase());
    db.prepare('UPDATE email_codes SET used=1 WHERE id=?').run(record.id);

    // Email de confirmation
    const user = db.prepare('SELECT name FROM users WHERE email=?').get(email.toLowerCase());
    const html = emailTemplate('Password Changed ✅', `
      <p class="text">Hello <span class="highlight">${user?.name || ''}</span>,</p>
      <p class="text">Your Horus account password has been successfully changed.</p>
      <p class="text">If you did not make this change, please contact us immediately at <span class="highlight">support@horuswealth.io</span></p>
    `);
    sendEmail(email, '✅ Horus — Password Changed', html);

    res.json({ message: 'Password reset successfully' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// POST /api/user/password — Changer mot de passe (connecté)
app.put('/api/user/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
    if (!await bcrypt.compare(currentPassword || '', user.password_hash)) {
      return res.status(400).json({ error: 'Current password incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
    res.json({ message: 'Password updated' });
  } catch (e) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─── USER ─────────────────────────────────────────────────────
app.get('/api/user/me', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const refs = db.prepare('SELECT account_id,name,created_at,invested FROM users WHERE referred_by=?').all(user.referral_code);
  const earnings = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id=? AND type='referral_bonus'").get(user.id);
  delete user.password_hash;
  const role = isAdmin(user.email) ? 'admin' : user.role;
  res.json({
    ...user, role,
    referrals: refs.map(r => ({
      accountId: r.account_id, name: r.name, joinDate: r.created_at, invested: r.invested,
      earned: parseFloat((r.invested * CONFIG.REF_PARRAIN_PCT / 100).toFixed(2)),
    })),
    referralEarnings: earnings.t,
  });
});

app.get('/api/user/transactions', auth, (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const txs = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(req.user.id, parseInt(limit), offset);
  const total = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE user_id=?').get(req.user.id);
  res.json({ transactions: txs, total: total.c });
});

// ─── DEPOSIT ──────────────────────────────────────────────────
app.post('/api/payments/deposit', auth, async (req, res) => {
  try {
    const { amount, currency = 'usdttrc20' } = req.body;
    if (!amount || parseFloat(amount) < CONFIG.MIN_DEPOSIT)
      return res.status(400).json({ error: `Minimum deposit is $${CONFIG.MIN_DEPOSIT}` });

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const orderId = `HR-DEP-${user.account_id}-${Date.now()}`;

    const payment = await npRequest('POST', '/payment', {
      price_amount: parseFloat(amount),
      price_currency: 'usd',
      pay_currency: currency.toLowerCase(),
      order_id: orderId,
      order_description: `Horus Deposit — ${user.name} (${user.account_id})`,
      ipn_callback_url: `${CONFIG.BASE_URL}/api/webhooks/nowpayments`,
    });

    if (!payment.pay_address) {
      console.error('NowPayments error:', payment);
      return res.status(400).json({ error: 'Payment creation failed — check NowPayments API key', details: payment });
    }

    const result = db.prepare('INSERT INTO deposits(user_id,payment_id,order_id,amount_usd,currency,pay_address,network)VALUES(?,?,?,?,?,?,?)')
      .run(user.id, payment.payment_id || payment.id, orderId, parseFloat(amount), currency.toUpperCase(), payment.pay_address, payment.network || currency);

    const nets = { usdttrc20: 'TRC20 — Tron', usdterc20: 'ERC20 — Ethereum', usdtsol: 'SPL — Solana' };

    // Email confirmation de dépôt initié
    const html = emailTemplate('Deposit Initiated 💰', `
      <p class="text">Hello <span class="highlight">${user.name}</span>,</p>
      <p class="text">Your deposit of <span class="highlight">$${parseFloat(amount).toFixed(2)}</span> has been initiated.</p>
      <p class="text">Network: <span class="highlight">${nets[currency.toLowerCase()] || currency.toUpperCase()}</span></p>
      <p class="text">Send exactly the required amount to the address provided. Your balance will be credited after blockchain confirmation.</p>
    `);
    sendEmail(user.email, '💰 Horus — Deposit Initiated', html);

    res.json({
      depositId: result.lastInsertRowid,
      paymentId: payment.payment_id || payment.id,
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount,
      currency: (payment.pay_currency || currency).toUpperCase(),
      network: nets[currency.toLowerCase()] || currency.toUpperCase(),
      amountUsd: parseFloat(amount),
      status: 'pending',
      expiresAt: payment.valid_until,
      qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payment.pay_address)}&bgcolor=ffffff&color=000000&margin=4`,
    });
  } catch (e) {
    console.error('Deposit:', e.message);
    res.status(500).json({ error: 'Failed to create payment', message: e.message });
  }
});

app.get('/api/payments/deposit/:id', auth, async (req, res) => {
  try {
    const dep = db.prepare('SELECT * FROM deposits WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!dep) return res.status(404).json({ error: 'Not found' });
    if (dep.status === 'confirmed') return res.json({ status: 'confirmed', deposit: dep });
    if (dep.payment_id) {
      const np = await npRequest('GET', `/payment/${dep.payment_id}`);
      if (np.payment_status === 'confirmed' || np.payment_status === 'finished') {
        await processDeposit(dep, dep.user_id);
        const u = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
        return res.json({ status: 'confirmed', deposit: db.prepare('SELECT * FROM deposits WHERE id=?').get(dep.id), newBalance: u.balance });
      }
      return res.json({ status: np.payment_status, deposit: dep });
    }
    res.json({ status: dep.status, deposit: dep });
  } catch (e) {
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ─── PROCESS CONFIRMED DEPOSIT ────────────────────────────────
async function processDeposit(dep, userId) {
  if (dep.status === 'confirmed') return;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) return;

  const newBal = parseFloat((user.balance + dep.amount_usd).toFixed(2));
  const newInv = parseFloat((user.invested + dep.amount_usd).toFixed(2));
  db.prepare('UPDATE users SET balance=?,invested=? WHERE id=?').run(newBal, newInv, user.id);
  db.prepare("UPDATE deposits SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP WHERE id=?").run(dep.id);
  logTx(user.id, 'deposit', dep.amount_usd, 'Crypto deposit confirmed', dep.id, newBal);

  // Email confirmation dépôt
  const html = emailTemplate('Deposit Confirmed! ✅', `
    <p class="text">Hello <span class="highlight">${user.name}</span>,</p>
    <p class="text">Your deposit of <span class="highlight">$${dep.amount_usd.toFixed(2)}</span> has been confirmed on the blockchain.</p>
    <p class="text">Your new balance: <span class="highlight">$${newBal.toFixed(2)}</span></p>
    <p class="text">You can now confirm the daily signal at <span class="highlight">12:00 PM</span> to start earning.</p>
  `);
  sendEmail(user.email, '✅ Horus — Deposit Confirmed', html);

  // Referral bonuses
  if (user.referred_by && !dep.referral_bonus_paid) {
    const parrain = db.prepare('SELECT * FROM users WHERE referral_code=?').get(user.referred_by);
    if (parrain) {
      const pb = parseFloat((dep.amount_usd * CONFIG.REF_PARRAIN_PCT / 100).toFixed(2));
      const pnb = parseFloat((parrain.balance + pb).toFixed(2));
      db.prepare('UPDATE users SET balance=? WHERE id=?').run(pnb, parrain.id);
      logTx(parrain.id, 'referral_bonus', pb, `Commission ${CONFIG.REF_PARRAIN_PCT}% — ${user.name} ($${dep.amount_usd})`, dep.id, pnb);

      const fb = parseFloat((dep.amount_usd * CONFIG.REF_FILLEUL_PCT / 100).toFixed(2));
      const fnb = parseFloat((newBal + fb).toFixed(2));
      db.prepare('UPDATE users SET balance=? WHERE id=?').run(fnb, user.id);
      logTx(user.id, 'referral_welcome_bonus', fb, `Welcome bonus ${CONFIG.REF_FILLEUL_PCT}%`, dep.id, fnb);
      db.prepare('UPDATE deposits SET referral_bonus_paid=1 WHERE id=?').run(dep.id);

      // Email parrain
      const htmlP = emailTemplate('Referral Commission! 🎁', `
        <p class="text">Hello <span class="highlight">${parrain.name}</span>,</p>
        <p class="text">Great news! Your referral <span class="highlight">${user.name}</span> just made a deposit.</p>
        <p class="text">Your commission: <span class="highlight">+$${pb.toFixed(2)}</span> (${CONFIG.REF_PARRAIN_PCT}%)</p>
        <p class="text">New balance: <span class="highlight">$${pnb.toFixed(2)}</span></p>
      `);
      sendEmail(parrain.email, '🎁 Horus — Referral Commission Received', htmlP);
    }
  }
}

// ─── WEBHOOK IPN ──────────────────────────────────────────────
app.post('/api/webhooks/nowpayments', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['x-nowpayments-sig'];
    const body = req.body.toString();
    const sorted = JSON.stringify(JSON.parse(body), Object.keys(JSON.parse(body)).sort());
    const expected = crypto.createHmac('sha512', CONFIG.NOWPAYMENTS_IPN_SECRET).update(sorted).digest('hex');
    if (sig !== expected) { console.warn('[IPN] Invalid sig'); return res.status(401).json({ error: 'Invalid signature' }); }
    const data = JSON.parse(body);
    if (data.payment_status === 'confirmed' || data.payment_status === 'finished') {
      const dep = db.prepare('SELECT * FROM deposits WHERE payment_id=?').get(data.payment_id);
      if (dep && dep.status === 'pending') await processDeposit(dep, dep.user_id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'IPN error' }); }
});

// ─── WITHDRAWAL ───────────────────────────────────────────────
app.post('/api/payments/withdraw', auth, async (req, res) => {
  try {
    const { amount, currency = 'USDT', walletAddress } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!walletAddress || walletAddress.length < 10) return res.status(400).json({ error: 'Valid wallet address required' });
    if (!amount || parseFloat(amount) < CONFIG.MIN_WITHDRAW) return res.status(400).json({ error: `Minimum $${CONFIG.MIN_WITHDRAW}` });
    if (parseFloat(amount) > user.balance) return res.status(400).json({ error: 'Insufficient balance' });
    if (user.kyc_status !== 'verified') return res.status(400).json({ error: 'KYC verification required' });

    const gross = parseFloat(amount);
    const fee = parseFloat((gross * CONFIG.WITHDRAW_FEE_PCT / 100).toFixed(2));
    const net = parseFloat((gross - fee).toFixed(2));
    const newBal = parseFloat((user.balance - gross).toFixed(2));

    db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBal, user.id);
    const r = db.prepare('INSERT INTO withdrawals(user_id,amount_usd,fee_usd,net_usd,currency,wallet_address)VALUES(?,?,?,?,?,?)')
      .run(user.id, gross, fee, net, currency.toUpperCase(), walletAddress);
    logTx(user.id, 'withdrawal', -gross, `Withdrawal — Fee:$${fee} Net:$${net}`, r.lastInsertRowid, newBal);

    // Email confirmation retrait
    const html = emailTemplate('Withdrawal Submitted 💸', `
      <p class="text">Hello <span class="highlight">${user.name}</span>,</p>
      <p class="text">Your withdrawal request has been submitted.</p>
      <p class="text">Gross: <span class="highlight">$${gross.toFixed(2)}</span></p>
      <p class="text">Platform fee (${CONFIG.WITHDRAW_FEE_PCT}%): <span class="highlight">-$${fee.toFixed(2)}</span></p>
      <p class="text">You will receive: <span class="highlight">$${net.toFixed(2)}</span></p>
      <p class="text">Processing time: 24-48 hours after admin approval.</p>
    `);
    sendEmail(user.email, '💸 Horus — Withdrawal Submitted', html);

    res.json({ message: 'Withdrawal submitted', withdrawalId: r.lastInsertRowid, gross, fee, net, newBalance: newBal });
  } catch (e) { res.status(500).json({ error: 'Withdrawal failed' }); }
});

// ─── SIGNALS ─────────────────────────────────────────────────
app.get('/api/signals/active', auth, (req, res) => {
  const sig = db.prepare("SELECT * FROM signals WHERE status='active' AND expires_at>CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1").get();
  if (!sig) return res.json({ signal: null });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const conf = db.prepare('SELECT * FROM signal_confirmations WHERE signal_id=? AND user_id=?').get(sig.id, req.user.id);
  res.json({
    signal: { id: sig.id, asset: sig.asset, direction: sig.direction, entry: sig.entry_price, takeProfit: sig.take_profit, stopLoss: sig.stop_loss, profitPct: sig.profit_pct, expiresAt: sig.expires_at, timeLeft: Math.max(0, Math.floor((new Date(sig.expires_at) - Date.now()) / 1000)) },
    confirmed: !!conf,
    estimatedProfit: user.invested > 0 ? parseFloat((user.invested * sig.profit_pct / 100).toFixed(2)) : 0,
  });
});

app.post('/api/signals/:id/confirm', auth, (req, res) => {
  try {
    const sig = db.prepare("SELECT * FROM signals WHERE id=? AND status='active' AND expires_at>CURRENT_TIMESTAMP").get(req.params.id);
    if (!sig) return res.status(404).json({ error: 'Signal not found or expired' });
    if (db.prepare('SELECT id FROM signal_confirmations WHERE signal_id=? AND user_id=?').get(sig.id, req.user.id))
      return res.status(409).json({ error: 'Already confirmed' });
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!user || user.invested <= 0) return res.status(400).json({ error: 'No active investment' });
    const profit = parseFloat((user.invested * sig.profit_pct / 100).toFixed(2));
    const newBal = parseFloat((user.balance + profit).toFixed(2));
    const newPft = parseFloat((user.total_profit + profit).toFixed(2));
    db.transaction(() => {
      db.prepare('INSERT INTO signal_confirmations(signal_id,user_id,profit_usd,auto_confirm)VALUES(?,?,?,?)').run(sig.id, req.user.id, profit, 0);
      db.prepare('UPDATE users SET balance=?,total_profit=? WHERE id=?').run(newBal, newPft, req.user.id);
      logTx(req.user.id, 'profit', profit, `Signal profit — ${sig.asset} ${sig.direction} (+${sig.profit_pct}%)`, sig.id, newBal);
    })();
    res.json({ message: 'Signal confirmed', profit, newBalance: newBal, totalProfit: newPft });
  } catch (e) { res.status(500).json({ error: 'Confirm failed' }); }
});

app.get('/api/signals/history', auth, (req, res) => {
  const { days = 30 } = req.query;
  const sigs = db.prepare("SELECT s.*,sc.confirmed_at,sc.profit_usd FROM signals s LEFT JOIN signal_confirmations sc ON s.id=sc.signal_id AND sc.user_id=? WHERE s.created_at>=datetime('now',?) ORDER BY s.created_at DESC").all(req.user.id, `-${days} days`);
  res.json({ signals: sigs });
});

// ─── PRICES ──────────────────────────────────────────────────
app.get('/api/prices', async (req, res) => {
  try {
    const data = await new Promise((resolve, reject) => {
      https.get({ hostname: 'api.coingecko.com', path: '/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true', headers: { 'Accept': 'application/json', 'User-Agent': 'HorusWealth/3.0' } }, (r) => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    res.json({ BTC: { price: data.bitcoin?.usd, change24h: data.bitcoin?.usd_24h_change }, ETH: { price: data.ethereum?.usd, change24h: data.ethereum?.usd_24h_change }, SOL: { price: data.solana?.usd, change24h: data.solana?.usd_24h_change }, BNB: { price: data.binancecoin?.usd, change24h: data.binancecoin?.usd_24h_change }, GOLD: { price: 2348.6, change24h: 0.3 }, 'EUR/USD': { price: 1.0821, change24h: -0.2 } });
  } catch (e) { res.status(503).json({ error: 'Price feed unavailable' }); }
});

// ─── SUBSCRIPTION ─────────────────────────────────────────────
app.post('/api/payments/subscribe', auth, async (req, res) => {
  try {
    const { paymentId } = req.body;
    const np = await npRequest('GET', `/payment/${paymentId}`);
    if (np.payment_status !== 'confirmed' && np.payment_status !== 'finished')
      return res.status(400).json({ error: 'Payment not confirmed' });
    const exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET has_subscription=1,sub_expires_at=? WHERE id=?').run(exp, req.user.id);
    db.prepare('INSERT OR REPLACE INTO subscriptions(user_id,payment_id,amount_usd,expires_at,status)VALUES(?,?,?,?,?)').run(req.user.id, paymentId, CONFIG.SUB_PRICE, exp, 'active');
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const html = emailTemplate('VIP Subscription Active! ⚡', `
      <p class="text">Hello <span class="highlight">${user.name}</span>,</p>
      <p class="text">Your VIP Auto-Signal subscription is now active!</p>
      <p class="text">Your daily signals will be confirmed automatically at <span class="highlight">12:00 PM</span>.</p>
      <p class="text">Subscription expires: <span class="highlight">${new Date(exp).toLocaleDateString()}</span></p>
    `);
    sendEmail(user.email, '⚡ Horus — VIP Subscription Activated', html);
    res.json({ message: 'VIP activated', expiresAt: exp });
  } catch (e) { res.status(500).json({ error: 'Subscription failed' }); }
});

// ─── ADMIN ────────────────────────────────────────────────────
app.get('/api/admin/overview', adminAuth, (req, res) => {
  const subs = db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status='active'").get().c;
  res.json({ stats: { totalUsers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='user'").get().c, activeUsers: db.prepare("SELECT COUNT(*) as c FROM users WHERE account_status='active'").get().c, pendingKyc: db.prepare("SELECT COUNT(*) as c FROM users WHERE kyc_status='pending'").get().c, totalDeposited: db.prepare("SELECT COALESCE(SUM(amount_usd),0) as t FROM deposits WHERE status='confirmed'").get().t, totalInvested: db.prepare("SELECT COALESCE(SUM(invested),0) as t FROM users").get().t, totalBalance: db.prepare("SELECT COALESCE(SUM(balance),0) as t FROM users").get().t, totalProfit: db.prepare("SELECT COALESCE(SUM(total_profit),0) as t FROM users").get().t, pendingWithdrawals: db.prepare("SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'").get().c, activeSubscriptions: subs, subRevenue: parseFloat((subs * CONFIG.SUB_PRICE).toFixed(2)) }, recentUsers: db.prepare("SELECT account_id,name,email,kyc_status,balance,created_at FROM users ORDER BY created_at DESC LIMIT 5").all() });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
  const { search = '', page = 1, limit = 20 } = req.query;
  const q = `%${search}%`;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const users = db.prepare("SELECT id,account_id,name,email,kyc_status,account_status,balance,invested,total_profit,referral_code,role,has_subscription,email_verified,created_at FROM users WHERE account_id LIKE ? OR email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(q, q, q, parseInt(limit), offset);
  const total = db.prepare('SELECT COUNT(*) as c FROM users WHERE account_id LIKE ? OR email LIKE ? OR name LIKE ?').get(q, q, q);
  res.json({ users, total: total.c });
});

app.patch('/api/admin/users/:accountId', adminAuth, (req, res) => {
  const { kycStatus, accountStatus } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE account_id=?').get(req.params.accountId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (kycStatus) {
    db.prepare('UPDATE users SET kyc_status=? WHERE id=?').run(kycStatus, user.id);
    // Email notification KYC
    if (kycStatus === 'verified') {
      const html = emailTemplate('KYC Approved! ✅', `<p class="text">Hello <span class="highlight">${user.name}</span>, your identity has been verified. You can now make withdrawals.</p>`);
      sendEmail(user.email, '✅ Horus — KYC Approved', html);
    }
  }
  if (accountStatus) db.prepare('UPDATE users SET account_status=? WHERE id=?').run(accountStatus, user.id);
  res.json({ message: 'User updated' });
});

app.post('/api/admin/signals', adminAuth, (req, res) => {
  const { asset, direction, entry, takeProfit, stopLoss, profitPct = CONFIG.SIGNAL_PROFIT_PCT, expiresMinutes = 30 } = req.body;
  const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000).toISOString();
  const result = db.prepare('INSERT INTO signals(asset,direction,entry_price,take_profit,stop_loss,profit_pct,expires_at)VALUES(?,?,?,?,?,?,?)').run(asset, direction, entry || null, takeProfit || null, stopLoss || null, profitPct, expiresAt);
  const vips = db.prepare("SELECT * FROM users WHERE has_subscription=1 AND account_status='active' AND invested>0").all();
  let autoCount = 0;
  vips.forEach(u => {
    const profit = parseFloat((u.invested * profitPct / 100).toFixed(2));
    try {
      db.prepare('INSERT OR IGNORE INTO signal_confirmations(signal_id,user_id,profit_usd,auto_confirm)VALUES(?,?,?,1)').run(result.lastInsertRowid, u.id, profit);
      db.prepare('UPDATE users SET balance=balance+?,total_profit=total_profit+? WHERE id=?').run(profit, profit, u.id);
      logTx(u.id, 'profit', profit, `Auto-signal VIP — ${asset} ${direction} (+${profitPct}%)`, result.lastInsertRowid, u.balance + profit);
      // Email VIP
      const html = emailTemplate('Signal Auto-Confirmed ⚡', `<p class="text">Hello <span class="highlight">${u.name}</span>, your VIP signal for <span class="highlight">${asset} ${direction}</span> has been automatically confirmed.</p><p class="text">Profit credited: <span class="highlight">+$${profit.toFixed(2)}</span></p>`);
      sendEmail(u.email, '⚡ Horus — VIP Signal Auto-Confirmed', html);
      autoCount++;
    } catch (e) { console.error('Auto-confirm:', e.message); }
  });
  res.status(201).json({ message: 'Signal published', signalId: result.lastInsertRowid, autoConfirmed: autoCount });
});

app.get('/api/admin/withdrawals', adminAuth, (req, res) => {
  const { status = 'pending' } = req.query;
  const wds = db.prepare("SELECT w.*,u.account_id,u.name,u.email FROM withdrawals w JOIN users u ON w.user_id=u.id WHERE w.status=? ORDER BY w.created_at DESC").all(status);
  res.json({ withdrawals: wds });
});

app.post('/api/admin/withdrawals/:id/:action', adminAuth, (req, res) => {
  const wd = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!wd) return res.status(404).json({ error: 'Not found' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(wd.user_id);
  if (req.params.action === 'reject') {
    db.prepare("UPDATE withdrawals SET status='rejected',admin_note=?,processed_at=CURRENT_TIMESTAMP WHERE id=?").run(req.body.note || 'Rejected', req.params.id);
    db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(wd.amount_usd, wd.user_id);
    const u = db.prepare('SELECT balance FROM users WHERE id=?').get(wd.user_id);
    logTx(wd.user_id, 'refund', wd.amount_usd, 'Withdrawal rejected — refunded', wd.id, u.balance);
    const html = emailTemplate('Withdrawal Rejected ❌', `<p class="text">Hello <span class="highlight">${user?.name}</span>, your withdrawal of $${wd.amount_usd.toFixed(2)} has been rejected. The amount has been refunded to your balance. Reason: ${req.body.note || 'Contact support'}.</p>`);
    if (user) sendEmail(user.email, '❌ Horus — Withdrawal Rejected', html);
    return res.json({ message: 'Rejected and refunded' });
  }
  if (req.params.action === 'approve') {
    db.prepare("UPDATE withdrawals SET status='processing',admin_note=?,processed_at=CURRENT_TIMESTAMP WHERE id=?").run(req.body.note || 'Approved', req.params.id);
    const html = emailTemplate('Withdrawal Approved ✅', `<p class="text">Hello <span class="highlight">${user?.name}</span>, your withdrawal of $${wd.net_usd.toFixed(2)} has been approved and is being processed.</p>`);
    if (user) sendEmail(user.email, '✅ Horus — Withdrawal Approved', html);
    return res.json({ message: 'Approved', net: wd.net_usd });
  }
  res.status(400).json({ error: 'Invalid action' });
});

app.get('/api/admin/finance', adminAuth, (req, res) => {
  const ti = db.prepare('SELECT COALESCE(SUM(invested),0) as t FROM users').get().t;
  const monthly = db.prepare("SELECT strftime('%Y-%m',created_at) as month,SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END) as deposits,SUM(CASE WHEN type='profit' THEN amount ELSE 0 END) as profits,SUM(CASE WHEN type='withdrawal' THEN ABS(amount) ELSE 0 END) as withdrawals,SUM(CASE WHEN type='referral_bonus' THEN amount ELSE 0 END) as referrals FROM transactions GROUP BY month ORDER BY month DESC LIMIT 12").all();
  res.json({ totalInvested: ti, reserve: ti * 0.4, active: ti * 0.6, monthlyStats: monthly });
});

// ─── HEALTH ───────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', platform: 'Horus v3', adminEmail: CONFIG.ADMIN_EMAIL, users: db.prepare('SELECT COUNT(*) as c FROM users').get().c, emailService: 'Gmail + Nodemailer', time: new Date().toISOString() });
});

// ─── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║          Horus Backend v3 — EN LIGNE               ║
║          Port: ${PORT}                               ║
║          Admin: policeair114@gmail.com             ║
║          Email: Gmail + Nodemailer ✅              ║
║          Dépôt min: $${CONFIG.MIN_DEPOSIT}                          ║
║          Signal: ${CONFIG.SIGNAL_PROFIT_PCT}% | Parrain: ${CONFIG.REF_PARRAIN_PCT}% | Filleul: ${CONFIG.REF_FILLEUL_PCT}%  ║
╚══════════════════════════════════════════════════════╝`);
});

module.exports = app;
