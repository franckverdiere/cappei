#!/usr/bin/env node
/* Contrôles automatiques du site généré (docs/). Usage : node check_site.js   (code de sortie ≠ 0 en cas d'échec)
   (a) liens internes et ancres ; (b) un seul <h1>, ids uniques ; (c) texte de chaque fiche = texte source (au balisage près) ;
   (d) nombre de pages ; + tests d'anonymisation, couverture des renvois, accessibilité de base, ressources externes. */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.env.FICHES_DIR || '/home/claude/atelier/fiches';
const DOCS = path.join(__dirname, 'docs');
const site = require('./build_site'); // ne régénère rien (build() n'est appelé que par `node build_site.js`)
const { CAT } = require(path.join(SRC, 'kit'));
const { LEGEND, jury } = require(path.join(SRC, 'jury'));
const { LEGENDE, notions } = require(path.join(SRC, 'fiches_notions'));
const { LEGENDE_C, cadre } = require(path.join(SRC, 'fiches_cadre'));
const { LEGENDE2, notions2 } = require(path.join(SRC, 'fiches_notions2'));
const { LEGENDE_P, publics } = require(path.join(SRC, 'fiches_publics'));
const { index: indexFiches } = require(path.join(SRC, 'index'));

let failures = 0;
const fail = m => { failures++; console.log('  ÉCHEC : ' + m); };
const section = t => console.log('\n' + t);

/* ------------------------------------------------------------ lecture des pages */
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(DOCS);
const htmlFiles = files.filter(f => f.endsWith('.html')).sort();
const rel = f => path.relative(DOCS, f).split(path.sep).join('/');
const html = {};
for (const f of htmlFiles) html[rel(f)] = fs.readFileSync(f, 'utf8');
const idsOf = h => [...h.matchAll(/\sid="([^"]*)"/g)].map(m => m[1]);

/* ------------------------------------------------------------ (a) liens internes */
section('(a) Liens internes');
let nLinks = 0, nAnch = 0;
for (const [file, h] of Object.entries(html)) {
  for (const m of h.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const url = m[1];
    if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(url)) { if (!/^data:,?$/.test(url)) fail(`${file} : URL absolue ou non locale ${url}`); continue; }
    const [p, frag] = url.split('#');
    const target = p ? path.posix.normalize(path.posix.join(path.posix.dirname(file), p)) : file;
    nLinks++;
    if (!fs.existsSync(path.join(DOCS, target))) { fail(`${file} : lien cassé ${url}`); continue; }
    if (frag !== undefined) {
      nAnch++;
      const th = html[target];
      if (!th || !idsOf(th).includes(frag)) fail(`${file} : ancre introuvable ${url}`);
    }
    if (url.startsWith('/')) fail(`${file} : lien absolu ${url} (doit être relatif)`);
  }
}
for (const f of ['assets/style.css', 'assets/site.js']) {
  const t = fs.readFileSync(path.join(DOCS, f), 'utf8');
  if (/https?:\/\/|@import|url\(/i.test(t)) fail(`${f} : ressource externe ou url() détectée`);
}
console.log(`  ${nLinks} liens/ressources vérifiés dont ${nAnch} ancres`);

/* ------------------------------------------------------------ (b) structure */
section('(b) Structure des pages');
for (const [file, h] of Object.entries(html)) {
  const n1 = (h.match(/<h1[\s>]/g) || []).length;
  if (n1 !== 1) fail(`${file} : ${n1} balises <h1>`);
  const ids = idsOf(h), dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) fail(`${file} : ids dupliqués ${[...new Set(dup)].join(', ')}`);
  if (!/<html lang="fr">/.test(h)) fail(`${file} : <html lang="fr"> absent`);
  if (!/<meta name="viewport"/.test(h)) fail(`${file} : meta viewport absente`);
  if (!/<title>[^<]+<\/title>/.test(h)) fail(`${file} : <title> absent`);
  for (const tag of ['header', 'main', 'footer']) if ((h.match(new RegExp('<' + tag + '[\\s>]', 'g')) || []).length < 1) fail(`${file} : <${tag}> absent`);
  if (!/<nav[^>]*aria-label="Menu principal"/.test(h)) fail(`${file} : nav principal absent`);
  if (!/class="skip" href="#contenu"/.test(h)) fail(`${file} : lien d'évitement absent`);
  const cur = (h.match(/id="menu"[\s\S]*?<\/nav>/)[0].match(/aria-current="page"/g) || []).length;
  if (cur !== 1) fail(`${file} : ${cur} éléments aria-current dans le menu`);
  if (/<img[\s>]/.test(h) && /<img(?![^>]*alt=)/.test(h)) fail(`${file} : image sans alt`);
}
console.log(`  ${Object.keys(html).length} pages examinées`);

/* ------------------------------------------------------------ (c) fidélité du texte */
section('(c) Fidélité du texte (HTML visible vs objets source)');
const INLINE_RE = /\*\*([^*]+)\*\*|\*([^*\n]+)\*|\[([A-Z][A-Za-z]{0,5}\d{0,2}(?:[,–-]\s?[A-Z]?[A-Za-z]{0,5}\d{0,2})*)\]/g;
const flatten = s => site.anonymise(String(s).replace(INLINE_RE, (_, b, i, t) => b !== undefined ? b : i !== undefined ? i : ' ' + t));
const raw = s => site.anonymise(String(s));
function ficheTexts(f) {
  const out = [raw(f.bannerLabel || (CAT[f.cat].label + '  ·  FICHE ' + f.code)), raw(f.title)];
  if (f.subtitle) out.push(raw(f.subtitle));
  for (const b of f.blocks) {
    if (b.h) out.push(raw(b.h));
    else if (b.ul) b.ul.forEach(t => out.push(flatten(t)));
    else if (b.p) out.push(flatten(b.p));
    else if (b.box) { if (b.box.title) out.push(raw(b.box.title)); b.box.lines.forEach(l => out.push(flatten(l.startsWith('- ') ? l.slice(2) : l))); }
    else if (b.table) { (b.table.head || []).forEach(c => out.push(flatten(c))); b.table.rows.forEach(r => r.forEach(c => out.push(flatten(c)))); }
    else if (b.flow) b.flow.steps.forEach(s => out.push(flatten(s)));
    else fail('bloc inconnu dans ' + f.code);
  }
  return out;
}
const words = arr => arr.join(' ').split(/\s+/).filter(Boolean);
const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
function visibleText(h) {
  const arts = [];
  const re = /<article class="fiche"[\s\S]*?<\/article>/g; let m;
  while ((m = re.exec(h)) !== null) arts.push(m[0]);
  return arts.map(a => a
    .replace(/<span class="mark" aria-hidden="true">[\s\S]*?<\/span>/g, '')        // marques décoratives (aria-hidden)
    .replace(/<\/?(?:p|li|ul|ol|div|h[1-6]|table|thead|tbody|colgroup|col|tr|th|td|header|article)\b[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, e => entities[e]));
}
function compare(label, expected, actual) {
  const e = words(expected), a = words(actual);
  if (e.length === a.length && e.every((w, i) => w === a[i])) return { ok: true, n: e.length };
  const cnt = new Map(); e.forEach(w => cnt.set(w, (cnt.get(w) || 0) + 1)); a.forEach(w => cnt.set(w, (cnt.get(w) || 0) - 1));
  const missing = [], added = [];
  for (const [w, c] of cnt) { if (c > 0) missing.push(w + (c > 1 ? '×' + c : '')); else if (c < 0) added.push(w + (c < -1 ? '×' + -c : '')); }
  let i = 0; while (i < e.length && e[i] === a[i]) i++;
  fail(`${label} : écart (mots source ${e.length} / page ${a.length}) ; manquants [${missing.slice(0, 15)}] ajoutés [${added.slice(0, 15)}] ; 1er écart au mot ${i} : « ${e.slice(i, i + 5).join(' ')} » vs « ${a.slice(i, i + 5).join(' ')} »`);
  return { ok: false, n: e.length };
}
// regroupement indépendant des fiches par page (code de base : « N4 · 1/2 » -> N4)
const base = c => String(c).split(' ')[0];
const slug = b => b.toLowerCase().replace(/^([a-z])(\d)$/, '$10$2');
const flat = [...jury, ...cadre.flatMap(n => n.fiches), ...notions.flatMap(n => n.fiches), ...notions2.flatMap(n => n.fiches), ...publics.flatMap(n => n.fiches)];
const groups = new Map(); flat.forEach(f => { const b = base(f.code); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(f); });
const legendOf = b => b[0] === 'J' ? LEGEND : b[0] === 'C' ? LEGENDE_C : b[0] === 'P' ? LEGENDE_P : (+b.slice(1) <= 5 ? LEGENDE : LEGENDE2);
let totalWords = 0, okPages = 0, nPagesChecked = 0, nFiches = 0;
const expectedPages = [];
for (const [b, fs_] of groups) expectedPages.push({ file: `fiches/${slug(b)}.html`, fiches: fs_, legend: legendOf(b), label: b });
expectedPages.push({ file: 'index-auteurs.html', fiches: indexFiches.slice(0, 4), legend: null, label: 'index-auteurs' });
expectedPages.push({ file: 'index-sigles.html', fiches: indexFiches.slice(4), legend: null, label: 'index-sigles' });
expectedPages.push({ file: 'index.html', fiches: [site.cover1, site.cover2], legend: null, label: 'accueil' });
for (const p of expectedPages) {
  const h = html[p.file];
  if (!h) { fail('page absente : ' + p.file); continue; }
  nPagesChecked++;
  const arts = visibleText(h);
  if (arts.length !== p.fiches.length) fail(`${p.file} : ${arts.length} volets pour ${p.fiches.length} fiches`);
  p.fiches.forEach((f, i) => {
    nFiches++;
    const r = compare(`${p.file} [${f.code || f.title}]`, ficheTexts(f), [arts[i] || '']);
    totalWords += r.n; if (r.ok) okPages++;
  });
  const lg = h.match(/<section class="legende"[^>]*><p>([\s\S]*?)<\/p><\/section>/);
  if (p.legend) {
    const t = lg ? lg[1].replace(/&(?:amp|lt|gt|quot);/g, e => entities[e]) : '';
    if (t !== site.anonymise(p.legend)) fail(`${p.file} : légende des sources différente de la source`);
  } else if (lg) fail(`${p.file} : légende inattendue`);
}
console.log(`  ${nPagesChecked} pages, ${nFiches} fiches/volets comparés, ${totalWords} mots ; ${okPages} identiques`);

/* Couvertures : écarts avec classeur.js (texte non adapté = présent à l'identique dans classeur.js) */
section('(c bis) Couvertures : passages différents de classeur.js (adaptations web)');
{
  const cl = fs.readFileSync(path.join(SRC, 'classeur.js'), 'utf8');
  const diffs = [];
  for (const f of [site.cover1, site.cover2]) for (const b of f.blocks) {
    const strs = [];
    if (b.h) strs.push(b.h); if (b.ul) strs.push(...b.ul);
    if (b.box) strs.push(b.box.title, ...b.box.lines);
    if (b.table) b.table.rows.forEach(r => strs.push(...r));
    for (const s of strs) if (!cl.includes(s.replace(/'/g, "\\'"))) diffs.push(s);
    for (const s of [f.title, f.subtitle, f.bannerLabel]) if (!cl.includes(s)) diffs.push(s);
  }
  console.log(`  ${diffs.length} chaîne(s) adaptée(s) :`); diffs.forEach(d => console.log('   - ' + d.slice(0, 150)));
}

/* ------------------------------------------------------------ (d) nombre de pages */
section('(d) Nombre de pages');
{
  const themes = htmlFiles.map(rel).filter(f => f.startsWith('fiches/'));
  const nJ = themes.filter(f => /\/j\d\d\.html$/.test(f)).length, nC = themes.filter(f => /\/c\d\d\.html$/.test(f)).length;
  const nN = themes.filter(f => /\/n\d\d\.html$/.test(f)).length, nP = themes.filter(f => /\/p\d\d\.html$/.test(f)).length;
  const idx = ['index-auteurs.html', 'index-sigles.html'].filter(f => html[f]).length, home = html['index.html'] ? 1 : 0;
  console.log(`  J=${nJ} C=${nC} N=${nN} P=${nP} index=${idx} accueil=${home} total=${htmlFiles.length}`);
  if (nJ !== 6 || nC !== 7 || nN !== 16 || nP !== 7 || idx !== 2 || home !== 1 || htmlFiles.length !== 39) fail('nombre de pages inattendu (attendu 6+7+16+7+2+1 = 39)');
  const attendu = b => /^J/.test(b) ? 1 : ({ C2: 1, C3: 1, C4: 1, C5: 3 }[b] || 2);
  for (const [b, fs_] of groups) if (fs_.length !== attendu(b)) fail(`${b} : ${fs_.length} volets (attendu ${attendu(b)})`);
  const att = ['.nojekyll', 'assets/style.css', 'assets/site.js'].filter(f => !fs.existsSync(path.join(DOCS, f)));
  if (att.length) fail('fichiers manquants : ' + att.join(', '));
  if (fs.statSync(path.join(DOCS, '.nojekyll')).size !== 0) fail('.nojekyll doit être vide');
  const bad = files.filter(f => !/\.(html|css|js)$/.test(f) && path.basename(f) !== '.nojekyll');
  if (bad.length) fail('fichiers non autorisés dans docs/ : ' + bad.map(rel).join(', '));
  console.log(`  contenu de docs/ : ${files.length} fichiers (html/css/js + .nojekyll uniquement)`);
}

/* ------------------------------------------------------------ renvois : couverture */
section('(e) Renvois entre fiches');
{
  const known = new Set([...groups.keys()]);
  let expected = 0, got = 0;
  const refRe = /(?<![\p{L}\p{N}\-])([JCNP])(\d{1,2})(?![\p{L}\p{N}])/gu;
  for (const p of expectedPages) {
    const h = html[p.file];
    const strip = s => String(s).replace(INLINE_RE, (_, b, i, t) => b !== undefined ? b : i !== undefined ? i : '');   // sans les repères [TAG]
    const texts = [];
    p.fiches.forEach(f => { for (const b of f.blocks) {
      if (b.ul) texts.push(...b.ul); if (b.p) texts.push(b.p);
      if (b.box) texts.push(...b.box.lines); if (b.table) { texts.push(...(b.table.head || [])); b.table.rows.forEach(r => texts.push(...r)); }
      if (b.flow) texts.push(...b.flow.steps);
    } });
    for (const t of texts) for (const m of strip(t).matchAll(refRe)) if (known.has(m[1] + m[2])) expected++;
    const arts = (h.match(/<article class="fiche"[\s\S]*?<\/article>/g) || []).join('');
    got += (arts.match(/<a class="ref"/g) || []).length;
  }
  console.log(`  renvois attendus (hors repères [TAG]) : ${expected} ; liens présents : ${got}`);
  if (expected !== got) fail('nombre de renvois différent du nombre de liens');
  // les liens pointent vers la bonne page
  let wrong = 0;
  for (const [file, h] of Object.entries(html)) for (const m of h.matchAll(/<a class="ref" href="([^"]+)" title="[^"]*">([JCNP]\d+)<\/a>/g)) {
    const want = `${slug(m[2])}.html`; if (path.posix.basename(m[1]) !== want) { wrong++; fail(`${file} : lien ${m[2]} -> ${m[1]}`); }
  }
  if (!wrong) console.log('  tous les liens de renvoi pointent vers la page du code affiché');
  if (site.REF_UNKNOWN.length) console.log('  candidats sans page (non liés) : ' + JSON.stringify(site.REF_UNKNOWN));
}

/* ------------------------------------------------------------ anonymisation */
section('(f) Anonymisation');
{
  const list = site.loadAnonymisationList(path.join(__dirname, 'anonymisation.json'));
  console.log(`  anonymisation.json : ${list.length} entrée(s)`);
  const sample = 'J. Cordelois et C. Laval citent Goigoux, Bucheton, Camille et Léa ; J.-F. Camps (JFC) ; Marie-Claire.';
  if (list.length === 0) {
    if (site.anonymise(sample) !== sample) fail('anonymise() modifie un texte alors que la liste est vide');
    // le texte de toutes les chaînes des fiches est inchangé (le point (c) le vérifie déjà sur les pages)
    console.log('  liste vide : anonymise() est l\'identité (testé sur un échantillon ; (c) confirme que les pages sont inchangées)');
  }
  // test fonctionnel avec une liste fictive (jamais écrite dans docs/)
  const a = site.anonymiseWith([{ prenom: 'Camille', initiale: 'C.' }, { prenom: 'Léa', initiale: 'L.' }, { prenom: 'Claire', initiale: 'C.' }]);
  const out = a('Camille et Léa lisent ; Camille-Anne reste ; C. Laval, J. Cordelois, Goigoux, Bucheton, J.-F. Camps inchangés ; Claire Laval n’existe pas ici.');
  const expect = 'C. et L. lisent ; Camille-Anne reste ; C. Laval, J. Cordelois, Goigoux, Bucheton, J.-F. Camps inchangés ; C. Laval n’existe pas ici.';
  console.log('  test avec liste fictive : ' + (out === expect ? 'OK' : 'ÉCHEC'));
  if (out !== expect) fail('anonymiseWith : obtenu « ' + out + ' »');
  const b = a('Goigoux et Bucheton, J. Cordelois, C. Laval, Archer & Hughes');
  if (b !== 'Goigoux et Bucheton, J. Cordelois, C. Laval, Archer & Hughes') fail('un nom d\'auteur a été touché');
}

/* ------------------------------------------------------------ repères [TAG] vs légendes (information) */
section('(g) Repères [TAG] absents des légendes (information, aucune correction)');
{
  const tagsByPage = {};
  for (const p of expectedPages.filter(x => x.legend)) {
    const keys = new Set(p.legend.replace(/^Sources\s*—\s*/, '').split(' · ').map(s => s.split(' : ')[0].trim()));
    const miss = new Set();
    p.fiches.forEach(f => JSON.stringify(f.blocks).replace(/\\n/g, ' ').replace(/\[([A-Z][A-Za-z]{0,5}\d{0,2}(?:[,–-]\s?[A-Z]?[A-Za-z]{0,5}\d{0,2})*)\]/g, (_, t) => { t.split(/[,–-]\s?/).forEach(x => { if (!keys.has(x) && !keys.has(x.replace(/\d+$/, ''))) miss.add(x); }); return ''; }));
    if (miss.size) tagsByPage[p.label] = [...miss];
  }
  const all = {}; Object.entries(tagsByPage).forEach(([k, v]) => v.forEach(t => (all[t] = all[t] || []).push(k)));
  console.log('  ' + (Object.keys(all).length ? Object.entries(all).map(([t, ps]) => `${t} (${ps.length} page(s))`).join(', ') : 'aucun'));
}

console.log('\n' + (failures ? `RÉSULTAT : ${failures} échec(s)` : 'RÉSULTAT : tous les contrôles passent'));
process.exit(failures ? 1 : 0);
