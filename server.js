// ============================================================
// HORUS BACKEND v2 — server.js
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
  JWT_SECRET:             process.env.JWT_SECRET || 'horus-secret-CHANGE-IN-PROD',
  NOWPAYMENTS_API_KEY:    process.env.NOWPAYMENTS_API_KEY || 'YOUR_API_KEY',
  NOWPAYMENTS_IPN_SECRET: process.env.NOWPAYMENTS_IPN_SECRET || 'YOUR_IPN_SECRET',
  BASE_URL:               process.env.BASE_URL || 'http://177.7.41.4:3001',
  PLATFORM_NAME:          'Horus',
  SIGNAL_PROFIT_PCT:  1.35,
  REF_PARRAIN_PCT:    10,
  REF_FILLEUL_PCT:    5,
  WITHDRAW_FEE_PCT:   19,
  MIN_DEPOSIT:        30,
  MIN_WITHDRAW:       20,
  SUB_PRICE:          4.99,
};

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
    FOREIGN KEY (user_id) REFERENCES users(id)
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
function genAccountId(){
  const L='ABCDEFGHJKLMNPQRSTUVWXYZ';
  return 'HR-'+L[Math.floor(Math.random()*L.length)]+L[Math.floor(Math.random()*L.length)]+(Math.floor(Math.random()*9000)+1000);
}
function genRefCode(){ return 'HR-'+Math.random().toString(36).toUpperCase().slice(2,8); }
function logTx(uid,type,amount,desc,refId,balAfter){
  db.prepare('INSERT INTO transactions(user_id,type,amount,description,ref_id,balance_after)VALUES(?,?,?,?,?,?)')
    .run(uid,type,amount,desc,refId||null,balAfter||0);
}

// ─── NOWPAYMENTS HELPER ───────────────────────────────────────
function npRequest(method,path,body){
  return new Promise((resolve,reject)=>{
    const data=body?JSON.stringify(body):null;
    const opts={hostname:'api.nowpayments.io',path:`/v1${path}`,method,
      headers:{'x-api-key':CONFIG.NOWPAYMENTS_API_KEY,'Content-Type':'application/json',
        ...(data?{'Content-Length':Buffer.byteLength(data)}:{})}};
    const req=https.request(opts,(res)=>{
      let raw='';res.on('data',c=>raw+=c);
      res.on('end',()=>{try{resolve(JSON.parse(raw));}catch(e){reject(new Error('NP JSON error: '+raw));}});
    });
    req.on('error',reject);
    if(data)req.write(data);
    req.end();
  });
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────
function auth(req,res,next){
  const h=req.headers['authorization'];
  if(!h||!h.startsWith('Bearer '))return res.status(401).json({error:'No token'});
  try{req.user=jwt.verify(h.slice(7),CONFIG.JWT_SECRET);next();}
  catch(e){res.status(401).json({error:'Invalid token'});}
}
function adminAuth(req,res,next){
  auth(req,res,()=>{
    const u=db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
    if(!u||u.role!=='admin')return res.status(403).json({error:'Admin only'});
    next();
  });
}

// ─── REGISTER ────────────────────────────────────────────────
app.post('/api/auth/register',async(req,res)=>{
  try{
    const{name,email,phone,password,referralCode}=req.body;
    if(!name||!email||!password)return res.status(400).json({error:'Name, email, password required'});
    if(password.length<6)return res.status(400).json({error:'Password min 6 chars'});
    if(db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase()))
      return res.status(409).json({error:'Email already registered'});
    let referredBy=null;
    if(referralCode){
      const ref=db.prepare('SELECT id FROM users WHERE referral_code=?').get(referralCode.toUpperCase());
      if(!ref)return res.status(400).json({error:'Invalid referral code'});
      referredBy=referralCode.toUpperCase();
    }
    const hash=await bcrypt.hash(password,12);
    let aid,rc;
    do{aid=genAccountId();}while(db.prepare('SELECT id FROM users WHERE account_id=?').get(aid));
    do{rc=genRefCode();}while(db.prepare('SELECT id FROM users WHERE referral_code=?').get(rc));
    const r=db.prepare('INSERT INTO users(account_id,name,email,phone,password_hash,referral_code,referred_by)VALUES(?,?,?,?,?,?,?)')
      .run(aid,name.trim(),email.toLowerCase().trim(),phone||null,hash,rc,referredBy);
    const token=jwt.sign({id:r.lastInsertRowid,role:'user'},CONFIG.JWT_SECRET,{expiresIn:'7d'});
    res.status(201).json({message:'Account created',token,user:{id:aid,name,email,refCode:rc,kycStatus:'pending'}});
  }catch(e){console.error(e);res.status(500).json({error:'Registration failed'});}
});

// ─── LOGIN ────────────────────────────────────────────────────
app.post('/api/auth/login',async(req,res)=>{
  try{
    const{email,password}=req.body;
    const user=db.prepare('SELECT * FROM users WHERE email=?').get(email?.toLowerCase());
    if(!user)return res.status(401).json({error:'Invalid credentials'});
    if(user.account_status==='suspended')return res.status(403).json({error:'Account suspended'});
    if(!await bcrypt.compare(password,user.password_hash))return res.status(401).json({error:'Invalid credentials'});
    db.prepare('UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
    const token=jwt.sign({id:user.id,role:user.role},CONFIG.JWT_SECRET,{expiresIn:'7d'});
    res.json({token,user:{id:user.account_id,name:user.name,email:user.email,balance:user.balance,
      invested:user.invested,profit:user.total_profit,kycStatus:user.kyc_status,role:user.role,
      refCode:user.referral_code,hasSubscription:!!user.has_subscription}});
  }catch(e){console.error(e);res.status(500).json({error:'Login failed'});}
});

// ─── USER ─────────────────────────────────────────────────────
app.get('/api/user/me',auth,(req,res)=>{
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if(!user)return res.status(404).json({error:'Not found'});
  const refs=db.prepare('SELECT account_id,name,created_at,invested FROM users WHERE referred_by=?').all(user.referral_code);
  const earnings=db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id=? AND type='referral_bonus'").get(user.id);
  delete user.password_hash;
  res.json({...user,referrals:refs.map(r=>({accountId:r.account_id,name:r.name,joinDate:r.created_at,invested:r.invested,
    earned:parseFloat((r.invested*CONFIG.REF_PARRAIN_PCT/100).toFixed(2))})),referralEarnings:earnings.t});
});

app.get('/api/user/transactions',auth,(req,res)=>{
  const{page=1,limit=20}=req.query;
  const offset=(parseInt(page)-1)*parseInt(limit);
  const txs=db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(req.user.id,parseInt(limit),offset);
  const total=db.prepare('SELECT COUNT(*) as c FROM transactions WHERE user_id=?').get(req.user.id);
  res.json({transactions:txs,total:total.c});
});

// ─── DEPOSIT — UNIQUE ADDRESS VIA NOWPAYMENTS ─────────────────
app.post('/api/payments/deposit',auth,async(req,res)=>{
  try{
    const{amount,currency='usdttrc20'}=req.body;
    if(!amount||parseFloat(amount)<CONFIG.MIN_DEPOSIT)
      return res.status(400).json({error:`Minimum deposit is $${CONFIG.MIN_DEPOSIT}`});
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const orderId=`HR-DEP-${user.account_id}-${Date.now()}`;

    // ── Create unique payment address via NowPayments API ──
    const payment=await npRequest('POST','/payment',{
      price_amount:    parseFloat(amount),
      price_currency:  'usd',
      pay_currency:    currency.toLowerCase(),
      order_id:        orderId,
      order_description:`Horus Deposit — ${user.name} (${user.account_id})`,
      ipn_callback_url:`${CONFIG.BASE_URL}/api/webhooks/nowpayments`,
      is_fixed_rate:   false,
      is_fee_paid_by_user:false,
    });

    if(!payment.pay_address){
      console.error('NowPayments error:',payment);
      return res.status(400).json({error:'Payment creation failed — check your NowPayments API key',details:payment});
    }

    const result=db.prepare('INSERT INTO deposits(user_id,payment_id,order_id,amount_usd,currency,pay_address,network)VALUES(?,?,?,?,?,?,?)')
      .run(user.id,payment.payment_id||payment.id,orderId,parseFloat(amount),currency.toUpperCase(),payment.pay_address,payment.network||currency);

    const nets={usdttrc20:'TRC20 — Tron',usdterc20:'ERC20 — Ethereum',btc:'Bitcoin Network',eth:'Ethereum Network',sol:'Solana Network',bnbbsc:'BNB Smart Chain'};
    res.json({
      depositId:  result.lastInsertRowid,
      paymentId:  payment.payment_id||payment.id,
      payAddress: payment.pay_address,
      payAmount:  payment.pay_amount,
      currency:   (payment.pay_currency||currency).toUpperCase(),
      network:    nets[currency.toLowerCase()]||currency.toUpperCase(),
      amountUsd:  parseFloat(amount),
      status:     'pending',
      expiresAt:  payment.valid_until,
      qrCode:     `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payment.pay_address)}&bgcolor=ffffff&color=000000&margin=4`,
    });
  }catch(e){console.error('Deposit error:',e.message);res.status(500).json({error:'Failed to create payment',message:e.message});}
});

// GET /api/payments/deposit/:id — Poll status
app.get('/api/payments/deposit/:id',auth,async(req,res)=>{
  try{
    const dep=db.prepare('SELECT * FROM deposits WHERE id=? AND user_id=?').get(req.params.id,req.user.id);
    if(!dep)return res.status(404).json({error:'Deposit not found'});
    if(dep.status==='confirmed')return res.json({status:'confirmed',deposit:dep});
    if(dep.payment_id){
      const np=await npRequest('GET',`/payment/${dep.payment_id}`);
      if(np.payment_status==='confirmed'||np.payment_status==='finished'){
        await processDeposit(dep,dep.user_id);
        const u=db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
        return res.json({status:'confirmed',deposit:db.prepare('SELECT * FROM deposits WHERE id=?').get(dep.id),newBalance:u.balance});
      }
      return res.json({status:np.payment_status,deposit:dep});
    }
    res.json({status:dep.status,deposit:dep});
  }catch(e){console.error(e);res.status(500).json({error:'Status check failed'});}
});

// ─── PROCESS CONFIRMED DEPOSIT ────────────────────────────────
async function processDeposit(dep,userId){
  if(dep.status==='confirmed')return;
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!user)return;
  const newBal =parseFloat((user.balance+dep.amount_usd).toFixed(2));
  const newInv =parseFloat((user.invested+dep.amount_usd).toFixed(2));
  db.prepare('UPDATE users SET balance=?,invested=? WHERE id=?').run(newBal,newInv,user.id);
  db.prepare("UPDATE deposits SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP WHERE id=?").run(dep.id);
  logTx(user.id,'deposit',dep.amount_usd,'Crypto deposit confirmed via blockchain',dep.id,newBal);

  // ── Referral bonuses ──
  if(user.referred_by&&!dep.referral_bonus_paid){
    const parrain=db.prepare('SELECT * FROM users WHERE referral_code=?').get(user.referred_by);
    if(parrain){
      // Parrain +10%
      const pb=parseFloat((dep.amount_usd*CONFIG.REF_PARRAIN_PCT/100).toFixed(2));
      const pnb=parseFloat((parrain.balance+pb).toFixed(2));
      db.prepare('UPDATE users SET balance=? WHERE id=?').run(pnb,parrain.id);
      logTx(parrain.id,'referral_bonus',pb,`Commission parrainage ${CONFIG.REF_PARRAIN_PCT}% — ${user.name} ($${dep.amount_usd})`,dep.id,pnb);
      // Filleul +5%
      const fb=parseFloat((dep.amount_usd*CONFIG.REF_FILLEUL_PCT/100).toFixed(2));
      const fnb=parseFloat((newBal+fb).toFixed(2));
      db.prepare('UPDATE users SET balance=? WHERE id=?').run(fnb,user.id);
      logTx(user.id,'referral_welcome_bonus',fb,`Bonus de bienvenue filleul ${CONFIG.REF_FILLEUL_PCT}%`,dep.id,fnb);
      db.prepare('UPDATE deposits SET referral_bonus_paid=1 WHERE id=?').run(dep.id);
      console.log(`[REF] Parrain ${parrain.account_id}+$${pb} | Filleul ${user.account_id}+$${fb}`);
    }
  }
}

// ─── WEBHOOK IPN NOWPAYMENTS ──────────────────────────────────
app.post('/api/webhooks/nowpayments',express.raw({type:'application/json'}),async(req,res)=>{
  try{
    const sig=req.headers['x-nowpayments-sig'];
    const body=req.body.toString();
    const sorted=JSON.stringify(JSON.parse(body),Object.keys(JSON.parse(body)).sort());
    const expected=crypto.createHmac('sha512',CONFIG.NOWPAYMENTS_IPN_SECRET).update(sorted).digest('hex');
    if(sig!==expected){console.warn('[IPN] Invalid signature');return res.status(401).json({error:'Invalid signature'});}
    const data=JSON.parse(body);
    console.log(`[IPN] payment_id=${data.payment_id} status=${data.payment_status}`);
    if(data.payment_status==='confirmed'||data.payment_status==='finished'){
      const dep=db.prepare('SELECT * FROM deposits WHERE payment_id=?').get(data.payment_id);
      if(dep&&dep.status==='pending'){await processDeposit(dep,dep.user_id);console.log(`[IPN] Dep#${dep.id} confirmed $${dep.amount_usd}`);}
    }
    res.json({ok:true});
  }catch(e){console.error('[IPN]',e.message);res.status(500).json({error:'IPN error'});}
});

// ─── WITHDRAW ─────────────────────────────────────────────────
app.post('/api/payments/withdraw',auth,async(req,res)=>{
  try{
    const{amount,currency='USDT',walletAddress}=req.body;
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if(!walletAddress||walletAddress.length<10)return res.status(400).json({error:'Valid wallet address required'});
    if(!amount||parseFloat(amount)<CONFIG.MIN_WITHDRAW)return res.status(400).json({error:`Minimum $${CONFIG.MIN_WITHDRAW}`});
    if(parseFloat(amount)>user.balance)return res.status(400).json({error:'Insufficient balance'});
    if(user.kyc_status!=='verified')return res.status(400).json({error:'KYC verification required'});
    const gross=parseFloat(amount),fee=parseFloat((gross*CONFIG.WITHDRAW_FEE_PCT/100).toFixed(2)),net=parseFloat((gross-fee).toFixed(2));
    const newBal=parseFloat((user.balance-gross).toFixed(2));
    db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBal,user.id);
    const r=db.prepare('INSERT INTO withdrawals(user_id,amount_usd,fee_usd,net_usd,currency,wallet_address)VALUES(?,?,?,?,?,?)')
      .run(user.id,gross,fee,net,currency.toUpperCase(),walletAddress);
    logTx(user.id,'withdrawal',-gross,`Withdrawal — Fee:$${fee} Net:$${net}`,r.lastInsertRowid,newBal);
    res.json({message:'Withdrawal submitted — 24-48h',withdrawalId:r.lastInsertRowid,gross,fee,net,newBalance:newBal});
  }catch(e){console.error(e);res.status(500).json({error:'Withdrawal failed'});}
});

// ─── SUBSCRIPTION ─────────────────────────────────────────────
app.post('/api/payments/subscribe',auth,async(req,res)=>{
  try{
    const{paymentId}=req.body;
    const np=await npRequest('GET',`/payment/${paymentId}`);
    if(np.payment_status!=='confirmed'&&np.payment_status!=='finished')
      return res.status(400).json({error:'Payment not yet confirmed'});
    const exp=new Date(Date.now()+30*24*60*60*1000).toISOString();
    db.prepare('UPDATE users SET has_subscription=1,sub_expires_at=? WHERE id=?').run(exp,req.user.id);
    db.prepare('INSERT OR REPLACE INTO subscriptions(user_id,payment_id,amount_usd,expires_at,status)VALUES(?,?,?,?,?)').run(req.user.id,paymentId,CONFIG.SUB_PRICE,exp,'active');
    res.json({message:'VIP activated',expiresAt:exp});
  }catch(e){console.error(e);res.status(500).json({error:'Subscription failed'});}
});

// ─── SIGNALS ─────────────────────────────────────────────────
app.get('/api/signals/active',auth,(req,res)=>{
  const sig=db.prepare("SELECT * FROM signals WHERE status='active' AND expires_at>CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1").get();
  if(!sig)return res.json({signal:null});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const conf=db.prepare('SELECT * FROM signal_confirmations WHERE signal_id=? AND user_id=?').get(sig.id,req.user.id);
  res.json({signal:{id:sig.id,asset:sig.asset,direction:sig.direction,entry:sig.entry_price,takeProfit:sig.take_profit,stopLoss:sig.stop_loss,profitPct:sig.profit_pct,expiresAt:sig.expires_at,timeLeft:Math.max(0,Math.floor((new Date(sig.expires_at)-Date.now())/1000))},
    confirmed:!!conf,estimatedProfit:user.invested>0?parseFloat((user.invested*sig.profit_pct/100).toFixed(2)):0,confirmedAt:conf?.confirmed_at||null});
});

app.post('/api/signals/:id/confirm',auth,(req,res)=>{
  try{
    const sig=db.prepare("SELECT * FROM signals WHERE id=? AND status='active' AND expires_at>CURRENT_TIMESTAMP").get(req.params.id);
    if(!sig)return res.status(404).json({error:'Signal not found or expired'});
    if(db.prepare('SELECT id FROM signal_confirmations WHERE signal_id=? AND user_id=?').get(sig.id,req.user.id))
      return res.status(409).json({error:'Already confirmed'});
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if(!user||user.invested<=0)return res.status(400).json({error:'No active investment'});
    const profit=parseFloat((user.invested*sig.profit_pct/100).toFixed(2));
    const newBal=parseFloat((user.balance+profit).toFixed(2));
    const newPft=parseFloat((user.total_profit+profit).toFixed(2));
    db.transaction(()=>{
      db.prepare('INSERT INTO signal_confirmations(signal_id,user_id,profit_usd,auto_confirm)VALUES(?,?,?,?)').run(sig.id,req.user.id,profit,req.body.auto?1:0);
      db.prepare('UPDATE users SET balance=?,total_profit=? WHERE id=?').run(newBal,newPft,req.user.id);
      logTx(req.user.id,'profit',profit,`Signal profit — ${sig.asset} ${sig.direction} (+${sig.profit_pct}%)`,sig.id,newBal);
    })();
    console.log(`[SIGNAL] ${user.account_id} +$${profit} (${sig.profit_pct}% × $${user.invested})`);
    res.json({message:'Signal confirmed — profit credited',profit,newBalance:newBal,totalProfit:newPft});
  }catch(e){console.error(e);res.status(500).json({error:'Confirm failed'});}
});

app.get('/api/signals/history',auth,(req,res)=>{
  const{days=30}=req.query;
  const sigs=db.prepare("SELECT s.*,sc.confirmed_at,sc.profit_usd,sc.auto_confirm FROM signals s LEFT JOIN signal_confirmations sc ON s.id=sc.signal_id AND sc.user_id=? WHERE s.created_at>=datetime('now',?) ORDER BY s.created_at DESC").all(req.user.id,`-${days} days`);
  res.json({signals:sigs});
});

// ─── PRICES ──────────────────────────────────────────────────
app.get('/api/prices',async(req,res)=>{
  try{
    const data=await new Promise((resolve,reject)=>{
      https.get({hostname:'api.coingecko.com',path:'/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true',headers:{'Accept':'application/json','User-Agent':'Horus/2.0'}},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});}).on('error',reject);
    });
    res.json({BTC:{price:data.bitcoin?.usd,change24h:data.bitcoin?.usd_24h_change},ETH:{price:data.ethereum?.usd,change24h:data.ethereum?.usd_24h_change},SOL:{price:data.solana?.usd,change24h:data.solana?.usd_24h_change},BNB:{price:data.binancecoin?.usd,change24h:data.binancecoin?.usd_24h_change},GOLD:{price:2348.6,change24h:0.3},'EUR/USD':{price:1.0821,change24h:-0.2},'USD/JPY':{price:154.32,change24h:0.5}});
  }catch(e){res.status(503).json({error:'Price feed unavailable'});}
});

// ─── ADMIN ────────────────────────────────────────────────────
app.get('/api/admin/overview',adminAuth,(req,res)=>{
  const subs=db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status='active'").get().c;
  res.json({stats:{totalUsers:db.prepare("SELECT COUNT(*) as c FROM users WHERE role='user'").get().c,activeUsers:db.prepare("SELECT COUNT(*) as c FROM users WHERE account_status='active' AND role='user'").get().c,pendingKyc:db.prepare("SELECT COUNT(*) as c FROM users WHERE kyc_status='pending'").get().c,totalDeposited:db.prepare("SELECT COALESCE(SUM(amount_usd),0) as t FROM deposits WHERE status='confirmed'").get().t,totalInvested:db.prepare("SELECT COALESCE(SUM(invested),0) as t FROM users").get().t,totalBalance:db.prepare("SELECT COALESCE(SUM(balance),0) as t FROM users").get().t,totalProfit:db.prepare("SELECT COALESCE(SUM(total_profit),0) as t FROM users").get().t,pendingWithdrawals:db.prepare("SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'").get().c,activeSubscriptions:subs,subRevenue:parseFloat((subs*CONFIG.SUB_PRICE).toFixed(2))},recentUsers:db.prepare("SELECT account_id,name,email,kyc_status,balance,created_at FROM users WHERE role='user' ORDER BY created_at DESC LIMIT 5").all()});
});

app.get('/api/admin/users',adminAuth,(req,res)=>{
  const{search='',page=1,limit=20}=req.query;const q=`%${search}%`;const offset=(parseInt(page)-1)*parseInt(limit);
  const users=db.prepare("SELECT id,account_id,name,email,kyc_status,account_status,balance,invested,total_profit,referral_code,referred_by,role,has_subscription,created_at,(SELECT COUNT(*) FROM users u2 WHERE u2.referred_by=users.referral_code) as referral_count FROM users WHERE account_id LIKE ? OR email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(q,q,q,parseInt(limit),offset);
  const total=db.prepare('SELECT COUNT(*) as c FROM users WHERE account_id LIKE ? OR email LIKE ? OR name LIKE ?').get(q,q,q);
  res.json({users,total:total.c});
});

app.patch('/api/admin/users/:accountId',adminAuth,(req,res)=>{
  const{kycStatus,accountStatus}=req.body;
  const user=db.prepare('SELECT * FROM users WHERE account_id=?').get(req.params.accountId);
  if(!user)return res.status(404).json({error:'User not found'});
  if(kycStatus)db.prepare('UPDATE users SET kyc_status=? WHERE id=?').run(kycStatus,user.id);
  if(accountStatus)db.prepare('UPDATE users SET account_status=? WHERE id=?').run(accountStatus,user.id);
  res.json({message:'User updated'});
});

app.post('/api/admin/signals',adminAuth,(req,res)=>{
  const{asset,direction,entry,takeProfit,stopLoss,profitPct=CONFIG.SIGNAL_PROFIT_PCT,expiresMinutes=30}=req.body;
  const expiresAt=new Date(Date.now()+expiresMinutes*60*1000).toISOString();
  const result=db.prepare('INSERT INTO signals(asset,direction,entry_price,take_profit,stop_loss,profit_pct,expires_at)VALUES(?,?,?,?,?,?,?)').run(asset,direction,entry||null,takeProfit||null,stopLoss||null,profitPct,expiresAt);
  // Auto-confirm for all VIP subscribers
  const vips=db.prepare("SELECT * FROM users WHERE has_subscription=1 AND account_status='active' AND invested>0").all();
  let autoCount=0;
  vips.forEach(u=>{
    const profit=parseFloat((u.invested*profitPct/100).toFixed(2));
    try{
      db.prepare('INSERT OR IGNORE INTO signal_confirmations(signal_id,user_id,profit_usd,auto_confirm)VALUES(?,?,?,1)').run(result.lastInsertRowid,u.id,profit);
      db.prepare('UPDATE users SET balance=balance+?,total_profit=total_profit+? WHERE id=?').run(profit,profit,u.id);
      logTx(u.id,'profit',profit,`Auto-signal VIP — ${asset} ${direction} (+${profitPct}%)`,result.lastInsertRowid,u.balance+profit);
      autoCount++;
    }catch(e){console.error('Auto-confirm error:',e.message);}
  });
  res.status(201).json({message:'Signal published',signalId:result.lastInsertRowid,autoConfirmed:autoCount});
});

app.get('/api/admin/withdrawals',adminAuth,(req,res)=>{
  const{status='pending'}=req.query;
  const wds=db.prepare("SELECT w.*,u.account_id,u.name,u.email FROM withdrawals w JOIN users u ON w.user_id=u.id WHERE w.status=? ORDER BY w.created_at DESC").all(status);
  res.json({withdrawals:wds});
});

app.post('/api/admin/withdrawals/:id/:action',adminAuth,(req,res)=>{
  const wd=db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if(!wd)return res.status(404).json({error:'Not found'});
  if(req.params.action==='reject'){
    db.prepare("UPDATE withdrawals SET status='rejected',admin_note=?,processed_at=CURRENT_TIMESTAMP WHERE id=?").run(req.body.note||'Rejected',req.params.id);
    db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(wd.amount_usd,wd.user_id);
    const u=db.prepare('SELECT balance FROM users WHERE id=?').get(wd.user_id);
    logTx(wd.user_id,'refund',wd.amount_usd,'Withdrawal rejected — refunded',wd.id,u.balance);
    return res.json({message:'Rejected and refunded'});
  }
  if(req.params.action==='approve'){
    db.prepare("UPDATE withdrawals SET status='processing',admin_note=?,processed_at=CURRENT_TIMESTAMP WHERE id=?").run(req.body.note||'Approved',req.params.id);
    return res.json({message:'Approved — payout queued',net:wd.net_usd});
  }
  res.status(400).json({error:'Invalid action'});
});

app.get('/api/admin/finance',adminAuth,(req,res)=>{
  const ti=db.prepare('SELECT COALESCE(SUM(invested),0) as t FROM users').get().t;
  const monthly=db.prepare("SELECT strftime('%Y-%m',created_at) as month,SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END) as deposits,SUM(CASE WHEN type='profit' THEN amount ELSE 0 END) as profits,SUM(CASE WHEN type='withdrawal' THEN ABS(amount) ELSE 0 END) as withdrawals,SUM(CASE WHEN type='referral_bonus' THEN amount ELSE 0 END) as referrals FROM transactions GROUP BY month ORDER BY month DESC LIMIT 12").all();
  res.json({totalInvested:ti,reserve:ti*0.4,active:ti*0.6,monthlyStats:monthly});
});

// ─── HEALTH ───────────────────────────────────────────────────
app.get('/api/health',(req,res)=>{
  res.json({status:'ok',platform:'Horus v2',users:db.prepare('SELECT COUNT(*) as c FROM users').get().c,time:new Date().toISOString()});
});

// ─── START ────────────────────────────────────────────────────
app.listen(PORT,()=>{
  console.log(`
╔══════════════════════════════════════════════════╗
║       Horus Backend v2 — EN LIGNE          ║
║       Port: ${PORT}                               ║
║       Dépôt minimum: $${CONFIG.MIN_DEPOSIT}                       ║
║       Signal rate: ${CONFIG.SIGNAL_PROFIT_PCT}%                      ║
║       Parrain: ${CONFIG.REF_PARRAIN_PCT}% | Filleul: ${CONFIG.REF_FILLEUL_PCT}%              ║
║       Frais retrait: ${CONFIG.WITHDRAW_FEE_PCT}%                      ║
╚══════════════════════════════════════════════════╝`);
});

module.exports = app;
