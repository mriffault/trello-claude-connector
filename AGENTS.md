# Consignes pour les agents

Les notes détaillées sur le projet sont dans `CLAUDE.md`.

## Déploiement

Le déploiement en production passe par GitHub Actions, un tunnel WireGuard et une commande forcée côté serveur. Avant de toucher à `.github/workflows/`, lire **`docs/deploiement-vps.md`**.

- Le job `deploy` reprend tel quel le modèle `docs/build-and-deploy.example.yml` ; l'adresse de tunnel de ce dépôt est `10.88.0.12/32`.
- Ce que fait un déploiement (`git pull`, `docker compose`, contrôle de santé) est défini sur le serveur, dans `deploy-project`, et ne se modifie pas depuis ce dépôt.
