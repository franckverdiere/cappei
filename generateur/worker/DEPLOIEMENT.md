# Mettre en ligne le service « fiches révisées » (brouillon)

Ce guide est écrit pour quelqu'un qui n'a jamais utilisé Cloudflare. Tout se fait dans le navigateur, sur le tableau de bord Cloudflare : pas de ligne de commande, pas de jeton.

Ce que vous allez créer : un tout petit programme (le « Worker ») et un petit espace de stockage (le « KV ») où le site enregistre quelles fiches sont révisées. Le site, lui, reste sur GitHub Pages.

> Les écrans de Cloudflare changent de temps en temps. Quand je ne suis pas sûr du texte exact d'un bouton ou d'un menu, c'est écrit **(à vérifier)** : cherchez le bouton qui ressemble le plus.
> Les noms de menus sont donnés en anglais, comme dans l'interface (l'interface Cloudflare peut ne pas être en français).

Ce qui est gratuit : le compte, le Worker (100 000 requêtes par jour) et le KV (1 000 écritures par jour et 100 000 lectures par jour, d'après la documentation de Cloudflare). Pour un usage de révision personnel, c'est largement suffisant.

## Étape 1. Créer un compte Cloudflare gratuit

1. Allez sur <https://dash.cloudflare.com/sign-up> (à vérifier : l'adresse peut être redirigée).
2. Entrez une adresse e-mail et un mot de passe, puis validez.
3. Cloudflare envoie un e-mail de confirmation : cliquez sur le lien qu'il contient.
4. Si on vous propose d'ajouter un site web ou un nom de domaine, **passez cette étape** (à vérifier : le texte du lien pour ignorer, par exemple « Skip »). Vous n'en avez pas besoin.

## Étape 2. Créer l'espace de stockage (KV)

1. Dans le menu de gauche du tableau de bord, cherchez **Storage & Databases** puis **Workers KV** (à vérifier : l'emplacement exact dans le menu ; le nom de la page, lui, est « Workers KV »).
2. Cliquez sur **Create instance** (la documentation de Cloudflare donne ce libellé ; une ancienne version de l'écran affichait peut-être « Create a namespace » : à vérifier).
3. Donnez un nom, par exemple `revisions-cappei`, puis cliquez sur **Create**.

Vous n'avez rien d'autre à faire dans cet espace : il se remplira tout seul.

## Étape 3. Créer le Worker et coller le code

1. Dans le menu de gauche, ouvrez **Workers & Pages**.
2. Cliquez sur **Create application** (la documentation donne ce libellé).
3. Choisissez de créer un Worker : **Create Worker** (à vérifier : selon les versions, il faut d'abord choisir « Start with Hello World! » ou un modèle « Hello World » plutôt que de se connecter à un dépôt Git. **Ne connectez pas de dépôt Git.**).
4. Donnez-lui un nom court, par exemple `cappei-revisions`. Ce nom fera partie de l'adresse finale. Cliquez sur **Deploy** (à vérifier) : cela crée d'abord un Worker d'exemple, qu'on va remplacer.
5. Une fois créé, cherchez le bouton **Edit code** (à vérifier : il peut être sur la page de félicitations après la création, ou depuis la page du Worker, dans « Overview » ou en haut à droite). Il ouvre un éditeur de texte dans le navigateur.
6. Dans l'éditeur, effacez tout le code d'exemple (sélectionner tout, puis supprimer).
7. Ouvrez le fichier `worker.mjs` de ce dossier, copiez tout son contenu, et collez-le dans l'éditeur.
8. Cliquez sur **Deploy** (à vérifier : le bouton peut être en haut à droite de l'éditeur ; il peut aussi s'appeler « Save and deploy »).

Le code est volontairement sans dépendance : rien d'autre à installer.

## Étape 4. Relier l'espace de stockage au Worker (très important)

Sans cette étape, le Worker ne peut pas enregistrer et le site affichera « Suivi indisponible ».

1. Sur la page de votre Worker, ouvrez l'onglet **Bindings** (à vérifier : il peut se trouver dans « Settings » > « Bindings » selon la version de l'écran).
2. Cliquez sur **Add binding**.
3. Choisissez **KV namespace**, puis cliquez de nouveau sur **Add binding** (la documentation de Cloudflare décrit ces deux clics).
4. Dans le champ **Variable name**, écrivez exactement : `REVISIONS` (en majuscules, sans espace).
5. Dans la liste déroulante, choisissez l'espace créé à l'étape 2 (`revisions-cappei`).
6. Cliquez sur **Add binding** pour valider ; cela déploie la liaison (à vérifier : un autre clic sur « Deploy » peut être demandé).

## Étape 5. Récupérer l'adresse du Worker

L'adresse a la forme `https://NOM-DU-WORKER.VOTRE-SOUS-DOMAINE.workers.dev` (modèle donné par la documentation de Cloudflare).

1. Sur la page de votre Worker, cherchez l'adresse qui se termine par `workers.dev` (à vérifier : souvent dans « Overview » ou dans « Settings » > « Domains & Routes »).
2. Si elle n'apparaît pas, ou si elle est désactivée, allez dans **Settings** > **Domains & Routes** et activez l'adresse `workers.dev` (à vérifier : libellé du bouton, par exemple « Enable »).
3. La première fois, Cloudflare peut vous demander de choisir un « sous-domaine » pour votre compte (la partie centrale de l'adresse). Choisissez un mot simple (à vérifier : ce choix peut avoir été fait automatiquement à la création du compte).
4. Notez l'adresse complète, **sans** barre oblique (`/`) à la fin.

## Étape 6. Tester l'adresse dans le navigateur

1. Dans un onglet du navigateur, ouvrez : `https://NOM-DU-WORKER.VOTRE-SOUS-DOMAINE.workers.dev/api/revisions` (c'est votre adresse suivie de `/api/revisions`).
2. Résultat attendu, au début : `{"revisees":{}}` (une liste vide : aucune fiche révisée).
3. Si vous voyez autre chose :
   - `{"erreur":"stockage_indisponible", ...}` : la liaison de l'étape 4 manque ou le nom n'est pas exactement `REVISIONS`. Reprenez l'étape 4.
   - `{"erreur":"route_inconnue", ...}` : il manque `/api/revisions` à la fin de l'adresse.
   - Une page d'erreur Cloudflare ou une erreur « 1101 » : le code collé est incomplet. Reprenez l'étape 3 en collant **tout** le fichier.

À ce stade, le service fonctionne. Lire l'adresse dans le navigateur ne modifie rien.

## Étape 7. Donner l'adresse au site

Cette étape se fait sur le site, pas sur Cloudflare : l'adresse notée à l'étape 5 doit être mise dans le fichier `config.json` du générateur du site (`{"apiUrl": "https://…workers.dev"}`), puis le site doit être régénéré et publié. Tant que `apiUrl` est vide, le suivi n'apparaît pas sur le site.

## Bon à savoir

- **Qui peut modifier ?** Il n'y a ni compte ni mot de passe : toute personne qui connaîtrait l'adresse du Worker pourrait en théorie cocher ou décocher des fiches (risque accepté). Le Worker refuse néanmoins les requêtes venant d'un autre site que `https://franckverdiere.github.io`, et n'accepte que les 36 codes de fiches avec des valeurs vrai/faux.
- **Autre adresse de site (tests)** : une variable optionnelle `ALLOWED_ORIGIN` permet d'autoriser une autre origine, par exemple `http://localhost:8080` (dans le tableau de bord : page du Worker, « Settings » puis « Variables and Secrets » ; à vérifier). Si vous la définissez, elle **remplace** l'origine par défaut : supprimez-la ensuite.
- **Limites du plan gratuit** : 1 000 écritures par jour sur le KV (le Worker n'écrit pas quand rien ne change). Au-delà, le site affiche « Impossible d'enregistrer » jusqu'au lendemain (remise à zéro à minuit UTC, d'après la documentation).
- **Délai de propagation** : Cloudflare indique que le KV est « à cohérence éventuelle » : après une modification faite à un endroit du monde, un autre appareil très éloigné peut mettre jusqu'à environ une minute à voir le changement (à vérifier dans la documentation de KV, page « How KV works »).
- **Copie de sécurité** : utilisez de temps en temps le bouton « Exporter » du bloc « Sauvegarde » de la page d'accueil du site. Le fichier peut être réimporté avec « Importer ».
- **Mettre à jour le code plus tard** : même chemin que l'étape 3 (Edit code, tout effacer, coller le nouveau `worker.mjs`, Deploy). La liaison KV et l'adresse ne changent pas.

## Sources consultées (documentation officielle)

- Créer un espace KV et le lier à un Worker : <https://developers.cloudflare.com/kv/get-started/>
- Adresse `workers.dev` : <https://developers.cloudflare.com/workers/configuration/routing/workers-dev/>
- Limites de KV : <https://developers.cloudflare.com/kv/platform/limits/>
- Limites de Workers : <https://developers.cloudflare.com/workers/platform/limits/>
- Créer un Worker depuis le tableau de bord : <https://developers.cloudflare.com/workers/get-started/dashboard/> (cette page décrit surtout la création par dépôt Git et ne donne pas le libellé du bouton d'édition du code : d'où les « à vérifier » des étapes 3 et 5).
