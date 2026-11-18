# Générateur du site (fiches de révision CAPPEI)

Ce dossier contient le code qui produit le dossier `docs/` (le site) à partir des sources JavaScript des fiches.
Il ne contient aucun contenu de cours ; les sources des fiches sont dans l'archive « atelier » (dossier Drive `FICHES DE REVISION/_Atelier/`).

## Régénérer le site

1. Décompresser l'archive atelier (`atelier-fiches-….zip`) dans un dossier, par exemple `/home/claude/atelier` : on obtient `…/atelier/fiches/`.
2. Placer ce dossier `generateur/` à côté, puis :

```
cd generateur
FICHES_DIR=/chemin/vers/atelier/fiches node build_site.js
FICHES_DIR=/chemin/vers/atelier/fiches node check_site.js
node check_anonymisation.js
```

(`FICHES_DIR` vaut `/home/claude/atelier/fiches` par défaut.) Le site est écrit dans `generateur/docs/` ; copier son contenu dans le dossier `docs/` du dépôt.
`kit.js` (dans l'atelier) charge le module npm `docx` : l'installer si besoin (`npm install docx`).

## Contrôles

- `check_site.js` : liens internes et ancres, un seul h1 par page, ids uniques, texte de chaque fiche identique à la source (mot à mot), nombre de pages (39), renvois entre fiches.
- `check_anonymisation.js` : échoue si un prénom listé dans `denylist.txt` (un par ligne, fichier à créer) apparaît dans `docs/`.

## Anonymisation des élèves

`anonymisation.json` (liste `{"prenom": …, "initiale": …}`) est vide : aucun prénom d'élève n'a été trouvé dans les fiches. Elle ne concerne que les élèves : les noms d'auteurs et d'intervenants ne sont jamais modifiés.

## Suivi « fiche révisée » (service Cloudflare)

Le site appelle un petit service hébergé chez Cloudflare (Worker + Workers KV) pour enregistrer les fiches révisées : rien n'est stocké dans le navigateur, pas de compte, pas de code.

- Adresse du service : `https://cappei-revisions.franck-verdiere.workers.dev` (renseignée dans `config.json`, champ `apiUrl` ; vide = fonction inactive et site identique à la version sans suivi).
- Code du service : `worker/worker.mjs` (copie d'archive : ce n'est PAS GitHub qui l'exécute ; il tourne sur Cloudflare, Worker `cappei-revisions`, liaison KV `REVISIONS` vers l'espace `revisions-cappei`).
- Tests : `node --test worker/test_worker.mjs` (Worker avec KV simulé) ; `e2e/run.mjs` (navigateur réel contre un serveur simulé ; demande `playwright-core` et un Chrome installés hors du dépôt).
- Mettre le Worker à jour : tableau de bord Cloudflare → Workers & Pages → `cappei-revisions` → Edit code → remplacer le code par `worker/worker.mjs` → Deploy. La liaison KV est conservée.
- Notes : `worker/DEPLOIEMENT.md` est un brouillon ; les libellés réels du tableau de bord observés le 15 novembre 2026 sont : « Create a KV namespace » (page Workers KV), « Start with Hello World! » (création du Worker), bouton « Edit code », Settings → Bindings → Add binding → KV namespace.

## Publication

GitHub Pages sert le dossier `/docs` de la branche `site`. Adresse : https://franckverdiere.github.io/cappei/

## Mise à jour du 18 novembre 2026

Les fiches ont changé (atelier `atelier-fiches-2026-11-18.zip`) : fiche **C0**, C6 et N15 à quatre volets, compléments repérés FC, moyen mnémotechnique de N1 déplacé en C5 · 3/3. Le générateur a été adapté :

- `build_site.js` : couvertures recopiées de `classeur.js` (état au 18 novembre, plan avec C0, « 4 fiches » pour C6 et N15, ligne sur les repères FC et FL, encadré « Dans cette version ») ; 37 codes.
- `check_site.js` : 8 pages C, 40 pages + mode d'emploi + export ; C6 et N15 à 4 volets ; `fiches/c00.html` toléré en plus de l'instantané.
- `worker/worker.mjs` et `worker/test_worker.mjs` : **`'C0'` ajouté à `CODES`** (37 codes).
- `e2e/run.mjs` : 37 codes, « Cadre … sur 8 ».

Résultat local (FICHES_DIR pointant sur les fiches du 18 novembre) : 42 pages, 513 renvois, `check_site.js` : tous les contrôles passent ; Worker : 17 tests ; bout en bout : 32 tests (passés avant le déplacement du moyen mnémotechnique).

État de la publication : le site (`docs/`) a été publié le 18 novembre 2026 au soir. **Le Worker en ligne doit recevoir la même modification** (Cloudflare → Workers & Pages → `cappei-revisions` → Edit code : ajouter `'C0', ` devant `'C1'` dans `CODES`, puis Deploy) : tant que ce n'est pas fait, cocher C0 affiche « Impossible d'enregistrer » et un import contenant C0 est refusé ; le reste du suivi fonctionne.
