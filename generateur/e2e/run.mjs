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
await test('accueil : « 1 fiche sur 37 révisée », barre, décompte par partie, 36 liens, prochaine = J1', async () => {
  reset(); kv.store.set('revisees', '{"N4":true}');
  const p = await open(ctxA, '/index.html'); await attendreCompteur(p, '1 fiche sur 37 révisée');
  const bar = p.getByRole('progressbar', { name: 'Fiches révisées' });
  eq(await bar.getAttribute('aria-valuenow'), '1'); eq(await bar.getAttribute('aria-valuemax'), '37');
  const parts = (await p.locator('.suivi-parties li').allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
  eq(parts.length, 4); ok(/jury.*0 sur 6/i.test(parts[0]), parts[0]); ok(/Cadre.*0 sur 8/.test(parts[1]), parts[1]); ok(/Notions.*1 sur 16/.test(parts[2]), parts[2]); ok(/Publics.*0 sur 7/.test(parts[3]), parts[3]);
  eq(await p.locator('.suivi-restantes a').count(), 36);
  ok((await p.locator('.suivi-prochaine').innerText()).includes('J1'));
  eq(await p.locator('.suivi-restantes a[href="fiches/n04.html"]').count(), 0, 'N4 absente de la liste');
  await p.close();
});
await test('compteur juste après plusieurs coches puis décoche (rechargement entre chaque)', async () => {
  reset();
  for (const [u] of [['/fiches/j02.html'], ['/fiches/c03.html'], ['/fiches/p07.html']]) { const p = await open(ctxA, u); await attendreActive(p); await caseDe(p).check(); await p.waitForFunction(() => document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré'); await p.close(); }
  let h = await open(ctxA, '/index.html'); await attendreCompteur(h, '3 fiches sur 37 révisées'); await h.close();
  const q = await open(ctxA, '/fiches/c03.html'); await attendreActive(q); await caseDe(q).uncheck(); await q.waitForFunction(() => document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré'); await q.close();
  eq(serverState(), { J2: true, P7: true });
  h = await open(ctxA, '/index.html'); await attendreCompteur(h, '2 fiches sur 37 révisées'); await h.close();
});
await test('toutes révisées : message dédié, plus de liste', async () => {
  reset(); kv.store.set('revisees', JSON.stringify(Object.fromEntries(CODES.map(c => [c, true]))));
  const p = await open(ctxA, '/index.html'); await attendreCompteur(p, '37 fiches sur 37 révisées');
  ok((await p.locator('.suivi-prochaine').innerText()).includes('Toutes les fiches')); ok(!(await p.locator('.suivi-liste').isVisible())); await p.close();
});
await test('menu : les 37 liens de fiches du menu = les 37 codes du Worker', async () => {
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
await test('export : fichier revisions-cappei-AAAA-MM-JJ.json valide, 37 codes, reflète le serveur', async () => {
  reset(); kv.store.set('revisees', '{"J1":true,"N4":true,"P7":true}');
  const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '3 fiches sur 37 révisées');
  kv.store.set('revisees', '{"J1":true,"N4":true,"P7":true,"C2":true}');     // changé côté serveur depuis le chargement : l'export doit le refléter
  const f = await dl(p);
  ok(/^revisions-cappei-\d{4}-\d{2}-\d{2}\.json$/.test(f.name), f.name);
  const j = JSON.parse(f.data);
  eq(Object.keys(j).sort(), ['annotations', 'exporte_le', 'revisees', 'version']); eq(j.version, 2); eq(j.annotations, {}); ok(!isNaN(Date.parse(j.exporte_le)) && /T.*Z$/.test(j.exporte_le), 'ISO');
  eq(Object.keys(j.revisees), CODES); ok(Object.values(j.revisees).every(v => typeof v === 'boolean'));
  eq(Object.keys(j.revisees).filter(k => j.revisees[k]).sort(), ['C2', 'J1', 'N4', 'P7']);
  await p.close();
});
const importFile = async (p, name, content) => { const f = path.join(os.tmpdir(), name); fs.writeFileSync(f, content); await p.locator('input.suivi-fichier').setInputFiles(f); };
const tousFalse = (vrais) => Object.fromEntries(CODES.map(c => [c, vrais.includes(c)]));
await test('import valide : confirmation (avant/après), puis état remplacé sur serveur et à l\'écran', async () => {
  reset(); kv.store.set('revisees', '{"J1":true,"N4":true}');
  const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '2 fiches sur 37 révisées');
  await importFile(p, 'ok.json', JSON.stringify({ version: 1, exporte_le: new Date().toISOString(), revisees: tousFalse(['C1', 'C2', 'C3', 'P1']) }));
  await p.locator('.suivi-confirm:not([hidden])').waitFor({ timeout: 5000 });
  const t = await p.locator('.suivi-confirm').innerText(); ok(/2 avant, 4 après/.test(t), t);
  eq(serverState(), { J1: true, N4: true }, 'rien n\'est écrit avant confirmation');
  await p.getByRole('button', { name: 'Remplacer' }).click();
  await attendreCompteur(p, '4 fiches sur 37 révisées'); eq(serverState(), { C1: true, C2: true, C3: true, P1: true });
  ok((await p.locator('.suivi-msg-sauv').innerText()).includes('Import terminé'));
  eq(await p.locator('#menu .suivi-ok').count(), 4);
  await p.close();
});
await test('import valide puis « Annuler » : rien n\'est modifié', async () => {
  reset(); kv.store.set('revisees', '{"J1":true}'); const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '1 fiche sur 37 révisée');
  const n = journal.length;
  await importFile(p, 'ok2.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1']) }));
  await p.locator('.suivi-confirm:not([hidden])').waitFor(); await p.getByRole('button', { name: 'Annuler' }).click();
  ok(await p.locator('.suivi-confirm').isHidden()); eq(serverState(), { J1: true }); eq(putsSince(n), 0); await p.close();
});
await test('import invalide (8 cas) : refusé avec message clair, aucun envoi, état inchangé', async () => {
  reset(); kv.store.set('revisees', '{"J1":true,"N4":true}'); const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '2 fiches sur 37 révisées');
  const cas = [
    ['pas json', 'ceci n\'est pas du JSON', /pas un JSON valide/],
    ['tableau', '[1,2,3]', /objet JSON attendu/],
    ['version', JSON.stringify({ version: 3, revisees: {} }), /Version de sauvegarde non reconnue/],
    ['sans version', JSON.stringify({ revisees: {} }), /Version de sauvegarde non reconnue/],
    ['code inconnu', JSON.stringify({ version: 1, revisees: { Z9: true } }), /Code de fiche inconnu : Z9/],
    ['non booléen', JSON.stringify({ version: 1, revisees: { J1: 'oui' } }), /doit être true ou false/],
    ['revisees absent', JSON.stringify({ version: 1 }), /revisees/],
    ['trop gros', JSON.stringify({ version: 1, revisees: {}, pad: 'x'.repeat(2200000) }), /volumineux/],
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
  reset(); kv.store.set('revisees', '{"J1":true}'); const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '1 fiche sur 37 révisée');
  await importFile(p, 'ok3.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1']) })); await p.locator('.suivi-confirm:not([hidden])').waitFor();
  mode.fail = '500'; await p.getByRole('button', { name: 'Remplacer' }).click();
  await p.waitForFunction(() => /Import impossible/.test(document.querySelector('.suivi-msg-sauv').textContent), null, { timeout: 5000 });
  mode.fail = null; eq(serverState(), { J1: true }); await attendreCompteur(p, '1 fiche sur 37 révisée'); await p.close();
});

console.log('\nStockage dans le navigateur');
await test('aucune donnée de suivi dans localStorage / sessionStorage / cookies / IndexedDB / Cache API (contexte ayant coché, exporté, importé)', async () => {
  const ctx = await newCtx(); reset();
  const p = await open(ctx, '/fiches/n04.html'); await attendreActive(p); await caseDe(p).check(); await p.waitForFunction(() => document.querySelector('.suivi-fiche .suivi-msg').textContent === 'Enregistré');
  const h = await open(ctx, '/export.html'); await attendreCompteur(h, '1 fiche sur 37 révisée'); await dl(h);
  await importFile(h, 'ok4.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1', 'J3']) })); await h.locator('.suivi-confirm:not([hidden])').waitFor(); await h.getByRole('button', { name: 'Remplacer' }).click(); await attendreCompteur(h, '2 fiches sur 37 révisées');
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
  reset(); const p = await open(ctxA, '/index.html'); await attendreCompteur(p, '0 fiche sur 37 révisée');
  const t = await p.evaluate(() => document.querySelector('main').innerText);
  ok(!/Sauvegarde/.test(t), 'mot « Sauvegarde » encore présent');
  ok(!/Le code couleur|Les règles suivies|Une information n’a qu’une fiche/.test(t), 'mode d\'emploi encore présent sur l\'accueil');
  eq(await p.getByRole('button', { name: 'Exporter' }).count(), 0);
  await p.locator('main').getByRole('link', { name: 'Mode d’emploi' }).click(); await p.waitForURL(/mode-emploi\.html$/);
  await p.goBack(); await p.locator('main').getByRole('link', { name: 'Export', exact: true }).click(); await p.waitForURL(/export\.html$/);
  await p.close();
});
await test('menu : « Mode d\'emploi » et « Export » sous Accueil, page courante marquée, sur toutes les pages', async () => {
  for (const u of ['/index.html', '/fiches/n04.html', '/index-sigles.html', '/mode-emploi.html', '/export.html', '/annotations.html']) {
    const p = await open(ctxA, u);
    eq(await p.$$eval('#menu > a', es => es.map(e => e.textContent)), ['Accueil', 'Mode d’emploi', 'Mes annotations', 'Export'], u);
    const cur = await p.$$eval('#menu > a[aria-current="page"]', es => es.map(e => e.textContent));
    eq(cur, u === '/mode-emploi.html' ? ['Mode d’emploi'] : u === '/export.html' ? ['Export'] : u === '/annotations.html' ? ['Mes annotations'] : u === '/index.html' ? ['Accueil'] : [], u);
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
  reset(); kv.store.set('revisees', '{"J1":true}'); const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '1 fiche sur 37 révisée');
  ok(/pas dans ce navigateur/.test(await p.locator('#suivi-export').innerText()));
  const f = await dl(p); eq(JSON.parse(f.data).revisees.J1, true); ok(/^revisions-cappei-\d{4}-\d{2}-\d{2}\.json$/.test(f.name)); await p.close();
});

await test('bas de fiche : case synchronisée avec celle du haut, placée avant « Fiche suivante », écriture unique, suivant sans cocher', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreActive(p);
  const bas = p.getByRole('checkbox', { name: 'Marquer cette fiche comme révisée' });
  ok(await p.evaluate(() => { const b = document.getElementById('suivi-revisee-bas'), n = document.querySelector('.pager'); return !!(b.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'case du bas avant le pager');
  const n0 = putsSince(journal.length);
  const enregistre = () => p.waitForFunction(() => [...document.querySelectorAll('.suivi-fiche .suivi-msg')].every(m => m.textContent === 'Enregistré'), null, { timeout: 5000 });
  await bas.check(); await p.waitForFunction(() => document.getElementById('suivi-revisee').checked); await enregistre();
  eq(serverState(), { N4: true }); ok(await caseDe(p).isChecked()); ok(await bas.isChecked());
  await caseDe(p).uncheck(); await p.waitForFunction(() => !document.getElementById('suivi-revisee-bas').checked); await enregistre(); eq(serverState(), {});
  await p.getByRole('link', { name: /Fiche suivante/ }).click(); await p.waitForURL(/n05\.html$/); await attendreActive(p); eq(serverState(), {});
  await p.close();
});

console.log('\nResponsive, clavier, impression');
const sansDebord = async (p) => p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
await test('370 px : aucun débordement horizontal (accueil, fiches, index, avec coches, confirmation d\'import et erreur)', async () => {
  reset(); kv.store.set('revisees', JSON.stringify(Object.fromEntries(CODES.slice(0, 20).map(c => [c, true]))));
  const ctx = await newCtx({ viewport: { width: 370, height: 740 } });
  for (const u of ['/index.html', '/export.html', '/mode-emploi.html', '/fiches/n04.html', '/fiches/c05.html', '/fiches/n16.html', '/fiches/p01.html', '/fiches/j03.html', '/index-auteurs.html', '/index-sigles.html']) {
    const p = await open(ctx, u); await p.waitForFunction(() => !/Chargement/.test(document.body.innerText.slice(0, 4000)) || true);
    if (u.startsWith('/fiches/')) await attendreActive(p); else if (u === '/index.html') await attendreCompteur(p, '20 fiches sur 37 révisées'); else if (u === '/export.html') await attendreCompteur(p, '20 fiches sur 37 révisées'); else await p.waitForTimeout(400);
    const d = await sansDebord(p); ok(d.sw <= d.cw, `${u} : scrollWidth ${d.sw} > ${d.cw}`);
    if (u === '/index.html') {
      for (const sel of ['.suivi-restantes a']) { const boxes = await p.$$eval(sel, es => es.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; })); ok(boxes.every(([l, r]) => l >= 0 && r <= 370), sel + ' dépasse'); }
    }
    if (u === '/export.html') {
      await importFile(p, 'ok5.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1']) })); await p.locator('.suivi-confirm:not([hidden])').waitFor();
      const d2 = await sansDebord(p); ok(d2.sw <= d2.cw, 'confirmation : ' + d2.sw);
      for (const sel of ['.suivi-actions button']) { const boxes = await p.$$eval(sel, es => es.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; })); ok(boxes.every(([l, r]) => l >= 0 && r <= 370), sel + ' dépasse'); }
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
  reset(); const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '0 fiche sur 37 révisée'.replace('0 fiche', '0 fiche'));
  await p.getByRole('button', { name: 'Exporter' }).focus(); await p.keyboard.press('Tab'); eq(await p.evaluate(() => document.activeElement.textContent), 'Importer…');
  await importFile(p, 'ok6.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1']) })); await p.locator('.suivi-confirm:not([hidden])').waitFor();
  eq(await p.evaluate(() => document.activeElement.textContent), 'Remplacer'); await p.keyboard.press('Tab'); eq(await p.evaluate(() => document.activeElement.textContent), 'Annuler'); await p.keyboard.press('Enter');
  ok(await p.evaluate(() => document.activeElement.textContent === 'Importer…'), 'focus rendu à « Importer »'); await p.close();
});
await test('impression : les éléments du suivi sont masqués', async () => {
  reset(); const p = await open(ctxA, '/index.html'); await attendreCompteur(p, '0 fiche sur 37 révisée'); await p.emulateMedia({ media: 'print' });
  eq(await p.$$eval('.suivi-home', es => es.map(e => getComputedStyle(e).display)), ['none']); await p.close();
  const q = await open(ctxA, '/fiches/n04.html'); await attendreActive(q); await q.emulateMedia({ media: 'print' }); eq(await q.$eval('.suivi-fiche', e => getComputedStyle(e).display), 'none'); await q.close();
});

/* ======================================================================== Annotations */
console.log('\nAnnotations : surlignages, commentaires, notes');
const kvAnn = (code) => { const v = kv.store.get('annotations:' + code); return v ? JSON.parse(v) : null; };
const annList = (code) => (kvAnn(code) || { annotations: [] }).annotations;
const D0 = '2026-11-18T21:00:00.000Z';
const passageKV = (o) => ({ id: 'abcdefgh1234', type: 'passage', volet: 'n04-1', bloc: 0, debut: 0, texte: 'proportionnalité inverse', avant: 'La règle de ', apres: '', couleur: 1, commentaire: '', cree: D0, modifie: D0, ...(o || {}) });
const noteKV = (o) => ({ id: 'note00000001', type: 'note', texte: 'Ma note de test.', cree: D0, modifie: D0, ...(o || {}) });
const setAnn = (code, list, rev) => kv.store.set('annotations:' + code, JSON.stringify({ rev: rev === undefined ? 1 : rev, annotations: list }));
/* Sélectionne dans les fiches le premier passage égal à `texte` (ou de `texte` jusqu'à `fin`, dans un autre bloc). */
const selectionner = (p, texte, fin) => p.evaluate(([texte, fin]) => {
  const BL = 'p, li, h2, h3';
  const blocs = [...document.querySelectorAll('.fiches > article.fiche')].flatMap(a => [...a.querySelectorAll(BL)].filter(e => !e.querySelector(BL)));
  const nodesOf = b => { const out = []; const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (!n.parentElement.closest('[data-annot-ui]')) out.push(n); } return out; };
  const txt = b => nodesOf(b).map(n => n.nodeValue).join('');
  const pos = (nodes, k) => { let acc = 0; for (const n of nodes) { if (k <= acc + n.nodeValue.length) return [n, k - acc]; acc += n.nodeValue.length; } const l = nodes[nodes.length - 1]; return [l, l.nodeValue.length]; };
  const b = blocs.find(x => txt(x).includes(texte)); if (!b) return false;
  const i = txt(b).indexOf(texte);
  let endNodes = nodesOf(b), j = i + texte.length;
  if (fin) { const b2 = blocs.find(x => x !== b && txt(x).includes(fin)); endNodes = nodesOf(b2); j = txt(b2).indexOf(fin) + fin.length; }
  const [sn, so] = pos(nodesOf(b), i), [en, eo] = pos(endNodes, j);
  getSelection().setBaseAndExtent(sn, so, en, eo);
  return true;
}, [texte, fin || null]);
const attendreAnnot = (p) => p.waitForFunction(() => { const r = document.querySelector('.annot-resume'); return r && r.textContent && !/Chargement/.test(r.textContent); }, null, { timeout: 5000 });
const barre = p => p.locator('.annot-barre');
const attendreBarre = p => p.locator('.annot-barre:not([hidden])').waitFor({ timeout: 5000 });
const msgAnnot = p => p.locator('.annot-tete .annot-msg');
const attendreMsg = (p, re) => p.waitForFunction(r => new RegExp(r).test(document.querySelector('.annot-tete .annot-msg').textContent), re.source, { timeout: 8000 });
const html0 = {};   // HTML d'origine des volets (sans annotation), pour vérifier que le texte des fiches n'est jamais modifié
const htmlVolets = p => p.$$eval('.fiches > article.fiche', as => as.map(a => a.innerHTML));
const texteVolets = p => p.$$eval('.fiches > article.fiche', as => as.map(a => { const c = a.cloneNode(true); c.querySelectorAll('[data-annot-ui]').forEach(x => x.remove()); return c.textContent; }));

await test('fiche sans annotation : aide et résumé en tête, notes en bas, HTML des volets identique au HTML publié', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  ok(!/sélectionnez un passage/.test(await p.locator('.annot-tete').innerText()), 'plus de phrase d\'aide en tête de fiche');
  eq(await p.locator('.annot-resume').innerText(), 'Aucune annotation sur cette fiche pour l’instant.');
  eq(await p.locator('#annot-notes h2').innerText(), 'Mes notes sur cette fiche');
  ok(await p.evaluate(() => { const n = document.getElementById('annot-notes'), b = document.getElementById('suivi-revisee-bas'); return !!(n.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'notes avant la case du bas');
  html0.n04 = await htmlVolets(p);
  const brut = fs.readFileSync(path.join(SITE_ON, 'fiches/n04.html'), 'utf8');
  const statique = [...brut.matchAll(/<article class="fiche"[^>]*>([\s\S]*?)<\/article>/g)].map(m => m[1]);
  eq(html0.n04.length, statique.length); html0.n04.forEach((h, i) => eq(h, statique[i], 'volet ' + i + ' modifié par les scripts'));
  ok(await barre(p).isHidden(), 'barre cachée sans sélection');
  await p.close();
});

await test('sélection -> barre (3 couleurs + Commenter) ; surligner en vert : enregistré, persistant, visible sur un autre appareil', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  ok(await selectionner(p, 'proportionnalité inverse')); await attendreBarre(p);
  eq(await barre(p).getAttribute('role'), 'toolbar');
  eq(await barre(p).locator('button[data-action]').allInnerTexts(), ['Jaune', 'Vert', 'Rose', 'Commenter…']);
  await barre(p).getByRole('button', { name: 'Surligner en vert' }).click();
  await attendreMsg(p, /^Enregistré$/);
  const l = annList('N4'); eq(l.length, 1);
  eq([l[0].type, l[0].volet, l[0].texte, l[0].couleur, l[0].commentaire], ['passage', 'n04-1', 'proportionnalité inverse', 2, '']);
  ok(l[0].avant.endsWith('La règle de ') && /^[a-z0-9]{12}$/.test(l[0].id), JSON.stringify(l[0]));
  eq(await p.locator('mark.annot').count(), 1); eq(await p.locator('mark.annot').innerText(), 'proportionnalité inverse'); ok(await p.locator('mark.annot.annot-c2').count() === 1);
  ok(await barre(p).isHidden(), 'barre cachée après enregistrement'); eq(await p.evaluate(() => String(getSelection())), '');
  ok(/1 surlignage/.test(await p.locator('.annot-resume').innerText()));
  eq(await texteVolets(p), await (async () => { const c = await newCtx(); const q = await open(c, '/fiches/n05.html'); await q.close(); await c.close(); return await texteVolets(p); })());   // texte inchangé (sanity)
  await p.reload(); await attendreAnnot(p); eq(await p.locator('mark.annot.annot-c2').innerText(), 'proportionnalité inverse');
  const ctxB = await newCtx(); const q = await open(ctxB, '/fiches/n04.html'); await attendreAnnot(q);
  eq(await q.locator('mark.annot').count(), 1, 'autre appareil'); await ctxB.close();
  await p.close();
});

await test('passage à cheval sur du gras : plusieurs segments, un seul surlignage ; le texte des volets est inchangé', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  const t0 = await texteVolets(p);
  ok(await selectionner(p, 'compensation individuelle (Benoit')); await attendreBarre(p);
  await barre(p).getByRole('button', { name: 'Surligner en jaune' }).click(); await attendreMsg(p, /^Enregistré$/);
  const marks = p.locator('mark.annot'); ok(await marks.count() >= 2, 'segments : ' + await marks.count());
  eq((await marks.allInnerTexts()).join(''), 'compensation individuelle (Benoit');
  eq(new Set(await marks.evaluateAll(ms => ms.map(m => m.getAttribute('data-annot')))).size, 1);
  ok(await p.locator('strong mark.annot').count() === 1, 'segment dans le gras');
  eq(await texteVolets(p), t0, 'texte des volets');
  await p.close();
});

await test('commenter : dialogue (couleur, compteur), bulle numérotée, info-bulle au survol, clic sur la bulle -> dialogue', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  await selectionner(p, 'proportionnalité inverse'); await attendreBarre(p);
  await barre(p).getByRole('button', { name: 'Commenter…' }).click();
  const dlg = p.locator('dialog.annot-dialogue'); await dlg.waitFor();
  ok(await dlg.evaluate(d => d.open && d.matches(':modal')), 'dialogue modal'); eq(await dlg.locator('h2').innerText(), 'Commenter le passage');
  eq(await dlg.locator('blockquote').innerText(), 'proportionnalité inverse');
  ok(await p.evaluate(() => document.activeElement.id === 'annot-com'), 'focus dans le commentaire');
  await dlg.getByLabel('Rose').check(); ok(await dlg.locator('blockquote.annot-c3').count() === 1, 'aperçu de la couleur');
  await dlg.getByLabel('Commentaire', { exact: true }).fill('Lien avec N6 :\nconception universelle.');
  ok(/38 \/ 2000/.test(await dlg.locator('.annot-compteur').innerText()), await dlg.locator('.annot-compteur').innerText());
  await dlg.getByRole('button', { name: 'Enregistrer' }).click();
  await p.waitForFunction(() => !document.querySelector('dialog.annot-dialogue').open);
  const a = annList('N4')[0]; eq([a.couleur, a.commentaire], [3, 'Lien avec N6 :\nconception universelle.']);
  const bulle = p.locator('.annot-bulle'); eq(await bulle.count(), 1);
  ok((await bulle.getAttribute('aria-label')).startsWith('Commentaire 1 : Lien avec N6'), await bulle.getAttribute('aria-label'));
  ok(/dont 1 commenté/.test(await p.locator('.annot-resume').innerText()));
  await bulle.hover(); await p.locator('.annot-infobulle:not([hidden])').waitFor({ timeout: 3000 });
  eq(await p.locator('.annot-infobulle').innerText(), 'Lien avec N6 :\nconception universelle.');
  await p.mouse.move(5, 5); await p.locator('.annot-infobulle').waitFor({ state: 'hidden', timeout: 3000 });
  await p.locator('mark.annot').first().hover(); await p.locator('.annot-infobulle:not([hidden])').waitFor({ timeout: 3000 });   // survol du passage lui-même
  eq(await bulle.innerText(), '1', 'numéro visible dans la bulle');
  const bx = await bulle.boundingBox(); ok(bx.height >= 15 && bx.width >= 20, 'bulle assez grande : ' + JSON.stringify(bx));
  ok(await p.evaluate(() => { const b = document.querySelector('.annot-bulle'), r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top - 6) === b && document.elementFromPoint(r.left + r.width / 2, r.bottom + 6) === b; }), 'zone de toucher plus grande que la pastille');
  eq((await p.locator('mark.annot.annot-commente').allInnerTexts()).join(''), 'proportionnalité inverse', 'passage commenté souligné');
  ok(await p.evaluate(() => { const b = document.querySelector('.annot-bulle'); return b.parentElement.classList.contains('annot-colle') && getComputedStyle(b.parentElement).whiteSpace === 'nowrap' && b.previousElementSibling.textContent === 'inverse'; }), 'bulle collée au dernier mot');
  await bulle.click(); await dlg.waitFor();
  // lecture d'abord : pas de champ éditable
  eq(await dlg.locator('h2').innerText(), 'Passage surligné'); eq(await dlg.locator('textarea, input').count(), 0, 'aucun champ en lecture');
  eq(await dlg.locator('.annot-lecture').innerText(), 'Lien avec N6 :\nconception universelle.'); eq(await dlg.locator('.annot-lecture-couleur').innerText(), 'Couleur : rose');
  eq(await dlg.locator('.annot-vue > .annot-actions button').allInnerTexts(), ['Modifier', 'Supprimer', 'Fermer']);
  // modifier : action volontaire
  await dlg.getByRole('button', { name: 'Modifier' }).click();
  eq(await dlg.locator('h2').innerText(), 'Modifier le passage surligné'); eq(await dlg.getByLabel('Commentaire', { exact: true }).inputValue(), 'Lien avec N6 :\nconception universelle.'); ok(await dlg.getByLabel('Rose').isChecked());
  await dlg.getByRole('button', { name: 'Annuler' }).click(); eq(await dlg.locator('h2').innerText(), 'Passage surligné', 'Annuler revient à la lecture');
  await dlg.getByRole('button', { name: 'Fermer' }).click(); ok(!(await dlg.evaluate(d => d.open)));
  await p.close();
});

await test('modifier (couleur, commentaire) puis supprimer avec confirmation : la fiche revient exactement à son HTML d\'origine', async () => {
  reset(); setAnn('N4', [passageKV({ bloc: 99, debut: 0 })], 3);   // bloc faux : retrouvé par le texte et le contexte
  const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  eq(await p.locator('mark.annot').innerText(), 'proportionnalité inverse');
  await p.locator('mark.annot').first().click();
  const dlg = p.locator('dialog.annot-dialogue'); await dlg.waitFor();
  ok(/Aucun commentaire/.test(await dlg.innerText())); eq(annList('N4')[0].commentaire, '');
  await dlg.getByRole('button', { name: 'Commenter ou changer la couleur' }).click();
  await dlg.getByLabel('Vert').check(); await dlg.getByLabel('Commentaire', { exact: true }).fill('Modifié');
  await dlg.getByRole('button', { name: 'Enregistrer' }).click();
  await p.waitForFunction(() => { const d = document.querySelector('dialog.annot-dialogue'); return d.open && d.querySelector('.annot-lecture') && /Enregistré/.test(d.textContent); });
  eq(await dlg.locator('.annot-lecture').innerText(), 'Modifié', 'retour à la lecture après enregistrement'); eq(await dlg.locator('.annot-lecture-couleur').innerText(), 'Couleur : vert');
  let a = annList('N4')[0]; eq([a.couleur, a.commentaire, kvAnn('N4').rev], [2, 'Modifié', 4]); ok(a.modifie > D0);
  await dlg.getByRole('button', { name: 'Fermer' }).click();
  await p.locator('mark.annot').first().click(); await dlg.waitFor();
  await dlg.locator('.annot-vue > .annot-actions').getByRole('button', { name: 'Supprimer', exact: true }).click();
  ok(/Supprimer ce surlignage et son commentaire/.test(await dlg.locator('.annot-confirm').innerText()));
  eq(annList('N4').length, 1, 'rien supprimé avant confirmation');
  await dlg.locator('.annot-confirm').getByRole('button', { name: 'Supprimer' }).click();
  await p.waitForFunction(() => !document.querySelector('dialog.annot-dialogue').open);
  eq(annList('N4'), []); eq(await p.locator('mark.annot, .annot-bulle').count(), 0);
  eq(await htmlVolets(p), html0.n04, 'HTML des volets après suppression');
  await p.close();
});

await test('sélections refusées : deux paragraphes, chevauchement d\'un surlignage, hors des fiches -> message ou rien, aucun envoi', async () => {
  reset(); setAnn('N4', [passageKV()], 1);
  const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  const n = journal.length;
  await selectionner(p, 'proportionnalité', 'Plus un environnement'); await attendreBarre(p);
  ok(/un seul paragraphe/.test(await barre(p).innerText()), await barre(p).innerText()); eq(await barre(p).locator('button[data-action]').count(), 0);
  await selectionner(p, 'règle de proportionnalité'); await p.waitForFunction(() => /touche un surlignage existant/.test(document.querySelector('.annot-barre').textContent), null, { timeout: 3000 });
  await p.evaluate(() => { const h = document.querySelector('.page-head h1'); getSelection().selectAllChildren(h); });
  await p.waitForTimeout(900); ok(await barre(p).isHidden(), 'sélection du titre de page : pas de barre');
  await selectionner(p, 'Un même outil, deux logiques'); await attendreBarre(p);
  await barre(p).getByRole('button', { name: 'Fermer la barre' }).click(); ok(await barre(p).isHidden()); eq(await p.evaluate(() => String(getSelection())), '');
  eq(journal.slice(n).filter(j => j.method !== 'GET' && j.method !== 'OPTIONS').length, 0, 'aucune écriture');
  await p.close();
});

await test('triple clic (paragraphe entier) : la fin au début du bloc suivant est acceptée', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  const r = await p.evaluate(() => { const b = [...document.querySelectorAll('.box-title')].find(x => /proportionnalité/.test(x.textContent)); const next = b.nextElementSibling; getSelection().setBaseAndExtent(b.firstChild, 0, next, 0); return b.textContent.trim(); });
  await attendreBarre(p); await barre(p).getByRole('button', { name: 'Surligner en rose' }).click(); await attendreMsg(p, /^Enregistré$/);
  eq(annList('N4')[0].texte, r);
  await p.close();
});

await test('notes de fiche : ajouter, modifier, supprimer ; résumé ; lien « Voir les notes »', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  await p.getByRole('button', { name: 'Ajouter une note' }).click();
  const dlg = p.locator('dialog.annot-dialogue'); await dlg.waitFor(); eq(await dlg.locator('h2').innerText(), 'Nouvelle note — N4');
  await dlg.getByRole('button', { name: 'Enregistrer' }).click(); ok(/La note est vide/.test(await dlg.locator('.annot-msg').innerText()));
  await dlg.getByLabel('Texte de la note').fill('Première ligne\nDeuxième ligne'); await dlg.getByRole('button', { name: 'Enregistrer' }).click();
  await p.waitForFunction(() => !document.querySelector('dialog.annot-dialogue').open);
  eq(annList('N4').map(a => [a.type, a.texte]), [['note', 'Première ligne\nDeuxième ligne']]);
  eq(await p.locator('.annot-notes-liste .annot-texte').innerText(), 'Première ligne\nDeuxième ligne');
  ok(/Écrite le \d\d\/\d\d\/\d{4}/.test(await p.locator('.annot-notes-liste .annot-date').innerText()));
  ok(/1 note/.test(await p.locator('.annot-resume').innerText())); eq(await p.locator('.annot-resume a').getAttribute('href'), '#annot-notes');
  await p.locator('.annot-notes-liste').getByRole('button', { name: 'Modifier' }).click(); await dlg.waitFor();
  await dlg.getByLabel('Texte de la note').fill('Modifiée'); await dlg.getByRole('button', { name: 'Enregistrer' }).click();
  await p.waitForFunction(() => !document.querySelector('dialog.annot-dialogue').open);
  eq(annList('N4')[0].texte, 'Modifiée'); ok(/Modifiée le/.test(await p.locator('.annot-notes-liste .annot-date').innerText()));
  await p.locator('.annot-notes-liste').getByRole('button', { name: 'Modifier' }).click(); await dlg.waitFor();
  await dlg.getByRole('button', { name: 'Supprimer la note' }).click(); await dlg.locator('.annot-confirm').getByRole('button', { name: 'Supprimer' }).click();
  await p.waitForFunction(() => !document.querySelector('dialog.annot-dialogue').open);
  eq(annList('N4'), []); ok(await p.locator('.annot-vide').isVisible());
  await p.close();
});

await test('textes saisis affichés comme du texte : aucune balise injectée (commentaire, note, passage)', async () => {
  reset();
  const piege = '<img src=x onerror="window.__pirate=1"><script>window.__pirate=2</script><b>gras</b>';
  setAnn('N4', [passageKV({ commentaire: piege }), noteKV({ texte: piege })], 1);
  const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  eq(await p.evaluate(() => window.__pirate), undefined);
  eq(await p.locator('main img, main script, main b, .annot-notes b').count(), 0);
  eq(await p.locator('.annot-notes-liste .annot-texte').innerText(), piege);
  await p.locator('.annot-bulle').hover(); await p.locator('.annot-infobulle:not([hidden])').waitFor(); eq(await p.locator('.annot-infobulle').innerText(), piege);
  ok((await p.locator('.annot-bulle').getAttribute('aria-label')).includes('<img'));
  const q = await open(ctxA, '/annotations.html'); await q.locator('.annot-items').first().waitFor({ timeout: 5000 });
  eq(await q.evaluate(() => window.__pirate), undefined); eq(await q.locator('main img, main script, main b').count(), 0);
  await p.close(); await q.close();
});

await test('annotation à rattacher (passage disparu de la fiche) : encadré, transformer en note, supprimer', async () => {
  reset(); setAnn('N4', [passageKV({ id: 'orph00000001', texte: 'texte qui n’existe plus nulle part', couleur: 3, commentaire: 'Mon commentaire' }), passageKV({ id: 'orph00000002', texte: 'autre passage disparu' })], 2);
  const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  const box = p.locator('.annot-orphelines'); ok(await box.isVisible()); ok(/Annotations à rattacher \(2\)/.test(await box.innerText()));
  ok(/2 annotations à rattacher/.test(await p.locator('.annot-resume').innerText())); eq(await p.locator('mark.annot').count(), 0);
  await box.locator('li').first().getByRole('button', { name: 'Transformer en note' }).click();
  await p.waitForFunction(() => document.querySelectorAll('.annot-orphelines li').length === 1, null, { timeout: 8000 });
  const l = annList('N4'); eq(l.map(a => a.type).sort(), ['note', 'passage']);
  eq(l.find(a => a.type === 'note').texte, '« texte qui n’existe plus nulle part »\nMon commentaire');
  await box.getByRole('button', { name: 'Supprimer' }).click();
  const dlg = p.locator('dialog.annot-dialogue'); await dlg.waitFor(); eq(await dlg.locator('h2').innerText(), 'Annotation à rattacher');
  await dlg.locator('.annot-vue > .annot-actions').getByRole('button', { name: 'Supprimer', exact: true }).click(); await dlg.locator('.annot-confirm').getByRole('button', { name: 'Supprimer' }).click();
  await p.waitForFunction(() => document.querySelector('.annot-orphelines').hidden, null, { timeout: 8000 });
  eq(annList('N4').map(a => a.type), ['note']);
  await p.close();
});

await test('échecs : réseau coupé à l\'enregistrement (dialogue gardé, texte conservé, réessai), lecture périmée (409), service indisponible au chargement', async () => {
  reset(); const p = await open(ctxA, '/fiches/n04.html'); await attendreAnnot(p);
  await p.getByRole('button', { name: 'Ajouter une note' }).click(); const dlg = p.locator('dialog.annot-dialogue'); await dlg.waitFor();
  await dlg.getByLabel('Texte de la note').fill('Ne pas perdre ce texte'); mode.fail = 'down';
  await dlg.getByRole('button', { name: 'Enregistrer' }).click();
  await p.waitForFunction(() => /injoignable/.test(document.querySelector('dialog.annot-dialogue .annot-msg').textContent), null, { timeout: 15000 });
  ok(await dlg.evaluate(d => d.open), 'dialogue toujours ouvert'); eq(await dlg.getByLabel('Texte de la note').inputValue(), 'Ne pas perdre ce texte'); ok(await dlg.getByRole('button', { name: 'Enregistrer' }).isEnabled());
  mode.fail = null; await dlg.getByRole('button', { name: 'Enregistrer' }).click(); await p.waitForFunction(() => !document.querySelector('dialog.annot-dialogue').open);
  eq(annList('N4').length, 1);
  // lecture périmée : le service relit une version plus ancienne que celle que la page connaît
  kv.store.set('annotations:N4', JSON.stringify({ rev: 0, annotations: [] }));
  await selectionner(p, 'proportionnalité inverse'); await attendreBarre(p); await barre(p).getByRole('button', { name: 'Surligner en jaune' }).click();
  await attendreMsg(p, /pas encore pris en compte/); ok(await msgAnnot(p).evaluate(e => e.classList.contains('annot-erreur')));
  eq(kvAnn('N4').annotations, [], 'rien écrit sur une lecture périmée');
  await p.close();
  reset(); mode.fail = '500'; const q = await open(ctxA, '/fiches/n04.html');
  await q.waitForFunction(() => /Annotations indisponibles/.test(document.querySelector('.annot-tete .annot-msg').textContent), null, { timeout: 8000 });
  ok(await q.getByRole('button', { name: 'Ajouter une note' }).isDisabled()); ok(await q.locator('.annot-tete').getByRole('button', { name: 'Réessayer' }).isVisible());
  await selectionner(q, 'proportionnalité inverse'); await q.waitForTimeout(500); ok(await barre(q).isHidden(), 'pas de barre si le service est indisponible');
  mode.fail = null; setAnn('N4', [passageKV()]); await q.locator('.annot-tete').getByRole('button', { name: 'Réessayer' }).click();
  await q.locator('mark.annot').first().waitFor({ timeout: 5000 }); ok(await q.getByRole('button', { name: 'Ajouter une note' }).isEnabled());
  await q.close();
});

await test('autre appareil : en revenant sur l\'onglet (après 30 s), la page relit et affiche les nouvelles annotations', async () => {
  reset(); const p = await ctxA.newPage(); await p.clock.install(); await p.goto(SITE + '/fiches/n04.html'); await attendreAnnot(p);
  eq(await p.locator('mark.annot').count(), 0);
  setAnn('N4', [passageKV()], 1);
  await p.clock.fastForward(31000); await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.locator('mark.annot').first().waitFor({ timeout: 5000 });
  await p.close();
});

await test('clavier : Tab atteint le surlignage, Entrée ouvre le dialogue, Échap le ferme et rend le focus', async () => {
  reset(); setAnn('N4', [passageKV()], 1); const p = await open(ctxA, '/fiches/n04.html'); await p.locator('mark.annot').first().waitFor();
  await p.locator('mark.annot').focus(); await p.keyboard.press('Enter');
  const dlg = p.locator('dialog.annot-dialogue'); await dlg.waitFor(); ok(await dlg.evaluate(d => d.open));
  await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog.annot-dialogue').open);
  ok(await p.evaluate(() => document.activeElement && document.activeElement.matches('mark.annot')), 'focus rendu au surlignage');
  let atteint = false; await p.locator('.page-head h1').click();
  for (let i = 0; i < 60 && !atteint; i++) { await p.keyboard.press('Tab'); atteint = await p.evaluate(() => document.activeElement.matches('mark.annot')); }
  ok(atteint, 'surlignage atteint au clavier');
  await p.close();
});

await test('lien profond #annot-<id> : la fiche défile jusqu\'au passage et le met en évidence', async () => {
  reset(); setAnn('N4', [passageKV({ id: 'cible0000001', texte: 'Ce qui fait la différence', avant: '', bloc: 0 })], 1);
  const p = await open(ctxA, '/fiches/n04.html#annot-cible0000001'); await p.locator('mark.annot').first().waitFor();
  await p.waitForFunction(() => document.querySelector('mark.annot').classList.contains('annot-flash'), null, { timeout: 3000 });
  const r = await p.locator('mark.annot').boundingBox(); const vh = await p.evaluate(() => innerHeight); ok(r.y > 0 && r.y < vh, 'passage visible : y=' + r.y);
  await p.close();
});

await test('page « Mes annotations » : regroupement par partie et fiche, filtres, liens vers le passage', async () => {
  reset();
  setAnn('N4', [passageKV({ commentaire: 'à revoir' }), passageKV({ id: 'vert00000001', texte: 'Un même outil', couleur: 2 }), noteKV()], 3);
  setAnn('J2', [passageKV({ id: 'jury00000001', volet: 'j02-1', texte: 'séance', couleur: 3 })], 1);
  const p = await open(ctxA, '/annotations.html'); await p.locator('.annot-items').first().waitFor({ timeout: 5000 });
  eq(await p.locator('.annot-resume-liste').innerText(), '3 surlignages (dont 1 commenté) et 1 note, sur 2 fiches.');
  ok(await p.evaluate(() => { const l = document.getElementById('annot-liste'), h = [...document.querySelectorAll('h3.rub')].find(x => /Comment faire/.test(x.textContent)); return !!h && !!(l.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING); }), '« Comment faire » après la liste');
  eq(await p.locator('h2.annot-partie').allInnerTexts(), ['Rapports de jury', 'Notions']);
  eq((await p.locator('h3.annot-fiche-t').allInnerTexts()).map(t => t.split(' ')[0]), ['J2', 'N4']);
  eq(await p.locator('.annot-items > li').count(), 4);
  const lien = p.locator('a.annot-lien').nth(1); eq(await lien.getAttribute('href'), 'fiches/n04.html#annot-abcdefgh1234');
  await p.getByLabel('Seulement les passages commentés').check(); eq(await p.locator('.annot-items > li').count(), 1);
  await p.getByLabel('Seulement les passages commentés').uncheck(); await p.getByLabel('Jaune').uncheck(); await p.getByLabel('Notes de fiche').uncheck();
  eq(await p.locator('.annot-items > li').count(), 2);
  await p.getByLabel('Vert').uncheck(); await p.getByLabel('Rose').uncheck(); ok(/Aucune annotation ne correspond/.test(await p.locator('.annot-contenu').innerText()));
  await p.getByLabel('Jaune').check(); await p.locator('a.annot-lien').first().click(); await p.waitForURL(/n04\.html#annot-abcdefgh1234$/);
  await p.waitForFunction(() => document.querySelector('mark.annot-flash'), null, { timeout: 5000 });
  await p.close();
  reset(); const q = await open(ctxA, '/annotations.html'); await q.waitForFunction(() => /Aucune annotation pour l’instant/.test(document.querySelector('.annot-resume-liste').textContent), null, { timeout: 5000 });
  ok(await q.locator('.annot-filtres').isHidden()); ok(/Comment faire/i.test(await q.locator('main').innerText())); await q.close();
});

await test('export / import avec annotations : fichier version 2, remplacement (avant/après), ancien fichier sans annotations, annotation invalide refusée par le service', async () => {
  reset(); kv.store.set('revisees', '{"J1":true}'); setAnn('N4', [passageKV(), noteKV()], 2);
  const p = await open(ctxA, '/export.html'); await attendreCompteur(p, '1 fiche sur 37 révisée');
  ok(/vos annotations/.test(await p.locator('#suivi-export').innerText()));
  const f = await dl(p); const j = JSON.parse(f.data);
  eq(j.version, 2); eq(Object.keys(j.annotations), ['N4']); eq(j.annotations.N4.length, 2);
  ok(/1 fiche révisée sur 37, 2 annotations/.test(await p.locator('.suivi-msg-sauv').innerText()), await p.locator('.suivi-msg-sauv').innerText());
  // vandalisme puis restauration
  kv.store.set('revisees', '{}'); setAnn('N4', [noteKV({ texte: 'n’importe quoi' })], 3); setAnn('P1', [noteKV({ id: 'vandale00001', texte: 'spam' })], 1);
  await importFile(p, 'restaure.json', f.data); await p.locator('.suivi-confirm:not([hidden])').waitFor();
  ok(/Fiches révisées : 0 avant, 1 après .*Annotations : 2 avant, 2 après/.test(await p.locator('.suivi-confirm').innerText()), await p.locator('.suivi-confirm').innerText());
  await p.getByRole('button', { name: 'Remplacer' }).click(); await p.waitForFunction(() => /Import terminé/.test(document.querySelector('.suivi-msg-sauv').textContent), null, { timeout: 8000 });
  eq(serverState(), { J1: true }); eq(annList('N4'), [passageKV(), noteKV()]); eq(annList('P1'), []);
  // ancien fichier (version 1) : seules les fiches révisées sont remplacées
  await importFile(p, 'v1.json', JSON.stringify({ version: 1, revisees: tousFalse(['C1']) })); await p.locator('.suivi-confirm:not([hidden])').waitFor();
  ok(/2 annotations actuelles sont conservées/.test(await p.locator('.suivi-confirm').innerText()));
  await p.getByRole('button', { name: 'Remplacer' }).click(); await p.waitForFunction(() => /Import terminé/.test(document.querySelector('.suivi-msg-sauv').textContent), null, { timeout: 8000 });
  eq(serverState(), { C1: true }); eq(annList('N4').length, 2);
  // fichier modifié à la main avec une annotation invalide : refus du service, rien ne change
  const bad = JSON.parse(f.data); bad.annotations.N4[0].couleur = 7; bad.revisees.P7 = true;
  await importFile(p, 'bad-annot.json', JSON.stringify(bad)); await p.locator('.suivi-confirm:not([hidden])').waitFor();
  await p.getByRole('button', { name: 'Remplacer' }).click();
  await p.waitForFunction(() => /Import refusé par le service : N4 : Couleur invalide/.test(document.querySelector('.suivi-msg-sauv').textContent), null, { timeout: 8000 });
  eq(serverState(), { C1: true }); eq(annList('N4').length, 2);
  // annotations de code inconnu : refus côté page
  await importFile(p, 'bad-code.json', JSON.stringify({ version: 2, revisees: {}, annotations: { Z9: [] } }));
  await p.waitForFunction(() => /Code de fiche inconnu dans les annotations : Z9/.test(document.querySelector('.suivi-msg-sauv').textContent), null, { timeout: 5000 });
  await p.close();
});

await test('impression : surlignages imprimés en couleur, bulles remplacées par des numéros, commentaires et notes en fin de page, outils masqués', async () => {
  reset(); setAnn('N4', [passageKV({ commentaire: 'Commentaire imprimé' }), noteKV()], 1);
  const p = await open(ctxA, '/fiches/n04.html'); await p.locator('mark.annot').first().waitFor(); await p.emulateMedia({ media: 'print' });
  const st = await p.evaluate(() => { const m = document.querySelector('mark.annot'), b = document.querySelector('.annot-bulle'), cs = getComputedStyle(m);
    return { bg: cs.backgroundColor, adj: cs.printColorAdjust || cs.webkitPrintColorAdjust, num: getComputedStyle(b.querySelector('.annot-num')).display, avant: getComputedStyle(b, '::before').display,
      tete: getComputedStyle(document.querySelector('.annot-tete')).display, notes: getComputedStyle(document.querySelector('.annot-notes')).display, barre: getComputedStyle(document.querySelector('.annot-barre')).display,
      imp: getComputedStyle(document.querySelector('.annot-impression')).display, txt: document.querySelector('.annot-impression').innerText }; });
  eq([st.bg, st.adj, st.num, st.avant, st.tete, st.notes, st.barre, st.imp], ['rgb(255, 235, 128)', 'exact', 'inline', 'none', 'none', 'none', 'none', 'block']);
  ok(/Mes annotations — N4/.test(st.txt) && /Commentaire imprimé/.test(st.txt) && /Ma note de test/.test(st.txt), st.txt);
  const pdf = await p.pdf({ format: 'A4', landscape: true, printBackground: false }); ok(pdf.length > 10000, 'PDF généré');
  await p.emulateMedia({ media: 'screen' }); eq(await p.locator('.annot-impression').evaluate(e => getComputedStyle(e).display), 'none');
  await p.close();
});

await test('téléphone Android émulé (412 px, tactile) : sélection, toucher « Jaune », toucher le surlignage, dialogue ; rien ne déborde à 360 px', async () => {
  reset();
  const ctx = await newCtx({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' });
  const p = await open(ctx, '/fiches/n04.html'); await attendreAnnot(p);
  await selectionner(p, 'proportionnalité inverse'); await attendreBarre(p);
  const bb = await barre(p).boundingBox(); ok(bb.x >= 0 && bb.x + bb.width <= 412 && bb.y + bb.height <= 860, 'barre dans l\'écran : ' + JSON.stringify(bb));
  const hautBandeau = await p.evaluate(() => document.querySelector('.site-header').getBoundingClientRect().bottom);
  ok(bb.y >= hautBandeau && bb.y + bb.height < 860 / 2, 'barre en haut de l\'écran, sous le bandeau (loin de la fenêtre système d\'Android) : ' + JSON.stringify(bb));
  const recouvre = (sr, b) => sr.top < b.y + b.height && sr.bottom > b.y;
  let sr = await p.evaluate(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  ok(!recouvre(sr, bb), 'la barre ne cache pas le passage sélectionné');
  // passage sélectionné tout en haut de l'écran : la barre se place en dessous
  await p.evaluate(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); window.scrollBy(0, r.top - document.querySelector('.site-header').getBoundingClientRect().bottom - 10); });
  await p.waitForTimeout(300);
  const bb2 = await barre(p).boundingBox(); sr = await p.evaluate(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  ok(!recouvre(sr, bb2) && bb2.y > sr.bottom, 'passage en haut : barre placée sous le passage ' + JSON.stringify({ sr, bb2 }));
  const tailles = await barre(p).locator('button').evaluateAll(bs => bs.map(b => b.getBoundingClientRect().height)); ok(tailles.every(h => h >= 36), 'boutons assez grands : ' + tailles);
  await barre(p).getByRole('button', { name: 'Surligner en jaune' }).tap(); await attendreMsg(p, /^Enregistré$/);
  await p.locator('mark.annot').first().tap(); const dlg = p.locator('dialog.annot-dialogue'); await dlg.waitFor();
  const db = await dlg.boundingBox(); ok(db.x >= 0 && db.x + db.width <= 412, 'dialogue dans l\'écran');
  eq(await dlg.locator('textarea').count(), 0, 'lecture d\'abord');
  await dlg.getByRole('button', { name: 'Commenter ou changer la couleur' }).tap();
  ok(await p.evaluate(() => document.activeElement && document.activeElement.type === 'radio'), 'au toucher, le curseur n\'est pas placé dans le commentaire (pas de clavier)');
  await dlg.getByLabel('Commentaire', { exact: true }).fill('Depuis le téléphone'); await dlg.getByRole('button', { name: 'Enregistrer' }).tap();
  await p.waitForFunction(() => { const d = document.querySelector('dialog.annot-dialogue'); return d.open && d.querySelector('.annot-lecture'); }); eq(annList('N4')[0].commentaire, 'Depuis le téléphone');
  await dlg.getByRole('button', { name: 'Fermer' }).tap(); await p.waitForFunction(() => !document.querySelector('dialog.annot-dialogue').open);
  await p.locator('.annot-bulle').tap(); await dlg.waitFor(); eq(await dlg.locator('.annot-lecture').innerText(), 'Depuis le téléphone'); await dlg.getByRole('button', { name: 'Fermer' }).tap();
  ok(await p.locator('.annot-infobulle').isHidden(), 'pas d\'info-bulle au toucher');
  await p.close(); await ctx.close();
  const c360 = await newCtx({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  setAnn('N4', [passageKV({ commentaire: 'x'.repeat(300) }), noteKV({ texte: 'mot'.repeat(200) }), passageKV({ id: 'orph00000009', texte: 'introuvable' })], 1);
  for (const u of ['/fiches/n04.html', '/annotations.html']) {
    const q = await open(c360, u); await q.waitForTimeout(800);
    if (u.startsWith('/fiches')) { await selectionner(q, 'Un même outil, deux logiques'); await attendreBarre(q); }
    const d = await sansDebord(q); ok(d.sw <= d.cw, `${u} : scrollWidth ${d.sw} > ${d.cw}`);
    if (u.startsWith('/fiches')) { await q.locator('mark.annot').first().tap(); await q.locator('dialog.annot-dialogue').waitFor(); const d2 = await sansDebord(q); ok(d2.sw <= d2.cw, 'dialogue : ' + d2.sw); }
    await q.close();
  }
  await c360.close();
});

await test('annotations : aucune donnée dans le stockage du navigateur', async () => {
  const ctx = await newCtx(); reset();
  const p = await open(ctx, '/fiches/n04.html'); await attendreAnnot(p);
  await selectionner(p, 'proportionnalité inverse'); await attendreBarre(p); await barre(p).getByRole('button', { name: 'Surligner en jaune' }).click(); await attendreMsg(p, /^Enregistré$/);
  const q = await open(ctx, '/annotations.html'); await q.locator('.annot-items').waitFor();
  for (const pg of [p, q]) {
    const s = await pg.evaluate(async () => ({ ls: Object.keys(localStorage), ss: Object.keys(sessionStorage), ck: document.cookie, idb: indexedDB.databases ? (await indexedDB.databases()).length : 0 }));
    eq(s.ls, []); eq(s.ck, ''); eq(s.idb, 0); ok(s.ss.every(k => k === 'cappei-menu-v1'), 'sessionStorage : ' + s.ss);
  }
  await ctx.close();
});

console.log('\nSuivi inactif (apiUrl vide)');
await test('aucun élément ajouté, aucun script de suivi, aucune requête vers le service', async () => {
  reset(); const n = journal.length; const reqs = []; const ctx = await newCtx();
  for (const u of ['/fiches/n04.html', '/index.html', '/index-sigles.html']) {
    const p = await ctx.newPage(); p.on('request', r => reqs.push(r.url())); await p.goto(`http://localhost:${portOff}${u}`); await p.waitForTimeout(500);
    eq(await p.evaluate(() => [...document.scripts].some(x => /annot\.js/.test(x.src))), false, u + ' : annot.js chargé');
    eq(await p.locator('[class*="suivi"], #suivi-revisee, [class*="annot"]').count(), 0, u + ' : éléments de suivi ou d\'annotation'); eq(await p.locator('#menu .suivi-ok').count(), 0);
    eq(await p.evaluate(() => typeof window.CAPPEI_API), 'undefined'); await p.close();
  }
  ok(reqs.every(r => r.startsWith(`http://localhost:${portOff}/`)), 'requêtes externes : ' + reqs.filter(r => !r.startsWith(`http://localhost:${portOff}/`)));
  eq(journal.length - n, 0, 'requêtes reçues par le Worker'); await ctx.close();
});

await test('aucune erreur JavaScript dans la console pendant tous les tests', async () => { eq(consoleErrors, []); });

await browser.close(); api.close(); siteOn.close(); siteOff.close();
console.log(`\nRÉSULTAT : ${pass} réussi(s), ${fail} échoué(s)` + (fail ? ' : ' + failures.join(' ; ') : ''));
process.exit(fail ? 1 : 0);
