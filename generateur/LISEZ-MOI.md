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

- `check_site.js` : liens internes et ancres, un seul h1 par page, ids uniques, texte de chaque fiche identique à la source (mot à mot), nombre de pages (39 pages d'origine + page Mode d'emploi + page Export si le suivi est actif), renvois entre fiches. Avec le suivi actif, le HTML ne doit différer de la version « suivi inactif » que par les balises de script, le lien et la phrase « Export ».
- `check_anonymisation.js` : échoue si un prénom listé dans `denylist.txt` (un par ligne, fichier à créer) apparaît dans `docs/`.

## Anonymisation des élèves

`anonymisation.json` (liste `{"prenom": …, "initiale": …}`) est vide : aucun prénom d'élève n'a été trouvé dans les fiches. Elle ne concerne que les élèves : les noms d'auteurs et d'intervenants ne sont jamais modifiés.

## Suivi « fiche révisée » (service Cloudflare)

Le site appelle un petit service hébergé chez Cloudflare (Worker + Workers KV) pour enregistrer les fiches révisées : rien n'est stocké dans le navigateur, pas de compte, pas de code.

- Adresse du service : `https://cappei-revisions.franck-verdiere.workers.dev` (renseignée dans `config.json`, champ `apiUrl` ; vide = fonction inactive : aucun script de suivi et pas de page Export).
- Code du service : `worker/worker.mjs` (copie d'archive : ce n'est PAS GitHub qui l'exécute ; il tourne sur Cloudflare, Worker `cappei-revisions`, liaison KV `REVISIONS` vers l'espace `revisions-cappei`).
- Tests : `node --test worker/test_worker.mjs` (Worker avec KV simulé) ; `e2e/run.mjs` (navigateur réel contre un serveur simulé ; demande `playwright-core` et un Chrome installés hors du dépôt).
- Mettre le Worker à jour : tableau de bord Cloudflare → Workers & Pages → `cappei-revisions` → Edit code → remplacer le code par `worker/worker.mjs` → Deploy. La liaison KV est conservée.
- Notes : `worker/DEPLOIEMENT.md` est un brouillon ; les libellés réels du tableau de bord observés le 15 novembre 2026 sont : « Create a KV namespace » (page Workers KV), « Start with Hello World! » (création du Worker), bouton « Edit code », Settings → Bindings → Add binding → KV namespace.

## Pages de l'accueil

- `index.html` (accueil) : bandeau du classeur (`cover1` sans ses blocs) avec deux liens, bloc « Suivi de la révision » (ajouté par `suivi.js`), plan du classeur (`cover2`).
- `mode-emploi.html` : les blocs de `cover1` (mode d'emploi, code couleur, règles suivies), texte inchangé.
- `export.html` (suivi actif seulement) : exporter et importer le suivi ; boutons construits par `suivi.js` dans `#suivi-export`.
- Chaque fiche porte deux cases « révisée » (en haut et en bas, avant précédent / suivant), synchronisées.
- Les adresses des styles et scripts portent `?v=<empreinte>` calculée à chaque génération (rechargement forcé des navigateurs après mise à jour).

## Publication

GitHub Pages sert le dossier `/docs` de la branche `site`. Adresse : https://franckverdiere.github.io/cappei/
