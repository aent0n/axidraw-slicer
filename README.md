# AxiDraw Slicer & Control 🖊️🎨

Un outil de préparation (slicing), d'optimisation de tracés vectoriels et de contrôle en temps réel pour les traceurs physiques **AxiDraw** (EBB hardware). Développé sur une architecture haute performance alliant **Rust** (Tauri backend) et **React + TypeScript** (Frontend).

---

## 🚀 Fonctionnalités Principales

### 📐 1. Espace de Préparation (Prepare Tab)
*   **Import SVG & Images :** Glissez-déposez des fichiers vectoriels SVG ou des images matricielles.
*   **Algorithmes de Vectorisation (Rust) :** Convertissez n'importe quelle image grâce à 3 algorithmes intégrés performants :
    *   *Sketch (Squiggle)* : Lignes sinueuses artistiques.
    *   *Hatch (Waves)* : Hachures ondulées à densité variable.
    *   *TSP (Traveling Salesperson)* : Ligne continue unique calculée via résolution de chemin optimal.
*   **Manipulation Assistée (CAD-style) :** Déplacez, redimensionnez et tournez vos designs directement sur la feuille à la souris (avec poignées interactives) ou via le clavier (raccourcis Ctrl+C / Ctrl+X / Ctrl+V / Suppr).
*   **Agencement Intelligent (Auto-Arrange) :** Réorganisez automatiquement vos designs pour optimiser l'occupation du lit d'écriture tout en maintenant des marges de sécurité.
*   **Gestion des Stylos (Lifespan Tracker) :** Suivi de l'usure de l'encre en mètres dessinés avec alertes de fin de vie.

### 🔍 2. Simulation de Tracé (Preview Tab)
*   **Curseur Temporel de Tracé :** Simulez le parcours exact du stylo point par point avant de lancer l'écriture.
*   **Indicateur de Stylo Virtuel :** Le curseur virtuel glisse le long des trajectoires de manière synchronisée avec le défilement.
*   **Télémétrie Estimée :** Analyse précise du temps total estimé, de la distance de dessin, de la distance de voyage à vide (Air Travel) et du nombre de levées de stylo.

### 🖥️ 3. Dashboard Monitor (Fluidd-style)
*   **Agencement Dynamique :** Une grille moderne affichant :
    *   *Terminal de logs EBB* en temps réel avec saisie de commandes manuelles (commandes série EBB brutes).
    *   *Historique de jobs passés* avec sauvegarde automatique et fonction **Relaunch** rapide en un clic.
    *   *Visualiseur dynamique* montrant la position exacte du stylo physique en direct à 60 FPS.
    *   *Statistiques de job en temps réel* : temps écoulé, distance parcourue, vitesse de déplacement à vide cumulée, et temps restant estimé.
*   **Contrôle Électronique Sécurisé :**
    *   *Arrêt d'urgence intelligent (Stop)* : Le stylo termine sa course proprement jusqu'au coin (checkpoint) le plus proche avant de se lever et de rentrer à sa base (Home), évitant les sursauts mécaniques ou rayures.
    *   *Pause & Reprise* à la volée.

---

## 🛠️ Architecture Technique

*   **Frontend :** React 18, TypeScript, Vite. Interface sombre inspirée de *Fluidd/Mainsail* pour imprimantes 3D.
*   **Backend & Hardware Driver (Tauri + Rust) :**
    *   Communication série asynchrone directe avec la carte EBB (EiBotBoard).
    *   Interpolation à fréquence de rafraîchissement **60 FPS** pour les mouvements et la télémétrie en temps réel.
    *   Calculs lourds de vectorisation et tri de tracés optimisés en Rust natif.

---

## 📦 Installation & Démarrage

### Prérequis
*   [Node.js](https://nodejs.org/) (version 20+)
*   [Rust & Cargo](https://www.rust-lang.org/) (compilateur stable)
*   Dépendances système Tauri (voir [Tauri Setup Guide](https://tauri.app/v1/guides/getting-started/prerequisites))

### Démarrage du projet en mode développement

1. Installez les dépendances npm :
```bash
npm install
```

2. Lancez l'application Tauri :
```bash
npm run tauri dev
```

3. Pour compiler l'application de production :
```bash
npm run tauri build
```

---

## 🤝 Raccourcis Clavier en Mode Préparation
*   `Ctrl + C` : Copier l'objet sélectionné.
*   `Ctrl + X` : Couper l'objet sélectionné.
*   `Ctrl + V` : Coller l'objet sur le lit de travail.
*   `Delete` / `Backspace` : Supprimer l'objet sélectionné.
*   `Ctrl + Molette souris` : Zoomer / Dézoomer de façon progressive sur le canevas.
