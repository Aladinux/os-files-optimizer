// Données factices pour mettre au point l'interface dans un navigateur,
// sans le backend Tauri. Jamais chargé dans l'application réelle.

const SVG = (color, label) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="50%" fill="#fff" font-size="40" font-family="sans-serif" text-anchor="middle">${label}</text></svg>`,
  )}`;

function group(size, name, dirs) {
  return {
    size,
    hash: Array.from({ length: 64 }, (_, i) => ((size + i * 7) % 16).toString(16)).join(""),
    files: dirs.map((dir, i) => ({ path: `${dir}/${name}`, name, dir, modified: 1700000000 + i * 86400 * 37 })),
  };
}

export function mockApi() {
  const listeners = [];
  let stopped = false;
  const groups = [
    group(4_812_390_400, "Vacances-2023.mov", ["/Volumes/Archive/Vidéos", "/Users/demo/Movies", "/Volumes/Backup/Films"]),
    group(734_003_200, "installer.dmg", ["/Users/demo/Downloads", "/Volumes/Archive/Logiciels"]),
    group(18_350_080, "IMG_2041.jpg", ["/Users/demo/Pictures/2024", "/Volumes/Backup/Photos/2024", "/Users/demo/Desktop"]),
    group(2_411_724, "rapport-annuel.pdf", ["/Users/demo/Documents", "/Volumes/Archive/Docs"]),
    group(48_211, "notes.md", ["/Users/demo/Documents/Notes", "/Volumes/Backup/Notes"]),
    ...Array.from({ length: 400 }, (_, i) => group(40_000 - i * 90, `fichier-${i}.txt`, ["/Users/demo/A", "/Volumes/Backup/A"])),
  ];

  return {
    async scan() {
      stopped = false;
      const stages = ["Recensement des fichiers", "Pré-hachage (début des fichiers)", "Hachage complet du contenu"];
      for (let i = 0; i <= 30 && !stopped; i++) {
        await new Promise((r) => setTimeout(r, 40));
        const payload = { stage: stages[Math.min(2, Math.floor(i / 10))], percent: Math.round((i / 30) * 99), entriesChecked: i * 400, entriesToCheck: 12000, bytesChecked: 0, bytesToCheck: 0 };
        listeners.forEach((cb) => cb(payload));
      }
      return { groups: structuredClone(groups), stopped, durationMs: 1200, warnings: [] };
    },
    async stop() {
      stopped = true;
    },
    async details() {
      return { size: 0, modified: 1700000000, created: 1690000000, readonly: false };
    },
    async textPreview(path) {
      return { text: `# Aperçu factice\n\n${path}\n\nLorem ipsum dolor sit amet.`, truncated: false, binary: false };
    },
    async trash(paths) {
      return paths.map((path) => ({ path, ok: true, error: null }));
    },
    async open() {},
    async reveal() {},
    fileUrl: (path) => SVG(path.includes("Backup") ? "#3b6" : "#36b", path.split("/").pop()),
    async pickFolders() {
      return ["/Users/demo", "/Volumes/Archive", "/Volumes/Backup"];
    },
    async confirm(message) {
      return window.confirm(message);
    },
    onProgress: (cb) => listeners.push(cb),
    onDrop: () => {},
  };
}
