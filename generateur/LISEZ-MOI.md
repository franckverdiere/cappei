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

## Publication

GitHub Pages sert le dossier `/docs` de la branche `site`. Adresse : https://franckverdiere.github.io/cappei/
