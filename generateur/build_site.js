#!/usr/bin/env node
/* Génère le site statique « Fiches de révision CAPPEI » dans ./docs/
   Usage : node build_site.js        (depuis /home/claude/site-build)
   Aucune dépendance npm : seuls les modules des fiches sont chargés (kit.js charge `docx` mais n'écrit rien à l'import ;
   classeur.js, lui, écrit des .docx à l'import : il n'est donc PAS chargé, ses deux couvertures sont recopiées ci-dessous). */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.env.FICHES_DIR || '/home/claude/atelier/fiches';
const ROOT = __dirname;
const OUT = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.join(ROOT, 'docs');

/* ------------------------------------------------------------------ Configuration du suivi « fiche révisée » */
/* config.json { "apiUrl": "" } ; la variable d'environnement API_URL (même vide) l'emporte. apiUrl vide = fonctionnalité inactive. */
function loadApiUrl() {
  let v = '';
  try { v = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).apiUrl; }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('config.json : ' + e.message); }
  if (process.env.API_URL !== undefined) v = process.env.API_URL;
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new Error('config.json : apiUrl doit être du texte');
  v = v.trim().replace(/\/+$/, '');
  if (v && !/^https:\/\/[^\s\/]+/i.test(v) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(v)) throw new Error('apiUrl doit commencer par https:// (http:// accepté seulement pour localhost) : ' + v);
  return v;
}
const API_URL = loadApiUrl();

const { CAT, RUB } = require(path.join(SRC, 'kit'));
const { LEGEND, jury } = require(path.join(SRC, 'jury'));
const { LEGENDE, notions } = require(path.join(SRC, 'fiches_notions'));
const { LEGENDE_C, cadre } = require(path.join(SRC, 'fiches_cadre'));
const { LEGENDE2, notions2 } = require(path.join(SRC, 'fiches_notions2'));
const { LEGENDE_P, publics } = require(path.join(SRC, 'fiches_publics'));
const { index: indexFiches } = require(path.join(SRC, 'index'));
const { AUTEURS } = require(path.join(SRC, 'index_data'));

/* ------------------------------------------------------------------ Anonymisation (élèves uniquement) */
/* Ne remplace QUE les prénoms listés dans anonymisation.json ([{ "prenom": ..., "initiale": ... }]).
   Les noms d'auteurs et d'intervenants (index_data.AUTEURS, motif « J. Cordelois ») sont protégés par masquage. */
function loadAnonymisationList(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error('doit être un tableau');
    list.forEach(e => { if (!e || typeof e.prenom !== 'string' || typeof e.initiale !== 'string' || !e.prenom) throw new Error('entrée invalide : ' + JSON.stringify(e)); });
    return list;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error('anonymisation.json : ' + e.message);
  }
}
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PROTECTED_NAMES = [...new Set(AUTEURS.flatMap(([n, , label]) => [n, label].filter(Boolean)))].sort((a, b) => b.length - a.length);
const PROTECTED_RE = new RegExp('(?:' + PROTECTED_NAMES.map(escRe).join('|') + '|(?:\\p{Lu}\\.-?\\s?)+\\p{Lu}[\\p{L}\'’-]+)', 'gu');
function makeAnonymiser(list) {
  if (!list.length) return t => t;
  const rules = list.map(e => ({ re: new RegExp('(?<![\\p{L}\\p{N}_-])' + escRe(e.prenom) + '(?![\\p{L}\\p{N}_-])', 'gu'), by: e.initiale }));
  return function (texte) {
    const masked = [];
    let t = String(texte).replace(PROTECTED_RE, m => { masked.push(m); return '' + (masked.length - 1) + ''; });
    for (const r of rules) t = t.replace(r.re, r.by);
    return t.replace(/(\d+)/g, (_, i) => masked[+i]);
  };
}
let anonymise = makeAnonymiser(loadAnonymisationList(path.join(ROOT, 'anonymisation.json')));
const anonymiseWith = list => makeAnonymiser(list);

/* ------------------------------------------------------------------ Couleurs : contraste AA */
const lum = h => { const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const MIN = 4.55; // AA texte normal (4,5) avec une marge d'arrondi
function darken(hex, bgs) {
  let [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  const toHex = () => [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  while (bgs.some(bg => contrast(toHex(), bg) < MIN)) { r *= 0.97; g *= 0.97; b *= 0.97; }
  return toHex();
}
const COLOR_CHANGES = [];
const CATC = {}, RUBC = {};
for (const [k, v] of Object.entries(CAT)) {
  const c = darken(v.color, ['FFFFFF']);                     // texte blanc du bandeau
  CATC[k] = { color: c, tint: v.tint, label: v.label };
  if (c !== v.color) COLOR_CHANGES.push(`CAT.${k} : #${v.color} -> #${c} (blanc : ${contrast(v.color, 'FFFFFF').toFixed(2)} -> ${contrast(c, 'FFFFFF').toFixed(2)})`);
}
for (const [k, v] of Object.entries(RUB)) {
  const c = darken(v.color, ['FFFFFF', v.tint]);             // en-tête de tableau (blanc), titres sur blanc et sur teinte
  RUBC[k] = { color: c, tint: v.tint, mark: v.mark };
  if (c !== v.color) COLOR_CHANGES.push(`RUB.${k} : #${v.color} -> #${c} (blanc/teinte : ${contrast(v.color, 'FFFFFF').toFixed(2)}/${contrast(v.color, v.tint).toFixed(2)} -> ${contrast(c, 'FFFFFF').toFixed(2)}/${contrast(c, v.tint).toFixed(2)})`);
}
const TAG_GREY = darken('7A7A7A', ['FFFFFF', ...Object.values(RUB).map(r => r.tint)]);
if (TAG_GREY !== '7A7A7A') COLOR_CHANGES.push(`repère de source [TAG] : #7A7A7A -> #${TAG_GREY} (sur blanc : ${contrast('7A7A7A', 'FFFFFF').toFixed(2)} -> ${contrast(TAG_GREY, 'FFFFFF').toFixed(2)})`);

/* ------------------------------------------------------------------ Couvertures (recopiées de classeur.js, adaptées au web) */
/* Texte identique à classeur.js sauf les passages marqués ADAPTÉ (papier / pliage / pages paysage). check_site.js liste ces écarts. */
const cover1 = {
  cat: 'classeur', code: '', bannerLabel: 'CAPPEI  ·  CLASSEUR DE RÉVISION',
  title: 'Fiches de révision CAPPEI', subtitle: 'Classeur général évolutif — état au 14 novembre 2026',
  blocks: [
    { h: 'Mode d’emploi', kind: 'neutre' },
    { ul: [
      // ADAPTÉ (original : « Chaque page paysage porte **deux fiches** à lire en portrait ; pliée en deux, elle donne un livret A5. »)
      'Chaque page du site réunit les **deux fiches** d’une notion ou d’un thème (parfois trois), à lire l’une sous l’autre ; elles s’affichent côte à côte sur grand écran.',
      '**Une information n’a qu’une fiche d’attache** : ailleurs, un renvoi (« voir N4 ») y conduit.',
      'Chaque fiche de notion réunit la **définition**, les **distinctions**, les **auteurs** et la **mise en pratique**.',
      'Le contenu vient **exclusivement des documents de cours** ; les petits repères gris (CL, ECR, T25…) indiquent la source, détaillée en pied de page.',
    ] },
    { h: 'Le code couleur', kind: 'neutre' },
    { table: { kind: 'neutre', legend: true, widths: [30, 70], head: ['Repère', 'Signification'], rows: [
      ['**◆ Bleu**', 'Ce qu’il faut savoir : définitions, attentes, distinctions.'],
      ['**✔ Vert**', 'Ce qui est apprécié, ce que montre la recherche.'],
      ['**✖ Rouge**', 'Points de vigilance, critiques, écueils.'],
      ['**➜ Ocre**', 'Conseils, pratique, repères pour l’oral.'],
      ['**★ Violet**', 'Moyen mnémotechnique (proposé, hors documents).'],
      ['**! Jaune**', 'Divergence entre sources, information manquante ou à vérifier.'],
      ['**▣ Gris**', 'En EPM : ce que les documents de cours disent du contexte pénitentiaire.'],
    ] } },
    { h: 'Les règles suivies', kind: 'neutre' },
    { ul: [
      '**Fidélité** aux formulations des cours ; aucune source extérieure.',
      'Quand deux sources ne disent pas la même chose, la fiche **le signale** au lieu de trancher.',
      'Les moyens mnémotechniques sont **ajoutés** et étiquetés comme tels.',
    ] },
  ],
};
const cover2 = {
  cat: 'classeur', code: '', bannerLabel: 'SOMMAIRE', title: 'Plan du classeur', subtitle: 'Version complète : toutes les fiches du plan sont présentes',
  blocks: [
    { table: { kind: 'neutre', widths: [36, 64], head: ['Partie', 'Fiches'], rows: [
      ['**1. Rapports de jury**', '**J1** Ce que le jury évalue · **J2** Épreuve 1, la séance · **J3** Épreuve 1, documents et entretien · **J4** Épreuve 2 · **J5** Épreuve 3 · **J6** Réussir les oraux'],
      ['**2. Cadre réglementaire et institutionnel** (chronologique)', '**C1** Frise d’ensemble (France, international) · **C2** Avant 2005 · **C3** 2005 – 2012 · **C4** 2013 – 2018 · **C5** De 2019 à aujourd’hui, dont la Conférence nationale du handicap 2026 (3 fiches) · **C6** Aujourd’hui, comment ça marche · **C7** Protection de l’enfance'],
      ['**3. Notions**', '**N1** École inclusive · **N2** Handicap et situation de handicap · **N3** Besoins éducatifs particuliers · **N4** Compensation, accessibilité, adaptation · **N5** Différenciation · **N6** Conception universelle et séance accessible · **N7** Enseignement explicite · **N8** Théories de l’apprentissage · **N9** Didactique · **N10** Observer et recueillir les besoins · **N11** Évaluer · **N12** Autonomie et métacognition · **N13** Co-enseignement et AESH · **N14** Familles et partenaires · **N15** Personne ressource, posture · **N16** Forme scolaire, exclusion, rapport au savoir'],
      ['**4. Publics et disciplines**', '**P1** Troubles du neurodéveloppement · **P2** Troubles du comportement et contenance · **P3** Corps, émotions, adolescence · **P4** Nombre et résolution de problèmes · **P5** Oral, lecture-écriture · **P6** Numérique et supports accessibles · **P7** Parcours et orientation'],
      // ADAPTÉ (original : « **Auteurs** (2 pages) · **Sigles** (1 page), avec renvois aux fiches »)
      ['**Index**', '**Auteurs** · **Sigles**, avec renvois aux fiches'],
    ] } },
    // ADAPTÉ (original : « … partie 2 (C1 à C7, 6 pages), … à raison de deux fiches par notion ou par thème, soit une page chacune. … »)
    { box: { kind: 'neutre', title: 'Dans cette version', lines: ['Les quatre parties sont complètes : partie 1 (6 fiches), partie 2 (C1 à C7), partie 3 (N1 à N16) et partie 4 (P1 à P7), à raison de deux fiches par notion ou par thème. Les deux index terminent le classeur.'] } },
  ],
};

/* ------------------------------------------------------------------ Organisation (même ordre que classeur.js) */
const PARTS = [
  { id: 'jury', letter: 'J', cat: 'jury', name: '1 Rapports de jury', legend: () => LEGEND },
  { id: 'cadre', letter: 'C', cat: 'cadre', name: '2 Cadre réglementaire et institutionnel', legend: () => LEGENDE_C },
  { id: 'notions', letter: 'N', cat: 'notion', name: '3 Notions', legend: code => (+code.slice(1) <= 5 ? LEGENDE : LEGENDE2) },
  { id: 'publics', letter: 'P', cat: 'public', name: '4 Publics et disciplines', legend: () => LEGENDE_P },
  { id: 'index', letter: '', cat: 'classeur', name: 'Index', legend: () => null },
];
const flat = [
  ...jury,
  ...cadre.flatMap(n => n.fiches),
  ...notions.flatMap(n => n.fiches),
  ...notions2.flatMap(n => n.fiches),
  ...publics.flatMap(n => n.fiches),
];
// libellés des thèmes, lus dans le plan (cover2) : « **J1** Ce que le jury évalue · **J2** … »
const LABELS = {};
cover2.blocks[0].table.rows.forEach(r => r[1].split(' · **').forEach((s, i) => {
  const m = (i ? '**' + s : s).match(/^\*\*([JCNP]\d+)\*\* (.+)$/);
  if (m) LABELS[m[1]] = m[2];
}));
const baseOf = code => String(code).split(' ')[0];
const slugOf = base => base.toLowerCase().replace(/^([a-z])(\d)$/, '$10$2');
const pages = [];
const byCode = {};
for (const f of flat) {
  const base = baseOf(f.code);
  if (!byCode[base]) {
    const part = PARTS.find(p => p.letter === base[0]);
    byCode[base] = { code: base, slug: slugOf(base), file: 'fiches/' + slugOf(base) + '.html', part, label: LABELS[base], fiches: [], legend: part.legend(base) };
    pages.push(byCode[base]);
  }
  byCode[base].fiches.push(f);
}
for (const p of pages) if (!p.label) throw new Error('libellé manquant pour ' + p.code);
const indexPages = [
  { code: 'Index des auteurs', slug: 'index-auteurs', file: 'index-auteurs.html', part: PARTS[4], label: 'Index des auteurs', fiches: indexFiches.slice(0, 4), legend: null },
  { code: 'Index des sigles', slug: 'index-sigles', file: 'index-sigles.html', part: PARTS[4], label: 'Index des sigles', fiches: indexFiches.slice(4), legend: null },
];
const HOME = { code: 'Accueil', slug: 'accueil', file: 'index.html', label: 'Fiches de révision CAPPEI' };
const sequence = [...pages, ...indexPages];

/* ------------------------------------------------------------------ Rendu */
const esc = s => anonymise(String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escAttr = esc;
const relHref = (from, to) => path.posix.relative(path.posix.dirname(from), to) || path.posix.basename(to);
const REFLOG = [];                    // journal des renvois transformés en liens
const REF_UNKNOWN = [];               // candidats de forme X0 sans page correspondante (non liés)
// Même balisage inline que kit.js (runs) : **gras**, *italique*, [TAG] = repère de source
const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|\[[A-Z][A-Za-z]{0,5}\d{0,2}(?:[,–-]\s?[A-Z]?[A-Za-z]{0,5}\d{0,2})*\])/g;
const REF_RE = /(?<![\p{L}\p{N}\-])([JCNP])(\d{1,2})(?![\p{L}\p{N}])/gu;

function linkRefs(seg, ctx) {
  let out = '', last = 0, m;
  const re = new RegExp(REF_RE.source, REF_RE.flags);
  while ((m = re.exec(seg)) !== null) {
    const code = m[1] + m[2], tgt = byCode[code];
    out += esc(seg.slice(last, m.index));
    if (tgt) {
      out += `<a class="ref" href="${relHref(ctx.file, tgt.file)}" title="${escAttr(code + ' — ' + tgt.label)}">${esc(code)}</a>`;
      REFLOG.push({ from: ctx.file, to: code, context: seg.slice(Math.max(0, m.index - 24), m.index + m[0].length + 14).replace(/\s+/g, ' ') });
    } else { out += esc(m[0]); REF_UNKNOWN.push({ from: ctx.file, code, context: seg.slice(Math.max(0, m.index - 24), m.index + 20) }); }
    last = m.index + m[0].length;
  }
  return out + esc(seg.slice(last));
}
function boldHtml(inner, ctx) {
  const href = ctx.boldLinks && ctx.boldLinks[inner];
  return '<strong>' + (href ? `<a href="${relHref(ctx.file, href)}">${esc(inner)}</a>` : linkRefs(inner, ctx)) + '</strong>';
}
function inline(text, ctx) {
  const t = anonymise(String(text));
  const re = new RegExp(INLINE_RE.source, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(t)) !== null) {
    if (m.index > last) out += linkRefs(t.slice(last, m.index), ctx);
    const tok = m[0];
    if (tok.startsWith('**')) out += boldHtml(tok.slice(2, -2), ctx);
    else if (tok.startsWith('*')) out += '<em>' + linkRefs(tok.slice(1, -1), ctx) + '</em>';
    else out += '<span class="src"> ' + esc(tok.slice(1, -1)) + '</span>';   // repère de source : petit, gris, précédé d'un espace
    last = m.index + tok.length;
  }
  if (last < t.length) out += linkRefs(t.slice(last), ctx);
  return out;
}
const mark = kind => `<span class="mark" aria-hidden="true">${RUBC[kind].mark}</span> `;

function renderBlocks(blocks, ctx) {
  const out = [];
  for (const b of blocks) {
    if (b.h) out.push(`<h3 class="rub k-${b.kind}">${mark(b.kind)}${esc(b.h)}</h3>`);
    else if (b.ul) out.push(`<ul class="puces">${b.ul.map(t => `<li>${inline(t, ctx)}</li>`).join('')}</ul>`);
    else if (b.p) out.push(`<p>${inline(b.p, ctx)}</p>`);
    else if (b.box) {
      const x = b.box, parts = [];
      if (x.title) parts.push(`<p class="box-title">${mark(x.kind)}${esc(x.title)}</p>`);
      let run = [];
      const flush = () => { if (run.length) { parts.push(`<ul class="puces">${run.map(t => `<li>${inline(t, ctx)}</li>`).join('')}</ul>`); run = []; } };
      for (const l of x.lines) { if (l.startsWith('- ')) run.push(l.slice(2)); else { flush(); parts.push(`<p>${inline(l, ctx)}</p>`); } }
      flush();
      out.push(`<div class="box k-${x.kind}">${parts.join('')}</div>`);
    } else if (b.table) {
      const t = b.table, tot = t.widths.reduce((a, c) => a + c, 0);
      const cell = (txt, tag, scope) => `<${tag}${scope ? ` scope="${scope}"` : ''}>${String(txt).split('\n').map(l => `<p>${inline(l, ctx)}</p>`).join('')}</${tag}>`;
      const cols = '<colgroup>' + t.widths.map(w => `<col style="width:${(100 * w / tot).toFixed(2)}%">`).join('') + '</colgroup>';
      const head = t.head ? `<thead><tr>${t.head.map(h => cell(h, 'th', 'col')).join('')}</tr></thead>` : '';
      const body = '<tbody>' + t.rows.map(r => '<tr>' + r.map((c, i) => cell(c, i === 0 ? 'th' : 'td', i === 0 ? 'row' : null)).join('') + '</tr>').join('') + '</tbody>';
      out.push(`<div class="table-scroll" tabindex="0"><table class="t k-${t.kind} cols-${t.widths.length}${t.compact ? ' compact' : ''}${t.legend ? ' legend' : ''}">${cols}${head}${body}</table></div>`);
    } else if (b.flow) {
      const steps = b.flow.steps.map(s => {
        const ls = s.split('\n');
        return `<li class="step"><p class="step-title">${inline(ls[0], ctx)}</p>${ls.slice(1).map(l => `<p>${inline(l, ctx)}</p>`).join('')}</li>`;
      });
      out.push(`<ol class="flow k-${b.flow.kind}">${steps.join('')}</ol>`);
    } else throw new Error('bloc inconnu : ' + JSON.stringify(Object.keys(b)));
  }
  return out.join('\n');
}
function renderFiche(f, ctx, id, level) {
  const label = f.bannerLabel || (CATC[f.cat].label + '  ·  FICHE ' + f.code);
  return `<article class="fiche" id="${id}" aria-labelledby="${id}-t">
<header class="banner cat-${f.cat}"><p class="banner-label">${esc(label)}</p><h${level} class="banner-title" id="${id}-t">${esc(f.title)}</h${level}>${f.subtitle ? `<p class="banner-sub">${esc(f.subtitle)}</p>` : ''}</header>
<div class="fiche-body">
${renderBlocks(f.blocks, ctx)}
</div>
</article>`;
}

/* Navigation latérale */
function renderNav(current) {
  const part = (p) => {
    const items = (p.id === 'index' ? indexPages : pages.filter(x => x.part === p)).map(pg => {
      const lbl = pg.code.startsWith('Index') ? pg.label : pg.code === 'C5' ? pg.label.split(',')[0] : pg.label;
      const cur = current && current.file === pg.file ? ' aria-current="page"' : '';
      const code = pg.code.startsWith('Index') ? '' : `<span class="code">${esc(pg.code)}</span> `;
      return `<li><a href="${relHref(current ? current.file : 'index.html', pg.file)}"${cur}>${code}${esc(lbl)}</a></li>`;
    }).join('');
    const open = !current || current === HOME || (current.part === p) ? ' open' : '';
    return `<details class="menu-part cat-${p.cat}" data-part="${p.id}"${open}><summary>${esc(p.name)}</summary><ul class="menu-list">${items}</ul></details>`;
  };
  const home = current === HOME ? ' aria-current="page"' : '';
  return `<nav id="menu" class="sidebar" aria-label="Menu principal">
<a class="menu-home" href="${relHref(current.file, 'index.html')}"${home}>Accueil</a>
${PARTS.map(part).join('\n')}
</nav>`;
}

const SITE = 'Fiches de révision CAPPEI';
let ACTIVE_API = API_URL;                 // adresse utilisée par le build en cours (build({ apiUrl }) peut la remplacer : tests)
function pageShell({ page, title, body, legend, head }) {
  const apiUrl = ACTIVE_API;
  const up = path.posix.dirname(page.file) === '.' ? '' : '../';
  const idx = sequence.indexOf(page);
  const prev = page === HOME ? null : (idx > 0 ? sequence[idx - 1] : HOME), next = page === HOME ? sequence[0] : sequence[idx + 1];
  const pg = (p, cls, dir) => p ? `<a class="${cls}" href="${relHref(page.file, p.file)}" rel="${cls}"><span class="dir">${dir}</span>${p === HOME ? 'Accueil' : (p.code.startsWith('Index') ? '' : esc(p.code) + ' ') + esc(p.label)}</a>` : '';
  const pager = page === HOME ? '' : `<nav class="pager" aria-label="Fiche précédente et suivante">${pg(prev, 'prev', page === sequence[0] ? '← Précédent' : '← Fiche précédente')}${pg(next, 'next', 'Fiche suivante →')}</nav>`;
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="Fiches de révision CAPPEI : classeur général évolutif, état au 14 novembre 2026.">
<link rel="icon" href="data:,">
<script>document.documentElement.className+=' js'</script>
<link rel="stylesheet" href="${up}assets/style.css">
${apiUrl ? `<script src="${up}assets/config.js" defer></script>\n` : ''}<script src="${up}assets/site.js" defer></script>
${apiUrl ? `<script src="${up}assets/suivi.js" defer></script>\n` : ''}</head>
<body>
<a class="skip" href="#contenu">Aller au contenu</a>
<header class="site-header">
<a class="brand" href="${up}index.html">${SITE}</a>
<button type="button" class="burger" id="menu-toggle" aria-expanded="false" aria-controls="menu"><span class="burger-icon" aria-hidden="true"></span><span>Menu</span></button>
</header>
<div class="layout">
${renderNav(page)}
<div class="scrim" id="menu-scrim" aria-hidden="true"></div>
<main id="contenu" tabindex="-1">
${body}
${pager}
${legend ? `<section class="legende" aria-label="Légende des sources"><p>${esc(legend)}</p></section>` : ''}
</main>
</div>
<footer class="site-footer"><p>${SITE} — classeur général évolutif, état au 14 novembre 2026.</p></footer>
</body>
</html>
`;
}

function renderPage(page) {
  const ctx = { file: page.file };
  const isIndex = page.part.id === 'index';
  const multi = page.fiches.length > 1;
  const ids = page.fiches.map((f, i) => `${page.slug}-${i + 1}`);
  const volLabel = (f, i) => { const m = String(f.code).match(/(\d+\/\d+)/); return (m ? m[1] + ' — ' : '') + f.title; };
  const nav = multi ? `<ul class="volets" aria-label="Fiches de cette page">${page.fiches.map((f, i) => `<li><a href="#${ids[i]}">${esc(volLabel(f, i))}</a></li>`).join('')}</ul>` : '';
  const h1 = isIndex ? esc(page.label) : `<span class="h1-code">${esc(page.code)}</span> ${esc(page.label)}`;
  const head = `<div class="page-head cat-${page.part.cat}"><p class="crumb">${esc(page.part.name)}</p><h1>${h1}</h1>${nav}</div>`;
  const duo = page.fiches.length % 2 === 0;
  const body = `${head}
<div class="fiches${duo ? ' duo' : ''}">
${page.fiches.map((f, i) => renderFiche(f, ctx, ids[i], 2)).join('\n')}
</div>`;
  return pageShell({ page, title: `${isIndex ? '' : page.code + ' '}${page.label} — ${SITE}`, body, legend: page.legend });
}

function renderHome() {
  const ctx = { file: HOME.file, boldLinks: {
    '1. Rapports de jury': pages.find(p => p.part.id === 'jury').file,
    '2. Cadre réglementaire et institutionnel': pages.find(p => p.part.id === 'cadre').file,
    '3. Notions': pages.find(p => p.part.id === 'notions').file,
    '4. Publics et disciplines': pages.find(p => p.part.id === 'publics').file,
    'Index': indexPages[0].file, 'Auteurs': indexPages[0].file, 'Sigles': indexPages[1].file,
  } };
  const body = `<div class="fiches accueil">
${renderFiche(cover1, ctx, 'accueil-1', 1)}
${renderFiche(cover2, ctx, 'accueil-2', 2)}
</div>`;
  return pageShell({ page: HOME, title: `Accueil — ${SITE}`, body, legend: null });
}

/* ------------------------------------------------------------------ CSS généré (couleurs) */
function colorCss() {
  const css = ['/* Couleurs générées par build_site.js depuis kit.js (CAT, RUB), assombries si nécessaire pour le contraste AA. */', `:root { --tag: #${TAG_GREY}; }`];
  for (const [k, v] of Object.entries(CATC)) css.push(`.cat-${k} { --c: #${v.color}; --t: #${v.tint}; }`);
  for (const [k, v] of Object.entries(RUBC)) css.push(`.k-${k} { --c: #${v.color}; --t: #${v.tint}; }`);
  css.push('.legend tbody tr:nth-child(1) th { --c: #' + RUBC.attente.color + '; } .legend tbody tr:nth-child(2) th { --c: #' + RUBC.plus.color + '; } .legend tbody tr:nth-child(3) th { --c: #' + RUBC.vigi.color + '; } .legend tbody tr:nth-child(4) th { --c: #' + RUBC.conseil.color + '; } .legend tbody tr:nth-child(5) th { --c: #' + RUBC.memo.color + '; } .legend tbody tr:nth-child(6) th { --c: #' + RUBC.alerte.color + '; } .legend tbody tr:nth-child(7) th { --c: #' + RUBC.epm.color + '; }');
  return css.join('\n') + '\n\n';
}

/* ------------------------------------------------------------------ Écriture */
function build(opts) {
  opts = opts || {};
  const out = opts.out ? path.resolve(opts.out) : OUT;
  ACTIVE_API = opts.apiUrl !== undefined ? opts.apiUrl : API_URL;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'fiches'), { recursive: true });
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  const active = !!ACTIVE_API;
  // Suivi inactif (apiUrl vide) : style.css et site.js sont identiques octet pour octet à ceux d'avant la fonctionnalité ; seul config.js s'ajoute (non référencé par les pages).
  fs.writeFileSync(path.join(out, 'assets', 'style.css'), colorCss() + fs.readFileSync(path.join(ROOT, 'src', 'style.css'), 'utf8') + (active ? '\n' + fs.readFileSync(path.join(ROOT, 'src', 'suivi.css'), 'utf8') : ''));
  fs.writeFileSync(path.join(out, 'assets', 'site.js'), fs.readFileSync(path.join(ROOT, 'src', 'site.js'), 'utf8'));
  fs.writeFileSync(path.join(out, 'assets', 'config.js'), configJs(ACTIVE_API));
  if (active) fs.writeFileSync(path.join(out, 'assets', 'suivi.js'), fs.readFileSync(path.join(ROOT, 'src', 'suivi.js'), 'utf8'));
  fs.writeFileSync(path.join(out, HOME.file), renderHome());
  for (const p of sequence) fs.writeFileSync(path.join(out, p.file), renderPage(p));
  return { pages: sequence.length + 1, refs: REFLOG.length, out, active };
}
/* Les 36 codes de pages de fiches (J, C, N, P), dans l'ordre du site : copiés dans config.js pour valider l'import côté navigateur. */
const CODES = pages.map(p => p.code);
const configJs = api => '/* Généré par build_site.js (config.json / API_URL). Adresse vide = suivi « fiche révisée » inactif. */\nwindow.CAPPEI_API = ' + JSON.stringify(api) + ';\nwindow.CAPPEI_CODES = ' + JSON.stringify(CODES) + ';\n';

module.exports = { CODES, API_URL, anonymise: t => anonymise(t), anonymiseWith, loadAnonymisationList, cover1, cover2, pages, indexPages, sequence, REFLOG, REF_UNKNOWN, COLOR_CHANGES, CATC, build };

if (require.main === module) {
  const r = build();
  console.log(`Site généré dans ${OUT} : ${r.pages} pages, ${r.refs} renvois transformés en liens, ${REF_UNKNOWN.length} candidats sans page. Suivi « fiche révisée » : ${r.active ? 'ACTIF (' + ACTIVE_API + ')' : 'inactif (apiUrl vide)'}.`);
  if (COLOR_CHANGES.length) console.log('Couleurs assombries (contraste AA) :\n  ' + COLOR_CHANGES.join('\n  '));
  fs.writeFileSync(path.join(ROOT, 'renvois.log.json'), JSON.stringify({ liens: REFLOG, sansPage: REF_UNKNOWN }, null, 1));
}
