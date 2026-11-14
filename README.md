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

## Installation

Il n'y a pas encore d'installateurs précompilés : l'application se compile depuis les sources,
sur la plateforme où elle sera utilisée (pas de compilation croisée). La procédure comporte
trois étapes : installer les prérequis de la plateforme, compiler, puis installer le paquet produit.

> Seule la procédure macOS (Apple Silicon) a été testée à ce jour. Celles de Windows et de Linux
> suivent les [prérequis officiels de Tauri 2](https://tauri.app/start/prerequisites/) mais n'ont
> pas encore été vérifiées sur ces systèmes.

### 1. Prérequis

#### macOS (11 ou plus récent)

```bash
xcode-select --install                                            # outils de compilation Apple
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh    # Rust
brew install node                                                 # Node.js (ou installateur de nodejs.org)
```

Si Xcode complet est installé, accepter sa licence une fois : `sudo xcodebuild -license accept`.

#### Windows (10 ou 11)

1. Installer les [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   en cochant « Développement Desktop en C++ ».
2. WebView2 est déjà présent sur Windows 11 et sur Windows 10 à jour ; sinon, installer le
   [runtime WebView2](https://developer.microsoft.com/microsoft-edge/webview2/).
3. Installer Git, Rust et Node.js, par exemple dans PowerShell :

```powershell
winget install Git.Git
winget install Rustlang.Rustup
winget install OpenJS.NodeJS.LTS
```

Rouvrir le terminal ensuite pour que `cargo` et `npm` soient dans le `PATH`.

#### Linux

Debian / Ubuntu :

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev nodejs npm git
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Fedora :

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel nodejs npm git
sudo dnf group install "c-development"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Arch :

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool nodejs npm git rustup
rustup default stable
```

### 2. Compilation

Identique sur les trois plateformes :

```bash
git clone https://github.com/Aladinux/os-files-optimizer.git
cd os-files-optimizer
npm install
npm run build
```

La première compilation télécharge et compile environ 700 dépendances Rust : compter plusieurs minutes.

### 3. Installation du paquet produit

Les paquets sont générés dans `src-tauri/target/release/bundle/` :

| Plateforme | Fichier produit | Installation |
| --- | --- | --- |
| macOS | `dmg/OS Files Optimizer_0.1.0_aarch64.dmg` (ou `_x64` sur Intel) | Ouvrir le `.dmg`, glisser l'application dans `Applications` |
| Windows | `nsis/OS Files Optimizer_0.1.0_x64-setup.exe` ou `msi/…_x64_en-US.msi` | Double-cliquer sur l'installateur |
| Linux (Debian/Ubuntu) | `deb/…_amd64.deb` | `sudo apt install ./<fichier>.deb` |
| Linux (Fedora) | `rpm/…x86_64.rpm` | `sudo dnf install ./<fichier>.rpm` |
| Linux (autres) | `appimage/…_amd64.AppImage` | `chmod +x <fichier>.AppImage` puis l'exécuter |

À savoir au premier lancement :

- **macOS** : l'application n'est pas signée. Compilée sur votre Mac, elle s'ouvre normalement ;
  copiée depuis un autre Mac, faire clic droit → Ouvrir. macOS demandera aussi l'autorisation
  d'accéder à Documents, Bureau, Téléchargements et aux disques externes lors de la première analyse.
- **Windows** : l'installateur n'est pas signé, SmartScreen peut afficher un avertissement
  (« Informations complémentaires » → « Exécuter quand même »).

## Développement

```bash
npm install
npm run dev      # lance l'application en mode développement, avec rechargement
npm run build    # produit les paquets de la plateforme courante
cd src-tauri && cargo test   # teste le moteur de détection sur de vrais fichiers
```

`env.sh` ne sert que si Rust et Node sont installés localement dans `.toolchain/` plutôt que sur
le système (`source env.sh` les ajoute alors au `PATH`).

## Structure

- `src/` — interface (HTML/CSS/JS sans dépendance ; `dev-mock.js` sert de faux backend dans un navigateur)
- `src-tauri/src/lib.rs` — commandes Rust : analyse, aperçu texte, corbeille, ouverture de fichiers
- `scripts/serve-ui.mjs` — petit serveur pour mettre au point l'interface seule
