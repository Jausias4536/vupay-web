// Banc d'essai local : imite D1, R2 et les fichiers statiques de Cloudflare pour tester src/worker.js avec Node.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sqlite = new DatabaseSync(':memory:');
const norm = a => a.map(v => v === undefined ? null : v);
class Stmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...a) { this.args = norm(a); return this; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
  runSync() { const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
const DB = {
  prepare: sql => new Stmt(sql),
  async batch(stmts) { sqlite.exec('BEGIN'); try { const out = stmts.map(s => s.runSync()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }
};
const store = new Map();
const MEDIA = {
  async put(key, body, opts) { const buf = Buffer.from(await new Response(body).arrayBuffer()); store.set(key, { buf, type: opts?.httpMetadata?.contentType }); },
  async head(key) { return store.has(key) ? {} : null; },
  async get(key, opts) {
    const o = store.get(key); if (!o) return null;
    let range = null, data = o.buf;
    const hdr = opts?.range?.get?.('range');
    if (hdr) { const m = /bytes=(\d*)-(\d*)/.exec(hdr); const s = +m[1] || 0, e = m[2] ? +m[2] : o.buf.length - 1; range = { offset: s, length: e - s + 1 }; data = o.buf.subarray(s, e + 1); }
    return { size: o.buf.length, range, httpEtag: '"x"', body: data, writeHttpMetadata(h) { if (o.type) h.set('content-type', o.type); } };
  }
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const ASSETS = { async fetch(req) {
  const p = new URL(req.url).pathname; let f = path.join(root, 'public', p === '/' ? 'index.html' : p);
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) f = path.join(root, 'public', 'index.html');
  return new Response(fs.readFileSync(f), { headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' } });
} };
const vars = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '')).vars;
const env = { ...vars, ...(process.env.MIN_WITHDRAW ? { MIN_WITHDRAW: process.env.MIN_WITHDRAW } : {}), DB, MEDIA, ASSETS, ADMIN_TOKEN: 'adm' };

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(+process.env.PORT || 8787, () => console.log('banc d’essai sur http://localhost:' + (process.env.PORT || 8787)));
