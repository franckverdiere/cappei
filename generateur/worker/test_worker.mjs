/* Tests du Worker (node:test, sans dépendance). Usage : node --test worker/   ou   node worker/test_worker.mjs
   KV simulé : get/put en mémoire, avec compteur d'écritures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import worker, { CODES } from './worker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://franckverdiere.github.io';
const fakeKV = (initial) => { const store = new Map(); if (initial !== undefined) store.set('revisees', initial); return { store, puts: 0, gets: 0,
  async get(k) { this.gets++; return store.has(k) ? store.get(k) : null; }, async put(k, v) { this.puts++; store.set(k, v); } }; };
const call = async (env, method, p, body, headers) => {
  const init = { method, headers: { Origin: ORIGIN, ...(headers || {}) } };
  if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await worker.fetch(new Request('https://w.example.workers.dev' + p, init), env);
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* non JSON */ }
  return { res, json, text };
};
const newEnv = (initial, extra) => ({ REVISIONS: fakeKV(initial), ...(extra || {}) });

test('la liste des codes du Worker = les codes des pages générées par le site', () => {
  assert.equal(CODES.length, 37);
  assert.equal(new Set(CODES).size, 37);
  const require = createRequire(import.meta.url);
  const site = require('../build_site.js');
  const fromSite = site.pages.map(p => p.code);
  assert.deepEqual([...CODES].sort(), [...fromSite].sort());
  // et, si le site a été généré, les fichiers fiches/*.html correspondent aussi
  const dir = path.join(process.env.OUT_DIR || path.join(HERE, '..', 'docs'), 'fiches');
  if (fs.existsSync(dir)) {
    const fromFiles = fs.readdirSync(dir).filter(f => /^[jcnp]\d\d\.html$/.test(f)).map(f => f[0].toUpperCase() + parseInt(f.slice(1, 3), 10));
    assert.deepEqual([...CODES].sort(), fromFiles.sort());
  }
});

test('lecture initiale : état vide, JSON, no-store', async () => {
  const env = newEnv();
  const { res, json } = await call(env, 'GET', '/api/revisions');
  assert.equal(res.status, 200);
  assert.deepEqual(json, { revisees: {} });
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  assert.equal(env.REVISIONS.puts, 0);
});

test('coche puis décoche une fiche', async () => {
  const env = newEnv();
  let r = await call(env, 'PUT', '/api/revisions/N4', { revisee: true });
  assert.equal(r.res.status, 200); assert.deepEqual(r.json, { revisees: { N4: true }, modifie: true });
  r = await call(env, 'PUT', '/api/revisions/J1', { revisee: true });
  assert.deepEqual(r.json.revisees, { J1: true, N4: true });
  r = await call(env, 'GET', '/api/revisions');
  assert.deepEqual(r.json, { revisees: { J1: true, N4: true } });
  assert.equal(env.REVISIONS.store.get('revisees'), '{"J1":true,"N4":true}');
  r = await call(env, 'PUT', '/api/revisions/N4', { revisee: false });
  assert.deepEqual(r.json.revisees, { J1: true });
  assert.equal(env.REVISIONS.store.get('revisees'), '{"J1":true}');
  assert.equal(env.REVISIONS.puts, 3);
});

test('aucune écriture quand rien ne change', async () => {
  const env = newEnv('{"N4":true}');
  let r = await call(env, 'PUT', '/api/revisions/N4', { revisee: true });
  assert.equal(r.json.modifie, false);
  r = await call(env, 'PUT', '/api/revisions/J2', { revisee: false });
  assert.equal(r.json.modifie, false);
  r = await call(env, 'PUT', '/api/revisions', { revisees: { N4: true, J1: false } });
  assert.equal(r.json.modifie, false);
  r = await call(env, 'PUT', '/api/revisions', { revisees: {} });
  assert.equal(r.json.modifie, true);
  assert.equal(env.REVISIONS.puts, 1);
  const vide = newEnv();
  r = await call(vide, 'PUT', '/api/revisions', { revisees: {} });
  assert.equal(r.json.modifie, false); assert.equal(vide.REVISIONS.puts, 0);
});

test('code inconnu ou mal formé : 400 et aucune écriture', async () => {
  const env = newEnv();
  for (const c of ['X1', 'J7', 'N17', 'P0', 'j1', 'J01', '__proto__', 'constructor', 'revisees', '%E0%A4%A']) {
    const r = await call(env, 'PUT', '/api/revisions/' + c, { revisee: true });
    assert.equal(r.res.status, 400, c); assert.equal(r.json.erreur, 'code_inconnu', c);
  }
  assert.equal(env.REVISIONS.puts, 0);
});

test('valeur non booléenne ou corps invalide : 400', async () => {
  const env = newEnv();
  for (const b of [{ revisee: 'true' }, { revisee: 1 }, { revisee: null }, {}, { revisee: true, autre: 1 }, { reviseee: true }, [], 'nimporte', '{"revisee":', '', 'null', '"x"']) {
    const r = await call(env, 'PUT', '/api/revisions/J1', typeof b === 'string' ? b : b);
    assert.equal(r.res.status, 400, JSON.stringify(b));
    assert.ok(r.json && r.json.erreur);
  }
  assert.equal(env.REVISIONS.puts, 0);
});

test('corps trop gros : 413 (Content-Length et flux)', async () => {
  const env = newEnv();
  const gros = JSON.stringify({ revisee: true, pad: 'x'.repeat(5000) });
  let r = await call(env, 'PUT', '/api/revisions/J1', gros);
  assert.equal(r.res.status, 413);
  r = await call(env, 'PUT', '/api/revisions', gros);
  assert.equal(r.res.status, 413);
  // flux sans Content-Length
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"revisee":true,"p":"')); for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1000).fill(120)); c.enqueue(new TextEncoder().encode('"}')); c.close(); } });
  const res = await worker.fetch(new Request('https://w.example/api/revisions/J1', { method: 'PUT', body: stream, duplex: 'half', headers: { Origin: ORIGIN } }), env);
  assert.equal(res.status, 413);
  assert.equal(env.REVISIONS.puts, 0);
});

test('import valide : remplace tout, ne stocke que les true', async () => {
  const env = newEnv('{"J1":true,"N4":true}');
  const r = await call(env, 'PUT', '/api/revisions', { revisees: { C2: true, C3: false, P7: true } });
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json.revisees, { C2: true, P7: true });
  assert.equal(env.REVISIONS.store.get('revisees'), '{"C2":true,"P7":true}');
  const tous = Object.fromEntries(CODES.map(c => [c, true]));
  const r2 = await call(env, 'PUT', '/api/revisions', { revisees: tous });
  assert.equal(Object.keys(r2.json.revisees).length, 37);
});

test('import invalide : 400, état inchangé', async () => {
  const env = newEnv('{"J1":true}');
  const cas = [{ revisees: { Z9: true } }, { revisees: { J1: 'oui' } }, { revisees: { J1: 1 } }, { revisees: [] }, { revisees: null }, { revisees: {}, extra: 1 }, { J1: true }, {}, { revisees: { __proto__x: true } }];
  for (const b of cas) { const r = await call(env, 'PUT', '/api/revisions', b); assert.equal(r.res.status, 400, JSON.stringify(b)); }
  const r = await call(env, 'PUT', '/api/revisions', 'pas du json'); assert.equal(r.res.status, 400);
  assert.equal(env.REVISIONS.puts, 0);
  assert.equal(env.REVISIONS.store.get('revisees'), '{"J1":true}');
});

test('valeur KV corrompue ou contenant des clés étrangères : filtrée à la lecture', async () => {
  let r = await call(newEnv('pas du json'), 'GET', '/api/revisions'); assert.deepEqual(r.json, { revisees: {} });
  r = await call(newEnv('{"J1":true,"Z9":true,"N4":false,"P1":"true"}'), 'GET', '/api/revisions'); assert.deepEqual(r.json, { revisees: { J1: true } });
  r = await call(newEnv('[1,2]'), 'GET', '/api/revisions'); assert.deepEqual(r.json, { revisees: {} });
});

test('routes et méthodes inconnues', async () => {
  const env = newEnv();
  for (const p of ['/', '/api', '/api/revisions/', '/api/revisions/J1/x', '/api/autre', '/revisions']) {
    const r = await call(env, 'GET', p); assert.equal(r.res.status, 404, p); assert.ok(r.json.erreur);
  }
  let r = await call(env, 'DELETE', '/api/revisions'); assert.equal(r.res.status, 405);
  r = await call(env, 'POST', '/api/revisions/J1', { revisee: true }); assert.equal(r.res.status, 405);
  r = await call(env, 'GET', '/api/revisions/J1'); assert.equal(r.res.status, 405);
  assert.equal(env.REVISIONS.puts, 0);
});

test('CORS : origine autorisée par défaut', async () => {
  const { res } = await call(newEnv(), 'GET', '/api/revisions');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(res.headers.get('Vary'), /Origin/);
});

test('CORS : origine refusée -> pas d\'en-tête CORS ; PUT refusé (403)', async () => {
  const env = newEnv();
  let r = await call(env, 'GET', '/api/revisions', undefined, { Origin: 'https://exemple.org' });
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), null);
  assert.match(r.res.headers.get('Vary'), /Origin/);
  r = await call(env, 'PUT', '/api/revisions/J1', { revisee: true }, { Origin: 'https://exemple.org' });
  assert.equal(r.res.status, 403); assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(env.REVISIONS.puts, 0);
  r = await call(env, 'GET', '/api/revisions', undefined, { Origin: ORIGIN + '.evil.org' });
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), null);
});

test('CORS : OPTIONS (préliminaire)', async () => {
  const env = newEnv();
  let r = await call(env, 'OPTIONS', '/api/revisions/J1', undefined, { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' });
  assert.equal(r.res.status, 204);
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(r.res.headers.get('Access-Control-Allow-Methods'), 'GET, PUT, OPTIONS');
  assert.match(r.res.headers.get('Access-Control-Allow-Headers'), /Content-Type/i);
  r = await call(env, 'OPTIONS', '/api/revisions', undefined, { Origin: 'https://exemple.org' });
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(env.REVISIONS.puts, 0); assert.equal(env.REVISIONS.gets, 0);
});

test('ALLOWED_ORIGIN : plusieurs origines, remplace la valeur par défaut', async () => {
  const env = newEnv(undefined, { ALLOWED_ORIGIN: 'http://localhost:8080, http://127.0.0.1:9000/' });
  let r = await call(env, 'GET', '/api/revisions', undefined, { Origin: 'http://localhost:8080' });
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
  r = await call(env, 'GET', '/api/revisions', undefined, { Origin: 'http://127.0.0.1:9000' });
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:9000');
  r = await call(env, 'GET', '/api/revisions', undefined, { Origin: ORIGIN });
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), null);
});

test('erreur du stockage : 503 JSON, CORS conservé', async () => {
  const env = { REVISIONS: { async get() { throw new Error('KV down'); }, async put() { throw new Error('KV down'); } } };
  const r = await call(env, 'GET', '/api/revisions');
  assert.equal(r.res.status, 503); assert.equal(r.json.erreur, 'stockage_indisponible');
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('requête sans en-tête Origin (outil en ligne de commande) : acceptée, sans CORS', async () => {
  const env = newEnv();
  const res = await worker.fetch(new Request('https://w.example/api/revisions'), env);
  assert.equal(res.status, 200); assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});
