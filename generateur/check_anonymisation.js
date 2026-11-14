#!/usr/bin/env node
/* Vérifie qu'aucun prénom d'élève de denylist.txt (un prénom par ligne) n'apparaît dans docs/.
   Vérifie aussi que docs/ ne contient que le site (html/css/js + .nojekyll) : jamais txt/, repliques_md/, scripts/, cnh.txt, notes_n.md, .docx.
   denylist.txt absent : signalé, sans échec. Code de sortie 1 si un mot est trouvé. */
'use strict';
const fs = require('fs');
const path = require('path');
const DOCS = path.join(__dirname, 'docs');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
let bad = 0;
if (!fs.existsSync(DOCS)) { console.log('docs/ absent : lancer node build_site.js'); process.exit(1); }
const files = walk(DOCS);

const interdits = files.filter(f => !/\.(html|css|js)$/.test(f) && path.basename(f) !== '.nojekyll'
  || /(^|[\\/])(txt|repliques_md|scripts)[\\/]/.test(path.relative(DOCS, f)) || /^(cnh\.txt|notes_n\.md)$/.test(path.basename(f)));
interdits.forEach(f => { bad++; console.log('FICHIER INTERDIT dans docs/ : ' + path.relative(DOCS, f)); });

const deny = path.join(__dirname, 'denylist.txt');
if (!fs.existsSync(deny)) {
  console.log('denylist.txt absent : aucun prénom d\'élève à rechercher (créer le fichier, un prénom par ligne, pour activer ce contrôle).');
} else {
  const mots = fs.readFileSync(deny, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const mot of mots) {
    const re = new RegExp('(?<![\\p{L}\\p{N}_])' + esc(mot) + '(?![\\p{L}\\p{N}_])', 'iu');
    for (const f of files.filter(f => /\.(html|css|js)$/.test(f))) {
      const m = fs.readFileSync(f, 'utf8').match(re);
      if (m) { bad++; console.log(`PRÉNOM TROUVÉ : « ${mot} » dans ${path.relative(DOCS, f)}`); }
    }
  }
  console.log(`denylist.txt : ${mots.length} mot(s) recherché(s) dans ${files.length} fichiers.`);
}
console.log(bad ? `ÉCHEC : ${bad} problème(s)` : 'OK : aucun fichier interdit, aucun prénom de la liste noire.');
process.exit(bad ? 1 : 0);
