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
const fakeKV = (initial) => { const store = new Map(); if (initial !== undefined) store.set('revisees', initial); return { store, puts: 0, gets: 0, failPuts: 0,
  async get(k) { this.gets++; return store.has(k) ? store.get(k) : null; }, async put(k, v) { this.puts++; if (this.failPuts > 0) { this.failPuts--; throw new Error('KV PUT failed: 429 Too Many Requests'); } store.set(k, v); } }; };
const call = async (env, method, p, body, headers) => {
  const init = { method, headers: { Origin: ORIGIN, ...(headers || {}) } };
  if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await worker.fetch(new Request('https://w.example.workers.dev' + p, init), env);
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* non JSON */ }
  return { res, json, text };
};
const newEnv = (initial, extra) => ({ REVISIONS: fakeKV(initial), RETRY_MS: 5, ...(extra || {}) });

test('la liste des codes du Worker = les codes des pages générées par le site', () => {
  assert.equal(CODES.length, 37);
  assert.equal(new Set(CODES).size, 37);
  const require = createRequire(import.meta.url);
  // Sur GitHub (déploiement automatique), les sources des fiches ne sont pas dans le dépôt : on compare alors seulement aux pages publiées.
  let site = null;
  try { site = require('../build_site.js'); } catch (e) { if (!process.env.CI) throw e; }
  if (site) assert.deepEqual([...CODES].sort(), [...site.pages.map(p => p.code)].sort());
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
  assert.equal(r.res.headers.get('Access-Control-Allow-Methods'), 'GET, PUT, DELETE, OPTIONS');
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

/* ------------------------------------------------------------------ Annotations */
const D = '2026-11-18T21:00:00.000Z';
const passage = (o) => ({ id: 'abcdefgh1234', type: 'passage', volet: 'n04-1', bloc: 3, debut: 10, texte: 'proportionnalité inverse', avant: 'La règle de ', apres: '', couleur: 1, commentaire: '', cree: D, modifie: D, ...(o || {}) });
const note = (o) => ({ id: 'note00000001', type: 'note', texte: 'Revoir avec le cours de S. Petit.', cree: D, modifie: D, ...(o || {}) });
const putA = (env, code, a, rev, hdr) => call(env, 'PUT', '/api/annotations/' + code + '/' + (a && a.id), { rev, annotation: a }, hdr);
const docKV = (env, code) => { const v = env.REVISIONS.store.get('annotations:' + code); return v ? JSON.parse(v) : null; };

test('annotations : lecture vide, création, modification, note, suppression ; rev augmente', async () => {
  const env = newEnv();
  let r = await call(env, 'GET', '/api/annotations/N4');
  assert.equal(r.res.status, 200); assert.deepEqual(r.json, { code: 'N4', rev: 0, annotations: [] });
  r = await putA(env, 'N4', passage(), 0);
  assert.equal(r.res.status, 200); assert.equal(r.json.rev, 1); assert.equal(r.json.modifie, true); assert.deepEqual(r.json.annotations, [passage()]);
  r = await putA(env, 'N4', passage({ commentaire: 'À relier à N6.', couleur: 3, modifie: '2026-11-18T21:05:00Z' }), 1);
  assert.equal(r.json.rev, 2); assert.equal(r.json.annotations.length, 1); assert.equal(r.json.annotations[0].commentaire, 'À relier à N6.'); assert.equal(r.json.annotations[0].couleur, 3);
  r = await putA(env, 'N4', note(), 2);
  assert.equal(r.json.rev, 3); assert.deepEqual(r.json.annotations.map(a => a.type), ['passage', 'note']);
  r = await call(env, 'DELETE', '/api/annotations/N4/abcdefgh1234?rev=3');
  assert.equal(r.res.status, 200); assert.equal(r.json.rev, 4); assert.deepEqual(r.json.annotations, [note()]);
  assert.deepEqual(docKV(env, 'N4'), { rev: 4, annotations: [note()] });
  const puts = env.REVISIONS.puts;
  r = await call(env, 'DELETE', '/api/annotations/N4/inexistant99?rev=4');      // rien à supprimer : pas d'écriture
  assert.equal(r.json.modifie, false); assert.equal(r.json.rev, 4); assert.equal(env.REVISIONS.puts, puts);
  r = await putA(env, 'N4', note(), 4);                                          // valeur identique : pas d'écriture
  assert.equal(r.json.modifie, false); assert.equal(env.REVISIONS.puts, puts);
  assert.equal(env.REVISIONS.store.get('revisees'), undefined, 'les fiches révisées ne sont pas touchées');
});

test('annotations : sans « rev » connu, l\'opération est appliquée à l\'état courant', async () => {
  const env = newEnv();
  let r = await call(env, 'PUT', '/api/annotations/J1/abcdefgh1234', { annotation: passage({ volet: 'j01-1' }) });
  assert.equal(r.res.status, 200); assert.equal(r.json.rev, 1);
  r = await call(env, 'DELETE', '/api/annotations/J1/abcdefgh1234');
  assert.equal(r.res.status, 200); assert.deepEqual(r.json.annotations, []);
});

test('annotations : lecture périmée (rev connu plus récent que le stockage) -> 409, rien n\'est écrit', async () => {
  const env = newEnv();
  env.REVISIONS.store.set('annotations:N4', JSON.stringify({ rev: 2, annotations: [passage()] }));
  let r = await putA(env, 'N4', note(), 3);
  assert.equal(r.res.status, 409); assert.equal(r.json.erreur, 'lecture_perimee');
  r = await call(env, 'DELETE', '/api/annotations/N4/abcdefgh1234?rev=5');
  assert.equal(r.res.status, 409);
  r = await putA(env, 'N4', note(), 1);                     // autre appareil, en retard : appliqué sur l'état le plus récent
  assert.equal(r.res.status, 200); assert.equal(r.json.annotations.length, 2); assert.equal(r.json.rev, 3);
  for (const bad of ['abc', '-1', '1.5', '1e3']) { r = await call(env, 'DELETE', '/api/annotations/N4/abcdefgh1234?rev=' + bad); assert.equal(r.res.status, 400, bad); }
  r = await putA(env, 'N4', note(), 'x'); assert.equal(r.res.status, 400);
  assert.equal(env.REVISIONS.puts, 1);
});

test('annotations invalides : 400, aucune écriture', async () => {
  const env = newEnv();
  const cas = [
    ['type inconnu', passage({ type: 'autre' })], ['champ en trop', passage({ html: '<b>x</b>' })], ['champ manquant', (() => { const a = passage(); delete a.apres; return a; })()],
    ['couleur 4', passage({ couleur: 4 })], ['couleur texte', passage({ couleur: '1' })], ['commentaire trop long', passage({ commentaire: 'x'.repeat(2001) })],
    ['passage vide', passage({ texte: '' })], ['passage espaces', passage({ texte: '   ' })], ['passage trop long', passage({ texte: 'x'.repeat(1001) })],
    ['contexte trop long', passage({ avant: 'x'.repeat(65) })], ['caractère de contrôle', passage({ commentaire: 'a\u0000b' })], ['date', passage({ cree: 'hier' })],
    ['bloc négatif', passage({ bloc: -1 })], ['debut décimal', passage({ debut: 1.5 })], ['volet', passage({ volet: '../x' })],
    ['note vide', note({ texte: '' })], ['note trop longue', note({ texte: 'x'.repeat(4001) })], ['note avec couleur', note({ couleur: 1 })],
    ['pas un objet', ['x']], ['null', null],
  ];
  for (const [nom, a] of cas) {
    const r = await call(env, 'PUT', '/api/annotations/N4/abcdefgh1234', { rev: 0, annotation: a });
    assert.equal(r.res.status, 400, nom); assert.ok(r.json.message, nom);
  }
  let r = await call(env, 'PUT', '/api/annotations/N4/zzzzzzzz9999', { annotation: passage() });          // id de l'adresse ≠ id de l'annotation
  assert.equal(r.res.status, 400); assert.equal(r.json.erreur, 'id_invalide');
  for (const id of ['court', 'MAJUSCULE123', 'a-b-c-d-e-f-g', 'x'.repeat(25)]) { r = await call(env, 'PUT', '/api/annotations/N4/' + id, { annotation: passage({ id }) }); assert.equal(r.res.status, 400, id); }
  for (const b of [{}, { annotation: passage(), autre: 1 }, { rev: 0 }]) { r = await call(env, 'PUT', '/api/annotations/N4/abcdefgh1234', b); assert.equal(r.res.status, 400, JSON.stringify(b)); }
  r = await call(env, 'PUT', '/api/annotations/N4/abcdefgh1234', 'pas du json'); assert.equal(r.res.status, 400);
  r = await call(env, 'PUT', '/api/annotations/Z9/abcdefgh1234', { annotation: passage() }); assert.equal(r.res.status, 400); assert.equal(r.json.erreur, 'code_inconnu');
  r = await call(env, 'GET', '/api/annotations/__proto__'); assert.equal(r.res.status, 400);
  r = await call(env, 'PUT', '/api/annotations/N4/abcdefgh1234', JSON.stringify({ annotation: passage({ commentaire: 'x'.repeat(40000) }) })); assert.equal(r.res.status, 413);
  assert.equal(env.REVISIONS.puts, 0);
});

test('annotations : au plus 300 par fiche (une existante reste modifiable)', async () => {
  const env = newEnv();
  const liste = Array.from({ length: 300 }, (_, i) => note({ id: 'n' + String(i).padStart(11, '0') }));
  env.REVISIONS.store.set('annotations:P1', JSON.stringify({ rev: 7, annotations: liste }));
  let r = await putA(env, 'P1', passage({ volet: 'p01-1' }), 7);
  assert.equal(r.res.status, 400); assert.equal(r.json.erreur, 'trop_d_annotations');
  r = await putA(env, 'P1', note({ id: 'n00000000005', texte: 'modifiée' }), 7);
  assert.equal(r.res.status, 200); assert.equal(r.json.annotations.length, 300); assert.equal(r.json.annotations[5].texte, 'modifiée');
});

test('annotations : écriture refusée par KV (429) réessayée ; trois refus -> 503', async () => {
  const env = newEnv();
  env.REVISIONS.failPuts = 2;
  let r = await putA(env, 'N4', passage(), 0);
  assert.equal(r.res.status, 200); assert.equal(env.REVISIONS.puts, 3); assert.equal(docKV(env, 'N4').rev, 1);
  env.REVISIONS.failPuts = 3;
  r = await putA(env, 'N4', note(), 1);
  assert.equal(r.res.status, 503); assert.equal(docKV(env, 'N4').annotations.length, 1);
});

test('annotations : valeurs KV corrompues filtrées ; lecture de toutes les fiches', async () => {
  const env = newEnv();
  env.REVISIONS.store.set('annotations:N4', 'pas du json');
  env.REVISIONS.store.set('annotations:J1', JSON.stringify({ rev: 3, annotations: [passage({ volet: 'j01-1' }), { id: 'x', type: 'passage' }, passage({ volet: 'j01-1' }), note()] }));
  env.REVISIONS.store.set('annotations:Z9', JSON.stringify({ rev: 1, annotations: [note()] }));
  let r = await call(env, 'GET', '/api/annotations/N4'); assert.deepEqual(r.json, { code: 'N4', rev: 0, annotations: [] });
  r = await call(env, 'GET', '/api/annotations/J1'); assert.equal(r.json.rev, 3); assert.deepEqual(r.json.annotations.map(a => a.id), ['abcdefgh1234', 'note00000001']);
  r = await call(env, 'GET', '/api/annotations');
  assert.equal(r.res.status, 200); assert.deepEqual(Object.keys(r.json.annotations), ['J1']); assert.equal(r.json.annotations.J1.length, 2);
});

test('sauvegarde : lecture complète, import avec et sans annotations', async () => {
  const env = newEnv('{"J1":true}');
  env.REVISIONS.store.set('annotations:N4', JSON.stringify({ rev: 5, annotations: [passage()] }));
  env.REVISIONS.store.set('annotations:C2', JSON.stringify({ rev: 1, annotations: [note()] }));
  let r = await call(env, 'GET', '/api/sauvegarde');
  assert.deepEqual(r.json, { revisees: { J1: true }, annotations: { C2: [note()], N4: [passage()] } });
  // import complet : N4 inchangée (pas d'écriture), C2 vidée, P7 créée, fiches révisées remplacées
  const puts = env.REVISIONS.puts;
  r = await call(env, 'PUT', '/api/sauvegarde', { revisees: { N4: true, J1: false }, annotations: { N4: [passage()], P7: [note({ id: 'p7note000001' })] } });
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json.revisees, { N4: true }); assert.deepEqual(r.json.modifie, { revisees: true, fiches: 2 });
  assert.deepEqual(Object.keys(r.json.annotations), ['N4', 'P7']);
  assert.equal(env.REVISIONS.puts - puts, 3, 'revisees + C2 + P7');
  assert.deepEqual(docKV(env, 'C2'), { rev: 2, annotations: [] }); assert.equal(docKV(env, 'N4').rev, 5); assert.equal(docKV(env, 'P7').rev, 1);
  // ancien fichier (sans annotations) : seules les fiches révisées changent
  r = await call(env, 'PUT', '/api/sauvegarde', { revisees: { C1: true } });
  assert.equal(r.res.status, 200); assert.deepEqual(r.json.revisees, { C1: true }); assert.deepEqual(Object.keys(r.json.annotations), ['N4', 'P7']); assert.equal(r.json.modifie.fiches, 0);
});

test('sauvegarde : import invalide -> 400, RIEN n\'est écrit (ni fiches révisées, ni annotations)', async () => {
  const env = newEnv('{"J1":true}');
  env.REVISIONS.store.set('annotations:N4', JSON.stringify({ rev: 5, annotations: [passage()] }));
  const cas = [
    { revisees: { C1: true }, annotations: { N4: [passage({ couleur: 9 })] } },
    { revisees: { C1: true }, annotations: { Z9: [] } },
    { revisees: { C1: true }, annotations: { N4: 'x' } },
    { revisees: { C1: true }, annotations: [] },
    { revisees: { C1: true }, annotations: { N4: [passage(), passage()] } },
    { revisees: { C1: true }, annotations: { N4: Array.from({ length: 301 }, (_, i) => note({ id: 'n' + String(i).padStart(11, '0') })) } },
    { revisees: { Z1: true }, annotations: {} },
    { revisees: { C1: 'oui' } },
    { annotations: {} },
    { revisees: {}, annotations: {}, autre: 1 },
  ];
  for (const b of cas) { const r = await call(env, 'PUT', '/api/sauvegarde', b); assert.equal(r.res.status, 400, JSON.stringify(b).slice(0, 120)); assert.ok(r.json.message); }
  assert.equal(env.REVISIONS.puts, 0);
  const gros = JSON.stringify({ revisees: {}, annotations: { N4: [passage({ commentaire: 'x'.repeat(1000) })] }, pad: 'x'.repeat(600000) });
  const r = await call(env, 'PUT', '/api/sauvegarde', gros); assert.equal(r.res.status, 413);
});

test('annotations : routes, méthodes et origine', async () => {
  const env = newEnv();
  let r = await call(env, 'GET', '/api/annotations/N4/abcdefgh1234'); assert.equal(r.res.status, 405);
  r = await call(env, 'PUT', '/api/annotations/N4', {}); assert.equal(r.res.status, 405);
  r = await call(env, 'DELETE', '/api/annotations'); assert.equal(r.res.status, 405);
  r = await call(env, 'DELETE', '/api/sauvegarde'); assert.equal(r.res.status, 405);
  r = await call(env, 'GET', '/api/annotations/N4/a/b'); assert.equal(r.res.status, 404);
  r = await putA(env, 'N4', passage(), 0, { Origin: 'https://exemple.org' }); assert.equal(r.res.status, 403);
  r = await call(env, 'DELETE', '/api/annotations/N4/abcdefgh1234', undefined, { Origin: 'https://exemple.org' }); assert.equal(r.res.status, 403);
  r = await call(env, 'PUT', '/api/sauvegarde', { revisees: {} }, { Origin: 'https://exemple.org' }); assert.equal(r.res.status, 403);
  r = await call(env, 'GET', '/api/annotations', undefined, { Origin: 'https://exemple.org' }); assert.equal(r.res.status, 200); assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), null);
  r = await call(env, 'OPTIONS', '/api/annotations/N4/abcdefgh1234', undefined, { 'Access-Control-Request-Method': 'DELETE' });
  assert.equal(r.res.status, 204); assert.match(r.res.headers.get('Access-Control-Allow-Methods'), /DELETE/);
  assert.equal(env.REVISIONS.puts, 0);
});
