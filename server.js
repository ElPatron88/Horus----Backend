// ============================================================
// CARIBEFUND BACKEND v2 — server.js
// Node.js + Express + SQLite + JWT + NowPayments COMPLET
//
// CORRECTIONS v2:
// ✅ Dépôt minimum $30
// ✅ Taux signal 1.35%
// ✅ Parrain reçoit 10% du dépôt du filleul
// ✅ Filleul reçoit 5% bonus de bienvenue
// ✅ Adresse de dépôt unique par paiement via NowPayments
// ✅ Webhook IPN sécurisé HMAC-SHA512
// ✅ Frais retrait 19% calculés automatiquement
// ✅ Abonnement VIP 4.99 USDT/mois
// ============================================================

const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const https    = require('https');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  JWT_SECRET:              process.env.JWT_SECRET || 'caribefund-secret-CHANGE-IN-PROD-32chars',
  NOWPAYMENTS_API_KEY:     process.env.NOWPAYMENTS_API_KEY || 'YOUR_API_KEY',
  NOWPAYMENTS_IPN_SECRET:  process.env.NOWPAYMENTS_IPN_SECRET || 'YOUR_IPN_SECRET',
  NOWPAYMENTS_BASE_URL:    'https://api.nowpayments.io/v1',
  BASE_URL:                process.env.BASE_URL || 'http://177.7.41.4:3001',
  PLATFORM_NAME:           'CaribeFund',

  // ── Financials ──
  SIGNAL_PROFIT_PCT:   1.35,   // Daily signal return %
  REF_PARRAIN_PCT:     10,     // Parrain gets 10% of filleul deposit
  REF_FILLEUL_PCT:     5,      // Filleul gets 5% welcome bonus
  WITHDRAW_FEE_PCT:    19,     // Platform withdrawal fee %
  MIN_DEPOSIT:         30,     // Minimum deposit USD
  MIN_WITHDRAW:        20,     // Minimum withdrawal USD
  SUB_PRICE:           4.99,   // VIP subscription monthly price USD
  DRAWDOWN_LIMIT:      20,     // Max loss % before trading stops
};

// ─── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── DATABASE ─────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './caribefund.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    email           TEXT UNIQUE NOT NULL,
    phone           TEXT,
    password_hash   TEXT NOT NULL,
    kyc_status      TEXT DEFAULT 'pending',
    account_status  TEXT DEFAULT 'active',
    referral_code   TEXT UNIQUE NOT NULL,
    referred_by     TEXT,
    balance         REAL DEFAULT 0,
    invested        REAL DEFAULT 0,
    total_profit    REAL DEFAULT 0,
    role            TEXT DEFAULT 'user',
    country         TEXT DEFAULT 'Haiti',
    id_type         TEXT,
    id_number       TEXT,
    has_subscription INTEGER DEFAULT 0,
    sub_expires_at  DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login      DATETIME
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    payment_id      TEXT UNIQUE,
    order_id        TEXT,
    amount_usd      REAL NOT NULL,
    amount_crypto   REAL,
    currency        TEXT DEFAULT 'USDT',
    pay_address     TEXT,
    network         TEXT,
    status          TEXT DEFAULT 'pending',
    confirmed_at    DATETIME,
    referral_bonus_paid INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    amount_usd      REAL NOT NULL,
    fee_usd         REAL NOT NULL,
    net_usd         REAL NOT NULL,
    currency        TEXT DEFAULT 'USDT',
    wallet_address  TEXT NOT NULL,
    status          TEXT DEFAULT 'pending',
    admin_note      TEXT,
    processed_at    DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
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
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    type        TEXT NOT NULL,
    amount      REAL NOT NULL,
    description TEXT,
    ref_id      INTEGER,
    balance_after REAL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL UNIQUE,
    payment_id  TEXT,
    amount_usd  REAL DEFAULT 4.99,
    starts_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at  DATETIME,
    status      TEXT DEFAULT 'active',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ─── HELPERS ─────────────────────────────────────────────────
function genAccountId() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const l1 = letters[Math.floor(Math.random() * letters.length)];
  const l2 = letters[Math.floor(Math.random() * letters.length)];
  const num = String(Math.floor(Math.random() * 9000) + 1000);
  return `CF-${l1}${l2}${num}`;
}
function genRefCode() {
  return 'CF-' + Math.random().toString(36).toUpperCase().slice(2, 8);
}
function logTransaction(userId, type, amount, description, refId, balanceAfter) {
  db.prepare(`
    INSERT INTO transactions (user_id, type, amount, description, ref_id, balance_after)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, type, amount, description, refId || null, balanceAfter || 0);
}

// ─── NOWPAYMENTS API HELPER ───────────────────────────────────
function nowpaymentsRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.nowpayments.io',
      path: `/v1${path}`,
      method,
      headers: {
        'x-api-key': CONFIG.NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Invalid JSON from NowPayments: ' + raw)); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), CONFIG.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

// ─── AUTH ROUTES ─────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password, referralCode } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    // Validate referral code if provided
    let referredBy = null;
    if (referralCode) {
      const referrer = db.prepare('SELECT id, account_id FROM users WHERE referral_code = ?').get(referralCode.toUpperCase());
      if (!referrer) return res.status(400).json({ error: 'Invalid referral code' });
      referredBy = referralCode.toUpperCase();
    }

    const hash = await bcrypt.hash(password, 12);
    let accountId, refCode;

    // Ensure unique IDs
    do { accountId = genAccountId(); } while (db.prepare('SELECT id FROM users WHERE account_id = ?').get(accountId));
    do { refCode = genRefCode(); } while (db.prepare('SELECT id FROM users WHERE referral_code = ?').get(refCode));

    const result = db.prepare(`
      INSERT INTO users (account_id, name, email, phone, password_hash, referral_code, referred_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(accountId, name.trim(), email.toLowerCase().trim(), phone || null, hash, refCode, referredBy);

    const token = jwt.sign({ id: result.lastInsertRowid, role: 'user' }, CONFIG.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: { id: accountId, name, email, refCode, kycStatus: 'pending' },
    });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.account_status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

    const token = jwt.sign({ id: user.id, role: user.role }, CONFIG.JWT_SECRET, { expiresIn: '7d' });

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
        role: user.role,
        refCode: user.referral_code,
        hasSubscription: !!user.has_subscription,
      },
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/user/me
app.get('/api/user/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const referrals = db.prepare(`
    SELECT account_id, name, created_at, invested
    FROM users WHERE referred_by = ?
  `).all(user.referral_code);

  const refEarnings = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM transactions WHERE user_id = ? AND type = 'referral_bonus'
  `).get(user.id);

  delete user.password_hash;
  res.json({
    ...user,
    referrals: referrals.map(r => ({
      accountId: r.account_id,
      name: r.name,
      joinDate: r.created_at,
      invested: r.invested,
      earned: parseFloat((r.invested * CONFIG.REF_PARRAIN_PCT / 100).toFixed(2)),
    })),
    referralEarnings: refEarnings.total,
  });
});

// GET /api/user/transactions
app.get('/api/user/transactions', authMiddleware, (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const txs = db.prepare(`
    SELECT * FROM transactions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(req.user.id, parseInt(limit), offset);
  const total = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE user_id = ?').get(req.user.id);
  res.json({ transactions: txs, total: total.c, page: parseInt(page) });
});

// ─── DEPOSIT ROUTES ───────────────────────────────────────────

// POST /api/payments/deposit — Create NowPayments invoice → unique address per payment
app.post('/api/payments/deposit', authMiddleware, async (req, res) => {
  try {
    const { amount, currency = 'usdttrc20' } = req.body;

    if (!amount || parseFloat(amount) < CONFIG.MIN_DEPOSIT) {
      return res.status(400).json({ error: `Minimum deposit is $${CONFIG.MIN_DEPOSIT}` });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const orderId = `CF-DEP-${user.account_id}-${Date.now()}`;
    const webhookUrl = `${CONFIG.BASE_URL}/api/webhooks/nowpayments`;

    // ── Call NowPayments API to get unique crypto address ──
    const payment = await nowpaymentsRequest('POST', '/payment', {
      price_amount:      parseFloat(amount),
      price_currency:    'usd',
      pay_currency:      currency.toLowerCase(),
      order_id:          orderId,
      order_description: `CaribeFund Deposit — ${user.name} (${user.account_id})`,
      ipn_callback_url:  webhookUrl,
      is_fixed_rate:     false,
      is_fee_paid_by_user: false,
    });

    if (!payment.pay_address) {
      console.error('NowPayments response:', payment);
      return res.status(400).json({ error: 'Payment creation failed — check API key', details: payment });
    }

    // ── Save deposit to DB ──
    const result = db.prepare(`
      INSERT INTO deposits (user_id, payment_id, order_id, amount_usd, currency, pay_address, network)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      payment.payment_id || payment.id,
      orderId,
      parseFloat(amount),
      currency.toUpperCase(),
      payment.pay_address,
      payment.network || currency
    );

    // ── Return everything the frontend needs ──
    const networkLabels = {
      usdttrc20: 'TRC20 — Tron',
      usdterc20: 'ERC20 — Ethereum',
      btc:       'Bitcoin Network',
      eth:       'Ethereum Network',
      sol:       'Solana Network',
      bnbbsc:    'BNB Smart Chain',
    };

    res.json({
      depositId:   result.lastInsertRowid,
      paymentId:   payment.payment_id || payment.id,
      payAddress:  payment.pay_address,
      payAmount:   payment.pay_amount,
      currency:    payment.pay_currency?.toUpperCase() || currency.toUpperCase(),
      network:     networkLabels[currency.toLowerCase()] || currency.toUpperCase(),
      amountUsd:   parseFloat(amount),
      status:      'pending',
      expiresAt:   payment.valid_until,
      qrCode:      `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payment.pay_address)}&bgcolor=ffffff&color=000000&margin=4`,
    });

  } catch (err) {
    console.error('Deposit error:', err.message);
    res.status(500).json({ error: 'Failed to create payment', message: err.message });
  }
});

// GET /api/payments/deposit/:id — Poll status
app.get('/api/payments/deposit/:id', authMiddleware, async (req, res) => {
  try {
    const deposit = db.prepare(`
      SELECT * FROM deposits WHERE id = ? AND user_id = ?
    `).get(req.params.id, req.user.id);

    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
    if (deposit.status === 'confirmed') {
      return res.json({ status: 'confirmed', deposit });
    }

    // ── Check live status from NowPayments ──
    if (deposit.payment_id) {
      const npStatus = await nowpaymentsRequest('GET', `/payment/${deposit.payment_id}`);
      const s = npStatus.payment_status;

      if (s === 'confirmed' || s === 'finished') {
        await processConfirmedDeposit(deposit, req.user.id);
        const updated = db.prepare('SELECT * FROM deposits WHERE id = ?').get(deposit.id);
        const user    = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
        return res.json({ status: 'confirmed', deposit: updated, newBalance: user.balance });
      }

      return res.json({ status: s, deposit });
    }

    res.json({ status: deposit.status, deposit });

  } catch (err) {
    console.error('Check deposit error:', err.message);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// ─── PROCESS CONFIRMED DEPOSIT (shared logic) ─────────────────
async function processConfirmedDeposit(deposit, userId) {
  // Avoid double credit
  if (deposit.status === 'confirmed') return;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return;

  // ① Credit user balance
  const newBalance  = parseFloat((user.balance + deposit.amount_usd).toFixed(2));
  const newInvested = parseFloat((user.invested + deposit.amount_usd).toFixed(2));

  db.prepare('UPDATE users SET balance = ?, invested = ? WHERE id = ?')
    .run(newBalance, newInvested, user.id);
  db.prepare(`UPDATE deposits SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(deposit.id);

  logTransaction(user.id, 'deposit', deposit.amount_usd, 'Crypto deposit confirmed', deposit.id, newBalance);

  // ② Referral bonuses (only once)
  if (user.referred_by && !deposit.referral_bonus_paid) {
    const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(user.referred_by);

    if (referrer) {
      // Parrain gets 10%
      const parrainBonus = parseFloat((deposit.amount_usd * CONFIG.REF_PARRAIN_PCT / 100).toFixed(2));
      const parrainNewBal = parseFloat((referrer.balance + parrainBonus).toFixed(2));
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(parrainNewBal, referrer.id);
      logTransaction(
        referrer.id, 'referral_bonus', parrainBonus,
        `Commission parrainage (${CONFIG.REF_PARRAIN_PCT}%) — dépôt de ${user.name} ($${deposit.amount_usd})`,
        deposit.id, parrainNewBal
      );

      // Filleul gets 5% welcome bonus
      const filleulBonus   = parseFloat((deposit.amount_usd * CONFIG.REF_FILLEUL_PCT / 100).toFixed(2));
      const filleulNewBal  = parseFloat((newBalance + filleulBonus).toFixed(2));
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(filleulNewBal, user.id);
      logTransaction(
        user.id, 'referral_welcome_bonus', filleulBonus,
        `Bonus de bienvenue filleul (${CONFIG.REF_FILLEUL_PCT}%)`,
        deposit.id, filleulNewBal
      );

      // Mark bonuses as paid
      db.prepare('UPDATE deposits SET referral_bonus_paid = 1 WHERE id = ?').run(deposit.id);

      console.log(`[REFERRAL] Parrain ${referrer.account_id} +$${parrainBonus} | Filleul ${user.account_id} +$${filleulBonus}`);
    }
  }
}

// ─── WEBHOOK — NOWPAYMENTS IPN ────────────────────────────────
app.post('/api/webhooks/nowpayments', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    const bodyStr   = req.body.toString();

    // ── Verify HMAC-SHA512 signature ──
    const sorted    = JSON.stringify(JSON.parse(bodyStr), Object.keys(JSON.parse(bodyStr)).sort());
    const expected  = crypto.createHmac('sha512', CONFIG.NOWPAYMENTS_IPN_SECRET).update(sorted).digest('hex');

    if (signature !== expected) {
      console.warn('[IPN] Invalid signature — possible fake webhook');
      return res.status(401).json({ error: 'Invalid IPN signature' });
    }

    const data = JSON.parse(bodyStr);
    console.log(`[IPN] payment_id=${data.payment_id} status=${data.payment_status}`);

    if (data.payment_status === 'confirmed' || data.payment_status === 'finished') {
      const deposit = db.prepare('SELECT * FROM deposits WHERE payment_id = ?').get(data.payment_id);
      if (deposit && deposit.status === 'pending') {
        await processConfirmedDeposit(deposit, deposit.user_id);
        console.log(`[IPN] Deposit #${deposit.id} confirmed — $${deposit.amount_usd}`);
      }
    }

    res.json({ ok: true });

  } catch (err) {
    console.error('[IPN] Error:', err.message);
    res.status(500).json({ error: 'IPN processing error' });
  }
});

// ─── WITHDRAWAL ───────────────────────────────────────────────

// POST /api/payments/withdraw
app.post('/api/payments/withdraw', authMiddleware, async (req, res) => {
  try {
    const { amount, currency = 'USDT', walletAddress } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (!walletAddress || walletAddress.length < 10) {
      return res.status(400).json({ error: 'Valid wallet address required' });
    }
    if (!amount || parseFloat(amount) < CONFIG.MIN_WITHDRAW) {
      return res.status(400).json({ error: `Minimum withdrawal is $${CONFIG.MIN_WITHDRAW}` });
    }
    if (parseFloat(amount) > user.balance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    if (user.kyc_status !== 'verified') {
      return res.status(400).json({ error: 'KYC verification required to withdraw' });
    }
    if (user.account_status !== 'active') {
      return res.status(403).json({ error: 'Account suspended' });
    }

    const gross    = parseFloat(amount);
    const fee      = parseFloat((gross * CONFIG.WITHDRAW_FEE_PCT / 100).toFixed(2));
    const net      = parseFloat((gross - fee).toFixed(2));
    const newBal   = parseFloat((user.balance - gross).toFixed(2));

    // Deduct from balance (hold pending admin approval)
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBal, user.id);

    const result = db.prepare(`
      INSERT INTO withdrawals (user_id, amount_usd, fee_usd, net_usd, currency, wallet_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, gross, fee, net, currency.toUpperCase(), walletAddress);

    logTransaction(user.id, 'withdrawal', -gross,
      `Withdrawal request — Fee: $${fee} — Net: $${net}`, result.lastInsertRowid, newBal);

    res.json({
      message: 'Withdrawal submitted — pending admin approval (24-48h)',
      withdrawalId: result.lastInsertRowid,
      gross, fee, net,
      newBalance: newBal,
    });

  } catch (err) {
    console.error('Withdrawal error:', err.message);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

// ─── SUBSCRIPTION ─────────────────────────────────────────────

// POST /api/payments/subscribe — Activate VIP subscription after payment
app.post('/api/payments/subscribe', authMiddleware, async (req, res) => {
  try {
    const { paymentId } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    // Verify payment with NowPayments
    const payment = await nowpaymentsRequest('GET', `/payment/${paymentId}`);
    if (payment.payment_status !== 'confirmed' && payment.payment_status !== 'finished') {
      return res.status(400).json({ error: 'Payment not yet confirmed' });
    }

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare('UPDATE users SET has_subscription = 1, sub_expires_at = ? WHERE id = ?')
      .run(expiresAt, user.id);

    db.prepare(`
      INSERT OR REPLACE INTO subscriptions (user_id, payment_id, amount_usd, expires_at, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(user.id, paymentId, CONFIG.SUB_PRICE, expiresAt);

    logTransaction(user.id, 'subscription', -CONFIG.SUB_PRICE,
      'VIP Auto-Signal subscription — 1 month', null, user.balance);

    res.json({ message: 'VIP subscription activated', expiresAt });

  } catch (err) {
    console.error('Subscription error:', err.message);
    res.status(500).json({ error: 'Subscription activation failed' });
  }
});

// ─── SIGNALS ─────────────────────────────────────────────────

// GET /api/signals/active
app.get('/api/signals/active', authMiddleware, (req, res) => {
  const signal = db.prepare(`
    SELECT * FROM signals
    WHERE status = 'active' AND expires_at > CURRENT_TIMESTAMP
    ORDER BY created_at DESC LIMIT 1
  `).get();

  if (!signal) return res.json({ signal: null, message: 'No active signal' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const confirmed = db.prepare(`
    SELECT * FROM signal_confirmations WHERE signal_id = ? AND user_id = ?
  `).get(signal.id, req.user.id);

  const estimatedProfit = user.invested > 0
    ? parseFloat((user.invested * signal.profit_pct / 100).toFixed(2))
    : 0;

  res.json({
    signal: {
      id: signal.id,
      asset: signal.asset,
      direction: signal.direction,
      entry: signal.entry_price,
      takeProfit: signal.take_profit,
      stopLoss: signal.stop_loss,
      profitPct: signal.profit_pct,
      expiresAt: signal.expires_at,
      timeLeft: Math.max(0, Math.floor((new Date(signal.expires_at) - Date.now()) / 1000)),
    },
    confirmed: !!confirmed,
    estimatedProfit,
    confirmedAt: confirmed?.confirmed_at || null,
  });
});

// POST /api/signals/:id/confirm — User confirms signal → profit credited
app.post('/api/signals/:id/confirm', authMiddleware, (req, res) => {
  try {
    const signal = db.prepare(`
      SELECT * FROM signals
      WHERE id = ? AND status = 'active' AND expires_at > CURRENT_TIMESTAMP
    `).get(req.params.id);

    if (!signal) return res.status(404).json({ error: 'Signal not found or expired' });

    const already = db.prepare(`
      SELECT id FROM signal_confirmations WHERE signal_id = ? AND user_id = ?
    `).get(signal.id, req.user.id);
    if (already) return res.status(409).json({ error: 'Already confirmed' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user || user.invested <= 0) {
      return res.status(400).json({ error: 'No active investment' });
    }

    // ── Credit profit based on invested amount × signal rate ──
    const profit     = parseFloat((user.invested * signal.profit_pct / 100).toFixed(2));
    const newBalance = parseFloat((user.balance + profit).toFixed(2));
    const newProfit  = parseFloat((user.total_profit + profit).toFixed(2));

    const creditProfit = db.transaction(() => {
      db.prepare(`
        INSERT INTO signal_confirmations (signal_id, user_id, profit_usd, auto_confirm)
        VALUES (?, ?, ?, ?)
      `).run(signal.id, req.user.id, profit, req.body.auto ? 1 : 0);

      db.prepare('UPDATE users SET balance = ?, total_profit = ? WHERE id = ?')
        .run(newBalance, newProfit, req.user.id);

      logTransaction(req.user.id, 'profit', profit,
        `Signal profit — ${signal.asset} ${signal.direction} (+${signal.profit_pct}%)`,
        signal.id, newBalance);
    });

    creditProfit();
    console.log(`[SIGNAL] User ${user.account_id} +$${profit} (${signal.profit_pct}% × $${user.invested})`);

    res.json({
      message: 'Signal confirmed — profit credited',
      profit,
      newBalance,
      totalProfit: newProfit,
    });

  } catch (err) {
    console.error('Confirm signal error:', err.message);
    res.status(500).json({ error: 'Failed to confirm signal' });
  }
});

// GET /api/signals/history
app.get('/api/signals/history', authMiddleware, (req, res) => {
  const { days = 30 } = req.query;
  const signals = db.prepare(`
    SELECT s.*, sc.confirmed_at, sc.profit_usd, sc.auto_confirm
    FROM signals s
    LEFT JOIN signal_confirmations sc ON s.id = sc.signal_id AND sc.user_id = ?
    WHERE s.created_at >= datetime('now', ?)
    ORDER BY s.created_at DESC
  `).all(req.user.id, `-${days} days`);
  res.json({ signals });
});

// ─── PRICES ──────────────────────────────────────────────────
app.get('/api/prices', async (req, res) => {
  try {
    const data = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.coingecko.com',
        path: '/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true',
        headers: { 'Accept': 'application/json', 'User-Agent': 'CaribeFund/1.0' },
      };
      https.get(opts, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    res.json({
      BTC:       { price: data.bitcoin?.usd,       change24h: data.bitcoin?.usd_24h_change },
      ETH:       { price: data.ethereum?.usd,      change24h: data.ethereum?.usd_24h_change },
      SOL:       { price: data.solana?.usd,        change24h: data.solana?.usd_24h_change },
      BNB:       { price: data.binancecoin?.usd,   change24h: data.binancecoin?.usd_24h_change },
      GOLD:      { price: 2348.6,  change24h: 0.3 },
      'EUR/USD': { price: 1.0821,  change24h: -0.2 },
      'USD/JPY': { price: 154.32,  change24h: 0.5 },
    });
  } catch (e) {
    res.status(503).json({ error: 'Price feed unavailable' });
  }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────

app.get('/api/admin/overview', adminMiddleware, (req, res) => {
  const subs = db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status='active'").get().c;
  res.json({
    stats: {
      totalUsers:            db.prepare("SELECT COUNT(*) as c FROM users WHERE role='user'").get().c,
      activeUsers:           db.prepare("SELECT COUNT(*) as c FROM users WHERE account_status='active' AND role='user'").get().c,
      pendingKyc:            db.prepare("SELECT COUNT(*) as c FROM users WHERE kyc_status='pending'").get().c,
      totalDeposited:        db.prepare("SELECT COALESCE(SUM(amount_usd),0) as t FROM deposits WHERE status='confirmed'").get().t,
      totalInvested:         db.prepare("SELECT COALESCE(SUM(invested),0) as t FROM users").get().t,
      totalBalance:          db.prepare("SELECT COALESCE(SUM(balance),0) as t FROM users").get().t,
      totalProfit:           db.prepare("SELECT COALESCE(SUM(total_profit),0) as t FROM users").get().t,
      pendingWithdrawals:    db.prepare("SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'").get().c,
      pendingWithdrawalAmt:  db.prepare("SELECT COALESCE(SUM(amount_usd),0) as t FROM withdrawals WHERE status='pending'").get().t,
      activeSubscriptions:   subs,
      subRevenue:            parseFloat((subs * CONFIG.SUB_PRICE).toFixed(2)),
      signalWinRate:         72,
    },
    recentUsers: db.prepare(`
      SELECT account_id, name, email, kyc_status, account_status, balance, created_at
      FROM users WHERE role='user' ORDER BY created_at DESC LIMIT 5
    `).all(),
  });
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const { search = '', page = 1, limit = 20 } = req.query;
  const q = `%${search}%`;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const users = db.prepare(`
    SELECT id, account_id, name, email, phone, kyc_status, account_status,
           balance, invested, total_profit, referral_code, referred_by,
           role, country, has_subscription, created_at, last_login,
           (SELECT COUNT(*) FROM users u2 WHERE u2.referred_by = users.referral_code) as referral_count
    FROM users
    WHERE account_id LIKE ? OR email LIKE ? OR name LIKE ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(q, q, q, parseInt(limit), offset);
  const total = db.prepare('SELECT COUNT(*) as c FROM users WHERE account_id LIKE ? OR email LIKE ? OR name LIKE ?').get(q, q, q);
  res.json({ users, total: total.c });
});

app.get('/api/admin/users/:accountId', adminMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE account_id = ?').get(req.params.accountId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  delete user.password_hash;
  const deposits    = db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(user.id);
  const withdrawals = db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(user.id);
  const txs         = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(user.id);
  const referrals   = db.prepare('SELECT account_id, name, created_at, invested FROM users WHERE referred_by = ?').all(user.referral_code);
  const sigStats    = db.prepare('SELECT COUNT(*) as confirmed, COALESCE(SUM(profit_usd),0) as earned FROM signal_confirmations WHERE user_id = ?').get(user.id);
  res.json({ user, deposits, withdrawals, transactions: txs, referrals, sigStats });
});

app.patch('/api/admin/users/:accountId', adminMiddleware, (req, res) => {
  const { kycStatus, accountStatus } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE account_id = ?').get(req.params.accountId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (kycStatus)     db.prepare('UPDATE users SET kyc_status = ? WHERE id = ?').run(kycStatus, user.id);
  if (accountStatus) db.prepare('UPDATE users SET account_status = ? WHERE id = ?').run(accountStatus, user.id);
  res.json({ message: 'User updated' });
});

app.post('/api/admin/signals', adminMiddleware, (req, res) => {
  const { asset, direction, entry, takeProfit, stopLoss, profitPct, expiresMinutes } = req.body;
  const expiresAt = new Date(Date.now() + (expiresMinutes || 30) * 60 * 1000).toISOString();
  const result = db.prepare(`
    INSERT INTO signals (asset, direction, entry_price, take_profit, stop_loss, profit_pct, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(asset, direction, entry || null, takeProfit || null, stopLoss || null,
     profitPct || CONFIG.SIGNAL_PROFIT_PCT, expiresAt);

  // Auto-confirm for VIP subscribers
  const vipUsers = db.prepare(`
    SELECT u.id, u.invested, u.balance, u.total_profit, u.account_id
    FROM users u
    WHERE u.has_subscription = 1 AND u.account_status = 'active' AND u.invested > 0
  `).all();

  let autoCount = 0;
  vipUsers.forEach(u => {
    const profit    = parseFloat((u.invested * (profitPct || CONFIG.SIGNAL_PROFIT_PCT) / 100).toFixed(2));
    const newBal    = parseFloat((u.balance + profit).toFixed(2));
    const newProfit = parseFloat((u.total_profit + profit).toFixed(2));
    db.prepare('INSERT OR IGNORE INTO signal_confirmations (signal_id, user_id, profit_usd, auto_confirm) VALUES (?,?,?,1)')
      .run(result.lastInsertRowid, u.id, profit);
    db.prepare('UPDATE users SET balance = ?, total_profit = ? WHERE id = ?').run(newBal, newProfit, u.id);
    logTransaction(u.id, 'profit', profit,
      `Auto-signal profit — ${asset} ${direction} (+${profitPct || CONFIG.SIGNAL_PROFIT_PCT}%)`,
      result.lastInsertRowid, newBal);
    autoCount++;
  });

  res.status(201).json({
    message: 'Signal published',
    signalId: result.lastInsertRowid,
    autoConfirmed: autoCount,
    vipUsers: autoCount,
  });
});

app.get('/api/admin/withdrawals', adminMiddleware, (req, res) => {
  const { status = 'pending' } = req.query;
  const withdrawals = db.prepare(`
    SELECT w.*, u.account_id, u.name, u.email
    FROM withdrawals w JOIN users u ON w.user_id = u.id
    WHERE w.status = ? ORDER BY w.created_at DESC
  `).all(status);
  res.json({ withdrawals });
});

app.post('/api/admin/withdrawals/:id/:action', adminMiddleware, (req, res) => {
  const { id, action } = req.params;
  const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });

  if (action === 'reject') {
    db.prepare("UPDATE withdrawals SET status='rejected', admin_note=?, processed_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(req.body.note || 'Rejected', id);
    // Refund balance
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(withdrawal.amount_usd, withdrawal.user_id);
    const u = db.prepare('SELECT balance FROM users WHERE id = ?').get(withdrawal.user_id);
    logTransaction(withdrawal.user_id, 'refund', withdrawal.amount_usd, 'Withdrawal rejected — refunded', withdrawal.id, u.balance);
    return res.json({ message: 'Withdrawal rejected and refunded' });
  }

  if (action === 'approve') {
    db.prepare("UPDATE withdrawals SET status='processing', admin_note=?, processed_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(req.body.note || 'Approved', id);
    // TODO: Send via NowPayments Mass Payout API
    return res.json({ message: 'Withdrawal approved — queued for payout', net: withdrawal.net_usd });
  }

  res.status(400).json({ error: 'Action must be approve or reject' });
});

app.get('/api/admin/finance', adminMiddleware, (req, res) => {
  const ti = db.prepare('SELECT COALESCE(SUM(invested),0) as t FROM users').get().t;
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as month,
           SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END) as deposits,
           SUM(CASE WHEN type='profit' THEN amount ELSE 0 END) as profits,
           SUM(CASE WHEN type='withdrawal' THEN ABS(amount) ELSE 0 END) as withdrawals,
           SUM(CASE WHEN type='referral_bonus' THEN amount ELSE 0 END) as referrals,
           SUM(CASE WHEN type='subscription' THEN ABS(amount) ELSE 0 END) as sub_revenue
    FROM transactions GROUP BY month ORDER BY month DESC LIMIT 12
  `).all();
  res.json({ totalInvested: ti, reserve: ti * 0.4, active: ti * 0.6, monthlyStats: monthly });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  res.json({ status: 'ok', platform: 'CaribeFund', users, time: new Date().toISOString() });
});

// ─── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║        CaribeFund Backend v2 — Démarré          ║
║        Port: ${PORT}                              ║
║        MIN_DEPOSIT: $${CONFIG.MIN_DEPOSIT}                        ║
║        SIGNAL_RATE: ${CONFIG.SIGNAL_PROFIT_PCT}%                     ║
║        REF PARRAIN: ${CONFIG.REF_PARRAIN_PCT}% | FILLEUL: ${CONFIG.REF_FILLEUL_PCT}%         ║
║        WITHDRAW FEE: ${CONFIG.WITHDRAW_FEE_PCT}%                      ║
╚══════════════════════════════════════════════════╝
  `);
});

module.exports = app;
