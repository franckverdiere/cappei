/* Fiches de révision CAPPEI : service « fiches révisées » et « annotations » (Cloudflare Worker + Workers KV). Aucune dépendance.
   Liaison KV attendue : REVISIONS (nom exact).
   Clés utilisées : « revisees » (fiches révisées) ; « annotations:<CODE> » (surlignages, commentaires et notes d'une fiche, une clé par fiche).
   Variable optionnelle : ALLOWED_ORIGIN (une ou plusieurs origines séparées par des virgules ; remplace l'origine par défaut).

   Fiches révisées : la valeur ne contient QUE les codes à true, par ex. {"J1":true,"N4":true}.
   Annotations d'une fiche : {"rev": n, "annotations": [ ... ]}. « rev » augmente à chaque écriture ; le navigateur renvoie le « rev »
   qu'il connaît, ce qui permet de refuser une écriture faite sur une lecture périmée (KV est « à cohérence éventuelle ») au lieu
   de perdre la modification précédente.
   Deux sortes d'annotations :
     passage : {id, type:"passage", volet, bloc, debut, texte, avant, apres, couleur (1, 2 ou 3), commentaire, cree, modifie}
     note    : {id, type:"note", texte, cree, modifie}   (note sur la fiche entière)
   Tout est vérifié strictement (codes connus, clés attendues, longueurs et nombres maximaux) ; le site affiche ces textes comme du texte
   simple, jamais comme du HTML.

   Limites de la formule gratuite de KV : 1 000 écritures par jour et 1 écriture par seconde sur une même clé.
   Le Worker n'écrit jamais si la valeur ne change pas, et réessaie une écriture refusée (deux fois, à un peu plus d'une seconde). */

/* Les 37 pages de fiches (même liste que le site : voir test_worker.mjs, qui compare les deux). */
export const CODES = [
  'J1', 'J2', 'J3', 'J4', 'J5', 'J6',
  'C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7',
  'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N11', 'N12', 'N13', 'N14', 'N15', 'N16',
  'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7',
];

/* Limites des annotations (le site utilise les mêmes valeurs). */
export const LIMITES = {
  parFiche: 300,        // annotations (passages + notes) par fiche
  texte: 1000,          // caractères d'un passage surligné
  contexte: 64,         // caractères gardés avant et après le passage (pour le retrouver)
  commentaire: 2000,    // caractères d'un commentaire de passage
  note: 4000,           // caractères d'une note de fiche
};

const DEFAULT_ORIGIN = 'https://franckverdiere.github.io';
const KEY = 'revisees';
const PREFIXE = 'annotations:';
const MAX_BODY = 4096;            // fiches révisées (octets)
const MAX_BODY_ANNOT = 32768;     // une annotation
const MAX_BODY_SAUV = 524288;     // sauvegarde complète (import)
const RETRY_MS = 1100;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function allowedOrigins(env) {
  const raw = env && typeof env.ALLOWED_ORIGIN === 'string' && env.ALLOWED_ORIGIN.trim() ? env.ALLOWED_ORIGIN : DEFAULT_ORIGIN;
  return raw.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

function baseHeaders(request, env) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, PUT, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const reply = (request, env, status, data, extra) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { ...baseHeaders(request, env), ...(extra || {}) } });
const erreur = (request, env, status, code, message, extra) => reply(request, env, status, { erreur: code, message }, extra);

/* Lecture du corps avec plafond (ne lit jamais plus de max octets + 1). */
async function readBody(request, max) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return { tooBig: true };
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch (e) { /* ignoré */ } return { tooBig: true }; }
    chunks.push(value);
  }
  const all = new Uint8Array(total); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return { text: new TextDecoder('utf-8').decode(all) };
}

async function parseJson(request, env, max) {
  const b = await readBody(request, max || MAX_BODY);
  if (b.tooBig) return { rep: erreur(request, env, 413, 'corps_trop_gros', 'Corps de la requête trop gros (maximum ' + (max || MAX_BODY) + ' octets).') };
  let data; try { data = JSON.parse(b.text); } catch (e) { return { rep: erreur(request, env, 400, 'json_invalide', 'Le corps de la requête n\'est pas un JSON valide.') }; }
  if (!isObj(data)) return { rep: erreur(request, env, 400, 'json_invalide', 'Le corps doit être un objet JSON.') };
  return { data };
}

/* Écriture KV avec deux nouvelles tentatives (limite d'une écriture par seconde sur une même clé). */
async function put(env, key, value) {
  const attente = Number.isFinite(Number(env.RETRY_MS)) && env.RETRY_MS !== undefined ? Number(env.RETRY_MS) : RETRY_MS;
  for (let i = 0; ; i++) {
    try { await env.REVISIONS.put(key, value); return; }
    catch (e) { if (i >= 2) throw e; await new Promise(r => setTimeout(r, attente)); }
  }
}

/* ------------------------------------------------------------------ Fiches révisées */
/* État stocké -> objet {code: true} limité aux codes connus (une valeur illisible est traitée comme vide). */
async function lire(env) {
  const raw = await env.REVISIONS.get(KEY);
  const out = {};
  if (!raw) return out;
  let data; try { data = JSON.parse(raw); } catch (e) { return out; }
  if (!isObj(data)) return out;
  for (const c of CODES) if (data[c] === true) out[c] = true;
  return out;
}
const canon = etat => JSON.stringify(CODES.filter(c => etat[c] === true));
const serial = etat => JSON.stringify(Object.fromEntries(CODES.filter(c => etat[c] === true).map(c => [c, true])));

/* Écrit seulement si l'état change. Renvoie true si une écriture a eu lieu. */
async function ecrire(env, ancien, nouveau) {
  if (canon(ancien) === canon(nouveau)) return false;
  await put(env, KEY, serial(nouveau));
  return true;
}

/* Valide {code: booléen} ; renvoie { etat } ou { message }. */
function validerRevisees(obj) {
  if (!isObj(obj)) return { message: 'Le champ « revisees » doit être un objet {"J1": true, ...}.' };
  const etat = {};
  for (const [c, v] of Object.entries(obj)) {
    if (!CODES.includes(c)) return { code: 'code_inconnu', message: 'Code de fiche inconnu : ' + c.slice(0, 20) + '.' };
    if (typeof v !== 'boolean') return { code: 'valeur_invalide', message: 'La valeur de ' + c + ' doit être true ou false.' };
    if (v) etat[c] = true;
  }
  return { etat };
}

/* ------------------------------------------------------------------ Annotations */
const ID_RE = /^[a-z0-9]{8,24}$/;
const VOLET_RE = /^[a-z0-9-]{1,24}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CLES_PASSAGE = ['id', 'type', 'volet', 'bloc', 'debut', 'texte', 'avant', 'apres', 'couleur', 'commentaire', 'cree', 'modifie'];
const CLES_NOTE = ['id', 'type', 'texte', 'cree', 'modifie'];
const texteOk = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && !CTRL_RE.test(v);
const entierOk = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

/* Renvoie { a } (annotation normalisée, clés dans un ordre fixe) ou { message }. */
export function validerAnnotation(a) {
  if (!isObj(a)) return { message: 'Une annotation doit être un objet.' };
  const cles = a.type === 'passage' ? CLES_PASSAGE : a.type === 'note' ? CLES_NOTE : null;
  if (!cles) return { message: 'Type d\'annotation inconnu (attendu : « passage » ou « note »).' };
  const en_trop = Object.keys(a).filter(k => !cles.includes(k));
  if (en_trop.length) return { message: 'Champ inattendu : ' + en_trop[0].slice(0, 20) + '.' };
  const manque = cles.filter(k => !(k in a));
  if (manque.length) return { message: 'Champ manquant : ' + manque[0] + '.' };
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return { message: 'Identifiant d\'annotation invalide.' };
  if (typeof a.cree !== 'string' || !DATE_RE.test(a.cree) || typeof a.modifie !== 'string' || !DATE_RE.test(a.modifie)) return { message: 'Date invalide (format ISO attendu).' };
  if (a.type === 'note') {
    if (!texteOk(a.texte, 1, LIMITES.note) || !a.texte.trim()) return { message: 'Le texte d\'une note doit compter de 1 à ' + LIMITES.note + ' caractères.' };
    return { a: { id: a.id, type: 'note', texte: a.texte, cree: a.cree, modifie: a.modifie } };
  }
  if (typeof a.volet !== 'string' || !VOLET_RE.test(a.volet)) return { message: 'Volet de fiche invalide.' };
  if (!entierOk(a.bloc, 9999) || !entierOk(a.debut, 99999)) return { message: 'Position du passage invalide.' };
  if (!texteOk(a.texte, 1, LIMITES.texte) || !a.texte.trim()) return { message: 'Le passage surligné doit compter de 1 à ' + LIMITES.texte + ' caractères.' };
  if (!texteOk(a.avant, 0, LIMITES.contexte) || !texteOk(a.apres, 0, LIMITES.contexte)) return { message: 'Contexte du passage invalide.' };
  if (![1, 2, 3].includes(a.couleur)) return { message: 'Couleur invalide (1, 2 ou 3).' };
  if (!texteOk(a.commentaire, 0, LIMITES.commentaire)) return { message: 'Le commentaire doit compter au plus ' + LIMITES.commentaire + ' caractères.' };
  return { a: { id: a.id, type: 'passage', volet: a.volet, bloc: a.bloc, debut: a.debut, texte: a.texte, avant: a.avant, apres: a.apres, couleur: a.couleur, commentaire: a.commentaire, cree: a.cree, modifie: a.modifie } };
}

/* Valide une liste d'annotations (import) ; renvoie { liste } ou { message }. */
function validerListe(code, liste) {
  if (!Array.isArray(liste)) return { message: code + ' : une liste d\'annotations est attendue.' };
  if (liste.length > LIMITES.parFiche) return { message: code + ' : trop d\'annotations (maximum ' + LIMITES.parFiche + ').' };
  const out = [], ids = new Set();
  for (const a of liste) {
    const v = validerAnnotation(a);
    if (v.message) return { message: code + ' : ' + v.message };
    if (ids.has(v.a.id)) return { message: code + ' : identifiant d\'annotation en double.' };
    ids.add(v.a.id); out.push(v.a);
  }
  return { liste: out };
}

/* Lecture d'une fiche : { rev, annotations } ; une valeur illisible ou invalide est filtrée (annotations invalides écartées). */
async function lireFiche(env, code) {
  const raw = await env.REVISIONS.get(PREFIXE + code);
  const vide = { rev: 0, annotations: [] };
  if (!raw) return vide;
  let d; try { d = JSON.parse(raw); } catch (e) { return vide; }
  if (!isObj(d) || !Array.isArray(d.annotations)) return vide;
  const rev = Number.isInteger(d.rev) && d.rev >= 0 ? d.rev : 0;
  const ids = new Set(), annotations = [];
  for (const a of d.annotations) { const v = validerAnnotation(a); if (v.a && !ids.has(v.a.id)) { ids.add(v.a.id); annotations.push(v.a); } }
  return { rev, annotations: annotations.slice(0, LIMITES.parFiche) };
}
async function ecrireFiche(env, code, ancien, liste) {
  if (JSON.stringify(ancien.annotations) === JSON.stringify(liste)) return { rev: ancien.rev, annotations: ancien.annotations, modifie: false };
  const doc = { rev: ancien.rev + 1, annotations: liste };
  await put(env, PREFIXE + code, JSON.stringify(doc));
  return { ...doc, modifie: true };
}
async function lireTout(env) {
  const docs = await Promise.all(CODES.map(c => lireFiche(env, c)));
  const out = {};
  CODES.forEach((c, i) => { if (docs[i].annotations.length) out[c] = docs[i].annotations; });
  return { docs, annotations: out };
}

/* Le navigateur indique le « rev » qu'il connaît : une lecture plus ancienne est périmée (KV n'a pas encore propagé l'écriture précédente). */
function revConnu(v) {
  if (v === undefined || v === null || v === '') return { rev: null };
  const n = typeof v === 'number' ? v : (/^\d{1,9}$/.test(String(v)) ? Number(v) : NaN);
  return Number.isInteger(n) && n >= 0 ? { rev: n } : { invalide: true };
}
const perimee = (request, env) => erreur(request, env, 409, 'lecture_perimee', 'Le service n\'a pas encore pris en compte la modification précédente. Réessayez dans une minute.');

/* ------------------------------------------------------------------ Routes */
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      const origin = request.headers.get('Origin');
      const ok = origin ? allowedOrigins(env).includes(origin) : true;

      const isList = path === '/api/revisions';
      const m = path.match(/^\/api\/revisions\/([^/]+)$/);
      const isAnnTout = path === '/api/annotations';
      const mAnnFiche = path.match(/^\/api\/annotations\/([^/]+)$/);
      const mAnnUne = path.match(/^\/api\/annotations\/([^/]+)\/([^/]+)$/);
      const isSauv = path === '/api/sauvegarde';
      if (!isList && !m && !isAnnTout && !mAnnFiche && !mAnnUne && !isSauv) return erreur(request, env, 404, 'route_inconnue', 'Route inconnue.');

      if (method === 'OPTIONS') return reply(request, env, 204, null, { 'Content-Type': 'text/plain' });
      const permis = isList || isSauv ? ['GET', 'PUT'] : m ? ['PUT'] : isAnnTout || mAnnFiche ? ['GET'] : ['PUT', 'DELETE'];
      if (!permis.includes(method)) return erreur(request, env, 405, 'methode_non_autorisee', 'Méthode non autorisée sur cette route.', { Allow: permis.join(', ') + ', OPTIONS' });
      if (method !== 'GET' && !ok) return erreur(request, env, 403, 'origine_refusee', 'Origine non autorisée.');

      /* ---------- fiches révisées ---------- */
      if (isList && method === 'GET') return reply(request, env, 200, { revisees: await lire(env) });

      if (isList && method === 'PUT') { // import (ancien format) : remplace la liste des fiches révisées
        const p = await parseJson(request, env); if (p.rep) return p.rep;
        const keys = Object.keys(p.data);
        if (keys.length !== 1 || keys[0] !== 'revisees' || !isObj(p.data.revisees)) return erreur(request, env, 400, 'corps_invalide', 'Attendu : {"revisees": {"J1": true, ...}}.');
        const v = validerRevisees(p.data.revisees);
        if (!v.etat) return erreur(request, env, 400, v.code || 'corps_invalide', v.message);
        const ancien = await lire(env);
        const modifie = await ecrire(env, ancien, v.etat);
        return reply(request, env, 200, { revisees: JSON.parse(serial(v.etat)), modifie });
      }

      if (m) { // PUT /api/revisions/<CODE>
        let code; try { code = decodeURIComponent(m[1]); } catch (e) { code = ''; }
        if (!CODES.includes(code)) return erreur(request, env, 400, 'code_inconnu', 'Code de fiche inconnu.');
        const p = await parseJson(request, env); if (p.rep) return p.rep;
        const keys = Object.keys(p.data);
        if (keys.length !== 1 || keys[0] !== 'revisee' || typeof p.data.revisee !== 'boolean') return erreur(request, env, 400, 'corps_invalide', 'Attendu : {"revisee": true} ou {"revisee": false}.');
        const etat = await lire(env);
        const nouveau = { ...etat };
        if (p.data.revisee) nouveau[code] = true; else delete nouveau[code];
        const modifie = await ecrire(env, etat, nouveau);
        return reply(request, env, 200, { revisees: JSON.parse(serial(nouveau)), modifie });
      }

      /* ---------- annotations ---------- */
      if (isAnnTout) return reply(request, env, 200, { annotations: (await lireTout(env)).annotations });

      if (mAnnFiche || mAnnUne) {
        let code; try { code = decodeURIComponent((mAnnFiche || mAnnUne)[1]); } catch (e) { code = ''; }
        if (!CODES.includes(code)) return erreur(request, env, 400, 'code_inconnu', 'Code de fiche inconnu.');
        if (mAnnFiche) { const d = await lireFiche(env, code); return reply(request, env, 200, { code, rev: d.rev, annotations: d.annotations }); }

        let id; try { id = decodeURIComponent(mAnnUne[2]); } catch (e) { id = ''; }
        if (!ID_RE.test(id)) return erreur(request, env, 400, 'id_invalide', 'Identifiant d\'annotation invalide.');

        if (method === 'DELETE') {
          const rc = revConnu(url.searchParams.get('rev'));
          if (rc.invalide) return erreur(request, env, 400, 'rev_invalide', 'Paramètre « rev » invalide.');
          const d = await lireFiche(env, code);
          if (rc.rev !== null && d.rev < rc.rev) return perimee(request, env);
          const r = await ecrireFiche(env, code, d, d.annotations.filter(a => a.id !== id));
          return reply(request, env, 200, { code, rev: r.rev, annotations: r.annotations, modifie: r.modifie });
        }

        // PUT : crée ou remplace l'annotation <id>
        const p = await parseJson(request, env, MAX_BODY_ANNOT); if (p.rep) return p.rep;
        const keys = Object.keys(p.data);
        if (!keys.includes('annotation') || keys.some(k => k !== 'annotation' && k !== 'rev')) return erreur(request, env, 400, 'corps_invalide', 'Attendu : {"rev": n, "annotation": {...}}.');
        const rc = revConnu(p.data.rev);
        if (rc.invalide) return erreur(request, env, 400, 'rev_invalide', 'Champ « rev » invalide.');
        const v = validerAnnotation(p.data.annotation);
        if (v.message) return erreur(request, env, 400, 'annotation_invalide', v.message);
        if (v.a.id !== id) return erreur(request, env, 400, 'id_invalide', 'L\'identifiant de l\'adresse et celui de l\'annotation diffèrent.');
        const d = await lireFiche(env, code);
        if (rc.rev !== null && d.rev < rc.rev) return perimee(request, env);
        const i = d.annotations.findIndex(a => a.id === id);
        if (i === -1 && d.annotations.length >= LIMITES.parFiche) return erreur(request, env, 400, 'trop_d_annotations', 'Trop d\'annotations sur cette fiche (maximum ' + LIMITES.parFiche + ').');
        const liste = d.annotations.slice();
        if (i === -1) liste.push(v.a); else liste[i] = v.a;
        const r = await ecrireFiche(env, code, d, liste);
        return reply(request, env, 200, { code, rev: r.rev, annotations: r.annotations, modifie: r.modifie });
      }

      /* ---------- sauvegarde complète (export / import) ---------- */
      if (isSauv && method === 'GET') {
        const [revisees, tout] = await Promise.all([lire(env), lireTout(env)]);
        return reply(request, env, 200, { revisees, annotations: tout.annotations });
      }
      // PUT /api/sauvegarde : remplace les fiches révisées, et les annotations si le champ est présent (ancien fichier : annotations conservées).
      const p = await parseJson(request, env, MAX_BODY_SAUV); if (p.rep) return p.rep;
      const keys = Object.keys(p.data);
      if (!keys.includes('revisees') || keys.some(k => k !== 'revisees' && k !== 'annotations')) return erreur(request, env, 400, 'corps_invalide', 'Attendu : {"revisees": {...}, "annotations": {...}}.');
      const vr = validerRevisees(p.data.revisees);
      if (!vr.etat) return erreur(request, env, 400, vr.code || 'corps_invalide', vr.message);
      let nouvelles = null;
      if ('annotations' in p.data) {
        if (!isObj(p.data.annotations)) return erreur(request, env, 400, 'corps_invalide', 'Le champ « annotations » doit être un objet {"N4": [...], ...}.');
        nouvelles = {};
        for (const [c, liste] of Object.entries(p.data.annotations)) {
          if (!CODES.includes(c)) return erreur(request, env, 400, 'code_inconnu', 'Code de fiche inconnu : ' + c.slice(0, 20) + '.');
          const vl = validerListe(c, liste);
          if (vl.message) return erreur(request, env, 400, 'annotation_invalide', vl.message);
          nouvelles[c] = vl.liste;
        }
      }
      // Tout est validé : on écrit (seulement ce qui change).
      const ancien = await lire(env);
      const modifRev = await ecrire(env, ancien, vr.etat);
      let fichesModifiees = 0;
      let annotations;
      if (nouvelles) {
        const tout = await lireTout(env);
        const res = await Promise.all(CODES.map((c, i) => ecrireFiche(env, c, tout.docs[i], nouvelles[c] || [])));
        annotations = {};
        CODES.forEach((c, i) => { if (res[i].modifie) fichesModifiees++; if (res[i].annotations.length) annotations[c] = res[i].annotations; });
      } else annotations = (await lireTout(env)).annotations;
      return reply(request, env, 200, { revisees: JSON.parse(serial(vr.etat)), annotations, modifie: { revisees: modifRev, fiches: fichesModifiees } });
    } catch (e) {
      return erreur(request, env, 503, 'stockage_indisponible', 'Le stockage est momentanément indisponible.');
    }
  },
};
