/* Annotations des fiches : surlignages (3 couleurs), commentaires, notes de fiche ; page « Mes annotations ».
   JavaScript sans dépendance, chargé seulement si une adresse de service est configurée (assets/config.js).
   Les annotations vivent UNIQUEMENT sur le service : rien n'est gardé dans ce navigateur.
   Le texte des fiches n'est jamais modifié : les surlignages sont des éléments <mark> posés par-dessus après le chargement,
   retrouvés par le passage lui-même (texte exact, quelques caractères avant et après, volet et paragraphe d'origine).
   Les textes saisis sont toujours affichés comme du texte (textContent), jamais comme du HTML. */
(function () {
  'use strict';
  var API = (window.CAPPEI_API || '').replace(/\/+$/, '');
  var CODES = window.CAPPEI_CODES || [];
  if (!API || !CODES.length || typeof window.fetch !== 'function') { return; }
  var LIM = { parFiche: 300, texte: 1000, contexte: 64, commentaire: 2000, note: 4000 };   // mêmes limites que le service
  var COULEURS = ['', 'Jaune', 'Vert', 'Rose'];
  var TIMEOUT_MS = 10000;
  var BLOCS = 'p, li, h2, h3';
  var MSG_RESEAU = 'Impossible d’enregistrer : le service est injoignable.';
  var MSG_INDISPO = 'Annotations indisponibles : impossible de joindre le service.';

  var menu = document.getElementById('menu');
  var main = document.getElementById('contenu');
  if (!menu || !main) { return; }
  var courante = menu.querySelector('a[aria-current="page"] .code');
  var codePage = courante && CODES.indexOf(courante.textContent.trim()) !== -1 ? courante.textContent.trim() : null;
  var zoneListe = document.getElementById('annot-liste');

  /* ---------- utilitaires ---------- */
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) { Object.keys(attrs).forEach(function (k) {
      if (k === 'text') { n.textContent = attrs[k]; } else if (k === 'class') { n.className = attrs[k]; } else { n.setAttribute(k, attrs[k]); }
    }); }
    (children || []).forEach(function (c) { if (c) { n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } });
    return n;
  }
  function plural(n, un, plusieurs) { return n + ' ' + (n > 1 ? plusieurs : un); }
  function maintenant() { return new Date().toISOString(); }
  function nouvelId() {
    var a = new Uint8Array(12), s = '', alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
    window.crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) { s += alpha.charAt(a[i] % 36); }
    return s;
  }
  function dateCourte(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) { return ''; }
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
  }
  function resume(txt, n) { txt = String(txt).replace(/\s+/g, ' ').trim(); return txt.length > n ? txt.slice(0, n - 1) + '…' : txt; }

  /* ---------- appels au service (aucune mise en mémoire locale) ---------- */
  function appel(method, chemin, corps) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: method, cache: 'no-store', credentials: 'omit', headers: {} };
    if (corps !== undefined) { init.body = JSON.stringify(corps); init.headers['Content-Type'] = 'application/json'; }
    if (ctl) { init.signal = ctl.signal; }
    return fetch(API + chemin, init).then(function (r) {
      if (timer) { clearTimeout(timer); }
      return r.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = null; }
        if (!r.ok) { var err = new Error(d && typeof d.message === 'string' ? d.message : 'HTTP ' + r.status); err.status = r.status; throw err; }
        if (!d || typeof d !== 'object') { throw new Error('Réponse inattendue du service.'); }
        return d;
      });
    }, function () { if (timer) { clearTimeout(timer); } var err = new Error(MSG_RESEAU); err.reseau = true; throw err; });
  }
  function texteErreur(e) {
    if (!e || e.reseau || !e.status) { return MSG_RESEAU; }
    if (e.status === 409) { return e.message; }
    if (e.status === 400 || e.status === 413) { return 'Refusé par le service : ' + e.message; }
    return 'Impossible d’enregistrer : le service est momentanément indisponible. Réessayez.';
  }
  function listeValide(d) {
    if (!d || !Array.isArray(d.annotations)) { throw new Error('Réponse inattendue du service.'); }
    return d.annotations.filter(function (a) { return a && typeof a === 'object' && typeof a.id === 'string' && (a.type === 'passage' || a.type === 'note') && typeof a.texte === 'string'; });
  }

  if (codePage) { fiche(); } else if (zoneListe) { pageListe(); }

  /* ======================================================================== Page d'une fiche */
  function fiche() {
    var items = [], rev = 0;
    var chargement = true, indispo = false, occupe = false, derniereLecture = 0;
    var ancres = {};            // id -> { bloc, debut, fin }
    var orphelines = [];
    var selCourante = null;     // dernière sélection valide (gardée un instant si un toucher l'efface)
    var premierRendu = true;

    /* ---------- éléments ajoutés à la page ---------- */
    var msg = el('span', { class: 'annot-msg', role: 'status', 'aria-live': 'polite' });
    var retry = el('button', { type: 'button', class: 'annot-btn annot-btn-petit', text: 'Réessayer' }); retry.hidden = true;
    var resumeEl = el('p', { class: 'annot-resume' });
    var orphBox = el('div', { class: 'annot-orphelines', role: 'region', 'aria-label': 'Annotations à rattacher' }); orphBox.hidden = true;
    var tete = el('div', { class: 'annot-tete' }, [
      resumeEl, el('p', {}, [msg, ' ', retry]), orphBox,
    ]);
    var suiviHaut = main.querySelector('.page-head .suivi-fiche');
    var h1 = main.querySelector('.page-head h1');
    if (suiviHaut) { suiviHaut.parentNode.insertBefore(tete, suiviHaut.nextSibling); }
    else if (h1) { h1.parentNode.insertBefore(tete, h1.nextSibling); } else { main.insertBefore(tete, main.firstChild); }

    var notesListe = el('ul', { class: 'annot-notes-liste' });
    var notesVide = el('p', { class: 'annot-vide', text: 'Aucune note pour l’instant.' });
    var bAjoutNote = el('button', { type: 'button', class: 'annot-btn', text: 'Ajouter une note' });
    var notesSec = el('section', { id: 'annot-notes', class: 'annot-notes', 'aria-labelledby': 'annot-notes-t' }, [
      el('h2', { id: 'annot-notes-t', text: 'Mes notes sur cette fiche' }), notesListe, notesVide, el('p', { class: 'annot-actions' }, [bAjoutNote]),
    ]);
    var avantNotes = main.querySelector('.suivi-fiche-bas') || main.querySelector('.pager') || main.querySelector('.legende');
    if (avantNotes) { avantNotes.parentNode.insertBefore(notesSec, avantNotes); } else { main.appendChild(notesSec); }
    var impression = el('section', { class: 'annot-impression', 'aria-hidden': 'true' });
    main.appendChild(impression);   // imprimée après les fiches et leur légende des sources

    /* barre d'annotation (bas de l'écran) */
    var barre = el('div', { class: 'annot-barre', role: 'toolbar', 'aria-label': 'Annoter la sélection' }); barre.hidden = true;
    document.body.appendChild(barre);
    /* info-bulle (survol) */
    var bulleInfo = el('div', { class: 'annot-infobulle', role: 'tooltip', id: 'annot-infobulle' }); bulleInfo.hidden = true;
    document.body.appendChild(bulleInfo);
    /* dialogue */
    var dlg = el('dialog', { class: 'annot-dialogue', 'aria-labelledby': 'annot-dlg-t' });
    document.body.appendChild(dlg);
    var dlgOuvert = false;

    function message(txt, erreur, duree) {
      msg.textContent = txt; msg.classList.toggle('annot-erreur', !!erreur);
      if (duree) { var t0 = txt; setTimeout(function () { if (msg.textContent === t0) { msg.textContent = ''; } }, duree); }
    }

    /* ---------- texte des blocs (paragraphe, puce, case de tableau, titre) ---------- */
    function articles() { return Array.prototype.slice.call(main.querySelectorAll('.fiches > article.fiche')); }
    function estUI(n, stop) { for (var e = n.parentNode; e && e !== stop; e = e.parentNode) { if (e.nodeType === 1 && e.hasAttribute('data-annot-ui')) { return true; } } return false; }
    function textes(bloc) {
      var out = [], w = document.createTreeWalker(bloc, NodeFilter.SHOW_TEXT, null), n;
      while ((n = w.nextNode())) { if (!estUI(n, bloc)) { out.push(n); } }
      return out;
    }
    function texteDe(bloc) { return textes(bloc).map(function (n) { return n.nodeValue; }).join(''); }
    function blocsDe(art) { return Array.prototype.filter.call(art.querySelectorAll(BLOCS), function (e) { return !e.querySelector(BLOCS); }); }
    function blocDe(node) {
      var e = node && (node.nodeType === 1 ? node : node.parentNode);
      var b = e && e.closest ? e.closest(BLOCS) : null;
      if (!b || b.querySelector(BLOCS) || !b.closest('.fiches > article.fiche') || estUI(b, main)) { return null; }
      return b;
    }
    function offsetDans(bloc, conteneur, decalage) {
      var n = 0, noeuds = textes(bloc);
      for (var i = 0; i < noeuds.length; i++) {
        var t = noeuds[i];
        if (t === conteneur) { return n + Math.min(decalage, t.nodeValue.length); }
        var r = document.createRange(); r.selectNodeContents(t);
        if (r.comparePoint(conteneur, decalage) < 0) { return n; }
        n += t.nodeValue.length;
      }
      return n;
    }
    function indexer() {
      return articles().map(function (art) { return { art: art, blocs: blocsDe(art).map(function (b) { return { el: b, t: texteDe(b) }; }) }; });
    }
    /* Retrouve un passage : meilleure occurrence du texte exact, selon le contexte, puis le volet et le paragraphe d'origine. */
    function ancrer(a, idx) {
      var meilleur = null;
      idx.forEach(function (x) {
        var memeVolet = x.art.id === a.volet;
        x.blocs.forEach(function (b, ib) {
          var t = b.t, i = t.indexOf(a.texte);
          while (i !== -1) {
            var n = 0, av = a.avant, ap = a.apres, j = i + a.texte.length, m = 0;
            while (n < av.length && i - 1 - n >= 0 && t.charAt(i - 1 - n) === av.charAt(av.length - 1 - n)) { n++; }
            while (m < ap.length && j + m < t.length && t.charAt(j + m) === ap.charAt(m)) { m++; }
            var s = (n + m) / 8 + (memeVolet ? 2 : 0) + (memeVolet && ib === a.bloc ? 3 : 0) + (memeVolet && ib === a.bloc && i === a.debut ? 1 : 0);
            if (!meilleur || s > meilleur.s) { meilleur = { s: s, bloc: b.el, debut: i, fin: j, ia: idx.indexOf(x), ib: ib }; }
            i = t.indexOf(a.texte, i + 1);
          }
        });
      });
      return meilleur;
    }
    function envelopper(bloc, debut, fin, a) {
      var noeuds = textes(bloc), pos = 0, marks = [];
      noeuds.forEach(function (n) {
        var L = n.nodeValue.length, s = Math.max(debut, pos), e = Math.min(fin, pos + L);
        if (s < e) {
          var t = n;
          if (s > pos) { t = t.splitText(s - pos); }
          if (e < pos + L) { t.splitText(e - s); }
          var m = document.createElement('mark');
          m.className = 'annot annot-c' + a.couleur; m.setAttribute('data-annot', a.id);
          t.parentNode.insertBefore(m, t); m.appendChild(t); marks.push(m);
        }
        pos += L;
      });
      return marks;
    }
    function nettoyer() {
      var parents = [];
      Array.prototype.forEach.call(main.querySelectorAll('.fiches .annot-bulle'), function (b) { b.parentNode.removeChild(b); });
      Array.prototype.forEach.call(main.querySelectorAll('.fiches .annot-colle'), function (c) { var p = c.parentNode; while (c.firstChild) { p.insertBefore(c.firstChild, c); } p.removeChild(c); });
      Array.prototype.forEach.call(main.querySelectorAll('.fiches mark.annot'), function (m) {
        var p = m.parentNode; while (m.firstChild) { p.insertBefore(m.firstChild, m); } p.removeChild(m);
        if (parents.indexOf(p) === -1) { parents.push(p); }
      });
      parents.forEach(function (p) { if (p.isConnected) { p.normalize(); } });
    }

    /* ---------- rendu ---------- */
    function trouver(id) { for (var i = 0; i < items.length; i++) { if (items[i].id === id) { return items[i]; } } return null; }
    function rendre() {
      cacherInfo();
      nettoyer();
      ancres = {}; orphelines = [];
      var idx = indexer(), places = [];
      items.forEach(function (a) {
        if (a.type !== 'passage') { return; }
        var r = ancrer(a, idx);
        if (r) { places.push({ a: a, r: r }); } else { orphelines.push(a); }
      });
      places.sort(function (x, y) { return x.r.ia - y.r.ia || x.r.ib - y.r.ib || x.r.debut - y.r.debut; });
      var num = 0, commentes = [];
      places.forEach(function (p) {
        var a = p.a, marks = envelopper(p.r.bloc, p.r.debut, p.r.fin, a);
        if (!marks.length) { orphelines.push(a); return; }
        ancres[a.id] = { bloc: p.r.bloc, debut: p.r.debut, fin: p.r.fin };
        marks[0].id = 'annot-' + a.id; marks[0].tabIndex = 0;
        if (!a.commentaire) { marks.forEach(function (m) { m.title = 'Surlignage ' + COULEURS[a.couleur].toLowerCase() + ' (cliquer pour modifier)'; }); }
        if (a.commentaire) {
          num++; commentes.push({ a: a, num: num });
          var b = el('button', { type: 'button', class: 'annot-bulle', 'data-annot-ui': '', 'data-annot': a.id, 'aria-label': 'Commentaire ' + num + ' : ' + resume(a.commentaire, 160) }, [el('span', { class: 'annot-num', 'aria-hidden': 'true', text: String(num) })]);
          marks.forEach(function (x) { x.classList.add('annot-commente'); });
          var last = marks[marks.length - 1], lien = last.closest('a');
          if (lien && p.r.bloc.contains(lien)) { lien.parentNode.insertBefore(b, lien.nextSibling); }
          else {
            // La bulle reste collée au dernier mot du passage (pas de retour à la ligne entre les deux).
            var cible = last, tn = last.lastChild;
            if (tn && tn.nodeType === 3) {
              var k = tn.nodeValue.search(/\S+\s*$/);
              if (k > 0) { var m2 = last.cloneNode(false); m2.removeAttribute('id'); m2.removeAttribute('tabindex'); m2.classList.add('annot-suite'); last.classList.add('annot-coupe'); last.parentNode.insertBefore(m2, last.nextSibling); m2.appendChild(tn.splitText(k)); cible = m2; }
            }
            var colle = el('span', { class: 'annot-colle' });
            cible.parentNode.insertBefore(colle, cible); colle.appendChild(cible); colle.appendChild(b);
          }
        }
      });
      majTete(places.length, commentes.length);
      majNotes();
      majImpression(commentes);
      if (premierRendu) { premierRendu = false; allerAuLien(); }
    }
    function majTete(nPass, nCom) {
      var notes = items.filter(function (a) { return a.type === 'note'; }).length;
      resumeEl.textContent = '';
      if (chargement) { resumeEl.textContent = 'Chargement des annotations…'; }
      else if (indispo) { resumeEl.textContent = ''; }
      else if (!nPass && !notes && !orphelines.length) { resumeEl.textContent = 'Aucune annotation sur cette fiche pour l’instant.'; }
      else {
        var parts = [];
        if (nPass) { parts.push(plural(nPass, 'surlignage', 'surlignages') + (nCom ? ' (dont ' + nCom + ' commenté' + (nCom > 1 ? 's' : '') + ')' : '')); }
        if (notes) { parts.push(plural(notes, 'note', 'notes')); }
        if (orphelines.length) { parts.push(plural(orphelines.length, 'annotation à rattacher', 'annotations à rattacher')); }
        resumeEl.appendChild(document.createTextNode('Sur cette fiche : ' + parts.join(', ') + '. '));
        if (notes) { resumeEl.appendChild(el('a', { href: '#annot-notes', text: 'Voir les notes' })); }
      }
      orphBox.textContent = '';
      orphBox.hidden = !orphelines.length;
      if (orphelines.length) {
        orphBox.appendChild(el('p', { class: 'annot-orphelines-t', text: 'Annotations à rattacher (' + orphelines.length + ')' }));
        orphBox.appendChild(el('p', { text: 'Le passage n’a pas été retrouvé dans la version actuelle de la fiche (elle a peut-être été modifiée). Vous pouvez transformer l’annotation en note de la fiche, ou la supprimer.' }));
        var ul = el('ul');
        orphelines.forEach(function (a) {
          var bNote = el('button', { type: 'button', class: 'annot-btn annot-btn-petit', text: 'Transformer en note' });
          var bSuppr = el('button', { type: 'button', class: 'annot-btn annot-btn-petit', text: 'Supprimer' });
          bNote.disabled = bSuppr.disabled = occupe;
          bNote.addEventListener('click', function () { transformerEnNote(a); });
          bSuppr.addEventListener('click', function () { ouvrirPassage(a.id); });
          ul.appendChild(el('li', { id: 'annot-' + a.id }, [
            el('p', { class: 'annot-citation annot-c' + a.couleur, text: '« ' + a.texte + ' »' }),
            a.commentaire ? el('p', { class: 'annot-texte', text: a.commentaire }) : null,
            el('p', { class: 'annot-actions' }, [bNote, bSuppr]),
          ]));
        });
        orphBox.appendChild(ul);
      }
    }
    function majNotes() {
      var notes = items.filter(function (a) { return a.type === 'note'; });
      notesListe.textContent = '';
      notes.forEach(function (n) {
        var b = el('button', { type: 'button', class: 'annot-btn annot-btn-petit', text: 'Modifier' });
        b.disabled = occupe || chargement || indispo;
        b.addEventListener('click', function () { ouvrirNote(n.id); });
        notesListe.appendChild(el('li', { id: 'annot-' + n.id }, [
          el('p', { class: 'annot-texte', text: n.texte }),
          el('p', { class: 'annot-date', text: (n.modifie !== n.cree ? 'Modifiée le ' : 'Écrite le ') + dateCourte(n.modifie) }),
          el('p', { class: 'annot-actions' }, [b]),
        ]));
      });
      notesVide.hidden = !!notes.length || chargement || indispo;
      bAjoutNote.disabled = occupe || chargement || indispo;
    }
    function majImpression(commentes) {
      var notes = items.filter(function (a) { return a.type === 'note'; });
      impression.textContent = '';
      if (!commentes.length && !notes.length && !orphelines.length) { return; }
      impression.appendChild(el('h2', { text: 'Mes annotations — ' + codePage }));
      if (commentes.length) {
        impression.appendChild(el('h3', { text: 'Commentaires' }));
        var ol = el('ol');
        commentes.forEach(function (c) { ol.appendChild(el('li', { value: String(c.num) }, [el('span', { class: 'annot-citation annot-c' + c.a.couleur, text: '« ' + resume(c.a.texte, 200) + ' »' }), ' — ', el('span', { class: 'annot-texte', text: c.a.commentaire })])); });
        impression.appendChild(ol);
      }
      if (notes.length) {
        impression.appendChild(el('h3', { text: 'Notes sur la fiche' }));
        var ul = el('ul'); notes.forEach(function (n) { ul.appendChild(el('li', { class: 'annot-texte', text: n.texte })); }); impression.appendChild(ul);
      }
      if (orphelines.length) {
        impression.appendChild(el('h3', { text: 'Annotations à rattacher (passage introuvable)' }));
        var ul2 = el('ul'); orphelines.forEach(function (a) { ul2.appendChild(el('li', {}, [el('span', { class: 'annot-citation annot-c' + a.couleur, text: '« ' + resume(a.texte, 200) + ' »' }), a.commentaire ? ' — ' + a.commentaire : ''])); }); impression.appendChild(ul2);
      }
    }
    function allerAuLien() {
      var m = /^#annot-([a-z0-9]{8,24})$/.exec(location.hash || '');
      if (!m) { return; }
      var cible = document.getElementById('annot-' + m[1]);
      if (!cible) { message('Cette annotation n’existe plus.', false, 6000); return; }
      cible.scrollIntoView({ block: 'center' });
      var marks = main.querySelectorAll('mark.annot[data-annot="' + m[1] + '"]');
      var flash = marks.length ? Array.prototype.slice.call(marks) : [cible];
      flash.forEach(function (x) { x.classList.add('annot-flash'); });
      setTimeout(function () { flash.forEach(function (x) { x.classList.remove('annot-flash'); }); }, 3500);
    }

    /* ---------- écriture ---------- */
    function rafraichirEtat() { majNotes(); majBarre(); if (!orphBox.hidden) { Array.prototype.forEach.call(orphBox.querySelectorAll('button'), function (b) { b.disabled = occupe; }); } }
    function appliquer(d) { items = listeValide(d); rev = typeof d.rev === 'number' ? d.rev : rev; derniereLecture = Date.now(); }
    function enregistrer(a) {
      occupe = true; message('Enregistrement…'); rafraichirEtat();
      return appel('PUT', '/api/annotations/' + encodeURIComponent(codePage) + '/' + a.id, { rev: rev, annotation: a }).then(function (d) {
        appliquer(d); occupe = false; rendre(); message('Enregistré', false, 4000); rafraichirEtat();
      }, function (e) { occupe = false; message(texteErreur(e), true); rafraichirEtat(); throw e; });
    }
    function supprimer(id) {
      occupe = true; message('Suppression…'); rafraichirEtat();
      return appel('DELETE', '/api/annotations/' + encodeURIComponent(codePage) + '/' + id + '?rev=' + rev).then(function (d) {
        appliquer(d); occupe = false; rendre(); message('Supprimé', false, 4000); rafraichirEtat();
      }, function (e) { occupe = false; message(texteErreur(e), true); rafraichirEtat(); throw e; });
    }
    function transformerEnNote(a) {
      if (occupe) { return; }
      var t = '« ' + a.texte + ' »' + (a.commentaire ? '\n' + a.commentaire : '');
      var n = { id: nouvelId(), type: 'note', texte: t.slice(0, LIM.note), cree: maintenant(), modifie: maintenant() };
      enregistrer(n).then(function () { return supprimer(a.id); }).catch(function () { /* message déjà affiché */ });
    }

    /* ---------- sélection et barre ---------- */
    function lireSelection() {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed || !String(sel).trim()) { return null; }
      var r = sel.getRangeAt(0);
      var dansFiche = function (n) { var e = n && (n.nodeType === 1 ? n : n.parentNode); return !!(e && e.closest && e.closest('.fiches > article.fiche')); };
      if (!dansFiche(r.startContainer) && !dansFiche(r.endContainer)) { return null; }
      var b1 = blocDe(r.startContainer), b2 = blocDe(r.endContainer);
      var multi = { erreur: 'Sélectionnez un passage à l’intérieur d’un seul paragraphe, d’une seule puce ou d’une seule case de tableau.' };
      var vide = function (a, ao, b, bo) { var x = document.createRange(); try { x.setStart(a, ao); x.setEnd(b, bo); } catch (e) { return false; } return !String(x).trim(); };
      var debut = null, fin = null;
      if (b1 && b2 !== b1 && vide(b1, b1.childNodes.length, r.endContainer, r.endOffset)) { b2 = b1; fin = -1; }          // triple clic : la fin tombe au début du bloc suivant
      else if (b2 && b1 !== b2 && vide(r.startContainer, r.startOffset, b2, 0)) { b1 = b2; debut = 0; }                    // sélection commencée juste avant le bloc
      if (!b1 || b1 !== b2) { return multi; }
      var t = texteDe(b1);
      if (debut === null) { debut = offsetDans(b1, r.startContainer, r.startOffset); }
      fin = fin === -1 ? t.length : offsetDans(b1, r.endContainer, r.endOffset);
      while (debut < fin && /\s/.test(t.charAt(debut))) { debut++; }
      while (fin > debut && /\s/.test(t.charAt(fin - 1))) { fin--; }
      if (fin <= debut) { return null; }
      if (fin - debut > LIM.texte) { return { erreur: 'Passage trop long : ' + LIM.texte + ' caractères au plus.' }; }
      var chev = Object.keys(ancres).some(function (id) { var x = ancres[id]; return x.bloc === b1 && x.debut < fin && debut < x.fin; });
      if (chev) { return { erreur: 'Ce passage touche un surlignage existant : touchez le surlignage pour le modifier.' }; }
      return { bloc: b1, debut: debut, fin: fin, t: t, texte: t.slice(debut, fin) };
    }
    var etatBarre = null;     // null | 'sel' | 'err'
    function majBarre() {
      if (etatBarre !== 'sel') { return; }
      Array.prototype.forEach.call(barre.querySelectorAll('button[data-action]'), function (b) { b.disabled = occupe; });
    }
    function montrerBarre(s) {
      barre.textContent = '';
      if (s.erreur) {
        etatBarre = 'err';
        barre.appendChild(el('span', { class: 'annot-barre-err', text: s.erreur }));
      } else {
        etatBarre = 'sel';
        barre.appendChild(el('span', { class: 'annot-barre-t', text: 'Surligner :' }));
        [1, 2, 3].forEach(function (c) {
          barre.appendChild(el('button', { type: 'button', class: 'annot-btn annot-btn-petit', 'data-action': 'c' + c, 'aria-label': 'Surligner en ' + COULEURS[c].toLowerCase() }, [el('span', { class: 'annot-pastille annot-c' + c, 'aria-hidden': 'true' }), COULEURS[c]]));
        });
        barre.appendChild(el('button', { type: 'button', class: 'annot-btn annot-btn-petit', 'data-action': 'commenter', text: 'Commenter…' }));
      }
      barre.appendChild(el('button', { type: 'button', class: 'annot-btn annot-btn-petit', 'data-action-fermer': '', 'aria-label': 'Fermer la barre', text: '✕' }));
      barre.hidden = false; majBarre(); placerBarre();
    }
    /* La barre est en haut de l'écran (sous le bandeau du site) : en bas, la fenêtre système d'Android ouverte pendant
       une sélection la recouvrirait. Si le passage sélectionné est sous la barre, elle se place juste en dessous de lui
       (en laissant la place du menu Copier / Partager du navigateur). */
    function placerBarre() {
      barre.style.top = '';
      if (barre.hidden) { return; }
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) { return; }
      var r = sel.getRangeAt(0).getBoundingClientRect(), b = barre.getBoundingClientRect();
      if (r.height && r.top < b.bottom + 8 && r.bottom > b.top - 8) {
        barre.style.top = Math.round(Math.max(b.top, Math.min(r.bottom + 64, window.innerHeight * 0.5))) + 'px';
      }
    }
    function cacherBarre() { barre.hidden = true; etatBarre = null; selCourante = null; }
    var timerSel = null, timerCache = null;
    function examinerSelection() {
      if (dlgOuvert || chargement || indispo) { return; }
      var s = lireSelection();
      if (s) {
        if (timerCache) { clearTimeout(timerCache); timerCache = null; }
        selCourante = s.erreur ? null : s; montrerBarre(s);
      } else if (!barre.hidden && !timerCache) {
        // Sélection effacée : on garde la barre un instant (un toucher sur un bouton peut effacer la sélection juste avant le clic).
        timerCache = setTimeout(function () { timerCache = null; if (!lireSelection() && !dlgOuvert) { cacherBarre(); } }, 600);
      }
    }
    document.addEventListener('selectionchange', function () { if (timerSel) { clearTimeout(timerSel); } timerSel = setTimeout(examinerSelection, 150); });
    // Ne pas perdre la sélection en appuyant sur un bouton de la barre (souris) ; au toucher, la sélection gardée sert.
    barre.addEventListener('mousedown', function (e) { if (e.target.closest('button')) { e.preventDefault(); } });
    barre.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || b.disabled) { return; }
      if (b.hasAttribute('data-action-fermer')) { viderSelection(); cacherBarre(); return; }
      var act = b.getAttribute('data-action'), s = selCourante;
      if (!s || !s.bloc.isConnected) { cacherBarre(); return; }
      if (act === 'commenter') { ouvrirNouveau(s); return; }
      var c = Number(act.slice(1));
      var a = nouveauPassage(s, c, '');
      enregistrer(a).then(function () { viderSelection(); cacherBarre(); }, function () { /* message affiché en tête ; la barre reste */ });
    });
    function viderSelection() { var sel = window.getSelection(); if (sel && sel.removeAllRanges) { sel.removeAllRanges(); } }
    function nouveauPassage(s, couleur, commentaire) {
      var art = s.bloc.closest('article.fiche'), d = maintenant();
      return { id: nouvelId(), type: 'passage', volet: art.id, bloc: blocsDe(art).indexOf(s.bloc), debut: s.debut, texte: s.texte,
        avant: s.t.slice(Math.max(0, s.debut - LIM.contexte), s.debut), apres: s.t.slice(s.fin, s.fin + LIM.contexte),
        couleur: couleur, commentaire: commentaire, cree: d, modifie: d };
    }

    /* ---------- dialogue (commentaire, couleur, suppression ; note) ---------- */
    var retourFocus = null;
    function fermerDialogue() {
      if (dlg.open) { if (dlg.close) { dlg.close(); } else { dlg.removeAttribute('open'); } }
      dlgOuvert = false;
      if (retourFocus && retourFocus.isConnected) { try { retourFocus.focus(); } catch (e) { /* ignoré */ } }
      retourFocus = null;
    }
    dlg.addEventListener('cancel', function (e) { if (occupe) { e.preventDefault(); return; } dlgOuvert = false; });
    dlg.addEventListener('close', function () { dlgOuvert = false; });
    var tactile = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
    function ouvrirDialogue(contenu, focusEl) {
      cacherInfo(); barre.hidden = true;
      var dejaOuvert = dlg.open;
      if (!dejaOuvert) { retourFocus = document.activeElement; }
      dlg.textContent = ''; dlg.appendChild(contenu);
      dlgOuvert = true;
      if (!dejaOuvert) { if (dlg.showModal) { dlg.showModal(); } else { dlg.setAttribute('open', ''); } }
      if (focusEl) { focusEl.focus(); }
    }
    function champTexte(id, label, valeur, max) {
      var ta = el('textarea', { id: id, maxlength: String(max), rows: '5' }); ta.value = valeur || '';
      var cpt = el('p', { class: 'annot-compteur', 'aria-live': 'off' });
      var maj = function () { cpt.textContent = ta.value.length + ' / ' + max + ' caractères'; };
      ta.addEventListener('input', maj); maj();
      return { ta: ta, noeuds: [el('label', { class: 'annot-champ', for: id, text: label }), ta, cpt] };
    }
    function choixCouleur(courante) {
      var fs = el('fieldset', { class: 'annot-couleurs' }, [el('legend', { text: 'Couleur' })]);
      [1, 2, 3].forEach(function (c) {
        var r = el('input', { type: 'radio', name: 'annot-couleur', value: String(c), id: 'annot-couleur-' + c });
        r.checked = c === courante;
        fs.appendChild(el('label', { for: 'annot-couleur-' + c }, [r, el('span', { class: 'annot-pastille annot-c' + c, 'aria-hidden': 'true' }), COULEURS[c]]));
      });
      return fs;
    }
    function couleurChoisie(form, defaut) { var r = form.querySelector('input[name="annot-couleur"]:checked'); return r ? Number(r.value) : defaut; }
    function zoneMessage() { return el('p', { class: 'annot-msg', role: 'status', 'aria-live': 'polite' }); }
    function confirmation(texte, onOui, onNon) {
      var oui = el('button', { type: 'button', class: 'annot-btn annot-btn-danger', text: 'Supprimer' });
      var non = el('button', { type: 'button', class: 'annot-btn', text: 'Annuler' });
      var box = el('div', { class: 'annot-confirm', role: 'group', 'aria-label': texte }, [el('p', { text: texte }), el('p', { class: 'annot-actions' }, [oui, non])]);
      box.hidden = true;
      oui.addEventListener('click', onOui); non.addEventListener('click', onNon);
      return { box: box, oui: oui, non: non };
    }
    function boutons(liste) { return el('p', { class: 'annot-actions' }, liste); }
    function dialogueEchec(m, e, liste) { m.textContent = texteErreur(e); m.classList.add('annot-erreur'); liste.forEach(function (b) { b.disabled = false; }); }

    /* nouveau passage commenté (depuis la barre) */
    function ouvrirNouveau(s) {
      var form = el('form', { method: 'dialog' });
      var champ = champTexte('annot-com', 'Commentaire', '', LIM.commentaire);
      var ok = el('button', { type: 'submit', class: 'annot-btn', text: 'Enregistrer' });
      var annuler = el('button', { type: 'button', class: 'annot-btn', text: 'Annuler' });
      var m = zoneMessage();
      [el('h2', { id: 'annot-dlg-t', text: 'Commenter le passage' }), el('blockquote', { class: 'annot-citation annot-c1', text: s.texte }), choixCouleur(1)]
        .concat(champ.noeuds, [m, boutons([ok, annuler])]).forEach(function (n) { form.appendChild(n); });
      form.addEventListener('change', function () { form.querySelector('blockquote').className = 'annot-citation annot-c' + couleurChoisie(form, 1); });
      annuler.addEventListener('click', function () { fermerDialogue(); });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (occupe) { return; }
        if (!s.bloc.isConnected) { fermerDialogue(); cacherBarre(); return; }
        ok.disabled = annuler.disabled = true; m.textContent = 'Enregistrement…'; m.classList.remove('annot-erreur');
        enregistrer(nouveauPassage(s, couleurChoisie(form, 1), champ.ta.value)).then(function () { fermerDialogue(); viderSelection(); cacherBarre(); }, function (err) { dialogueEchec(m, err, [ok, annuler]); });
      });
      barre.hidden = true;
      viderSelection();   // ferme aussi la fenêtre système de sélection d'Android, qui recouvrirait le dialogue (la sélection est gardée dans « s »)
      ouvrirDialogue(form, champ.ta);
    }

    /* passage existant : d'abord en LECTURE (passage, couleur, commentaire) ; modifier ou supprimer sur action volontaire */
    function ouvrirPassage(id, info) {
      var a = trouver(id); if (!a || chargement || indispo) { return; }
      var orphe = !ancres[a.id];
      var vue = el('div', { class: 'annot-vue' });
      var bModif = el('button', { type: 'button', class: 'annot-btn', text: a.commentaire ? 'Modifier' : 'Commenter ou changer la couleur' });
      var bSuppr = el('button', { type: 'button', class: 'annot-btn', text: 'Supprimer' });
      var bFermer = el('button', { type: 'button', class: 'annot-btn', text: 'Fermer' });
      var lst = [bModif, bSuppr, bFermer];
      var m = zoneMessage();
      if (info) { m.textContent = info; }
      var conf = confirmation(a.commentaire ? 'Supprimer ce surlignage et son commentaire ?' : 'Supprimer ce surlignage ?', function () {
        conf.oui.disabled = conf.non.disabled = true; m.textContent = 'Suppression…'; m.classList.remove('annot-erreur');
        supprimer(a.id).then(function () { fermerDialogue(); }, function (err) { dialogueEchec(m, err, [conf.oui, conf.non]); });
      }, function () { conf.box.hidden = true; lst.forEach(function (b) { b.disabled = false; }); bSuppr.focus(); });
      [el('h2', { id: 'annot-dlg-t', text: orphe ? 'Annotation à rattacher' : 'Passage surligné' }),
       el('blockquote', { class: 'annot-citation annot-c' + a.couleur, text: a.texte }),
       el('p', { class: 'annot-lecture-couleur' }, [el('span', { class: 'annot-pastille annot-c' + a.couleur, 'aria-hidden': 'true' }), 'Couleur : ' + COULEURS[a.couleur].toLowerCase()]),
       el('p', { class: 'annot-champ', text: 'Commentaire' }),
       a.commentaire ? el('p', { class: 'annot-lecture' }, [a.commentaire]) : el('p', { class: 'annot-vide', text: 'Aucun commentaire.' }),
       m, boutons(lst), conf.box].forEach(function (n) { vue.appendChild(n); });
      bFermer.addEventListener('click', function () { fermerDialogue(); });
      bModif.addEventListener('click', function () { editerPassage(a.id); });
      bSuppr.addEventListener('click', function () { conf.box.hidden = false; lst.forEach(function (b) { b.disabled = true; }); conf.non.focus(); });
      ouvrirDialogue(vue, bFermer);
    }
    function editerPassage(id) {
      var a = trouver(id); if (!a) { fermerDialogue(); return; }
      var form = el('form', { method: 'dialog' });
      var champ = champTexte('annot-com', 'Commentaire', a.commentaire, LIM.commentaire);
      var ok = el('button', { type: 'submit', class: 'annot-btn', text: 'Enregistrer' });
      var annuler = el('button', { type: 'button', class: 'annot-btn', text: 'Annuler' });
      var m = zoneMessage();
      var couleurs = choixCouleur(a.couleur);
      [el('h2', { id: 'annot-dlg-t', text: 'Modifier le passage surligné' }), el('blockquote', { class: 'annot-citation annot-c' + a.couleur, text: a.texte }), couleurs]
        .concat(champ.noeuds, [m, boutons([ok, annuler])]).forEach(function (n) { form.appendChild(n); });
      form.addEventListener('change', function () { form.querySelector('blockquote').className = 'annot-citation annot-c' + couleurChoisie(form, a.couleur); });
      annuler.addEventListener('click', function () { ouvrirPassage(a.id); });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (occupe) { return; }
        var c = couleurChoisie(form, a.couleur), com = champ.ta.value;
        if (c === a.couleur && com === a.commentaire) { ouvrirPassage(a.id); return; }
        var b = {}; Object.keys(a).forEach(function (k) { b[k] = a[k]; }); b.couleur = c; b.commentaire = com; b.modifie = maintenant();
        ok.disabled = annuler.disabled = true; m.textContent = 'Enregistrement…'; m.classList.remove('annot-erreur');
        enregistrer(b).then(function () { ouvrirPassage(a.id, 'Enregistré'); }, function (err) { dialogueEchec(m, err, [ok, annuler]); });
      });
      // Au toucher, on ne place pas le curseur dans le commentaire (le clavier masquerait le dialogue) : on peut vouloir seulement changer la couleur.
      ouvrirDialogue(form, tactile ? couleurs.querySelector('input:checked') : champ.ta);
    }

    /* note de fiche : ajout, modification, suppression */
    function ouvrirNote(id) {
      var n = id ? trouver(id) : null;
      if ((id && !n) || chargement || indispo) { return; }
      var form = el('form', { method: 'dialog' });
      var champ = champTexte('annot-note', 'Texte de la note', n ? n.texte : '', LIM.note);
      var ok = el('button', { type: 'submit', class: 'annot-btn', text: 'Enregistrer' });
      var annuler = el('button', { type: 'button', class: 'annot-btn', text: 'Annuler' });
      var suppr = n ? el('button', { type: 'button', class: 'annot-btn', text: 'Supprimer la note' }) : null;
      var m = zoneMessage();
      var lst = [ok].concat(suppr ? [suppr] : [], [annuler]);
      var conf = confirmation('Supprimer cette note ?', function () {
        conf.oui.disabled = conf.non.disabled = true; m.textContent = 'Suppression…'; m.classList.remove('annot-erreur');
        supprimer(n.id).then(function () { fermerDialogue(); }, function (err) { dialogueEchec(m, err, [conf.oui, conf.non]); });
      }, function () { conf.box.hidden = true; lst.forEach(function (b) { b.disabled = false; }); suppr.focus(); });
      [el('h2', { id: 'annot-dlg-t', text: (n ? 'Modifier la note' : 'Nouvelle note') + ' — ' + codePage })].concat(champ.noeuds, [m, boutons(lst), conf.box]).forEach(function (x) { form.appendChild(x); });
      annuler.addEventListener('click', function () { fermerDialogue(); });
      if (suppr) { suppr.addEventListener('click', function () { conf.box.hidden = false; lst.forEach(function (b) { b.disabled = true; }); conf.non.focus(); }); }
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (occupe) { return; }
        var t = champ.ta.value;
        if (!t.trim()) { m.textContent = 'La note est vide.'; m.classList.add('annot-erreur'); return; }
        if (n && t === n.texte) { fermerDialogue(); return; }
        var d = maintenant();
        var note = n ? { id: n.id, type: 'note', texte: t, cree: n.cree, modifie: d } : { id: nouvelId(), type: 'note', texte: t, cree: d, modifie: d };
        lst.forEach(function (b) { b.disabled = true; }); m.textContent = 'Enregistrement…'; m.classList.remove('annot-erreur');
        enregistrer(note).then(function () { fermerDialogue(); }, function (err) { dialogueEchec(m, err, lst); });
      });
      ouvrirDialogue(form, champ.ta);
    }
    bAjoutNote.addEventListener('click', function () { ouvrirNote(null); });

    /* ---------- clics et clavier sur les surlignages ---------- */
    main.addEventListener('click', function (e) {
      var b = e.target.closest('.annot-bulle');
      if (b) { e.preventDefault(); ouvrirPassage(b.getAttribute('data-annot')); return; }
      var m = e.target.closest('mark.annot');
      if (!m || e.target.closest('a')) { return; }
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).trim()) { return; }   // fin d'une sélection, pas un clic
      ouvrirPassage(m.getAttribute('data-annot'));
    });
    main.addEventListener('keydown', function (e) {
      var m = e.target.closest && e.target.closest('mark.annot');
      if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ouvrirPassage(m.getAttribute('data-annot')); }
    });

    /* ---------- info-bulle au survol (souris seulement) ---------- */
    function montrerInfo(cible) {
      var a = trouver(cible.getAttribute('data-annot'));
      if (!a || !a.commentaire || dlgOuvert) { return; }
      bulleInfo.textContent = a.commentaire;
      bulleInfo.hidden = false;
      var r = cible.getBoundingClientRect(), w = bulleInfo.offsetWidth, h = bulleInfo.offsetHeight;
      var x = Math.min(Math.max(8, r.left + window.scrollX), window.scrollX + document.documentElement.clientWidth - w - 8);
      var y = r.bottom + window.scrollY + 6;
      if (r.bottom + h + 12 > window.innerHeight && r.top - h - 6 > 0) { y = r.top + window.scrollY - h - 6; }
      bulleInfo.style.left = x + 'px'; bulleInfo.style.top = y + 'px';
    }
    function cacherInfo() { bulleInfo.hidden = true; }
    main.addEventListener('pointerover', function (e) {
      if (e.pointerType !== 'mouse') { return; }
      var c = e.target.closest('.annot-bulle, mark.annot'); if (c) { montrerInfo(c); }
    });
    main.addEventListener('pointerout', function (e) {
      var c = e.target.closest('.annot-bulle, mark.annot');
      if (c && !(e.relatedTarget && c.contains(e.relatedTarget))) { cacherInfo(); }
    });
    main.addEventListener('focusin', function (e) { var c = e.target.closest && e.target.closest('.annot-bulle'); if (c) { montrerInfo(c); } });
    main.addEventListener('focusout', function () { cacherInfo(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { cacherInfo(); if (!dlgOuvert && !barre.hidden) { cacherBarre(); } } });
    window.addEventListener('scroll', function () { cacherInfo(); if (!barre.hidden) { placerBarre(); } }, { passive: true });

    /* ---------- chargement initial et rafraîchissement ---------- */
    function charger() {
      chargement = true; indispo = false; retry.hidden = true; message(''); majTete(0, 0); majNotes();
      appel('GET', '/api/annotations/' + encodeURIComponent(codePage)).then(function (d) {
        appliquer(d); chargement = false; rendre(); majNotes();
      }, function () {
        items = []; chargement = false; indispo = true; retry.hidden = false;
        message(MSG_INDISPO, true); majTete(0, 0); majNotes();
      });
    }
    retry.addEventListener('click', charger);
    /* Autre appareil : on relit en revenant sur l'onglet (au plus toutes les 30 s ; jamais pendant une écriture, un dialogue ou une sélection). */
    function rafraichir() {
      if (occupe || chargement || indispo || dlgOuvert || Date.now() - derniereLecture < 30000) { return; }
      var sel = window.getSelection(); if (sel && !sel.isCollapsed) { return; }
      appel('GET', '/api/annotations/' + encodeURIComponent(codePage)).then(function (d) {
        if (occupe || dlgOuvert) { return; }
        var avant = JSON.stringify(items); appliquer(d);
        if (JSON.stringify(items) !== avant) { rendre(); }
      }, function () { /* silencieux : l'affichage reste celui du dernier succès */ });
    }
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { rafraichir(); } });
    window.addEventListener('pageshow', function (e) { if (e.persisted) { derniereLecture = 0; rafraichir(); } });
    window.addEventListener('hashchange', allerAuLien);

    charger();
  }

  /* ======================================================================== Page « Mes annotations » */
  function pageListe() {
    var liens = {}, parties = [];
    Array.prototype.forEach.call(menu.querySelectorAll('details.menu-part'), function (d) {
      var codes = [];
      Array.prototype.forEach.call(d.querySelectorAll('.menu-list a'), function (a) {
        var c = a.querySelector('.code'); if (c && CODES.indexOf(c.textContent.trim()) !== -1) { liens[c.textContent.trim()] = a; codes.push(c.textContent.trim()); }
      });
      if (codes.length) { parties.push({ nom: (d.querySelector('summary').textContent || '').replace(/^\s*\d+\s+/, '').trim(), cat: (d.className.match(/cat-[a-z]+/) || [''])[0], codes: codes }); }
    });
    function libelle(c) { var a = liens[c]; if (!a) { return c; } var cl = a.cloneNode(true); Array.prototype.forEach.call(cl.querySelectorAll('.suivi-ok'), function (x) { x.parentNode.removeChild(x); }); return cl.textContent.replace(/\s+/g, ' ').trim(); }

    var statut = el('p', { class: 'annot-msg', role: 'status', 'aria-live': 'polite' });
    var retry = el('button', { type: 'button', class: 'annot-btn annot-btn-petit', text: 'Réessayer' }); retry.hidden = true;
    var resumeEl = el('p', { class: 'annot-resume-liste' });
    var filtres = el('fieldset', { class: 'annot-filtres' }, [el('legend', { text: 'Afficher' })]);
    var cases = {};
    [['c1', 'Jaune'], ['c2', 'Vert'], ['c3', 'Rose'], ['notes', 'Notes de fiche'], ['commentes', 'Seulement les passages commentés']].forEach(function (f) {
      var i = el('input', { type: 'checkbox', id: 'annot-f-' + f[0] }); i.checked = f[0] !== 'commentes';
      cases[f[0]] = i;
      filtres.appendChild(el('label', { for: 'annot-f-' + f[0] }, [i, /^c\d$/.test(f[0]) ? el('span', { class: 'annot-pastille annot-' + f[0], 'aria-hidden': 'true' }) : null, f[1]]));
    });
    filtres.hidden = true;
    var contenu = el('div', { class: 'annot-contenu' });
    zoneListe.textContent = '';
    [el('p', {}, [statut, retry]), resumeEl, filtres, contenu].forEach(function (n) { zoneListe.appendChild(n); });
    var donnees = {};

    function afficher() {
      contenu.textContent = '';
      var nP = 0, nC = 0, nN = 0, nF = 0, vus = 0;
      CODES.forEach(function (c) { var l = donnees[c] || []; if (l.length) { nF++; } l.forEach(function (a) { if (a.type === 'note') { nN++; } else { nP++; if (a.commentaire) { nC++; } } }); });
      resumeEl.textContent = nP || nN ? plural(nP, 'surlignage', 'surlignages') + ' (dont ' + nC + ' commenté' + (nC > 1 ? 's' : '') + ') et ' + plural(nN, 'note', 'notes') + ', sur ' + plural(nF, 'fiche', 'fiches') + '.' : 'Aucune annotation pour l’instant.';
      filtres.hidden = !(nP || nN);
      parties.forEach(function (p) {
        var bloc = [];
        p.codes.forEach(function (c) {
          var l = (donnees[c] || []).filter(function (a) {
            if (a.type === 'note') { return cases.notes.checked && !cases.commentes.checked; }
            return cases['c' + a.couleur] && cases['c' + a.couleur].checked && (!cases.commentes.checked || !!a.commentaire);
          });
          if (!l.length) { return; }
          l.sort(function (x, y) {
            if (x.type !== y.type) { return x.type === 'passage' ? -1 : 1; }
            if (x.type === 'note') { return x.cree < y.cree ? -1 : 1; }
            return (x.volet < y.volet ? -1 : x.volet > y.volet ? 1 : 0) || x.bloc - y.bloc || x.debut - y.debut;
          });
          var href = liens[c] ? liens[c].getAttribute('href') : '#';
          var ul = el('ul', { class: 'annot-items' });
          l.forEach(function (a) {
            vus++;
            var lien = el('a', { class: 'annot-lien', href: href + '#annot-' + a.id, text: a.type === 'note' ? 'Voir la note dans la fiche' : 'Voir dans la fiche' });
            if (a.type === 'note') {
              ul.appendChild(el('li', {}, [el('p', { class: 'annot-type', text: 'Note sur la fiche' }), el('p', { class: 'annot-texte', text: a.texte }), lien]));
            } else {
              ul.appendChild(el('li', {}, [el('p', { class: 'annot-citation annot-c' + a.couleur }, [el('span', { class: 'sr-only', text: COULEURS[a.couleur] + ' : ' }), '« ' + a.texte + ' »']), a.commentaire ? el('p', { class: 'annot-texte', text: a.commentaire }) : null, lien]));
            }
          });
          bloc.push(el('h3', { class: 'annot-fiche-t' }, [el('a', { href: href, text: libelle(c) })]), ul);
        });
        if (bloc.length) { contenu.appendChild(el('h2', { class: 'annot-partie ' + p.cat, text: p.nom })); bloc.forEach(function (n) { contenu.appendChild(n); }); }
      });
      if ((nP || nN) && !vus) { contenu.appendChild(el('p', { class: 'annot-vide', text: 'Aucune annotation ne correspond aux cases cochées.' })); }
    }
    filtres.addEventListener('change', afficher);

    function charger() {
      retry.hidden = true; statut.textContent = 'Chargement des annotations…'; statut.classList.remove('annot-erreur');
      appel('GET', '/api/annotations').then(function (d) {
        if (!d.annotations || typeof d.annotations !== 'object') { throw new Error('Réponse inattendue du service.'); }
        donnees = {};
        CODES.forEach(function (c) { if (Array.isArray(d.annotations[c])) { donnees[c] = listeValide({ annotations: d.annotations[c] }); } });
        statut.textContent = ''; afficher();
      }, function () { statut.textContent = MSG_INDISPO; statut.classList.add('annot-erreur'); retry.hidden = false; });
    }
    retry.addEventListener('click', charger);
    charger();
  }
})();
