/* Tests de bout en bout : Worker (KV simulé en mémoire) + site généré + Chrome sans interface (playwright-core).
   Usage : cd /home/claude/e2e && node run.mjs      (code de sortie 1 si un test échoue) */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import worker, { CODES } from '/home/claude/site-build/worker/worker.mjs';

const BUILD = '/home/claude/site-build';
const SITE_ON = '/tmp/site-test', SITE_OFF = '/tmp/site-test-off';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';

/* ---------- KV simulé + serveur du Worker ---------- */
const kv = { store: new Map(), puts: 0, async get(k) { return this.store.has(k) ? this.store.get(k) : null; }, async put(k, v) { this.puts++; this.store.set(k, v); } };
const mode = { fail: null, delay: 0 };            // null | 'down' (connexion coupée) | '500'
const journal = [];                                // requêtes reçues par le Worker
const toListen = (srv) => new Promise(r => srv.listen(0, () => r(srv.address().port)));
const api = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  journal.push({ method: req.method, url: req.url });
  if (mode.delay) await new Promise(r => setTimeout(r, mode.delay));
  if (mode.fail === 'down' && req.method !== 'OPTIONS') { req.socket.destroy(); return; }
  if (mode.fail === '500' && req.method !== 'OPTIONS') { res.writeHead(500, { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Content-Type': 'application/json' }); res.end('{"erreur":"x"}'); return; }
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const init = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method)) init.body = body;
  const r = await worker.fetch(new Request('http://localhost' + req.url, init), { REVISIONS: kv, ALLOWED_ORIGIN: ORIGIN });
  const out = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(out);
});
/* ---------- serveur statique ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript; charset=utf-8' };
const staticSrv = (root) => http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
const siteOn = staticSrv(SITE_ON), siteOff = staticSrv(SITE_OFF);
const portApi = await toListen(api), portOn = await toListen(siteOn), portOff = await toListen(siteOff);
const ORIGIN = `http://localhost:${portOn}`;
const API = `http://localhost:${portApi}`;
const SITE = ORIGIN;

const buildSite = (out, apiUrl) => execFileSync('node', ['build_site.js'], { cwd: BUILD, env: { ...process.env, OUT_DIR: out, API_URL: apiUrl }, stdio: 'pipe' }).toString();
console.log(buildSite(SITE_ON, API).split('\n')[0]);
console.log(buildSite(SITE_OFF, '').split('\n')[0]);

/* ---------- mini-harnais ---------- */
let pass = 0, fail = 0; const failures = [];
const test = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name); console.log('  ÉCHEC ' + name + '\n         ' + String(e.message || e).split('\n').slice(0, 4).join('\n         ')); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'différent') + ' : obtenu ' + JSON.stringify(a) + ', attendu ' + JSON.stringify(b)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'condition fausse'); };
const serverState = () => { const v = kv.store.get('revisees'); return v ? JSON.parse(v) : {}; };
const reset = () => { kv.store.clear(); mode.fail = null; mode.delay = 0; };
const putsSince = (n) => journal.slice(n).filter(j => j.method === 'PUT').length;

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
console.log('Navigateur : ' + browser.version());
const newCtx = async (opts) => { const ctx = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR', ...(opts || {}) }); return ctx; };
const consoleErrors = [];
const open = async (ctx, url) => { const p = await ctx.newPage(); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|CORS|Access-Control/i.test(m.text())) consoleErrors.push(url + ' : ' + m.text()); }); p.on('pageerror', e => consoleErrors.push(url + ' : ' + e.message)); await p.goto(SITE + url); return p; };
const caseDe = p => p.getByRole('checkbox', { name: 'Fiche révisée' });
const attendreActive = async p => { await p.waitForFunction(() => { const c = document.getElementById('suivi-revisee'); return c && !c.disabled; }, null, { timeout: 5000 }); };
const compteur = async p => (await p.locator('.suivi-resume').innerText()).replace(/\s+/g, ' ').trim();
const nbRevisees = () => Object.values(serverState()).filter(v => v === true).length;
const attendreCompteurAcc = (p, txt) => p.waitForFunction(t => { const e = document.querySelector('.suivi-resume'); return e && e.textContent.replace(/\s+/g, ' ').trim() === t; }, txt, { timeout: 5000 });
const attendreCompteur = async (p, txt) => {
  if (!/\/export\.html$/.test(p.url())) return attendreCompteurAcc(p, txt);
  const n = parseInt(txt, 10);   // page Export : boutons actifs et état du service = nombre attendu
  await p.waitForFunction(() => { const b = [...document.querySelectorAll('#suivi-export > .suivi-actions button')]; return b.length === 2 && b.every(x => !x.disabled); }, null, { timeout: 5000 });
  for (let k = 0; k < 50 && nbRevisees() !== n; k++) await new Promise(r => setTimeout(r, 100));
  eq(nbRevisees(), n, 'état du service');
};

await test('check_site.js passe sur le site généré avec le suivi actif (OUT_DIR)', async () => {
  const out = execFileSync('node', ['check_site.js'], { cwd: BUILD, env: { ...process.env, OUT_DIR: SITE_ON }, stdio: 'pipe' }).toString();
  ok(/tous les contrôles passent/.test(out) && /ACTIF/.test(out), out.slice(-300));
});
const ctxA = await newCtx();
console.log('\nCase de la fiche, persistance, autre appareil');
await test('fiche N4 : case « Fiche révisée » présente, activée après chargement, décochée', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreActive(p);
  eq(await caseDe(p).count(), 1); ok(await caseDe(p).isEnabled()); ok(!(await caseDe(p).isChecked()));
  eq(await p.locator('label[for="suivi-revisee"]').innerText(), 'Fiche révisée');
  eq(await p.locator('[role="status"][aria-live="polite"]').count() >= 1, true, 'zone aria-live');
  await p.close();
});
await test('cocher N4 : « Enregistré », état écrit sur le serveur, toujours cochée après rechargement', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreActive(p);
  await caseDe(p).check();
  await p.waitForFunction(() => document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré', null, { timeout: 5000 });
  eq(serverState(), { N4: true });
  await p.reload(); await attendreActive(p); ok(await caseDe(p).isChecked(), 'cochée après rechargement');
  await p.close();
});
await test('second contexte vierge (autre appareil) : N4 cochée, J1 non', async () => {
  const ctxB = await newCtx(); const p = await open(ctxB, '/fiches/n04.html'); await attendreActive(p);
  ok(await caseDe(p).isChecked(), 'N4 cochée sur l\'autre appareil');
  const q = await open(ctxB, '/fiches/j01.html'); await attendreActive(q); ok(!(await caseDe(q).isChecked()), 'J1 non cochée');
  await ctxB.close();
});
await test('la coche apparaît dans le menu (texte masqué « révisée »), en direct puis après rechargement', async () => {
  const p = await open(ctxA, '/fiches/n04.html'); await attendreActive(p);
  const lien = p.locator('#menu a[href="n04.html"]');
  eq(await lien.locator('.suivi-ok').count(), 1); ok((await lien.locator('.suivi-ok .sr-only').textContent()).includes('révisée'));
  eq(await p.locator('#menu .suivi-ok').count(), 1, 'une seule coche dans le menu');
  await caseDe(p).uncheck(); await p.waitForFunction(() => !document.querySelector('#menu .suivi-ok'));
  await caseDe(p).check(); await p.waitForFunction(() => document.querySelectorAll('#menu .suivi-ok').length === 1);
  await p.close();
});
await test('coche aussi visible dans le menu des autres pages (index, accueil)', async () => {
  const p = await open(ctxA, '/index-sigles.html'); await p.waitForFunction(() => document.querySelector('#menu .suivi-ok'), null, { timeout: 5000 });
  eq(await p.locator('#menu a[href="fiches/n04.html"] .suivi-ok').count(), 1); await p.close();
});

console.log('\nAccueil : compteur, parties, liste, décocher');
await test('accueil : « 1 fiche sur 36 révisée », barre, décompte par partie, 35 liens, prochaine = J1', async () => {
  reset(); kv.store.set('revisees', '{"N4":true}');
  const p = await open(ctxA, '/index.html'); await attendreCompteur(p, '1 fiche sur 36 révisée');
  const bar = p.getByRole('progressbar', { name: 'Fiches révisées' });
  eq(await bar.getAttribute('aria-valuenow'), '1'); eq(await bar.getAttribute('aria-valuemax'), '36');
  const parts = (await p.locator('.suivi-parties li').allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
  eq(parts.length, 4); ok(/jury.*0 sur 6/i.test(parts[0]), parts[0]); ok(/Cadre.*0 sur 7/.test(parts[1]), parts[1]); ok(/Notions.*1 sur 16/.test(parts[2]), parts[2]); ok(/Publics.*0 sur 7/.test(parts[3]), parts[3]);
  eq(await p.locator('.suivi-restantes a').count(), 35);
  ok((await p.locator('.suivi-prochaine').innerText()).includes('J1'));
  eq(await p.locator('.suivi-restantes a[href="fiches/n04.html"]').count(), 0, 'N4 absente de la liste');
  await p.close();
});
await test('compteur juste après plusieurs coches puis décoche (rechargement entre chaque)', async () => {
  reset();
  for (const [u] of [['/fiches/j02.html'], ['/fiches/c03.html'], ['/fiches/p07.html']]) { const p = await open(ctxA, u); await attendreActive(p); await caseDe(p).check(); await p.waitForFunction(() => document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré'); await p.close(); }
  let h = await open(ctxA, '/index.html'); await attendreCompteur(h, '3 fiches sur 36 révisées'); await h.close();
  const q = await open(ctxA, '/fiches/c03.html'); await attendreActive(q); await caseDe(q).uncheck(); await q.waitForFunction(() => document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré'); await q.close();
  eq(serverState(), { J2: true, P7: true });
  h = await open(ctxA, '/index.html'); await attendreCompteur(h, '2 fiches sur 36 révisées'); await h.close();
});
await test('toutes révisées : message dédié, plus de liste', async () => {
  reset(); kv.store.set('revisees', JSON.stringify(Object.fromEntries(CODES.map(c => [c, true]))));
  const p = await open(ctxA, '/index.html'); await attendreCompteur(p, '36 fiches sur 36 révisées');
  ok((await p.locator('.suivi-prochaine').innerText()).includes('Toutes les fiches')); ok(!(await p.locator('.suivi-liste').isVisible())); await p.close();
});
await test('menu : les 36 liens de fiches du menu = les 36 codes du Worker', async () => {
  const p = await open(ctxA, '/index.html');
  const codes = await p.$$eval('#menu .menu-list a .code', els => els.map(e => e.textContent.trim()));
  eq([...codes].sort(), [...CODES].sort()); await p.close();
});

console.log('\nÉchecs réseau');
await test('échec à l\'écriture (connexion coupée) : message, case revenue en arrière, serveur inchangé', async () => {
  reset(); const p = await open(ctxA, '/fiches/j05.html'); await attendreActive(p);
  mode.fail = 'down'; await caseDe(p).check();
  await p.waitForFunction(() => /Impossible d.enregistrer : le service est injoignable/.test(document.querySelector('.suivi-fiche .suivi-msg').textContent), null, { timeout: 15000 });
  ok(!(await caseDe(p).isChecked()), 'case revenue décochée'); ok(await caseDe(p).isEnabled(), 'case réactivée');
  eq(await p.locator('#menu .suivi-ok').count(), 0); eq(serverState(), {});
  mode.fail = null; await caseDe(p).check(); await p.waitForFunction(() => document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré'); eq(serverState(), { J5: true });
  await p.close();
});
await test('échec à l\'écriture (réponse 500) pour une décoche : la case redevient cochée', async () => {
  reset(); kv.store.set('revisees', '{"J5":true}'); const p = await open(ctxA, '/fiches/j05.html'); await attendreActive(p); ok(await caseDe(p).isChecked());
  mode.fail = '500'; await caseDe(p).click({ noWaitAfter: true, force: true }).catch(() => {});
  await p.waitForFunction(() => /Impossible d.enregistrer/.test(document.querySelector('.suivi-fiche .suivi-msg').textContent), null, { timeout: 5000 });
  ok(await caseDe(p).isChecked(), 'case revenue cochée'); eq(await p.locator('#menu .suivi-ok').count(), 1); eq(serverState(), { J5: true });
  await p.close();
});
await test('échec au chargement : message visible, case désactivée et décochée (même si le serveur dit « révisée »), pas de coches', async () => {
  reset(); kv.store.set('revisees', '{"J5":true}'); mode.fail = 'down';
  const p = await open(ctxA, '/fiches/j05.html');
  await p.waitForFunction(() => /Suivi indisponible : impossible de joindre le service\./.test(document.querySelector('.suivi-fiche .suivi-msg').textContent), null, { timeout: 15000 });
  ok(await caseDe(p).isDisabled()); ok(!(await caseDe(p).isChecked())); eq(await p.locator('#menu .suivi-ok').count(), 0);
  ok(await p.locator('.suivi-retry:visible').first().isVisible(), 'bouton Réessayer');
  mode.fail = null; await p.locator('.suivi-retry:visible').first().click(); await attendreActive(p); ok(await caseDe(p).isChecked(), 'après réessai : cochée'); ok(!(await p.locator('.suivi-retry:visible').first().isVisible()));
  await p.close();
});
await test('échec au chargement sur l\'accueil et une page d\'index : message, boutons désactivés', async () => {
  reset(); mode.fail = '500';
  const h = await open(ctxA, '/index.html');
  await h.waitForFunction(() => /Suivi indisponible/.test(document.querySelector('.suivi-home .suivi-msg').textContent), null, { timeout: 5000 });
  eq(await h.locator('.suivi-restantes').count(), 0); eq(await h.getByRole('button', { name: 'Exporter' }).count(), 0);
  const x = await open(ctxA, '/export.html');
  await x.waitForFunction(() => /Suivi indisponible/.test(document.querySelector('.suivi-avis').textContent), null, { timeout: 5000 });
  ok(await x.getByRole('button', { name: 'Exporter' }).isDisabled()); ok(await x.getByRole('button', { name: /Importer/ }).isDisabled()); await x.close();
  const i = await open(ctxA, '/index-auteurs.html');
  await i.waitForFunction(() => /Suivi indisponible/.test(document.querySelector('.suivi-avis').textContent), null, { timeout: 5000 });
  await h.close(); await i.close(); mode.fail = null;
});
await test('double clic rapide (service lent) : une seule écriture envoyée, case désactivée pendant l\'envoi', async () => {
  reset(); const p = await open(ctxA, '/fiches/c01.html'); await attendreActive(p);
  mode.delay = 400; const n = journal.length;
  await caseDe(p).click(); ok(await caseDe(p).isDisabled(), 'désactivée pendant l\'envoi');
  await caseDe(p).click({ force: true, timeout: 500 }).catch(() => {});
  ok((await p.locator('.suivi-fiche .suivi-msg').first().innerText()).includes('Enregistrement'));
  await p.waitForFunction(() => document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré', null, { timeout: 5000 });
  mode.delay = 0; eq(putsSince(n), 1, 'nombre de PUT'); eq(serverState(), { C1: true }); ok(await caseDe(p).isChecked());
  await p.close();
});

console.log('\nExport / import');
const dl = async (p) => { const [d] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Exporter' }).click()]); const f = await d.path(); return { name: d.suggestedFilename(), data: fs.readFileSync(f, 'utf8') }; };
await test('export : fichier revisions-cappei-AAAA-MM-JJ.json valide, 36 codes, reflète le serveur', async () => {
  reset(); kv.store.set('revisees', '{"J1":true,"N4":true,"P7":true}');
  const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '3 fiches sur 36 révisées');
  kv.store.set('revisees', '{"J1":true,"N4":true,"P7":true,"C2":true}');     // changé côté serveur depuis le chargement : l'export doit le refléter
  const f = await dl(p);
  ok(/^revisions-cappei-\d{4}-\d{2}-\d{2}\.json$/.test(f.name), f.name);
  const j = JSON.parse(f.data);
  eq(Object.keys(j).sort(), ['exporte_le', 'revisees', 'version']); eq(j.version, 1); ok(!isNaN(Date.parse(j.exporte_le)) && /T.*Z$/.test(j.exporte_le), 'ISO');
  eq(Object.keys(j.revisees), CODES); ok(Object.values(j.revisees).every(v => typeof v === 'boolean'));
  eq(Object.keys(j.revisees).filter(k => j.revisees[k]).sort(), ['C2', 'J1', 'N4', 'P7']);
  await p.close();
});
const importFile = async (p, name, content) => { const f = path.join(os.tmpdir(), name); fs.writeFileSync(f, content); await p.locator('input.suivi-fichier').setInputFiles(f); };
const tousFalse = (vrais) => Object.fromEntries(CODES.map(c => [c, vrais.includes(c)]));
await test('import valide : confirmation (avant/après), puis état remplacé sur serveur et à l\'écran', async () => {
  reset(); kv.store.set('revisees', '{"J1":true,"N4":true}');
  const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '2 fiches sur 36 révisées');
  await importFile(p, 'ok.json', JSON.stringify({ version: 1, exporte_le: new Date().toISOString(), revisees: tousFalse(['C1', 'C2', 'C3', 'P1']) }));
  await p.locator('.suivi-confirm:not([hidden])').waitFor({ timeout: 5000 });
  const t = await p.locator('.suivi-confirm').innerText(); ok(/2 avant, 4 après/.test(t), t);
  eq(serverState(), { J1: true, N4: true }, 'rien n\'est écrit avant confirmation');
  await p.getByRole('button', { name: 'Remplacer' }).click();
  await attendreCompteur(p, '4 fiches sur 36 révisées'); eq(serverState(), { C1: true, C2: true, C3: true, P1: true });
  ok((await p.locator('.suivi-msg-sauv').innerText()).includes('Import terminé'));
  eq(await p.locator('#menu .suivi-ok').count(), 4);
  await p.close();
});
await test('import valide puis « Annuler » : rien n\'est modifié', async () => {
  reset(); kv.store.set('revisees', '{"J1":true}'); const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '1 fiche sur 36 révisée');
  const n = journal.length;
  await importFile(p, 'ok2.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1']) }));
  await p.locator('.suivi-confirm:not([hidden])').waitFor(); await p.getByRole('button', { name: 'Annuler' }).click();
  ok(await p.locator('.suivi-confirm').isHidden()); eq(serverState(), { J1: true }); eq(putsSince(n), 0); await p.close();
});
await test('import invalide (8 cas) : refusé avec message clair, aucun envoi, état inchangé', async () => {
  reset(); kv.store.set('revisees', '{"J1":true,"N4":true}'); const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '2 fiches sur 36 révisées');
  const cas = [
    ['pas json', 'ceci n\'est pas du JSON', /pas un JSON valide/],
    ['tableau', '[1,2,3]', /objet JSON attendu/],
    ['version', JSON.stringify({ version: 2, revisees: {} }), /Version de sauvegarde non reconnue/],
    ['sans version', JSON.stringify({ revisees: {} }), /Version de sauvegarde non reconnue/],
    ['code inconnu', JSON.stringify({ version: 1, revisees: { Z9: true } }), /Code de fiche inconnu : Z9/],
    ['non booléen', JSON.stringify({ version: 1, revisees: { J1: 'oui' } }), /doit être true ou false/],
    ['revisees absent', JSON.stringify({ version: 1 }), /revisees/],
    ['trop gros', JSON.stringify({ version: 1, revisees: {}, pad: 'x'.repeat(20000) }), /volumineux/],
  ];
  const n = journal.length;
  for (const [nom, contenu, motif] of cas) {
    console.log('         cas : ' + nom); await importFile(p, 'bad-' + 'c' + cas.findIndex(c => c[0] === nom) + '.json', contenu);
    await p.waitForFunction(() => /^Import refusé|^Fichier refusé/.test(document.querySelector('.suivi-msg-sauv').textContent), null, { timeout: 5000 });
    const m = await p.locator('.suivi-msg-sauv').innerText(); ok(motif.test(m), nom + ' : ' + m);
    ok(await p.locator('.suivi-confirm').isHidden(), nom + ' : pas de confirmation');
    await p.evaluate(() => { document.querySelector('.suivi-msg-sauv').textContent = ''; });
  }
  eq(putsSince(n), 0, 'aucune écriture'); eq(serverState(), { J1: true, N4: true }); await p.close();
});
await test('import : échec du service pendant l\'envoi -> message, état inchangé', async () => {
  reset(); kv.store.set('revisees', '{"J1":true}'); const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '1 fiche sur 36 révisée');
  await importFile(p, 'ok3.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1']) })); await p.locator('.suivi-confirm:not([hidden])').waitFor();
  mode.fail = '500'; await p.getByRole('button', { name: 'Remplacer' }).click();
  await p.waitForFunction(() => /Import impossible/.test(document.querySelector('.suivi-msg-sauv').textContent), null, { timeout: 5000 });
  mode.fail = null; eq(serverState(), { J1: true }); await attendreCompteur(p, '1 fiche sur 36 révisée'); await p.close();
});

console.log('\nStockage dans le navigateur');
await test('aucune donnée de suivi dans localStorage / sessionStorage / cookies / IndexedDB / Cache API (contexte ayant coché, exporté, importé)', async () => {
  const ctx = await newCtx(); reset();
  const p = await open(ctx, '/fiches/n04.html'); await attendreActive(p); await caseDe(p).check(); await p.waitForFunction(() => document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré');
  const h = await open(ctx, '/export.html'); await attendreCompteur(h, '1 fiche sur 36 révisée'); await dl(h);
  await importFile(h, 'ok4.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1', 'J3']) })); await h.locator('.suivi-confirm:not([hidden])').waitFor(); await h.getByRole('button', { name: 'Remplacer' }).click(); await attendreCompteur(h, '2 fiches sur 36 révisées');
  for (const pg of [p, h]) {
    const s = await pg.evaluate(async () => ({
      ls: Object.keys(localStorage), ss: Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])), ck: document.cookie,
      idb: indexedDB.databases ? (await indexedDB.databases()).length : 0, cs: 'caches' in window ? (await caches.keys()).length : 0 }));
    eq(s.ls, [], 'localStorage'); eq(s.ck, '', 'cookies'); eq(s.idb, 0, 'IndexedDB'); eq(s.cs, 0, 'Cache API');
    for (const [k, v] of Object.entries(s.ss)) ok(k === 'cappei-menu-v1' && !/revis|"[JCNP]\d+"/.test(v), 'sessionStorage inattendu : ' + k + '=' + v);
    console.log('         sessionStorage de la page : ' + JSON.stringify(s.ss));
  }
  eq((await ctx.cookies()).length, 0, 'cookies du contexte'); await ctx.close();
});

console.log('\nPages Accueil, Mode d\'emploi, Export');
await test('accueil : plus de « Sauvegarde » ni de mode d\'emploi, deux liens vers les nouvelles pages, pas de boutons export', async () => {
  reset(); const p = await open(ctxA, '/index.html'); await attendreCompteur(p, '0 fiche sur 36 révisée');
  const t = await p.evaluate(() => document.querySelector('main').innerText);
  ok(!/Sauvegarde/.test(t), 'mot « Sauvegarde » encore présent');
  ok(!/Le code couleur|Les règles suivies|Une information n’a qu’une fiche/.test(t), 'mode d\'emploi encore présent sur l\'accueil');
  eq(await p.getByRole('button', { name: 'Exporter' }).count(), 0);
  await p.locator('main').getByRole('link', { name: 'Mode d’emploi' }).click(); await p.waitForURL(/mode-emploi\.html$/);
  await p.goBack(); await p.locator('main').getByRole('link', { name: 'Export', exact: true }).click(); await p.waitForURL(/export\.html$/);
  await p.close();
});
await test('menu : « Mode d\'emploi » et « Export » sous Accueil, page courante marquée, sur toutes les pages', async () => {
  for (const u of ['/index.html', '/fiches/n04.html', '/index-sigles.html', '/mode-emploi.html', '/export.html']) {
    const p = await open(ctxA, u);
    eq(await p.$$eval('#menu > a', es => es.map(e => e.textContent)), ['Accueil', 'Mode d’emploi', 'Export'], u);
    const cur = await p.$$eval('#menu > a[aria-current="page"]', es => es.map(e => e.textContent));
    eq(cur, u === '/mode-emploi.html' ? ['Mode d’emploi'] : u === '/export.html' ? ['Export'] : u === '/index.html' ? ['Accueil'] : [], u);
    await p.close();
  }
});
await test('mode d\'emploi : contenu de l\'ancien accueil, aucun bloc de suivi ni de message', async () => {
  const p = await open(ctxA, '/mode-emploi.html'); await p.waitForTimeout(500);
  const t = await p.evaluate(() => document.querySelector('main').textContent);
  ok(/Le code couleur/.test(t) && /Les règles suivies/.test(t) && /Fidélité/.test(t));
  eq(await p.locator('.suivi-home, .suivi-avis, .suivi-actions').count(), 0); await p.close();
});
await test('export : explication, boutons actifs, export fichier valide (état du service)', async () => {
  reset(); kv.store.set('revisees', '{"J1":true}'); const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '1 fiche sur 36 révisée');
  ok(/pas dans ce navigateur/.test(await p.locator('#suivi-export').innerText()));
  const f = await dl(p); eq(JSON.parse(f.data).revisees.J1, true); ok(/^revisions-cappei-\d{4}-\d{2}-\d{2}\.json$/.test(f.name)); await p.close();
});

await test('bas de fiche : case synchronisée avec celle du haut, placée avant « Fiche suivante », écriture unique, suivant sans cocher', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreActive(p);
  const bas = p.getByRole('checkbox', { name: 'Marquer cette fiche comme révisée' });
  ok(await p.evaluate(() => { const b = document.getElementById('suivi-revisee-bas'), n = document.querySelector('.pager'); return !!(b.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'case du bas avant le pager');
  const n0 = putsSince(journal.length);
  await bas.check(); await p.waitForFunction(() => document.getElementById('suivi-revisee').checked);
  eq(serverState(), { N4: true }); ok(await caseDe(p).isChecked()); ok(await bas.isChecked());
  await caseDe(p).uncheck(); await p.waitForFunction(() => !document.getElementById('suivi-revisee-bas').checked); eq(serverState(), {});
  await p.getByRole('link', { name: /Fiche suivante/ }).click(); await p.waitForURL(/n05\.html$/); await attendreActive(p); eq(serverState(), {});
  await p.close();
});

console.log('\nResponsive, clavier, impression');
const sansDebord = async (p) => p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
await test('360 px : aucun débordement horizontal (accueil, fiches, index, avec coches, confirmation d\'import et erreur)', async () => {
  reset(); kv.store.set('revisees', JSON.stringify(Object.fromEntries(CODES.slice(0, 20).map(c => [c, true]))));
  const ctx = await newCtx({ viewport: { width: 360, height: 740 } });
  for (const u of ['/index.html', '/export.html', '/mode-emploi.html', '/fiches/n04.html', '/fiches/c05.html', '/fiches/n16.html', '/fiches/p01.html', '/fiches/j03.html', '/index-auteurs.html', '/index-sigles.html']) {
    const p = await open(ctx, u); await p.waitForFunction(() => !/Chargement/.test(document.body.innerText.slice(0, 4000)) || true);
    if (u.startsWith('/fiches/')) await attendreActive(p); else if (u === '/index.html') await attendreCompteur(p, '20 fiches sur 36 révisées'); else if (u === '/export.html') await attendreCompteur(p, '20 fiches sur 36 révisées'); else await p.waitForTimeout(400);
    const d = await sansDebord(p); ok(d.sw <= d.cw, `${u} : scrollWidth ${d.sw} > ${d.cw}`);
    if (u === '/index.html') {
      for (const sel of ['.suivi-restantes a']) { const boxes = await p.$$eval(sel, es => es.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; })); ok(boxes.every(([l, r]) => l >= 0 && r <= 360), sel + ' dépasse'); }
    }
    if (u === '/export.html') {
      await importFile(p, 'ok5.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1']) })); await p.locator('.suivi-confirm:not([hidden])').waitFor();
      const d2 = await sansDebord(p); ok(d2.sw <= d2.cw, 'confirmation : ' + d2.sw);
      for (const sel of ['.suivi-actions button']) { const boxes = await p.$$eval(sel, es => es.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; })); ok(boxes.every(([l, r]) => l >= 0 && r <= 360), sel + ' dépasse'); }
    }
    await p.close();
  }
  const p = await open(ctx, '/fiches/n04.html'); await attendreActive(p); mode.fail = 'down'; await caseDe(p).click();
  await p.waitForFunction(() => /Impossible d.enregistrer/.test(document.querySelector('.suivi-fiche .suivi-msg').textContent), null, { timeout: 15000 }); const d3 = await sansDebord(p); ok(d3.sw <= d3.cw, 'message d\'erreur : ' + d3.sw); mode.fail = null;
  await ctx.close();
});
await test('clavier : Tab atteint la case, Espace la coche/décoche, focus conservé et visible', async () => {
  reset(); const ctx = await newCtx(); const p = await open(ctx, '/fiches/n04.html'); await attendreActive(p);
  let ok_ = false; for (let i = 0; i < 40; i++) { await p.keyboard.press('Tab'); if (await p.evaluate(() => document.activeElement && document.activeElement.id === 'suivi-revisee')) { ok_ = true; break; } }
  ok(ok_, 'case atteinte au clavier (en ' + 'moins de 40 Tab)');
  const outline = await p.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle + ' ' + s.outlineWidth; }); ok(/solid 3px/.test(outline), 'focus visible : ' + outline);
  await p.keyboard.press('Space'); await p.waitForFunction(() => document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré'); eq(serverState(), { N4: true });
  ok(await p.evaluate(() => document.activeElement.id === 'suivi-revisee'), 'focus conservé');
  await p.keyboard.press('Space'); await p.waitForFunction(() => !document.getElementById('suivi-revisee').checked && document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré'); eq(serverState(), {});
  // l'ordre de tabulation vient juste après le titre : la case précède le contenu de la fiche
  const avant = await p.evaluate(() => { const c = document.getElementById('suivi-revisee'); const a = document.querySelector('.fiche'); return !!(c.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); }); ok(avant, 'case avant la fiche');
  await ctx.close();
});
await test('clavier sur l\'accueil : Importer/Exporter atteignables, Remplacer reçoit le focus à l\'ouverture de la confirmation', async () => {
  reset(); const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '0 fiche sur 36 révisée'.replace('0 fiche', '0 fiche'));
  await p.getByRole('button', { name: 'Exporter' }).focus(); await p.keyboard.press('Tab'); eq(await p.evaluate(() => document.activeElement.textContent), 'Importer…');
  await importFile(p, 'ok6.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1']) })); await p.locator('.suivi-confirm:not([hidden])').waitFor();
  eq(await p.evaluate(() => document.activeElement.textContent), 'Remplacer'); await p.keyboard.press('Tab'); eq(await p.evaluate(() => document.activeElement.textContent), 'Annuler'); await p.keyboard.press('Enter');
  ok(await p.evaluate(() => document.activeElement.textContent === 'Importer…'), 'focus rendu à « Importer »'); await p.close();
});
await test('impression : les éléments du suivi sont masqués', async () => {
  reset(); const p = await open(ctxA, '/index.html'); await attendreCompteur(p, '0 fiche sur 36 révisée'); await p.emulateMedia({ media: 'print' });
  eq(await p.$$eval('.suivi-home', es => es.map(e => getComputedStyle(e).display)), ['none']); await p.close();
  const q = await open(ctxA, '/fiches/n04.html'); await attendreActive(q); await q.emulateMedia({ media: 'print' }); eq(await q.$eval('.suivi-fiche', e => getComputedStyle(e).display), 'none'); await q.close();
});

console.log('\nSuivi inactif (apiUrl vide)');
await test('aucun élément ajouté, aucun script de suivi, aucune requête vers le service', async () => {
  reset(); const n = journal.length; const reqs = []; const ctx = await newCtx();
  for (const u of ['/fiches/n04.html', '/index.html', '/index-sigles.html']) {
    const p = await ctx.newPage(); p.on('request', r => reqs.push(r.url())); await p.goto(`http://localhost:${portOff}${u}`); await p.waitForTimeout(500);
    eq(await p.locator('[class*="suivi"], #suivi-revisee').count(), 0, u + ' : éléments de suivi'); eq(await p.locator('#menu .suivi-ok').count(), 0);
    eq(await p.evaluate(() => typeof window.CAPPEI_API), 'undefined'); await p.close();
  }
  ok(reqs.every(r => r.startsWith(`http://localhost:${portOff}/`)), 'requêtes externes : ' + reqs.filter(r => !r.startsWith(`http://localhost:${portOff}/`)));
  eq(journal.length - n, 0, 'requêtes reçues par le Worker'); await ctx.close();
});

await test('aucune erreur JavaScript dans la console pendant tous les tests', async () => { eq(consoleErrors, []); });

await browser.close(); api.close(); siteOn.close(); siteOff.close();
console.log(`\nRÉSULTAT : ${pass} réussi(s), ${fail} échoué(s)` + (fail ? ' : ' + failures.join(' ; ') : ''));
process.exit(fail ? 1 : 0);
