/* Suivi « fiche révisée » : JavaScript sans dépendance, chargé seulement si une adresse de service est configurée (assets/config.js).
   L'état (quelles fiches sont révisées) vit UNIQUEMENT sur le service : rien n'est gardé dans ce navigateur (ni copie, ni repli).
   Si le service est injoignable, l'interface le dit et les cases restent désactivées ou reviennent à leur état précédent. */
(function () {
  'use strict';
  var API = (window.CAPPEI_API || '').replace(/\/+$/, '');
  var CODES = window.CAPPEI_CODES || [];
  if (!API || !CODES.length) { return; }
  var TOTAL = CODES.length;
  var TIMEOUT_MS = 10000;
  var MAX_FILE = 16 * 1024;
  var MSG_INDISPO = 'Suivi indisponible : impossible de joindre le service.';
  var MSG_ECHEC = 'Impossible d’enregistrer : le service est injoignable.';

  var menu = document.getElementById('menu');
  var main = document.getElementById('contenu');
  if (!menu || !main) { return; }

  /* ---------- utilitaires ---------- */
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) { Object.keys(attrs).forEach(function (k) {
      if (k === 'text') { n.textContent = attrs[k]; } else if (k === 'class') { n.className = attrs[k]; } else { n.setAttribute(k, attrs[k]); }
    }); }
    (children || []).forEach(function (c) { n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function plural(n, un, plusieurs) { return n + ' ' + (n > 1 ? plusieurs : un); }
  function isPlain(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function countTrue(etat) { var n = 0; CODES.forEach(function (c) { if (etat[c] === true) { n++; } }); return n; }
  function copy(o) { var r = {}; Object.keys(o).forEach(function (k) { r[k] = o[k]; }); return r; }

  /* ---------- appels au service (aucune mise en mémoire locale) ---------- */
  function appel(method, path, body) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: method, cache: 'no-store', credentials: 'omit', headers: {} };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    if (ctl) { init.signal = ctl.signal; }
    return fetch(API + path, init).then(function (r) {
      if (timer) { clearTimeout(timer); }
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.json();
    }, function (e) { if (timer) { clearTimeout(timer); } throw e; }).then(function (data) {
      if (!data || !isPlain(data.revisees)) { throw new Error('réponse inattendue'); }
      var etat = {};
      Object.keys(data.revisees).forEach(function (k) { if (CODES.indexOf(k) !== -1 && data.revisees[k] === true) { etat[k] = true; } });
      return etat;
    });
  }
  function lire() { return appel('GET', '/api/revisions'); }
  function ecrireFiche(code, val) { return appel('PUT', '/api/revisions/' + encodeURIComponent(code), { revisee: val }); }
  function remplacerTout(etat) {
    var obj = {}; CODES.forEach(function (c) { obj[c] = etat[c] === true; });
    return appel('PUT', '/api/revisions', { revisees: obj });
  }

  /* ---------- état en mémoire de la page (non conservé) ---------- */
  var etat = {};
  var chargement = true;       // lecture initiale en cours
  var indispo = false;         // lecture initiale échouée
  var occupe = false;          // une écriture est en cours
  var derniereLecture = 0;

  /* ---------- repères dans la page ---------- */
  var liens = {};              // code -> lien du menu
  var parties = [];            // { lettre, nom, codes: [] }
  Array.prototype.forEach.call(menu.querySelectorAll('details.menu-part'), function (d) {
    var codes = [];
    Array.prototype.forEach.call(d.querySelectorAll('.menu-list a'), function (a) {
      var c = a.querySelector('.code');
      if (c && CODES.indexOf(c.textContent.trim()) !== -1) { liens[c.textContent.trim()] = a; codes.push(c.textContent.trim()); }
    });
    if (codes.length) {
      var nom = (d.querySelector('summary').textContent || '').replace(/^\s*\d+\s+/, '').trim();
      parties.push({ lettre: codes[0].charAt(0), nom: nom, codes: codes });
    }
  });

  var courante = menu.querySelector('a[aria-current="page"] .code');
  var codePage = courante && CODES.indexOf(courante.textContent.trim()) !== -1 ? courante.textContent.trim() : null;
  var estAccueil = !!menu.querySelector('.menu-home[aria-current="page"]');
  var zoneExport = document.getElementById('suivi-export');   // page « Export » (null ailleurs)
  var estEmploi = !!menu.querySelector('.menu-extra[aria-current="page"]') && !zoneExport;

  /* ---------- zone de messages ---------- */
  var statut = el('span', { class: 'suivi-msg', role: 'status', 'aria-live': 'polite' });
  var retry = el('button', { type: 'button', class: 'suivi-btn suivi-retry', text: 'Réessayer' });
  retry.hidden = true;
  var timerMsg = null;
  function message(txt, duree) {
    if (timerMsg) { clearTimeout(timerMsg); timerMsg = null; }
    statut.textContent = txt;
    statut.classList.toggle('suivi-erreur', /^(Suivi indisponible|Impossible)/.test(txt));
    if (duree) { timerMsg = setTimeout(function () { statut.textContent = ''; statut.classList.remove('suivi-erreur'); }, duree); }
  }

  /* ---------- case à cocher de la fiche ---------- */
  var boite = null, coche = null;
  if (codePage) {
    var h1 = main.querySelector('.page-head h1');
    coche = el('input', { type: 'checkbox', id: 'suivi-revisee', class: 'suivi-case' });
    coche.disabled = true;
    boite = el('div', { class: 'suivi-fiche' }, [
      el('span', { class: 'suivi-ligne' }, [coche, el('label', { for: 'suivi-revisee', text: 'Fiche révisée' })]),
      statut, retry,
    ]);
    if (h1) { h1.parentNode.insertBefore(boite, h1.nextSibling); } else { main.insertBefore(boite, main.firstChild); }
    coche.addEventListener('change', onCoche);
  } else if (!estAccueil && !zoneExport && !estEmploi) {
    /* Pages d'index : un message discret en tête de page, vide tant que tout va bien (sur l'accueil, il est dans le bloc de suivi). */
    main.insertBefore(el('p', { class: 'suivi-avis' }, [statut, retry]), main.firstChild);
  }

  /* ---------- menu latéral : coches des fiches révisées ---------- */
  function majMenu() {
    CODES.forEach(function (c) {
      var a = liens[c]; if (!a) { return; }
      var m = a.querySelector('.suivi-ok');
      var ok = etat[c] === true && !indispo && !chargement;
      if (ok && !m) {
        a.appendChild(document.createTextNode(' '));
        a.appendChild(el('span', { class: 'suivi-ok' }, [el('span', { 'aria-hidden': 'true', text: '✓' }), el('span', { class: 'sr-only', text: ' révisée' })]));
      } else if (!ok && m) {
        if (m.previousSibling && m.previousSibling.nodeType === 3 && m.previousSibling.nodeValue === ' ') { a.removeChild(m.previousSibling); }
        a.removeChild(m);
      }
    });
  }

  /* ---------- accueil : suivi de la révision ; page Export : copie de sécurité ---------- */
  var home = null, sauv = null;
  function construireAccueil() {
    var premiere = main.querySelector('.fiches.accueil > .fiche');
    if (!premiere) { return; }
    var barre = el('div', { class: 'suivi-barre', role: 'progressbar', 'aria-label': 'Fiches révisées', 'aria-valuemin': '0', 'aria-valuemax': String(TOTAL), 'aria-valuenow': '0' }, [el('span', { class: 'suivi-barre-rempli' })]);
    var resume = el('p', { class: 'suivi-resume' });
    var detail = el('ul', { class: 'suivi-parties' });
    var prochaine = el('p', { class: 'suivi-prochaine' });
    var liste = el('details', { class: 'suivi-liste' });
    var section1 = el('section', { class: 'fiche suivi-home cat-classeur', 'aria-labelledby': 'suivi-titre' }, [
      el('h2', { id: 'suivi-titre', class: 'suivi-h', text: 'Suivi de la révision' }),
      el('div', { class: 'suivi-corps' }, [resume, el('p', { class: 'suivi-avis' }, [statut, retry]), barre, detail, prochaine, liste]),
    ]);
    premiere.parentNode.insertBefore(section1, premiere.nextSibling);
    home = { barre: barre, resume: resume, detail: detail, prochaine: prochaine, liste: liste, section1: section1 };
  }
  function construireExport() {
    var bExp = el('button', { type: 'button', class: 'suivi-btn', text: 'Exporter' });
    var bImp = el('button', { type: 'button', class: 'suivi-btn', text: 'Importer…' });
    var fichier = el('input', { type: 'file', accept: '.json,application/json', class: 'suivi-fichier', tabindex: '-1', 'aria-hidden': 'true' });
    fichier.hidden = true;
    var msgSauvEl = el('p', { class: 'suivi-msg suivi-msg-sauv', role: 'status', 'aria-live': 'polite' });
    var confirmation = el('div', { class: 'suivi-confirm', role: 'group', 'aria-labelledby': 'suivi-confirm-t' });
    confirmation.hidden = true;
    zoneExport.textContent = '';
    [el('p', { class: 'suivi-avis' }, [statut, retry]),
     el('p', { text: 'Le suivi est enregistré sur un service en ligne, pas dans ce navigateur. Exportez-le de temps en temps pour en garder une copie ; importer un fichier remplace tout le suivi actuel.' }),
     el('p', { class: 'suivi-actions' }, [bExp, bImp, fichier]), confirmation, msgSauvEl].forEach(function (n) { zoneExport.appendChild(n); });
    sauv = { bExp: bExp, bImp: bImp, fichier: fichier, msg: msgSauvEl, confirmation: confirmation };

    bExp.addEventListener('click', exporter);
    bImp.addEventListener('click', function () { if (!bImp.disabled) { fichier.value = ''; fichier.click(); } });
    fichier.addEventListener('change', function () { if (fichier.files && fichier.files[0]) { importer(fichier.files[0]); } });
  }
  function majAccueil() {
    var pret = !chargement && !indispo;
    if (sauv) { sauv.bExp.disabled = !pret || occupe; sauv.bImp.disabled = !pret || occupe; }
    if (!home) { return; }
    if (!pret) {
      home.resume.textContent = chargement ? 'Chargement du suivi…' : '';
      home.barre.hidden = true; home.detail.textContent = ''; home.prochaine.textContent = ''; home.liste.hidden = true;
      return;
    }
    var n = countTrue(etat);
    home.barre.hidden = false; home.liste.hidden = false;
    home.resume.textContent = '';
    home.resume.appendChild(el('strong', { text: plural(n, 'fiche', 'fiches') + ' sur ' + TOTAL }));
    home.resume.appendChild(document.createTextNode(n > 1 ? ' révisées' : ' révisée'));
    home.barre.setAttribute('aria-valuenow', String(n));
    home.barre.setAttribute('aria-valuetext', n + ' fiches sur ' + TOTAL + ' révisées');
    home.barre.firstChild.style.width = (100 * n / TOTAL).toFixed(1) + '%';
    home.detail.textContent = '';
    var restantes = [];
    parties.forEach(function (p) {
      var k = 0; p.codes.forEach(function (c) { if (etat[c] === true) { k++; } else { restantes.push(c); } });
      home.detail.appendChild(el('li', {}, [el('span', { class: 'suivi-part-nom', text: p.nom }), el('span', { class: 'suivi-part-n', text: k + ' sur ' + p.codes.length })]));
    });
    home.prochaine.textContent = '';
    home.liste.textContent = '';
    if (!restantes.length) {
      home.prochaine.textContent = 'Toutes les fiches sont révisées.';
      home.liste.hidden = true;
    } else {
      var lienDe = function (c) {
        var a = liens[c], lbl = c;
        if (a) { var cl = a.cloneNode(true); var m = cl.querySelector('.suivi-ok'); if (m) { cl.removeChild(m); } lbl = cl.textContent.replace(/\s+/g, ' ').trim(); }
        return el('a', { href: a ? a.getAttribute('href') : '#', text: lbl });
      };
      home.prochaine.appendChild(document.createTextNode('Prochaine fiche à réviser : '));
      home.prochaine.appendChild(lienDe(restantes[0]));
      var ul = el('ul', { class: 'suivi-restantes' });
      restantes.forEach(function (c) { ul.appendChild(el('li', {}, [lienDe(c)])); });
      home.liste.appendChild(el('summary', { text: 'Fiches non révisées (' + restantes.length + ')' }));
      home.liste.appendChild(ul);
    }
  }

  /* ---------- rendu global ---------- */
  function rendre() {
    var pret = !chargement && !indispo;
    if (coche) {
      coche.checked = pret && etat[codePage] === true;
      coche.disabled = !pret || occupe;
    }
    retry.hidden = !indispo;
    majMenu();
    majAccueil();
  }

  /* ---------- actions ---------- */
  function onCoche() {
    if (occupe || chargement || indispo) { rendre(); return; }
    var avant = copy(etat), val = coche.checked;
    if (val) { etat[codePage] = true; } else { delete etat[codePage]; }
    occupe = true; message('Enregistrement…'); rendre();
    ecrireFiche(codePage, val).then(function (serveur) {
      etat = serveur; occupe = false; message('Enregistré', 4000); rendre();
      if (coche) { coche.focus(); }
    }, function () {
      etat = avant; occupe = false; message(MSG_ECHEC); rendre();
      if (coche) { coche.focus(); }
    });
  }

  function dateLocale() { var d = new Date(); var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function msgSauv(txt, erreur) { sauv.msg.textContent = txt; sauv.msg.classList.toggle('suivi-erreur', !!erreur); }
  function bloquer(b) { occupe = b; rendre(); }

  function exporter() {
    if (occupe) { return; }
    bloquer(true); msgSauv('Export…');
    lire().then(function (serveur) {   // l'export lit l'état sur le service, pas une copie locale
      var revisees = {}; CODES.forEach(function (c) { revisees[c] = serveur[c] === true; });
      var contenu = JSON.stringify({ version: 1, exporte_le: new Date().toISOString(), revisees: revisees }, null, 2) + '\n';
      var url = URL.createObjectURL(new Blob([contenu], { type: 'application/json' }));
      var a = el('a', { href: url, download: 'revisions-cappei-' + dateLocale() + '.json' });
      a.style.display = 'none'; document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
      etat = serveur; occupe = false; rendre();
      msgSauv('Fichier exporté : ' + plural(countTrue(serveur), 'fiche révisée', 'fiches révisées') + ' sur ' + TOTAL + '.');
    }, function () { occupe = false; rendre(); msgSauv('Export impossible : le service est injoignable.', true); });
  }

  /* Validation stricte du fichier : renvoie { erreur } ou { revisees } (objet {code: true/false} pour tous les codes connus). */
  function valider(texte) {
    var d;
    try { d = JSON.parse(texte); } catch (e) { return { erreur: 'Ce fichier n’est pas un JSON valide.' }; }
    if (!isPlain(d)) { return { erreur: 'Ce fichier n’a pas le format d’une sauvegarde du suivi (objet JSON attendu).' }; }
    if (d.version !== 1) { return { erreur: 'Version de sauvegarde non reconnue (attendu : 1).' }; }
    if (!isPlain(d.revisees)) { return { erreur: 'Le champ « revisees » est absent ou n’est pas un objet.' }; }
    var out = {}, inconnus = [], mauvais = [];
    Object.keys(d.revisees).forEach(function (k) {
      if (CODES.indexOf(k) === -1) { inconnus.push(k); } else if (typeof d.revisees[k] !== 'boolean') { mauvais.push(k); } else { out[k] = d.revisees[k]; }
    });
    if (inconnus.length) { return { erreur: 'Code de fiche inconnu : ' + inconnus.slice(0, 5).map(function (x) { return x.slice(0, 20); }).join(', ') + '.' }; }
    if (mauvais.length) { return { erreur: 'La valeur de ' + mauvais.slice(0, 5).join(', ') + ' doit être true ou false.' }; }
    CODES.forEach(function (c) { if (out[c] === undefined) { out[c] = false; } });   // code absent du fichier : non révisée
    return { revisees: out };
  }

  function fermerConfirmation(focusBtn) {
    sauv.confirmation.hidden = true; sauv.confirmation.textContent = '';
    if (focusBtn) { sauv.bImp.focus(); }
  }
  function importer(fic) {
    if (occupe) { return; }
    msgSauv(''); fermerConfirmation(false);
    if (fic.size > MAX_FILE) { msgSauv('Fichier refusé : il est beaucoup trop volumineux pour une sauvegarde du suivi.', true); return; }
    var lecteur = new FileReader();
    lecteur.onerror = function () { msgSauv('Impossible de lire ce fichier.', true); };
    lecteur.onload = function () {
      var v = valider(String(lecteur.result));
      if (v.erreur) { msgSauv('Import refusé : ' + v.erreur + ' Le suivi n’a pas été modifié.', true); return; }
      bloquer(true); msgSauv('Vérification du suivi actuel…');
      lire().then(function (serveur) {
        etat = serveur; occupe = false; rendre(); msgSauv('');
        proposer(v.revisees, countTrue(serveur));
      }, function () { occupe = false; rendre(); msgSauv('Import impossible : le service est injoignable. Le suivi n’a pas été modifié.', true); });
    };
    lecteur.readAsText(fic);
  }
  function proposer(nouveau, avant) {
    var apres = countTrue(nouveau);
    var c = sauv.confirmation; c.textContent = '';
    var ok = el('button', { type: 'button', class: 'suivi-btn suivi-btn-danger', text: 'Remplacer' });
    var non = el('button', { type: 'button', class: 'suivi-btn', text: 'Annuler' });
    c.appendChild(el('p', { id: 'suivi-confirm-t', class: 'suivi-confirm-t', text: 'Remplacer le suivi actuel ? Fiches révisées : ' + avant + ' avant, ' + apres + ' après (sur ' + TOTAL + ').' }));
    c.appendChild(el('p', { class: 'suivi-actions' }, [ok, non]));
    c.hidden = false; ok.focus();
    non.addEventListener('click', function () { fermerConfirmation(true); msgSauv('Import annulé : le suivi n’a pas été modifié.'); });
    ok.addEventListener('click', function () {
      ok.disabled = true; non.disabled = true; bloquer(true); msgSauv('Import en cours…');
      remplacerTout(nouveau).then(function (serveur) {
        etat = serveur; occupe = false; fermerConfirmation(true); rendre();
        msgSauv('Import terminé : ' + plural(countTrue(serveur), 'fiche révisée', 'fiches révisées') + ' sur ' + TOTAL + '.');
      }, function () {
        occupe = false; ok.disabled = false; non.disabled = false; rendre();
        msgSauv('Import impossible : le service est injoignable. Le suivi n’a pas été modifié.', true);
      });
    });
  }

  /* ---------- chargement initial et rafraîchissement ---------- */
  function charger() {
    chargement = true; indispo = false; retry.hidden = true;
    message(codePage ? 'Chargement du suivi…' : ''); rendre();
    lire().then(function (serveur) {
      etat = serveur; chargement = false; indispo = false; derniereLecture = Date.now();
      message(''); rendre();
    }, function () {
      etat = {}; chargement = false; indispo = true;
      message(MSG_INDISPO); rendre();
    });
  }
  retry.addEventListener('click', charger);

  /* Autre appareil : on relit l'état en revenant sur l'onglet (au plus une fois toutes les 30 s, jamais pendant une écriture). */
  function rafraichir() {
    if (occupe || chargement || indispo || Date.now() - derniereLecture < 30000) { return; }
    lire().then(function (serveur) { if (!occupe) { etat = serveur; derniereLecture = Date.now(); rendre(); } }, function () { /* silencieux : l'état affiché reste celui du dernier succès */ });
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { rafraichir(); } });
  window.addEventListener('pageshow', function (e) { if (e.persisted) { derniereLecture = 0; rafraichir(); } });

  if (estAccueil) { construireAccueil(); }
  if (zoneExport) { construireExport(); }
  charger();
})();
