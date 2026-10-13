# Déploiement sur le VPS par GitHub Actions

> **Document partagé.** Ce fichier est copié à l'identique dans chaque projet déployé sur le VPS. La version de référence est dans le dépôt d'infrastructure du serveur : toute correction s'y fait d'abord, puis se reporte dans les autres dépôts. Il ne contient volontairement aucune valeur propre au serveur ou à un projet : ces valeurs sont dans le workflow et l'`AGENTS.md` de chaque dépôt, et sur le serveur. Dernière mise à jour : 13 octobre 2026.

## En bref

Le VPS n'expose pas SSH sur Internet. Un déploiement passe par un tunnel WireGuard ouvert le temps du job, puis par une clé SSH qui ne sait exécuter qu'une seule commande côté serveur.

```
push sur main
  └─ job test
       └─ job deploy (environnement GitHub « prod », branche main uniquement)
            1. monte le tunnel WireGuard propre au dépôt
            2. ssh deploy@<adresse du serveur dans le tunnel> (aucune commande envoyée)
                 └─ sshd exécute la commande forcée de la clé :
                    /usr/local/bin/deploy-project <projet>
                      git pull --ff-only origin main
                      docker compose up -d --build
                      contrôle de santé, journaux si échec
            3. démonte le tunnel (toujours, même en cas d'échec)
```

Le workflow **déclenche** le déploiement ; il ne le **décrit** pas. Ce que fait un déploiement est défini sur le serveur, dans `deploy-project`.

## Pourquoi c'est construit ainsi

- **Port 22 fermé à Internet.** SSH n'est joignable que par le tunnel (`wg0`) et par la console web de l'hébergeur.
- **Un pair WireGuard par dépôt.** Deux déploiements simultanés de dépôts différents ne se disputent pas le tunnel, et la clé d'un dépôt se révoque sans toucher aux autres.
- **Une clé SSH qui ne fait qu'une chose.** L'utilisateur `deploy` est membre du groupe `docker`, ce qui équivaut à root. Chaque clé stockée dans GitHub est donc restreinte dans `/home/deploy/.ssh/authorized_keys` :
  ```
  from="<adresse du dépôt>",command="/usr/local/bin/deploy-project mon-projet",restrict ssh-ed25519 AAAA... github-actions-mon-projet
  ```
  Elle n'est acceptée que depuis l'adresse de tunnel du dépôt, ignore la commande envoyée par le client, et n'ouvre ni terminal ni redirection. Une clé qui fuit permet seulement de redéployer ce qui est déjà sur `main`.
- **`deploy-project` appartient à root.** `deploy` ne peut pas le modifier pour élargir ce que fait sa clé.
- **Pas d'action tierce pour SSH.** Une action comme `appleboy/ssh-action` recevrait une clé à pouvoir root. Le job utilise `ssh` directement.
- **Clé d'hôte épinglée.** Le job vérifie l'identité du serveur (`StrictHostKeyChecking=yes`) contre la clé inscrite dans le workflow.
- **Environnement `prod` limité à `main`.** Un workflow lancé depuis une autre branche ne reçoit pas les secrets de déploiement.

## Ce que l'agent configure dans le dépôt

Tout se trouve dans le workflow, par exemple `.github/workflows/build-and-deploy.yml`. Le modèle est **`docs/build-and-deploy.example.yml`** : un workflow complet dont le job `deploy` se reprend **tel quel**, en remplaçant les quatre valeurs entre chevrons :

- `TUNNEL_ADDRESS` : l'adresse attribuée au dépôt, indiquée dans son `AGENTS.md` ;
- les trois valeurs du serveur : à recopier depuis le workflow d'un dépôt déjà déployé, ou à lire sur le serveur (voir plus bas).

Le job `test` du modèle n'est qu'un exemple : le remplacer par celui du projet.

Les valeurs du serveur sont publiques (clés publiques, adresse) : elles s'écrivent en clair dans le workflow, et un changement doit apparaître dans un diff pour être relu. Pour les lire sur le serveur, en root :

```bash
wg show wg0 public-key                                  # VPS_WG_PUBLIC_KEY
cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub       # VPS_SSH_HOST_KEY
ip -4 -br addr show eth0                                # adresse publique, pour VPS_WG_ENDPOINT
```

Elles ne changent que si le serveur est réinstallé, ses clés régénérées ou son adresse modifiée ; il faut alors les mettre à jour dans le workflow de chaque dépôt.

Adaptations permises :

- la condition `if:` selon les déclencheurs du workflow (un workflow déclenché seulement par `push` sur `main` n'a pas besoin de tester `github.event_name`) ;
- `needs:` selon le nom du ou des jobs de test.

À ne **jamais** faire :

- envoyer une commande dans l'appel `ssh` : elle serait ignorée, et laisser croire le contraire induit en erreur ;
- décrire les étapes du déploiement dans le workflow (`git pull`, `docker compose`...) : elles vivent dans `deploy-project`, sur le serveur ;
- utiliser une action tierce pour SSH ou WireGuard ;
- désactiver la vérification de clé d'hôte, ou remplacer `VPS_SSH_HOST_KEY` sans avoir vérifié la nouvelle clé sur le serveur ;
- retirer `if: always()` de la fermeture du tunnel ;
- mettre une clé privée ou un mot de passe dans le YAML. Seules des valeurs publiques vont dans `env:`.

Changer **ce que fait** un déploiement (une commande de migration, un autre fichier compose, un contrôle de santé) se fait dans `deploy-project`, pas dans le workflow. C'est une modification du serveur, faite par l'humain ou l'orchestrateur, jamais par un agent de code.

## Ce qui ne passe pas par le déploiement automatique

Le déploiement automatique ne doit transporter que des changements qui se rejouent par un simple `docker compose up -d --build` : code, images, variables, services. **Une modification de la définition d'un réseau ou d'un volume Compose** (sous-réseau, pilote, options, renommage) oblige Compose à supprimer et recréer la ressource, et il le fait mal : les conteneurs qu'il ne recrée pas sont rebranchés sans leurs alias de service, et les noms comme `postgres` cessent de se résoudre (constaté avec Compose v5.1.0, au prix d'une coupure de production).

Ces changements s'appliquent à la main sur le serveur, dans une fenêtre choisie, **avant** de fusionner :

```bash
sudo -u deploy -i
cd ~/<projet>
docker compose <fichiers et options du projet> down     # les volumes nommés sont conservés
git fetch && git checkout <branche de la PR> -- <fichiers compose modifiés>
docker compose <fichiers et options du projet> up -d
# vérifier, puis remettre le clone propre avant la fusion :
git checkout -- . && git status
```

Le déploiement qui suit la fusion ne trouve alors plus rien à recréer. Pour savoir à l'avance ce que Compose fera, `docker compose ... --dry-run up -d` : une ligne `Network ... Removed` ou `Volume ... Removed` signale un changement à faire à la main.

## Secrets GitHub

Dans l'environnement `prod` du dépôt (Settings, Environments, prod), avec la règle de branche `main` :

| Secret | Contenu |
| :--- | :--- |
| `WG_PRIVATE_KEY` | clé privée WireGuard du pair du dépôt |
| `VPS_SSH_KEY` | clé privée SSH ed25519, restreinte côté serveur |
| `VPS_HOST` | `10.88.0.1` (adresse du serveur dans le tunnel) |
| `VPS_USER` | `deploy` |

Les clés privées sont générées sur le serveur et envoyées directement à `gh secret set` par un pipe (`ssh vps 'cat <clé>' | gh secret set ...`) : elles ne s'affichent jamais et ne sont écrites dans aucun fichier du poste. Elles sont ensuite effacées du serveur.

## Plan d'adressage du tunnel

Réseau `10.88.0.0/24`, volontairement hors de `172.16.0.0/12` (réseaux Docker et `mynetworks` de Postfix).

| Plage | Usage |
| :--- | :--- |
| `10.88.0.1` | serveur |
| `10.88.0.2` à `10.88.0.10` | appareils personnels |
| à partir de `10.88.0.11` | un pair par dépôt déployé par la CI |

La liste à jour des pairs se lit sur le serveur, pas dans ce document. Chaque pair y est précédé d'un commentaire qui le nomme :

```bash
grep -B1 -A2 '^\[Peer\]' /etc/wireguard/wg0.conf     # pairs déclarés, avec leur nom
wg show wg0 allowed-ips                               # pairs actifs et leurs adresses
```

Pour un nouveau dépôt, prendre la première adresse libre à partir de `.11`.

## Ajouter un projet (côté serveur, en root)

À faire par l'humain ou l'orchestrateur, pas par un agent de code. Dans les commandes ci-dessous, `mon-projet` est le nom du projet et du dépôt, `10.88.0.NN` sa nouvelle adresse de tunnel, et le clone du dépôt est `/home/deploy/mon-projet` (cloné avec la clé de déploiement GitHub de `deploy`).

1. **Ajouter un cas dans `/usr/local/bin/deploy-project`** : `cd`, `git pull --ff-only origin main`, `docker compose up -d --build`, contrôle de santé si l'application en expose un. Vérifier avec `bash -n`.

2. **Générer les clés et déclarer le pair** :
   ```bash
   umask 077; d=/root/ci-keys/mon-projet; mkdir -p "$d"
   wg genkey > "$d/wg.key"; wg pubkey < "$d/wg.key" > "$d/wg.pub"
   ssh-keygen -q -t ed25519 -N "" -C github-actions-mon-projet -f "$d/ssh"
   wg set wg0 peer "$(cat "$d/wg.pub")" allowed-ips 10.88.0.NN/32
   printf '\n# CI GitHub Actions : mon-projet\n[Peer]\nPublicKey = %s\nAllowedIPs = 10.88.0.NN/32\n' "$(cat "$d/wg.pub")" >> /etc/wireguard/wg0.conf
   printf 'from="10.88.0.NN",command="/usr/local/bin/deploy-project mon-projet",restrict %s\n' "$(cat "$d/ssh.pub")" >> /home/deploy/.ssh/authorized_keys
   ```

3. **Poser les secrets depuis un poste où `gh` est authentifié**, sans afficher les clés (`vps` est l'alias SSH root du serveur par le tunnel) :
   ```bash
   ssh vps 'cat /root/ci-keys/mon-projet/wg.key' | gh secret set WG_PRIVATE_KEY --env prod -R <propriétaire>/mon-projet
   ssh vps 'cat /root/ci-keys/mon-projet/ssh'    | gh secret set VPS_SSH_KEY    --env prod -R <propriétaire>/mon-projet
   gh secret set VPS_HOST --env prod -R <propriétaire>/mon-projet --body 10.88.0.1
   gh secret set VPS_USER --env prod -R <propriétaire>/mon-projet --body deploy
   ```
   Créer l'environnement `prod` s'il n'existe pas, et le limiter à `main` :
   ```bash
   gh api -X PUT repos/<propriétaire>/mon-projet/environments/prod \
     -F "deployment_branch_policy[protected_branches]=false" \
     -F "deployment_branch_policy[custom_branch_policies]=true"
   gh api -X POST repos/<propriétaire>/mon-projet/environments/prod/deployment-branch-policies -f name=main
   ```

4. **Effacer les clés privées du serveur** : `shred -u /root/ci-keys/mon-projet/{wg.key,ssh} && rm -r /root/ci-keys/mon-projet`.

5. **Dans le dépôt** : ce document et `build-and-deploy.example.yml` dans `docs/`, le job `deploy` du modèle dans `.github/workflows/` avec `TUNNEL_ADDRESS: 10.88.0.NN/32`, et l'adresse de tunnel indiquée dans `AGENTS.md`.

Révoquer un dépôt : retirer sa ligne de `authorized_keys`, retirer son pair (`wg set wg0 peer <clé publique> remove` et le bloc correspondant de `wg0.conf`), supprimer ses secrets.

## Dépannage

| Symptôme dans le job | Cause probable | Vérification |
| :--- | :--- | :--- |
| `wg-quick up` échoue | paquet absent, clé mal copiée dans le secret | journal de l'étape « Ouvrir le tunnel » |
| `ssh: connect ... timed out` | le tunnel ne s'établit pas | sur le serveur : `wg show wg0`, la poignée de main du pair doit être récente |
| `Permission denied (publickey)` | adresse de tunnel différente du `from=`, ou mauvaise clé | `TUNNEL_ADDRESS` du workflow contre la ligne de `authorized_keys` |
| `Host key verification failed` | clé d'hôte du serveur changée | comparer avec `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` ; ne jamais désactiver la vérification |
| `Un déploiement de ... est déjà en cours` (code 75) | un déploiement précédent tourne encore | attendre, ou chercher un processus bloqué sur le serveur |
| `git pull --ff-only` refusé | le clone du serveur a des modifications locales ou un historique divergent | `sudo -u deploy git -C /home/deploy/<projet> status` |
| `projet inconnu` | cas absent de `deploy-project` | ajouter le cas (section précédente) |
| un service ne trouve pas un autre par son nom (`Can't reach ... postgres:5432`) après un changement de réseau | conteneurs rebranchés sans alias | `docker inspect <conteneur> -f '{{range .NetworkSettings.Networks}}{{.Aliases}}{{end}}'` vide : recréer ces conteneurs (`up -d --force-recreate <services>`), les volumes nommés sont conservés |

## Limites connues

- `deploy` équivaut à root (groupe `docker`). La commande forcée limite ce qu'une clé fuitée permet, pas ce que permettrait un dépôt compromis : un commit malveillant poussé sur `main` sera déployé.
- `deploy-project` est versionné dans le dépôt d'infrastructure du serveur, mais installé à la main : le dépôt et le serveur peuvent diverger si une modification n'est pas reportée.
- Ce document est copié dans plusieurs dépôts et peut diverger.