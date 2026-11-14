/* Menu latéral : tiroir sur mobile, parties repliables, page courante visible. JavaScript minimal, sans dépendance. */
(function () {
  var body = document.body;
  var btn = document.getElementById('menu-toggle');
  var menu = document.getElementById('menu');
  var scrim = document.getElementById('menu-scrim');
  if (!menu) { return; }
  var KEY = 'cappei-menu-v1';

  /* Parties repliables : on mémorise l'état d'une page à l'autre (la partie de la page courante reste ouverte). */
  var parts = menu.querySelectorAll('details.menu-part');
  var saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
  Array.prototype.forEach.call(parts, function (d) {
    var id = d.getAttribute('data-part');
    if (!d.querySelector('[aria-current="page"]') && Object.prototype.hasOwnProperty.call(saved, id)) { d.open = !!saved[id]; }
    d.addEventListener('toggle', function () {
      saved[id] = d.open;
      try { sessionStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* stockage indisponible */ }
    });
  });
  var cur = menu.querySelector('[aria-current="page"]');
  if (cur && cur.scrollIntoView) { cur.scrollIntoView({ block: 'nearest' }); }

  /* Tiroir mobile */
  if (!btn) { return; }
  function setOpen(open, restoreFocus) {
    body.classList.toggle('menu-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { var first = menu.querySelector('a'); if (first) { first.focus(); } }
    else if (restoreFocus) { btn.focus(); }
  }
  btn.addEventListener('click', function () { setOpen(!body.classList.contains('menu-open'), false); });
  if (scrim) { scrim.addEventListener('click', function () { setOpen(false, true); }); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && body.classList.contains('menu-open')) { setOpen(false, true); }
  });
  var mq = window.matchMedia('(max-width: 59.99rem)');
  var onChange = function () { if (!mq.matches) { setOpen(false, false); } };
  if (mq.addEventListener) { mq.addEventListener('change', onChange); } else if (mq.addListener) { mq.addListener(onChange); }
})();
