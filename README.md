# OS Files Optimizer

Détecteur de fichiers en double pour macOS, Windows et Linux.

- Analyse conjointe de plusieurs dossiers, y compris sur des disques différents
- Résultats regroupés par contenu identique, triés par taille décroissante
- Barre latérale droite d'aperçu (images, vidéo, audio, PDF, texte) et métadonnées
- Sélection automatique des copies, envoi à la corbeille du système (récupérable)

## Bases open source

| Projet | Rôle ici |
| --- | --- |
| [czkawka](https://github.com/qarmin/czkawka) (`czkawka_core`, MIT) | Moteur de détection utilisé tel quel : regroupement par taille → pré-hachage → hachage Blake3, multi-thread, cache |
| [czkawka-tauri](https://github.com/shixinhuang99/czkawka-tauri) (MIT) | Modèle d'architecture : interface web Tauri au-dessus de `czkawka_core` |
| [Tauri 2](https://tauri.app) | Coque multi-plateforme (binaire léger, WebView système) |

Autres outils étudiés : dupeGuru (Python/Qt, GPL), fclones (CLI Rust), WinDirStat et Cleaner One (inspiration d'ergonomie).

## Développement

Prérequis : Rust, Node.js, et les [dépendances système de Tauri](https://tauri.app/start/prerequisites/)
(Xcode Command Line Tools sur macOS, WebView2 + MSVC sur Windows, webkit2gtk sur Linux).

Sur cette machine, Rust et Node sont installés localement dans `.toolchain/` :

```bash
source env.sh
npm run dev      # lance l'application en mode développement
npm run build    # produit l'installateur de la plateforme courante
```

Chaque plateforme se compile sur elle-même (ou via une CI GitHub Actions avec `tauri-action`).

## Structure

- `src/` — interface (HTML/CSS/JS sans dépendance ; `dev-mock.js` sert de faux backend dans un navigateur)
- `src-tauri/src/lib.rs` — commandes Rust : analyse, aperçu texte, corbeille, ouverture de fichiers
- `scripts/serve-ui.mjs` — petit serveur pour mettre au point l'interface seule
