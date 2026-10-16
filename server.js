import crypto from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const scrypt = promisify(crypto.scrypt);
const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
const port = Number(process.env.PORT || 3000);
const sessionHours = Math.max(1, Math.min(720, Number(process.env.SESSION_TTL_HOURS) || 168));
const networks = {
  bep20: { asset: 'BNB', label: 'BNB · BNB Smart Chain', env: 'DEPOSIT_ADDRESS_BNB_BEP20' },
  trc20: { asset: 'USDT', label: 'USDT · TRON TRC-20', env: 'DEPOSIT_ADDRESS_USDT_TRC20' },
  bitcoin: { asset: 'BTC', label: 'BTC · Bitcoin', env: 'DEPOSIT_ADDRESS_BTC' },
};
const now = () => Date.now();
const id = () => crypto.randomUUID();
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const json = (res, data, status = 200) => res.status(status).json(data);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const authAttempts = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

function baseAccount({ id: accountId, username, email, role = 'user', createdAt = now(), data = {} }) {
  return {
    id: accountId, username, email, role, status: 'approved', createdAt, revision: 1,
    wallet: { deposit: 0, earnings: 0 }, investments: [], transactions: [],
    depositRequests: [], withdrawalRequests: [], preferences: { language: 'en', theme: 'dark' },
    withdrawalWallet: null, walletChangeRequests: [], withdrawalPinSet: false,
    h9Points: 0, bonusSpins: 0, pointHistory: [], referralCode: accountId.slice(-7).toUpperCase(),
    referrals: [], activeBonuses: [], rewardRedemptions: [], dailyPrizes: [],
    ...data,
  };
}

async function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString('hex') };
}

async function passwordMatches(password, salt, storedHash) {
  if (!salt || !storedHash) return false;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(storedHash, 'hex');
  return expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
}

function publicAccount(row, depositRequests = []) {
  const data = row.account_data || {};
  return {
    ...data,
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: Number(row.created_at),
    revision: Number(row.revision),
    depositRequests,
    withdrawalRequests: data.withdrawalRequests || [],
    withdrawalPinSet: Boolean(data.withdrawalPinSet),
  };
}

function depositView(row) {
  return {
    id: row.id,
    amount: Number(row.amount),
    amountCurrency: row.amount_currency || 'crypto',
    asset: row.asset,
    network: row.network,
    depositAddress: row.deposit_address,
    txHash: row.tx_hash,
    status: row.status,
    creditUsdt: row.credit_usdt == null ? null : Number(row.credit_usdt),
    createdAt: Number(row.created_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    transactionId: row.transaction_id,
  };
}

async function getAccount(row) {
  const { rows } = await pool.query(
    'SELECT * FROM deposit_requests WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100',
    [row.id],
  );
  return publicAccount(row, rows.map(depositView));
}

function requireAuth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || token.length > 256) return json(res, { error: 'Sign in to continue.' }, 401);
  pool.query(
    'SELECT a.*, s.expires_at FROM app_sessions s JOIN app_accounts a ON a.id = s.account_id WHERE s.token_hash = $1 AND s.expires_at > NOW()',
    [hashToken(token)],
  ).then(({ rows }) => {
    if (!rows[0] || rows[0].status !== 'approved') return json(res, { error: 'Session expired. Please log in again.' }, 401);
    req.account = rows[0];
    next();
  }).catch(next);
}

function requireAdmin(req, res, next) {
  if (req.account?.role !== 'admin') return json(res, { error: 'Not authorized.' }, 403);
  next();
}

function authRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const entry = authAttempts.get(key) || { count: 0, resetAt: now() + 15 * 60_000 };
  if (entry.resetAt <= now()) { entry.count = 0; entry.resetAt = now() + 15 * 60_000; }
  entry.count += 1;
  if (authAttempts.size > 10_000) {
    for (const [ip, attempt] of authAttempts) if (attempt.resetAt <= now()) authAttempts.delete(ip);
  }
  authAttempts.set(key, entry);
  if (entry.count > 30) return json(res, { error: 'Too many attempts. Try again later.' }, 429);
  next();
}

function safeTxHash(network, value) {
  const hash = String(value || '').trim();
  if (network === 'bep20') return /^0x[a-fA-F0-9]{64}$/.test(hash) ? hash.toLowerCase() : '';
  return /^[a-fA-F0-9]{64}$/.test(hash) ? hash.toLowerCase() : '';
}

function getDepositAddresses() {
  return Object.fromEntries(Object.entries(networks).map(([key, config]) => [key, String(process.env[config.env] || '').trim()]));
}

app.post('/api/auth/register', authRateLimit, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (username.length < 3 || username.length > 30 || !emailPattern.test(email) || password.length < 12 || password.length > 200) {
      return json(res, { error: 'Use a valid username and email, and a password of at least 12 characters.' }, 400);
    }
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD_SALT || !process.env.ADMIN_PASSWORD_HASH) return json(res, { error: 'Service admin is not configured.' }, 503);
    if (email === adminEmail) return json(res, { error: 'This email is reserved.' }, 409);
    const credentials = await passwordHash(password);
    const account = baseAccount({ id: id(), username, email, data: { preferences: { language: ['en','fr','es','de','pt','hi','zh','it'].includes(req.body?.language) ? req.body.language : 'en', theme: 'dark' } } });
    await pool.query(
      'INSERT INTO app_accounts (id, username, email, role, status, password_salt, password_hash, account_data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
      [account.id, username, email, 'user', 'approved', credentials.salt, credentials.hash, JSON.stringify(account), account.createdAt],
    );
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO app_sessions (token_hash, account_id, expires_at) VALUES ($1,$2,NOW() + ($3 * INTERVAL '1 hour'))", [hashToken(token), account.id, sessionHours]);
    return json(res, { token, account });
  } catch (error) {
    if (error.code === '23505') return json(res, { error: 'Email or username is already in use.' }, 409);
    next(error);
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!emailPattern.test(email) || !password || password.length > 200) return json(res, { error: 'Email or password is incorrect.' }, 401);
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    let row = (await pool.query('SELECT * FROM app_accounts WHERE email = $1', [email])).rows[0];
    if (email === adminEmail && process.env.ADMIN_PASSWORD_HASH) {
      if (!await passwordMatches(password, process.env.ADMIN_PASSWORD_SALT, process.env.ADMIN_PASSWORD_HASH)) {
        return json(res, { error: 'Email or password is incorrect.' }, 401);
      }
      if (!row) {
        const credentials = await passwordHash(password, process.env.ADMIN_PASSWORD_SALT);
        const data = baseAccount({ id: id(), username: 'Admin-' + id().slice(0, 8), email, role: 'admin' });
        row = (await pool.query(
          'INSERT INTO app_accounts (id,username,email,role,status,password_salt,password_hash,account_data,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *',
          [data.id,data.username,email,'admin','approved',credentials.salt,credentials.hash,JSON.stringify(data),data.createdAt],
        )).rows[0];
      } else if (row.role !== 'admin') {
        return json(res, { error: 'Admin account configuration conflict.' }, 503);
      }
    } else if (!row || row.role === 'admin' || !await passwordMatches(password, row.password_salt, row.password_hash)) {
      return json(res, { error: 'Email or password is incorrect.' }, 401);
    }
    if (row.status !== 'approved') return json(res, { error: 'This account is not active.' }, 403);
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO app_sessions (token_hash, account_id, expires_at) VALUES ($1,$2,NOW() + ($3 * INTERVAL '1 hour'))", [hashToken(token), row.id, sessionHours]);
    return json(res, { token, account: await getAccount(row) });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  try {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    await pool.query('DELETE FROM app_sessions WHERE token_hash = $1', [hashToken(token)]);
    return json(res, { ok: true });
  } catch (error) { next(error); }
});

app.get('/api/account', requireAuth, async (req, res, next) => {
  try { return json(res, { account: await getAccount(req.account) }); }
  catch (error) { next(error); }
});

app.put('/api/account', requireAuth, async (req, res, next) => {
  try {
    const current = req.account.account_data || {};
    const preferences = req.body?.preferences;
    if (!preferences || typeof preferences !== 'object') return json(res, { error: 'Invalid account update.' }, 400);
    const data = { ...current, preferences: {
      language: ['en','fr','es','de','pt','hi','zh','it'].includes(preferences.language) ? preferences.language : current.preferences?.language || 'en',
      theme: ['dark','light'].includes(preferences.theme) ? preferences.theme : current.preferences?.theme || 'dark',
    } };
    const result = await pool.query('UPDATE app_accounts SET account_data=$1::jsonb, revision=revision+1 WHERE id=$2 RETURNING *', [JSON.stringify(data), req.account.id]);
    return json(res, { account: await getAccount(result.rows[0]) });
  } catch (error) { next(error); }
});

app.put('/api/admin/account', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const targetId = String(req.body?.id || '');
    const row = (await pool.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [targetId])).rows[0];
    if (!row) return json(res, { error: 'Account not found.' }, 404);
    const wallet = req.body?.wallet;
    const status = String(req.body?.status || row.status);
    if (!wallet || !Number.isFinite(Number(wallet.deposit)) || !Number.isFinite(Number(wallet.earnings)) || Number(wallet.deposit) < 0 || Number(wallet.earnings) < 0 || !['approved','blocked','pending','rejected'].includes(status)) {
      return json(res, { error: 'Enter valid non-negative balances and account status.' }, 400);
    }
    const data = row.account_data || {};
    data.wallet = { deposit: Number(wallet.deposit), earnings: Number(wallet.earnings) };
    if (Array.isArray(req.body.transactions)) data.transactions = req.body.transactions.slice(0, 2000);
    const updated = (await pool.query('UPDATE app_accounts SET account_data=$1::jsonb,status=$2,revision=revision+1 WHERE id=$3 RETURNING *', [JSON.stringify(data),status,targetId])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { next(error); }
});

app.get('/api/deposit-addresses', requireAuth, (req, res) => {
  if (process.env.ENABLE_CRYPTO_DEPOSITS !== 'true' && req.account.role !== 'admin') return json(res, { error: 'Crypto deposits are temporarily disabled.' }, 503);
  const addresses = getDepositAddresses();
  if (Object.values(addresses).some((value) => !value)) return json(res, { error: 'Deposit service is not fully configured.' }, 503);
  return json(res, { addresses });
});

app.post('/api/deposits', requireAuth, async (req, res, next) => {
  if (process.env.ENABLE_CRYPTO_DEPOSITS !== 'true') return json(res, { error: 'Crypto deposits are temporarily disabled.' }, 503);
  try {
    const network = String(req.body?.network || '');
    const config = networks[network];
    const rawAmount = Number(req.body?.amount);
    const amount = Number.isFinite(rawAmount) ? Number(rawAmount.toFixed(2)) : NaN;
    const txHash = safeTxHash(network, req.body?.txHash);
    const address = getDepositAddresses()[network];
    if (!config || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 || !txHash || !address) {
      return json(res, { error: 'Enter a valid USD amount, network and transaction hash.' }, 400);
    }
    if (String(req.body?.depositAddress || '') !== address) return json(res, { error: 'The deposit address changed. Reopen the request and use the current address.' }, 409);
    const requestId = id();
    const transactionId = id();
    const createdAt = now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO deposit_requests (id,account_id,network,asset,amount,amount_currency,deposit_address,tx_hash,status,transaction_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [requestId,req.account.id,network,config.asset,amount,'USD',address,txHash,'pending',transactionId,createdAt],
      );
      const data = req.account.account_data || {};
      data.transactions ||= [];
      data.transactions.unshift({ id: transactionId, type: 'deposit', amount: 0, network, status: 'pending', date: createdAt, requestId });
      await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data), req.account.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return json(res, { error: 'This transaction hash has already been submitted.' }, 409);
      throw error;
    } finally { client.release(); }
    const refreshed = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [req.account.id])).rows[0];
    return json(res, { account: await getAccount(refreshed) }, 201);
  } catch (error) { next(error); }
});

app.get('/api/admin/accounts', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [accounts, deposits] = await Promise.all([
      pool.query('SELECT * FROM app_accounts ORDER BY created_at DESC LIMIT 500'),
      pool.query('SELECT * FROM deposit_requests ORDER BY created_at DESC LIMIT 1000'),
    ]);
    const byAccount = new Map();
    for (const row of deposits.rows) {
      const list = byAccount.get(row.account_id) || [];
      list.push(depositView(row));
      byAccount.set(row.account_id, list);
    }
    return json(res, { accounts: accounts.rows.map((row) => publicAccount(row, byAccount.get(row.id) || [])) });
  } catch (error) { next(error); }
});

app.post('/api/admin/deposits/:id/approve', requireAuth, requireAdmin, async (req, res, next) => {
  const rawCreditUsdt = Number(req.body?.creditUsdt);
  const creditUsdt = Number.isFinite(rawCreditUsdt) ? Number(rawCreditUsdt.toFixed(8)) : NaN;
  if (!Number.isFinite(creditUsdt) || creditUsdt <= 0 || creditUsdt > 1_000_000_000) return json(res, { error: 'Enter the verified USDT amount to credit.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deposit = (await client.query('SELECT * FROM deposit_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!deposit || deposit.status !== 'pending') { await client.query('ROLLBACK'); return json(res, { error: 'Deposit not found or already reviewed.' }, 409); }
    const accountRow = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [deposit.account_id])).rows[0];
    if (!accountRow || accountRow.status !== 'approved') { await client.query('ROLLBACK'); return json(res, { error: 'Account is not active.' }, 409); }
    const data = accountRow.account_data || {};
    data.wallet ||= { deposit: 0, earnings: 0 };
    data.wallet.deposit = Number(data.wallet.deposit || 0) + creditUsdt;
    data.transactions ||= [];
    const reviewedAt = now();
    const tx = data.transactions.find((item) => item.id === deposit.transaction_id);
    if (tx) { tx.status = 'confirmed'; tx.amount = creditUsdt; tx.creditedUsdt = creditUsdt; tx.reviewedAt = reviewedAt; }
    await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),accountRow.id]);
    await client.query('UPDATE deposit_requests SET status=$1,credit_usdt=$2,reviewed_at=$3,reviewed_by=$4 WHERE id=$5', ['confirmed',creditUsdt,reviewedAt,req.account.id,deposit.id]);
    await client.query('INSERT INTO deposit_ledger (id,account_id,deposit_id,credit_usdt,balance_after_usdt,created_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id(),accountRow.id,deposit.id,creditUsdt,Number(data.wallet.deposit),reviewedAt,req.account.id]);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [accountRow.id])).rows[0];
    return json(res, { account: await getAccount(updated), depositId: deposit.id });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/admin/deposits/:id/reject', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const deposit = (await client.query('SELECT * FROM deposit_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!deposit || deposit.status !== 'pending') { await client.query('ROLLBACK'); return json(res, { error: 'Deposit not found or already reviewed.' }, 409); }
      const accountRow = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [deposit.account_id])).rows[0];
      const data = accountRow?.account_data || {};
      const tx = (data.transactions || []).find((item) => item.id === deposit.transaction_id);
      const reviewedAt = now();
      if (tx) { tx.status = 'rejected'; tx.reviewedAt = reviewedAt; }
      await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),deposit.account_id]);
      await client.query('UPDATE deposit_requests SET status=$1,reviewed_at=$2,reviewed_by=$3 WHERE id=$4', ['rejected',reviewedAt,req.account.id,deposit.id]);
      await client.query('COMMIT');
      const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [deposit.account_id])).rows[0];
      return json(res, { account: await getAccount(updated), depositId: deposit.id });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } catch (error) { next(error); }
});

app.get('/api/admin/deposit-addresses', requireAuth, requireAdmin, (req, res) => json(res, { addresses: getDepositAddresses() }));
app.post('/api/investments/mark', requireAuth, async (req, res, next) => {
  try { return json(res, { account: await getAccount(req.account) }); }
  catch (error) { next(error); }
});

app.use('/api', (req, res) => json(res, { error: 'This operation is not available on the Render backend yet.' }, 501));
app.use(express.static(root, { index: 'index.html', maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(root, 'index.html')));
app.use((error, req, res, next) => {
  console.error('API error:', error?.message || error);
  if (res.headersSent) return next(error);
  return json(res, { error: 'Service temporarily unavailable.' }, 500);
});

const schema = `
  CREATE TABLE IF NOT EXISTS app_accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('user','admin')), status TEXT NOT NULL DEFAULT 'approved', password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, account_data JSONB NOT NULL, created_at BIGINT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS app_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL);
  CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS app_accounts_username_lower ON app_accounts (LOWER(username));
  CREATE TABLE IF NOT EXISTS deposit_requests (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, network TEXT NOT NULL, asset TEXT NOT NULL, amount NUMERIC(24,8) NOT NULL CHECK (amount > 0), amount_currency TEXT NOT NULL DEFAULT 'crypto' CHECK (amount_currency IN ('crypto','USD')), deposit_address TEXT NOT NULL, tx_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected')), credit_usdt NUMERIC(24,8), transaction_id TEXT NOT NULL, created_at BIGINT NOT NULL, reviewed_at BIGINT, reviewed_by TEXT REFERENCES app_accounts(id), UNIQUE(network,tx_hash));
  CREATE TABLE IF NOT EXISTS deposit_ledger (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, deposit_id TEXT NOT NULL UNIQUE REFERENCES deposit_requests(id), credit_usdt NUMERIC(24,8) NOT NULL CHECK (credit_usdt > 0), balance_after_usdt NUMERIC(24,8) NOT NULL, created_at BIGINT NOT NULL, created_by TEXT NOT NULL REFERENCES app_accounts(id));
`;

async function start() {
  for (const name of ['DATABASE_URL','ADMIN_EMAIL','ADMIN_PASSWORD_SALT','ADMIN_PASSWORD_HASH', ...Object.values(networks).map((item) => item.env)]) {
    if (!process.env[name]) throw new Error('Missing required environment variable: ' + name);
  }
  if (process.env.ADMIN_PASSWORD_SALT.length < 16 || !/^[a-f0-9]{128}$/i.test(process.env.ADMIN_PASSWORD_HASH)) throw new Error('ADMIN_PASSWORD_SALT/HASH must be a 16+ char salt and 64-byte scrypt hash in hex.');
  await pool.query(schema);
  await pool.query("ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS amount_currency TEXT NOT NULL DEFAULT 'crypto' CHECK (amount_currency IN ('crypto','USD'))");
  const addresses = getDepositAddresses();
  if (!/^0x[a-fA-F0-9]{40}$/.test(addresses.bep20)) throw new Error('DEPOSIT_ADDRESS_BNB_BEP20 is not a valid BNB Smart Chain address.');
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addresses.trc20)) throw new Error('DEPOSIT_ADDRESS_USDT_TRC20 is not a valid TRON address.');
  if (!/^bc1[ac-hj-np-z02-9]{11,71}$/i.test(addresses.bitcoin)) throw new Error('DEPOSIT_ADDRESS_BTC is not a valid bech32 Bitcoin address.');
  await pool.query('DELETE FROM app_sessions WHERE expires_at <= NOW()');
  app.listen(port, () => console.log('Custody API listening on port ' + port));
}

start().catch((error) => {
  console.error('Custody API failed to start:', error.message);
  process.exit(1);
});
