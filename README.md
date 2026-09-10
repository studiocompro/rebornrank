# RebornRank — V2 spécialisée

Site statique spécialisé Isekai / réincarnation / régression / résurrection / transmigration / systèmes / hunters / dungeon / cultivation / Murim.

## Contenu
- 33 familles spécialisées × 9 langues = pages SEO réelles par langue.
- Japon, Corée, Chine/Taïwan, avec Manga / Manhwa / Manhua / Anime / Donghua / Light-Web Novel.
- Recherche multi-tags : chaque tag de départ est interrogé séparément dans une même requête GraphQL puis les résultats sont fusionnés. Cela évite le comportement `tag_in` qui exige tous les tags à la fois.
- 2 à 4 pages de candidats par classement ; jusqu’à 3 pages filtrées pour les Pépites.
- Pépites : seuils de note + popularité modeste.
- Contenu adulte exclu par défaut.
- Forgotten Source apparaît dans les grilles comme **Projet du créateur — hors classement**, sans fausse note ni faux rang.
- Rails publicitaires fixes gauche/droite sur grands écrans + emplacements internes.
- Ko-fi, Soutenir, réseau de sites, robots.txt, sitemap.xml, ads.txt.

## Avant publication
1. Choisir l’URL Cloudflare Pages.
2. Depuis le dossier : `node tools/set-domain.mjs https://TON-SITE.pages.dev`
3. Renseigner les vrais IDs de slots AdSense dans `assets/js/config.js`.
4. Renseigner `forgottenSourceUrl` ou `originalWork.url`.
5. Quand tu as une couverture publique de Forgotten Source, mettre son URL dans `originalWork.coverUrl`.

## Ajouter un autre site au réseau
Une seule entrée à ajouter dans `networkSites` de `assets/js/config.js`.

## Données
Les données AniList sont chargées à la demande et mises en cache localement. Le site ne tente pas de copier toute la base.

## Vérifications avant monétisation importante
- AniList autorise actuellement l’usage commercial gratuit jusqu’au seuil indiqué dans ses conditions ; au-delà, vérifier/obtenir la licence commerciale applicable directement auprès d’AniList.
- La disponibilité d’une URL de couverture dans une API ne remplace pas les droits d’auteur sur l’illustration. Pour un usage commercial à grande échelle, vérifier les conditions des ayants droit / éditeurs et la politique de la source d’image.
- Ne pas utiliser MangaDex comme source de données pour cette version financée par publicité sans revalider ses conditions.
