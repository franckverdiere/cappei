/* Fiches de révision CAPPEI : service « fiches révisées » (Cloudflare Worker + Workers KV).
   À coller tel quel dans l'éditeur du Worker (tableau de bord Cloudflare). Aucune dépendance.
   Liaison KV attendue : REVISIONS (nom exact). Une seule clé y est utilisée : « revisees ».
   Variable optionnelle : ALLOWED_ORIGIN (une ou plusieurs origines séparées par des virgules ; remplace l'origine par défaut).

   Choix de stockage : la valeur ne contient QUE les codes à true, par ex. {"J1":true,"N4":true}.
   Raisons : valeur courte (moins d'octets écrits), un seul état possible par fiche (absent = non révisée),
   et rien à nettoyer si une liste de codes change. Les routes renvoient et acceptent toujours des booléens
   explicites ; c'est le client (export) qui complète les 36 codes avec false.

   Limites de la formule gratuite de KV : 1 000 écritures par jour et 1 écriture par seconde sur une même clé.
   Le Worker n'écrit donc jamais si la valeur ne change pas. Remarque : KV est « à cohérence éventuelle » :
   une lecture faite depuis un autre site du réseau Cloudflare peut montrer l'ancienne valeur pendant environ une minute. */

/* Les 36 pages de fiches (même liste que le site : voir test_worker.mjs, qui compare les deux). */
export const CODES = [
  'J1', 'J2', 'J3', 'J4', 'J5', 'J6',
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7',
  'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N11', 'N12', 'N13', 'N14', 'N15', 'N16',
  'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7',
];

const DEFAULT_ORIGIN = 'https://franckverdiere.github.io';
const KEY = 'revisees';
const MAX_BODY = 4096; // octets

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function allowedOrigins(env) {
  const raw = env && typeof env.ALLOWED_ORIGIN === 'string' && env.ALLOWED_ORIGIN.trim() ? env.ALLOWED_ORIGIN : DEFAULT_ORIGIN;
  return raw.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

function baseHeaders(request, env) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, PUT, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const reply = (request, env, status, data, extra) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { ...baseHeaders(request, env), ...(extra || {}) } });
const erreur = (request, env, status, code, message, extra) => reply(request, env, status, { erreur: code, message }, extra);

/* Lecture du corps avec plafond (ne lit jamais plus de MAX_BODY octets + 1). */
async function readBody(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) return { tooBig: true };
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { try { await reader.cancel(); } catch (e) { /* ignoré */ } return { tooBig: true }; }
    chunks.push(value);
  }
  const all = new Uint8Array(total); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return { text: new TextDecoder('utf-8').decode(all) };
}

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
const canon = etat => JSON.stringify(CODES.filter(c => etat[c] === true).map(c => c));
const serial = etat => JSON.stringify(Object.fromEntries(CODES.filter(c => etat[c] === true).map(c => [c, true])));

/* Écrit seulement si l'état change. Renvoie true si une écriture a eu lieu. */
async function ecrire(env, ancien, nouveau) {
  if (canon(ancien) === canon(nouveau)) return false;
  await env.REVISIONS.put(KEY, serial(nouveau));
  return true;
}

async function parseJson(request, env) {
  const b = await readBody(request);
  if (b.tooBig) return { rep: erreur(request, env, 413, 'corps_trop_gros', 'Corps de la requête trop gros (maximum ' + MAX_BODY + ' octets).') };
  let data; try { data = JSON.parse(b.text); } catch (e) { return { rep: erreur(request, env, 400, 'json_invalide', 'Le corps de la requête n\'est pas un JSON valide.') }; }
  if (!isObj(data)) return { rep: erreur(request, env, 400, 'json_invalide', 'Le corps doit être un objet JSON.') };
  return { data };
}

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
      if (!isList && !m) return erreur(request, env, 404, 'route_inconnue', 'Route inconnue.');

      if (method === 'OPTIONS') return reply(request, env, 204, null, { 'Content-Type': 'text/plain' });
      if (method !== 'GET' && method !== 'PUT') return erreur(request, env, 405, 'methode_non_autorisee', 'Méthode non autorisée.', { Allow: 'GET, PUT, OPTIONS' });
      if (m && method !== 'PUT') return erreur(request, env, 405, 'methode_non_autorisee', 'Utiliser PUT sur cette route.', { Allow: 'PUT, OPTIONS' });
      if (method === 'PUT' && !ok) return erreur(request, env, 403, 'origine_refusee', 'Origine non autorisée.');

      if (isList && method === 'GET') return reply(request, env, 200, { revisees: await lire(env) });

      if (isList && method === 'PUT') { // import : remplace tout
        const p = await parseJson(request, env); if (p.rep) return p.rep;
        const keys = Object.keys(p.data);
        if (keys.length !== 1 || keys[0] !== 'revisees' || !isObj(p.data.revisees)) return erreur(request, env, 400, 'corps_invalide', 'Attendu : {"revisees": {"J1": true, ...}}.');
        const nouveau = {};
        for (const [c, v] of Object.entries(p.data.revisees)) {
          if (!CODES.includes(c)) return erreur(request, env, 400, 'code_inconnu', 'Code de fiche inconnu : ' + c.slice(0, 20) + '.');
          if (typeof v !== 'boolean') return erreur(request, env, 400, 'valeur_invalide', 'La valeur de ' + c + ' doit être true ou false.');
          if (v) nouveau[c] = true;
        }
        const ancien = await lire(env);
        const modifie = await ecrire(env, ancien, nouveau);
        return reply(request, env, 200, { revisees: JSON.parse(serial(nouveau)), modifie });
      }

      // PUT /api/revisions/<CODE>
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
    } catch (e) {
      return erreur(request, env, 503, 'stockage_indisponible', 'Le stockage est momentanément indisponible.');
    }
  },
};
