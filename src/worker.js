/*
 * VuPay — serveur pour Cloudflare Workers.
 *   Base de données : Cloudflare D1 (liaison DB)
 *   Vidéos et miniatures : Cloudflare R2 (liaison MEDIA)
 *   Pages de l'appli : dossier public/ (liaison ASSETS)
 * Les tables sont créées automatiquement à la première visite.
 */
import { sendSms, payout } from './providers.js';
import DEMO_VIDEOS from '../seed/demo-videos.js';

const COUNTRIES = [
  ['Sénégal', '+221', 'XOF'], ['Côte d’Ivoire', '+225', 'XOF'], ['Mali', '+223', 'XOF'], ['Burkina Faso', '+226', 'XOF'],
  ['Bénin', '+229', 'XOF'], ['Togo', '+228', 'XOF'], ['Niger', '+227', 'XOF'], ['Guinée-Bissau', '+245', 'XOF'],
  ['Cameroun', '+237', 'XAF'], ['Gabon', '+241', 'XAF'], ['Congo', '+242', 'XAF'], ['Tchad', '+235', 'XAF'],
  ['Centrafrique', '+236', 'XAF'], ['Guinée équatoriale', '+240', 'XAF']
];
const OPS = ['Orange Money', 'Wave', 'MTN MoMo', 'Moov Money'];
const CATS = ['pub', 'tuto', 'avis'];
const PAYS = [100, 150, 200, 250, 300, 400, 500];
const STEP_INDEX = { 'En attente': 0, 'En traitement': 1, 'Envoyé': 2 };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, country INTEGER NOT NULL, phone TEXT NOT NULL, name TEXT NOT NULL, op TEXT NOT NULL,
    ref_code TEXT UNIQUE, balance INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, watched INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL, UNIQUE(country, phone))`,
  `CREATE TABLE IF NOT EXISTS otps(key TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, brand TEXT NOT NULL, cat TEXT NOT NULL, pay INTEGER NOT NULL,
    q TEXT NOT NULL, opts TEXT NOT NULL, answer INTEGER NOT NULL, dur REAL NOT NULL, file TEXT, poster TEXT,
    frames TEXT, art TEXT, color TEXT, owner_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS views(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, video_id TEXT NOT NULL, day TEXT NOT NULL, started INTEGER NOT NULL,
    status TEXT NOT NULL, UNIQUE(user_id, video_id, day))`,
  `CREATE TABLE IF NOT EXISTS txs(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, amount INTEGER NOT NULL,
    status TEXT NOT NULL, ref TEXT UNIQUE, op TEXT, num TEXT, steps TEXT, created TEXT NOT NULL, day TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bonuses(user_id INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY(user_id, day))`,
  `CREATE INDEX IF NOT EXISTS txs_user ON txs(user_id, id)`,
  `CREATE INDEX IF NOT EXISTS views_user_day ON views(user_id, day)`
];

// ---------------------------------------------------------------- outils
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };
const nowIso = () => new Date().toISOString();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const rid = (n = 12) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const otpCode = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

function cfg(env) {
  return {
    devOtp: env.DEV_SHOW_OTP === '1',
    minOut: +(env.MIN_WITHDRAW || 2000),
    goal: +(env.DAILY_GOAL || 5),
    bonus: +(env.DAILY_BONUS || 300),
    maxUpload: Math.min(+(env.MAX_UPLOAD_MB || 95), 95) * 1024 * 1024,
    maxVideoSec: +(env.MAX_VIDEO_SECONDS || 180),
    tz: env.TIMEZONE || 'Africa/Dakar',
    payoutMode: env.PAYOUT_PROVIDER || 'simulation'
  };
}
const today = env => new Intl.DateTimeFormat('en-CA', { timeZone: cfg(env).tz }).format(new Date());

async function readJson(req, limit = 2 * 1024 * 1024) {
  if (+(req.headers.get('content-length') || 0) > limit) fail(413, 'Requête trop volumineuse.');
  try { const t = await req.text(); return t ? JSON.parse(t) : {}; } catch { fail(400, 'JSON invalide.'); }
}
function cleanPhone(country, phone) {
  if (!Number.isInteger(country) || !COUNTRIES[country]) fail(400, 'Pays invalide.');
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length < 8 || p.length > 10) fail(400, 'Le numéro doit contenir 8 à 10 chiffres.');
  return p;
}
const intl = (country, phone) => COUNTRIES[country][1] + phone;
const str = (v, max, label) => { const s = String(v ?? '').trim(); if (!s) fail(400, label + ' manquant.'); if (s.length > max) fail(400, label + ' trop long.'); return s; };

// ---------------------------------------------------------------- base
let ready = null;
function init(env) {
  if (!ready) {
    ready = (async () => {
      await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
      if (env.SEED_DEMO !== '0') {
        const at = nowIso();
        await env.DB.batch(DEMO_VIDEOS.map(v => env.DB.prepare(
          `INSERT OR IGNORE INTO videos(id,kind,title,brand,cat,pay,q,opts,answer,dur,frames,art,color,created) VALUES(?, 'demo', ?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind('demo-' + v.id, v.title, v.brand, v.cat, v.pay, v.q, JSON.stringify(v.opts), v.a, v.dur, JSON.stringify(v.frames), v.art, v.color, at)));
      }
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}
const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const st = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);

async function authUser(env, req) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) fail(401, 'Connexion requise.');
  const u = await one(env, 'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', await sha(t));
  if (!u) fail(401, 'Session expirée, reconnecte-toi.');
  return u;
}

const fmtTx = t => ({ id: t.id, kind: t.kind, label: t.label, amount: t.amount, status: t.status, ref: t.ref, op: t.op, num: t.num, steps: t.steps ? JSON.parse(t.steps) : null, at: t.created });

async function setTxStatus(env, ref, status) {
  const t = await one(env, 'SELECT * FROM txs WHERE ref = ?', ref);
  if (!t || t.status === 'Envoyé' || t.status === 'Échoué') return;
  const steps = t.steps ? JSON.parse(t.steps) : [];
  const idx = STEP_INDEX[status];
  if (idx !== undefined) for (let i = 0; i <= idx; i++) steps[i] = steps[i] || nowIso();
  const r = await run(env, "UPDATE txs SET status = ?, steps = ? WHERE ref = ? AND status NOT IN ('Envoyé','Échoué')", status, JSON.stringify(steps), ref);
  if (status === 'Échoué' && r.meta.changes) await run(env, 'UPDATE users SET balance = balance + ? WHERE id = ?', -t.amount, t.user_id);
}

// En mode simulation, les retraits avancent avec le temps (pas de minuterie sur Cloudflare).
async function advanceSimulated(env, userId) {
  if (cfg(env).payoutMode !== 'simulation') return;
  const rows = userId
    ? await all(env, "SELECT * FROM txs WHERE user_id = ? AND kind = 'out' AND status IN ('En attente','En traitement')", userId)
    : await all(env, "SELECT * FROM txs WHERE kind = 'out' AND status IN ('En attente','En traitement')");
  for (const t of rows) {
    const age = Date.now() - Date.parse(t.created);
    const target = age > 7000 ? 'Envoyé' : age > 2500 ? 'En traitement' : null;
    if (target && target !== t.status) await setTxStatus(env, t.ref, target);
  }
}

async function mePayload(env, userId) {
  await advanceSimulated(env, userId);
  const c = cfg(env), d = today(env);
  const [u, views, gain, bonus, txs] = await Promise.all([
    one(env, 'SELECT * FROM users WHERE id = ?', userId),
    all(env, "SELECT video_id, status FROM views WHERE user_id = ? AND day = ? AND status IN ('ok','ko')", userId, d),
    one(env, 'SELECT COALESCE(SUM(amount),0) s FROM txs WHERE user_id = ? AND day = ? AND amount > 0', userId, d),
    one(env, 'SELECT 1 x FROM bonuses WHERE user_id = ? AND day = ?', userId, d),
    all(env, 'SELECT * FROM txs WHERE user_id = ? ORDER BY id DESC LIMIT 50', userId)
  ]);
  const done = {};
  for (const v of views) done[v.video_id] = v.status;
  return {
    user: { name: u.name, country: u.country, phone: u.phone, op: u.op, code: u.ref_code, since: u.created },
    balance: u.balance, total: u.total, watched: u.watched, done, todayGain: gain.s, bonus: !!bonus, tx: txs.map(fmtTx),
    config: { goal: c.goal, bonus: c.bonus, minOut: c.minOut }
  };
}

function publicVideo(v) {
  const o = { id: v.id, kind: v.kind, title: v.title, brand: v.brand, cat: v.cat, pay: v.pay, q: v.q, opts: JSON.parse(v.opts), dur: v.dur };
  if (v.kind === 'demo') Object.assign(o, { frames: JSON.parse(v.frames), art: v.art, color: v.color });
  else Object.assign(o, { url: '/media/' + v.file, poster: v.poster ? '/posters/' + v.poster : null });
  return o;
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('POST', '/api/otp/send', async (req, env) => {
  const b = await readJson(req), c = cfg(env);
  const country = +b.country, phone = cleanPhone(country, b.phone);
  const user = await one(env, 'SELECT id FROM users WHERE country = ? AND phone = ?', country, phone);
  if (b.mode === 'login' && !user) fail(404, 'Aucun compte avec ce numéro. Inscris-toi en 1 minute.');
  const key = country + ':' + phone;
  const prev = await one(env, 'SELECT sent_at FROM otps WHERE key = ?', key);
  if (prev && Date.now() - prev.sent_at < 30000) fail(429, 'Patiente 30 secondes avant de redemander un code.');
  const code = otpCode();
  await run(env, 'INSERT OR REPLACE INTO otps(key, code_hash, expires, tries, sent_at) VALUES(?,?,?,0,?)', key, await sha(key + code), Date.now() + 10 * 60000, Date.now());
  await sendSms(env, intl(country, phone), `VuPay : ton code de vérification est ${code}. Ne le partage avec personne.`);
  return { ok: true, exists: !!user, ...(c.devOtp ? { devCode: code } : {}) };
});

route('POST', '/api/otp/verify', async (req, env) => {
  const b = await readJson(req);
  const country = +b.country, phone = cleanPhone(country, b.phone), key = country + ':' + phone;
  const o = await one(env, 'SELECT * FROM otps WHERE key = ?', key);
  if (!o || o.expires < Date.now()) fail(400, 'Code expiré. Demande un nouveau code.');
  if (o.tries >= 5) fail(429, 'Trop d’essais. Demande un nouveau code.');
  if (await sha(key + String(b.code || '')) !== o.code_hash) {
    await run(env, 'UPDATE otps SET tries = tries + 1 WHERE key = ?', key);
    fail(400, 'Code incorrect, réessaie.');
  }
  await run(env, 'DELETE FROM otps WHERE key = ?', key);
  let user = await one(env, 'SELECT * FROM users WHERE country = ? AND phone = ?', country, phone);
  let created = false;
  if (!user) {
    const name = str(b.name, 40, 'Prénom');
    if (!OPS.includes(b.op)) fail(400, 'Opérateur invalide.');
    let code;
    do { code = 'VU' + rid(4).slice(0, 5).toUpperCase(); } while (await one(env, 'SELECT 1 x FROM users WHERE ref_code = ?', code));
    const r = await run(env, 'INSERT INTO users(country, phone, name, op, ref_code, created) VALUES(?,?,?,?,?,?)', country, phone, name, b.op, code, nowIso());
    user = { id: r.meta.last_row_id };
    created = true;
  }
  const token = rid(32);
  await run(env, 'INSERT INTO sessions(token_hash, user_id, created) VALUES(?,?,?)', await sha(token), user.id, nowIso());
  return { token, created, me: await mePayload(env, user.id) };
});

route('POST', '/api/logout', async (req, env) => {
  const h = req.headers.get('authorization') || '';
  if (h.startsWith('Bearer ')) await run(env, 'DELETE FROM sessions WHERE token_hash = ?', await sha(h.slice(7)));
  return { ok: true };
});

route('GET', '/api/me', async (req, env) => mePayload(env, (await authUser(env, req)).id));

route('PATCH', '/api/me', async (req, env) => {
  const u = await authUser(env, req), b = await readJson(req);
  if (b.op !== undefined) { if (!OPS.includes(b.op)) fail(400, 'Opérateur invalide.'); await run(env, 'UPDATE users SET op = ? WHERE id = ?', b.op, u.id); }
  return mePayload(env, u.id);
});

route('GET', '/api/videos', async (req, env) => {
  await authUser(env, req);
  return (await all(env, "SELECT * FROM videos WHERE active = 1 ORDER BY (kind = 'demo'), created DESC")).map(publicVideo);
});

route('POST', '/api/views', async (req, env) => {
  const u = await authUser(env, req), b = await readJson(req);
  const v = await one(env, 'SELECT id FROM videos WHERE id = ? AND active = 1', String(b.videoId || ''));
  if (!v) fail(404, 'Vidéo introuvable.');
  const d = today(env);
  const ex = await one(env, 'SELECT * FROM views WHERE user_id = ? AND video_id = ? AND day = ?', u.id, v.id, d);
  if (ex) { if (ex.status !== 'started') fail(409, 'Tu as déjà fait cette vidéo aujourd’hui.'); return { viewId: ex.id }; }
  const id = rid(10);
  await run(env, "INSERT OR IGNORE INTO views(id, user_id, video_id, day, started, status) VALUES(?,?,?,?,?, 'started')", id, u.id, v.id, d, Date.now());
  const row = await one(env, 'SELECT id FROM views WHERE user_id = ? AND video_id = ? AND day = ?', u.id, v.id, d);
  return { viewId: row.id };
});

route('POST', '/api/views/:id/answer', async (req, env, p) => {
  const u = await authUser(env, req), b = await readJson(req), c = cfg(env);
  const view = await one(env, 'SELECT * FROM views WHERE id = ? AND user_id = ?', p.id, u.id);
  if (!view) fail(404, 'Lecture introuvable.');
  if (view.status !== 'started') fail(409, 'Cette vidéo a déjà été validée.');
  const v = await one(env, 'SELECT * FROM videos WHERE id = ?', view.video_id);
  if ((Date.now() - view.started) / 1000 < v.dur * 0.9 - 2) fail(400, 'La vidéo n’a pas été regardée en entier.');
  const correct = Number(b.answer) === v.answer;
  const claim = await run(env, "UPDATE views SET status = ? WHERE id = ? AND status = 'started'", correct ? 'ok' : 'ko', view.id);
  if (!claim.meta.changes) fail(409, 'Cette vidéo a déjà été validée.');
  let bonus = 0;
  if (correct) {
    const d = view.day, at = nowIso();
    await env.DB.batch([
      st(env, 'UPDATE users SET balance = balance + ?, total = total + ?, watched = watched + 1 WHERE id = ?', v.pay, v.pay, u.id),
      st(env, "INSERT INTO txs(user_id, kind, label, amount, status, created, day) VALUES(?, 'video', ?, ?, 'Crédité', ?, ?)", u.id, v.title, v.pay, at, d)
    ]);
    const n = await one(env, "SELECT COUNT(*) n FROM views WHERE user_id = ? AND day = ? AND status = 'ok'", u.id, d);
    if (n.n >= c.goal) {
      const got = await run(env, 'INSERT OR IGNORE INTO bonuses(user_id, day) VALUES(?,?)', u.id, d);
      if (got.meta.changes) {
        bonus = c.bonus;
        await env.DB.batch([
          st(env, 'UPDATE users SET balance = balance + ?, total = total + ? WHERE id = ?', bonus, bonus, u.id),
          st(env, "INSERT INTO txs(user_id, kind, label, amount, status, created, day) VALUES(?, 'bonus', 'Bonus objectif du jour', ?, 'Crédité', ?, ?)", u.id, bonus, at, d)
        ]);
      }
    }
  }
  return { correct, gained: correct ? v.pay : 0, bonus, me: await mePayload(env, u.id) };
});

route('POST', '/api/withdrawals', async (req, env) => {
  const u = await authUser(env, req), b = await readJson(req), c = cfg(env);
  const amount = Math.floor(Number(b.amount));
  if (!Number.isFinite(amount) || amount < c.minOut) fail(400, `Le minimum est de ${c.minOut} FCFA.`);
  if (!OPS.includes(b.op)) fail(400, 'Opérateur invalide.');
  const num = cleanPhone(u.country, b.number);
  const debit = await run(env, 'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', amount, u.id, amount);
  if (!debit.meta.changes) fail(400, 'Montant supérieur à ton solde.');
  const ref = 'VP' + Date.now().toString().slice(-6) + (100 + (crypto.getRandomValues(new Uint16Array(1))[0] % 900));
  const phone = intl(u.country, num);
  await run(env, "INSERT INTO txs(user_id, kind, label, amount, status, ref, op, num, steps, created, day) VALUES(?, 'out', ?, ?, 'En attente', ?, ?, ?, ?, ?, ?)",
    u.id, 'Retrait ' + b.op, -amount, ref, b.op, phone, JSON.stringify([nowIso()]), nowIso(), today(env));
  try {
    const s = await payout(env, { ref, amount, currency: COUNTRIES[u.country][2], operator: b.op, phone });
    if (s !== 'En attente') await setTxStatus(env, ref, s);
  } catch (e) {
    console.error('Retrait', ref, e.message);
    await setTxStatus(env, ref, 'Échoué');
  }
  return { ref, me: await mePayload(env, u.id) };
});

route('POST', '/api/webhooks/payout', async (req, env) => {
  if (!env.PAYOUT_WEBHOOK_SECRET || req.headers.get('x-webhook-secret') !== env.PAYOUT_WEBHOOK_SECRET) fail(401, 'Non autorisé.');
  const b = await readJson(req);
  const status = b.status === 'success' ? 'Envoyé' : b.status === 'failed' ? 'Échoué' : null;
  if (!status) fail(400, 'Statut inconnu.');
  await setTxStatus(env, String(b.reference || ''), status);
  return { ok: true };
});

// ---- espace annonceur
route('PUT', '/api/uploads', async (req, env) => {
  await authUser(env, req);
  if (!env.MEDIA) fail(503, 'Le stockage des vidéos (R2) n’est pas encore activé.');
  const type = String(req.headers.get('content-type') || '').split(';')[0];
  const ext = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }[type];
  if (!ext) fail(415, 'Format refusé. Utilise une vidéo MP4, WebM ou MOV.');
  const len = +(req.headers.get('content-length') || 0), max = cfg(env).maxUpload;
  if (!len) fail(411, 'Taille de la vidéo inconnue.');
  if (len > max) fail(413, `Vidéo trop lourde (${Math.round(max / 1048576)} Mo maximum).`);
  const file = rid(12) + '.' + ext;
  await env.MEDIA.put('videos/' + file, req.body, { httpMetadata: { contentType: type } });
  return { fileId: file };
});

route('POST', '/api/videos', async (req, env) => {
  const u = await authUser(env, req), b = await readJson(req, 3 * 1024 * 1024), c = cfg(env);
  if (!env.MEDIA) fail(503, 'Le stockage des vidéos (R2) n’est pas encore activé.');
  const file = String(b.fileId || '');
  if (!/^[a-f0-9]{24}\.(mp4|webm|mov)$/.test(file) || !(await env.MEDIA.head('videos/' + file))) fail(400, 'Vidéo introuvable, renvoie-la.');
  const title = str(b.title, 70, 'Titre'), brand = str(b.brand, 30, 'Marque'), q = str(b.q, 90, 'Question');
  if (!CATS.includes(b.cat)) fail(400, 'Catégorie invalide.');
  if (!PAYS.includes(+b.pay)) fail(400, 'Gain par vue invalide.');
  if (!Array.isArray(b.opts) || b.opts.length !== 4) fail(400, 'Il faut 4 réponses.');
  const opts = b.opts.map((o, i) => str(o, 40, 'Réponse ' + (i + 1)));
  const answer = +b.answer; if (![0, 1, 2, 3].includes(answer)) fail(400, 'Coche la bonne réponse.');
  const dur = Number(b.dur); if (!(dur > 0 && dur <= c.maxVideoSec + 1)) fail(400, `La vidéo doit durer ${c.maxVideoSec / 60} minutes maximum.`);
  let poster = null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.poster || ''));
  if (m) {
    poster = rid(10) + '.jpg';
    await env.MEDIA.put('posters/' + poster, Uint8Array.from(atob(m[1]), ch => ch.charCodeAt(0)), { httpMetadata: { contentType: 'image/jpeg' } });
  }
  const id = 'v' + rid(8);
  await run(env, `INSERT INTO videos(id, kind, title, brand, cat, pay, q, opts, answer, dur, file, poster, owner_id, created) VALUES(?, 'video', ?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, title, brand, b.cat, +b.pay, q, JSON.stringify(opts), answer, dur, file, poster, u.id, nowIso());
  return publicVideo(await one(env, 'SELECT * FROM videos WHERE id = ?', id));
});

route('GET', '/api/my-videos', async (req, env) => {
  const u = await authUser(env, req);
  return (await all(env, `SELECT v.*, (SELECT COUNT(*) FROM views w WHERE w.video_id = v.id AND w.status = 'ok') views
    FROM videos v WHERE owner_id = ? AND active = 1 ORDER BY created DESC`, u.id)).map(v => ({ ...publicVideo(v), views: v.views }));
});

route('DELETE', '/api/videos/:id', async (req, env, p) => {
  const u = await authUser(env, req);
  const r = await run(env, 'UPDATE videos SET active = 0 WHERE id = ? AND owner_id = ?', p.id, u.id);
  if (!r.meta.changes) fail(404, 'Vidéo introuvable.');
  return { ok: true };
});

// ---- administration (en-tête X-Admin-Token)
function admin(req, env) { if (!env.ADMIN_TOKEN || req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) fail(401, 'Jeton administrateur invalide.'); }
route('GET', '/api/admin/withdrawals', async (req, env) => {
  admin(req, env);
  await advanceSimulated(env);
  return (await all(env, `SELECT t.*, u.name FROM txs t JOIN users u ON u.id = t.user_id WHERE t.kind = 'out' ORDER BY t.id DESC LIMIT 200`))
    .map(t => ({ ...fmtTx(t), name: t.name }));
});
route('POST', '/api/admin/withdrawals/:ref', async (req, env, p) => {
  admin(req, env);
  const b = await readJson(req);
  if (!['En traitement', 'Envoyé', 'Échoué'].includes(b.status)) fail(400, 'Statut invalide.');
  await setTxStatus(env, p.ref, b.status);
  return { ok: true };
});
route('GET', '/api/admin/stats', async (req, env) => {
  admin(req, env);
  const [a, b, c, d, e] = await Promise.all([
    one(env, 'SELECT COUNT(*) n FROM users'),
    one(env, "SELECT COUNT(*) n FROM views WHERE day = ? AND status = 'ok'", today(env)),
    one(env, 'SELECT COALESCE(SUM(amount),0) s FROM txs WHERE amount > 0'),
    one(env, "SELECT COALESCE(SUM(-amount),0) s FROM txs WHERE kind = 'out' AND status IN ('En attente','En traitement')"),
    one(env, 'SELECT COALESCE(SUM(balance),0) s FROM users')
  ]);
  return { users: a.n, viewsToday: b.n, paidToUsers: c.s, pendingWithdrawals: d.s, balances: e.s };
});

// ---------------------------------------------------------------- fichiers R2 (lecture avec Range pour les vidéos)
async function serveMedia(req, env, key) {
  if (!env.MEDIA) return new Response('Introuvable', { status: 404 });
  const ranged = req.headers.has('range');
  const obj = await env.MEDIA.get(key, ranged ? { range: req.headers } : undefined);
  if (!obj) return new Response('Introuvable', { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', 'public, max-age=86400');
  if (ranged && obj.range) {
    const r = obj.range;
    const start = 'suffix' in r ? obj.size - r.suffix : (r.offset || 0);
    const end = 'suffix' in r ? obj.size - 1 : (r.length !== undefined ? start + r.length - 1 : obj.size - 1);
    h.set('content-range', `bytes ${start}-${end}/${obj.size}`);
    h.set('content-length', String(end - start + 1));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set('content-length', String(obj.size));
  return new Response(obj.body, { headers: h });
}

// ---------------------------------------------------------------- point d'entrée
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    try {
      if (path.startsWith('/api/')) {
        await init(env);
        for (const r of routes) {
          const m = r.method === req.method && r.re.exec(path);
          if (m) return json(await r.handler(req, env, m.groups || {}));
        }
        return json({ error: 'Route inconnue.' }, 404);
      }
      if (path.startsWith('/media/') && /^[a-f0-9]{24}\.(mp4|webm|mov)$/.test(path.slice(7))) return serveMedia(req, env, 'videos/' + path.slice(7));
      if (path.startsWith('/posters/') && /^[a-f0-9]{20}\.jpg$/.test(path.slice(9))) return serveMedia(req, env, 'posters/' + path.slice(9));
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.code);
      console.error(e);
      return json({ error: 'Erreur du serveur, réessaie.' }, 500);
    }
  }
};
