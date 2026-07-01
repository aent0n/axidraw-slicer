# AxiDraw Slicer & Control

Un outil de préparation, d'optimisation de tracés vectoriels et de contrôle en live pour les plotters **AxiDraw**. Développé sur une architecture **Rust** (Tauri backend) et **React + TypeScript** (Frontend).

---

## Fonctionnalités

### Prepare tab
*   **Import SVG & images :** Glissez-déposez des fichiers vectoriels SVG ou des images matricielles.
*   **Algorithmes de vectorisation (Rust) :** Convertissez n'importe quelle image grâce à 3 algorithmes intégrés performants :
    *   *Sketch (Squiggle)* : Lignes sinueuses artistiques.
    *   *Hatch (Waves)* : Hachures ondulées à densité variable.
    *   *TSP (Traveling Salesperson)* : Ligne continue unique calculée via résolution de chemin optimal.
*   **Manipulation assistée :** Déplacez, redimensionnez et tournez vos designs directement sur la feuille à la souris (avec poignées interactives) ou via le clavier (raccourcis Ctrl+C / Ctrl+X / Ctrl+V / Suppr).
*   **Agencement intelligent :** Réorganisez automatiquement vos designs pour optimiser l'occupation du lit d'écriture tout en maintenant des marges de sécurité.
*   **Gestion des stylos :** Suivi de l'usure de l'encre en mètres dessinés avec alertes de fin de vie.

<img width="2223" height="1392" alt="image" src="https://github.com/user-attachments/assets/02f17a14-2b3a-4d48-b86d-171a0590ca54" />


### Preview tab
*   **Curseur temporel de tracé :** Simulez le parcours exact du stylo point par point avant de lancer l'écriture.
*   **Indicateur de stylo virtuel :** Le curseur virtuel glisse le long des trajectoires de manière synchronisée avec le défilement.
*   **Télémétrie estimée :** Analyse du temps total estimé, de la distance de dessin, de la distance de voyage à vide et du nombre de levées de stylo.

<img width="2223" height="1392" alt="image" src="https://github.com/user-attachments/assets/6686f1e0-c07f-49a4-a5bb-15ab8c62b693" />


###  Monitor tab
*   **Agencement dynamique :** Une grille moderne affichant :
    *   *Terminal de logs EBB* en temps réel avec saisie de commandes manuelles (commandes série EBB brutes).
    *   *Historique de jobs passés* avec sauvegarde automatique et fonction **Relaunch** rapide en un clic.
    *   *Visualiseur dynamique* montrant la position exacte du stylo physique en direct à 60 FPS.
    *   *Statistiques de job en temps réel* : temps écoulé, distance parcourue, vitesse de déplacement à vide cumulée, et temps restant estimé.
*   **Contrôle électronique sécurisé :**
    *   *Arrêt d'urgence intelligent* : Le stylo termine sa course proprement jusqu'au coin (checkpoint) le plus proche avant de se lever et de rentrer à sa base, évitant les sursauts mécaniques ou rayures.
    *   *Pause & Reprise* à la volée.

<img width="2223" height="1392" alt="image" src="https://github.com/user-attachments/assets/bb39032e-66f3-4910-8766-fec2102db75b" />


---

## Architecture technique

*   **Frontend :** React 18, TypeScript, Vite. Interface inspirée de *Fluidd/Mainsail* pour imprimantes 3D.
*   **Backend & hardware driver (Tauri + Rust) :**
    *   Communication série asynchrone directe avec la carte EBB.
    *   Interpolation à fréquence de rafraîchissement **60 FPS** pour les mouvements et la télémétrie en temps réel.
    *   Calculs lourds de vectorisation et tri de tracés optimisés en Rust natif.

---

## Installation & démarrage

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

## Raccourcis clavier en mode préparation
*   `Ctrl + C` : Copier l'objet sélectionné.
*   `Ctrl + X` : Couper l'objet sélectionné.
*   `Ctrl + V` : Coller l'objet sur le lit de travail.
*   `Delete` / `Backspace` : Supprimer l'objet sélectionné.
*   `Ctrl + Molette souris` : Zoomer / Dézoomer de façon progressive sur le canevas.
