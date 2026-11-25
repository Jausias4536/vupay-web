# VuPay — version Cloudflare

Application web qui paie les utilisateurs pour regarder des vidéos d'annonceurs, en FCFA, avec retrait sur Orange Money, Wave, MTN MoMo et Moov Money.

Cette version se met en ligne **gratuitement** sur Cloudflare, depuis GitHub, sans rien installer sur ton ordinateur :

| Partie | Service Cloudflare | Dans ce dossier |
|---|---|---|
| Les pages de l'appli (installable sur téléphone) | Workers, fichiers statiques | `public/` |
| Le serveur (comptes, codes, gains, retraits) | Workers | `src/worker.js` |
| La base de données | D1 | créée automatiquement à la 1re visite |
| Les vidéos des annonceurs | R2 | bucket `vupay-media` |
| Les réglages | | `wrangler.jsonc` |
| Les branchements SMS et Mobile Money | | `src/providers.js` |

Chaque fois que tu modifies un fichier sur GitHub, Cloudflare remet l'appli à jour tout seul.

---

## Étape 1 — Mettre le code sur GitHub

1. Crée un compte gratuit sur **github.com**.
2. Clique sur **+** puis **New repository**. Nom : `vupay`. Laisse-le **Private** si tu veux. Clique sur **Create repository**.
3. Sur la page du dépôt, clique sur **uploading an existing file**.
4. Décompresse le zip sur ton ordinateur, ouvre le dossier `vupay-cloudflare` et **glisse tout son contenu** (les dossiers `public`, `src`, `seed`, `test` et les fichiers `wrangler.jsonc`, `package.json`, `README.md`…) dans la page GitHub. Ne glisse pas le dossier lui-même.
5. Clique sur **Commit changes**.

## Étape 2 — Créer ton compte Cloudflare

Va sur **dash.cloudflare.com** et crée un compte gratuit.

## Étape 3 — Créer la base de données (D1)

1. Dans Cloudflare, menu de gauche : **Storage & databases** puis **D1 SQL database** → **Create database**.
2. Nom : `vupay-db` → **Create**.
3. Sur la page de la base, copie le **Database ID** (une longue suite de lettres et chiffres).
4. Sur GitHub, ouvre le fichier `wrangler.jsonc`, clique sur le crayon ✏️ pour le modifier, remplace `COLLE-ICI-L-ID-DE-TA-BASE-D1` par ton identifiant, puis **Commit changes**.

Les tables se créent toutes seules à la première visite de l'appli.

## Étape 4 — Créer le stockage des vidéos (R2)

1. Menu de gauche : **R2 object storage** → **Create bucket**.
2. Nom : `vupay-media` → **Create bucket**.

R2 est gratuit jusqu'à 10 Go, mais Cloudflare peut demander d'ajouter une carte bancaire avant le premier bucket.
**Pas de carte ?** Sur GitHub, dans `wrangler.jsonc`, supprime le bloc `"r2_buckets": [ ... ],`. L'appli fonctionnera, mais l'espace annonceur ne pourra pas recevoir de vidéos tant que R2 n'est pas activé.

## Étape 5 — Mettre l'appli en ligne

1. Menu de gauche : **Workers & Pages** → **Create** → **Import a repository** (ou « Connect to Git »).
2. Connecte ton compte GitHub et choisis le dépôt `vupay`.
3. Vérifie les réglages :
   - **Project name** : `vupay`
   - **Build command** : laisse vide
   - **Deploy command** : `npx wrangler deploy`
4. Clique sur **Deploy**. Après 1 à 2 minutes, ton adresse s'affiche, du type **`https://vupay.ton-nom.workers.dev`**.

## Étape 6 — Ajouter le mot de passe d'administration

1. **Workers & Pages** → `vupay` → **Settings** → **Variables and Secrets** → **Add**.
2. Type **Secret**, nom `ADMIN_TOKEN`, valeur : une longue phrase secrète. Enregistre.
3. Ouvre `https://ton-adresse/admin.html` et entre cette phrase pour voir les statistiques et les retraits.

## Étape 7 — Essayer

Ouvre ton adresse sur ton téléphone. Avec les réglages de départ :
- le code de vérification s'affiche à l'écran (pas encore de vrais SMS) ;
- les retraits sont **simulés** : ils passent à « Envoyé » mais **aucun argent n'est envoyé** ;
- 8 vidéos de démonstration dessinées sont présentes.

Pour installer l'appli : dans Chrome sur Android, menu ⋮ → **Ajouter à l'écran d'accueil**, ou bouton **Installer VuPay** dans le Profil.

---

## Avant d'ouvrir au public

Dans `wrangler.jsonc` sur GitHub (section `vars`) :

| Réglage | Valeur en production | Pourquoi |
|---|---|---|
| `DEV_SHOW_OTP` | `"0"` | Sinon n'importe qui peut s'inscrire avec le numéro d'un autre |
| `SMS_PROVIDER` | `"http"` | Pour envoyer de vrais SMS (voir plus bas) |
| `PAYOUT_PROVIDER` | `"manual"` ou `"http"` | Pour de vrais retraits (voir plus bas) |
| `SEED_DEMO` | `"0"` | Pour ne plus ajouter les vidéos dessinées |
| `PUBLIC_URL` | ton adresse | Utilisée par les webhooks de paiement |

Pour retirer les vidéos de démonstration déjà présentes : Cloudflare → D1 → `vupay-db` → **Console**, puis exécute `UPDATE videos SET active = 0 WHERE kind = 'demo';`

### Envoyer de vrais SMS
1. Ouvre un compte chez un fournisseur de SMS qui couvre tes pays (API SMS d'Orange, agrégateur local, service international…).
2. Dans Cloudflare (Settings → Variables and Secrets), ajoute les secrets `SMS_API_URL` et `SMS_API_KEY`.
3. Mets `SMS_PROVIDER` à `"http"` dans `wrangler.jsonc`, et adapte `buildSmsRequest()` dans `src/providers.js` au format de ton fournisseur.

### Payer les retraits
| Mode | Fonctionnement |
|---|---|
| `simulation` | Tests uniquement. **Aucun argent envoyé.** |
| `manual` | La demande reste « En attente ». Tu envoies l'argent toi-même depuis ton compte marchand, puis « Marquer envoyé » dans `/admin.html`. « Échoué » rembourse le solde. |
| `http` | L'appli demande le paiement à ton agrégateur (CinetPay, PayDunya, Wave Business…). Ajoute les secrets `PAYOUT_API_URL`, `PAYOUT_API_KEY`, `PAYOUT_WEBHOOK_SECRET`, et adapte `buildPayoutRequest()` dans `src/providers.js`. Leur webhook doit appeler `POST /api/webhooks/payout` avec l'en-tête `X-Webhook-Secret` et `{ "reference": "...", "status": "success" | "failed" }`. |

La devise est choisie automatiquement : **XOF** (UEMOA) ou **XAF** (CEMAC).

---

## Limites de l'offre gratuite Cloudflare

- **Visites** : 100 000 requêtes par jour pour le serveur (les pages de l'appli ne comptent pas).
- **Vidéos envoyées** : 95 Mo maximum chacune, 3 minutes maximum (réglable).
- **Base de données** : 500 Mo. **Vidéos** : 10 Go.

Quand l'appli grandit, l'offre payante Workers lève ces limites pour quelques dollars par mois.

## Nom de domaine (facultatif)

Si tu achètes un domaine (ex. `vupay.sn`), ajoute-le dans Cloudflare puis **Workers & Pages** → `vupay` → **Settings** → **Domains & Routes** → **Add** → **Custom domain**.

## Publier sur le Play Store

Va sur **pwabuilder.com**, entre l'adresse de ton appli, et télécharge le paquet Android. Tu le publies avec un compte développeur Google Play (frais d'inscription unique). Le fichier `assetlinks.json` que PWABuilder te donne se place dans `public/.well-known/` sur GitHub.

---

## Comment l'appli empêche la triche

- Une vidéo ne rapporte qu'une fois par jour et par compte.
- Le serveur note l'heure d'ouverture de la vidéo et refuse la réponse si elle arrive trop tôt.
- La bonne réponse n'est jamais envoyée au téléphone.
- Pas d'avance rapide, pause automatique quand on quitte l'écran.
- Un compte = un numéro vérifié par code.

## Points à régler avant le lancement

- **Le modèle économique** : l'argent versé aux utilisateurs doit venir des annonceurs. Facture la vue plus cher que le gain versé + les frais de transfert.
- **Le cadre légal** : conditions d'utilisation, politique de confidentialité, déclaration des données personnelles dans ton pays, règles de ton agrégateur de paiement.
- **Les vidéos des annonceurs** : vérifie-les avant diffusion.

---

## Pour un développeur

- Tester en local : `npm install` puis `npx wrangler dev` (copie `.dev.vars.example` en `.dev.vars`).
- Banc d'essai sans Cloudflare (Node 22.5+) : `node test/harness.mjs` puis `http://localhost:8787`.
- Routes API : `/api/otp/send`, `/api/otp/verify`, `/api/me`, `/api/videos`, `/api/views`, `/api/views/:id/answer`, `/api/withdrawals`, `/api/uploads` (PUT, corps = fichier vidéo), `/api/videos` (POST), `/api/my-videos`, `/api/webhooks/payout`, `/api/admin/*` (en-tête `X-Admin-Token`).
