// Interface de OS Files Optimizer. Aucune dépendance : on utilise l'API
// globale de Tauri (window.__TAURI__), ou un jeu de données factice quand la
// page est ouverte dans un simple navigateur (mise au point de l'interface).

const api = window.__TAURI__ ? tauriApi() : (await import("./dev-mock.js")).mockApi();

function tauriApi() {
  const { core, event, dialog } = window.__TAURI__;
  return {
    scan: (paths, minSize) => core.invoke("scan_duplicates", { paths, minSize }),
    stop: () => core.invoke("stop_scan"),
    details: (path) => core.invoke("file_details", { path }),
    textPreview: (path) => core.invoke("read_text_preview", { path }),
    trash: (paths) => core.invoke("move_to_trash", { paths }),
    open: (path) => core.invoke("open_file", { path }),
    reveal: (path) => core.invoke("reveal_file", { path }),
    fileUrl: (path) => core.convertFileSrc(path),
    pickFolders: () => dialog.open({ directory: true, multiple: true, title: "Choisir les dossiers à analyser" }),
    confirm: (message, title) => dialog.ask(message, { title, kind: "warning", okLabel: "Mettre à la corbeille", cancelLabel: "Annuler" }),
    onProgress: (cb) => event.listen("scan-progress", (e) => cb(e.payload)),
    onDrop: (handlers) => {
      event.listen("tauri://drag-enter", handlers.enter);
      event.listen("tauri://drag-leave", handlers.leave);
      event.listen("tauri://drag-drop", (e) => handlers.drop(e.payload.paths || []));
    },
  };
}

const GROUPS_PER_BATCH = 150;

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "heic", "tif", "tiff"]);
const VIDEO = new Set(["mp4", "m4v", "mov", "webm", "ogv"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus"]);
const BINARY = new Set([
  "zip", "gz", "7z", "rar", "tar", "dmg", "iso", "exe", "dll", "so", "dylib", "bin", "pkg", "msi", "deb", "rpm",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "psd", "sqlite", "db", "mkv", "avi", "wmv", "jar", "class", "o", "a",
]);

const state = {
  folders: [],
  groups: [],
  rendered: 0,
  checked: new Set(),
  current: null, // chemin du fichier affiché dans l'aperçu
  scanning: false,
  previewToken: 0,
};

const $ = (id) => document.getElementById(id);
const el = {
  folders: $("folders"),
  addFolder: $("add-folder"),
  minSize: $("min-size"),
  scan: $("scan"),
  progress: $("progress"),
  progressBar: $("progress-bar"),
  progressLabel: $("progress-label"),
  summary: $("summary"),
  autoSelect: $("auto-select"),
  clearSelect: $("clear-select"),
  list: $("list"),
  empty: $("empty"),
  groups: $("groups"),
  sentinel: $("sentinel"),
  selectionInfo: $("selection-info"),
  trash: $("trash"),
  preview: $("preview"),
  toast: $("toast"),
};

// ---------- utilitaires ----------

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node[k] = v;
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const nfInt = new Intl.NumberFormat("fr-FR");

function formatSize(bytes) {
  const units = ["octets", "Ko", "Mo", "Go", "To"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? nfInt.format(value) : nf.format(value)} ${units[i]}`;
}

function formatDate(secs) {
  if (!secs) return "—";
  return new Date(secs * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

const plural = (n, one, many) => `${nfInt.format(n)} ${n > 1 ? many : one}`;

function extension(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 5000);
}

// ---------- dossiers ----------

function addFolders(paths) {
  for (const p of paths) {
    if (p && !state.folders.includes(p)) state.folders.push(p);
  }
  renderFolders();
}

function renderFolders() {
  el.folders.replaceChildren(
    ...state.folders.map((path) =>
      h(
        "div",
        { class: "chip", title: path },
        h("span", {}, `‎${path}`),
        h("button", {
          type: "button",
          title: "Retirer ce dossier",
          textContent: "×",
          disabled: state.scanning,
          onclick: () => {
            state.folders = state.folders.filter((f) => f !== path);
            renderFolders();
          },
        }),
      ),
    ),
  );
  el.scan.disabled = !state.scanning && state.folders.length === 0;
}

el.addFolder.addEventListener("click", async () => {
  const picked = await api.pickFolders();
  if (picked) addFolders(Array.isArray(picked) ? picked : [picked]);
});

api.onDrop({
  enter: () => document.body.classList.add("dragging"),
  leave: () => document.body.classList.remove("dragging"),
  drop: (paths) => {
    document.body.classList.remove("dragging");
    if (!state.scanning) addFolders(paths);
  },
});

// ---------- analyse ----------

api.onProgress((p) => {
  if (!state.scanning) return;
  el.progressBar.style.width = `${Math.max(2, p.percent)}%`;
  let detail = "";
  if (p.bytesToCheck > 0) detail = ` — ${formatSize(p.bytesChecked)} / ${formatSize(p.bytesToCheck)}`;
  else if (p.entriesToCheck > 0) detail = ` — ${nfInt.format(p.entriesChecked)} / ${nfInt.format(p.entriesToCheck)}`;
  else if (p.entriesChecked > 0) detail = ` — ${plural(p.entriesChecked, "fichier", "fichiers")}`;
  el.progressLabel.textContent = p.stage + detail;
});

function setScanning(on) {
  state.scanning = on;
  el.scan.textContent = on ? "Arrêter" : "Analyser";
  el.scan.classList.toggle("primary", !on);
  el.addFolder.disabled = on;
  el.minSize.disabled = on;
  el.progress.hidden = !on;
  if (on) {
    el.progressBar.style.width = "2%";
    el.progressLabel.textContent = "Démarrage…";
  }
  renderFolders();
}

el.scan.addEventListener("click", async () => {
  if (state.scanning) {
    el.progressLabel.textContent = "Arrêt en cours…";
    api.stop();
    return;
  }
  setScanning(true);
  try {
    const result = await api.scan(state.folders, Number(el.minSize.value));
    // Le backend trie déjà ; on re-trie par sécurité (taille décroissante).
    state.groups = result.groups.sort((a, b) => b.size - a.size);
    state.checked.clear();
    state.current = null;
    state.lastScan = result;
    renderAll();
    renderPreview();
    if (result.stopped) toast("Analyse interrompue : résultats partiels.");
    else if (result.warnings.length) toast(`${plural(result.warnings.length, "avertissement", "avertissements")} — ${result.warnings[0]}`);
  } catch (err) {
    toast(String(err));
  } finally {
    setScanning(false);
  }
});

// ---------- liste des résultats ----------

function renderAll() {
  el.groups.replaceChildren();
  state.rendered = 0;
  el.list.scrollTop = 0;
  const scanned = Boolean(state.lastScan);
  el.empty.hidden = state.groups.length > 0;
  if (scanned && state.groups.length === 0) {
    el.empty.replaceChildren(
      h("p", { class: "empty-title" }, "Aucun doublon trouvé"),
      h("p", {}, "Aucun fichier identique dans les dossiers analysés avec ce filtre de taille."),
    );
  }
  renderMore();
  updateSummary();
  updateSelection();
}

function renderMore() {
  const end = Math.min(state.rendered + GROUPS_PER_BATCH, state.groups.length);
  const frag = document.createDocumentFragment();
  for (let i = state.rendered; i < end; i++) frag.append(renderGroup(state.groups[i], i));
  el.groups.append(frag);
  state.rendered = end;
}

new IntersectionObserver(
  (entries) => {
    if (entries[0].isIntersecting && state.rendered < state.groups.length) renderMore();
  },
  { root: el.list, rootMargin: "600px" },
).observe(el.sentinel);

function renderGroup(group, index) {
  const n = group.files.length;
  return h(
    "div",
    { class: "group", dataset: { index } },
    h(
      "div",
      { class: "group-head" },
      h("span", { class: "group-size" }, formatSize(group.size)),
      h("span", { class: "group-meta" }, `× ${n} copies`),
      h("span", { class: "spacer" }),
      h("span", { class: "group-meta" }, `${formatSize(group.size * (n - 1))} récupérables`),
    ),
    ...group.files.map((file) => renderRow(file)),
  );
}

function renderRow(file) {
  return h(
    "div",
    {
      class: `row${file.path === state.current ? " current" : ""}`,
      dataset: { path: file.path },
      onclick: (e) => {
        if (e.target.tagName !== "INPUT") select(file.path);
      },
      ondblclick: (e) => {
        if (e.target.tagName !== "INPUT") api.open(file.path).catch((err) => toast(String(err)));
      },
    },
    h("input", {
      type: "checkbox",
      checked: state.checked.has(file.path),
      title: "Cocher pour la corbeille",
      onchange: (e) => {
        if (e.target.checked) state.checked.add(file.path);
        else state.checked.delete(file.path);
        updateSelection();
      },
    }),
    h("span", { class: "name", title: file.name }, file.name),
    h("span", { class: "dir", title: file.dir }, file.dir),
    h("span", { class: "date" }, formatDate(file.modified)),
  );
}

function rowFor(path) {
  return el.groups.querySelector(`.row[data-path="${CSS.escape(path)}"]`);
}

function updateSummary() {
  if (!state.lastScan) return;
  const files = state.groups.reduce((s, g) => s + g.files.length, 0);
  const wasted = state.groups.reduce((s, g) => s + g.size * (g.files.length - 1), 0);
  el.summary.textContent = state.groups.length
    ? `${plural(state.groups.length, "groupe", "groupes")} · ${plural(files, "fichier", "fichiers")} · ${formatSize(wasted)} récupérables · triés par taille décroissante`
    : "Aucun doublon.";
  el.autoSelect.disabled = state.groups.length === 0;
}

function updateSelection() {
  const count = state.checked.size;
  let bytes = 0;
  if (count) {
    for (const g of state.groups) for (const f of g.files) if (state.checked.has(f.path)) bytes += g.size;
  }
  el.selectionInfo.textContent = count ? `${plural(count, "fichier coché", "fichiers cochés")} · ${formatSize(bytes)}` : "Aucun fichier coché";
  el.trash.disabled = count === 0;
  el.clearSelect.disabled = count === 0;
}

function syncCheckboxes() {
  for (const row of el.groups.querySelectorAll(".row")) {
    row.querySelector("input").checked = state.checked.has(row.dataset.path);
  }
  updateSelection();
}

el.autoSelect.addEventListener("click", () => {
  state.checked.clear();
  for (const g of state.groups) {
    // On conserve la copie la plus ancienne (l'originale probable).
    const keep = g.files.reduce((a, b) => (b.modified < a.modified ? b : a));
    for (const f of g.files) if (f !== keep) state.checked.add(f.path);
  }
  syncCheckboxes();
});

el.clearSelect.addEventListener("click", () => {
  state.checked.clear();
  syncCheckboxes();
});

el.trash.addEventListener("click", async () => {
  const paths = [...state.checked];
  const fullGroups = state.groups.filter((g) => g.files.every((f) => state.checked.has(f.path))).length;
  let message = `Mettre ${plural(paths.length, "fichier", "fichiers")} à la corbeille ?`;
  if (fullGroups) {
    message += `\n\nAttention : dans ${plural(fullGroups, "groupe", "groupes")}, toutes les copies sont cochées — il n'en restera aucun exemplaire hors de la corbeille.`;
  }
  if (!(await api.confirm(message, "Confirmer"))) return;

  el.trash.disabled = true;
  try {
    const outcomes = await api.trash(paths);
    const removed = new Set(outcomes.filter((o) => o.ok).map((o) => o.path));
    const failed = outcomes.filter((o) => !o.ok);
    for (const p of removed) state.checked.delete(p);
    state.groups = state.groups
      .map((g) => ({ ...g, files: g.files.filter((f) => !removed.has(f.path)) }))
      .filter((g) => g.files.length > 1);
    if (state.current && removed.has(state.current)) state.current = null;

    const scroll = el.list.scrollTop;
    const keep = Math.max(state.rendered, GROUPS_PER_BATCH);
    renderAll();
    while (state.rendered < Math.min(keep, state.groups.length)) renderMore();
    el.list.scrollTop = scroll;
    renderPreview();

    toast(
      failed.length
        ? `${plural(removed.size, "fichier déplacé", "fichiers déplacés")}, ${plural(failed.length, "échec", "échecs")} : ${failed[0].error}`
        : `${plural(removed.size, "fichier déplacé", "fichiers déplacés")} vers la corbeille.`,
    );
  } catch (err) {
    toast(String(err));
    updateSelection();
  }
});

// ---------- sélection et navigation clavier ----------

function select(path, { scroll = false } = {}) {
  if (state.current) rowFor(state.current)?.classList.remove("current");
  state.current = path;
  const row = rowFor(path);
  row?.classList.add("current");
  if (scroll) row?.scrollIntoView({ block: "nearest" });
  renderPreview();
}

el.list.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== " ") return;
  const rows = [...el.groups.querySelectorAll(".row")];
  if (!rows.length) return;
  e.preventDefault();
  const i = rows.findIndex((r) => r.dataset.path === state.current);
  if (e.key === " ") {
    if (i >= 0) rows[i].querySelector("input").click();
    return;
  }
  const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
  select(next.dataset.path, { scroll: true });
});

// ---------- aperçu (barre latérale droite) ----------

function findFile(path) {
  for (const group of state.groups) {
    const file = group.files.find((f) => f.path === path);
    if (file) return { group, file };
  }
  return null;
}

function genericPreview(ext, note) {
  return h("div", { class: "preview-generic" }, h("div", { class: "ext" }, ext || "?"), h("div", {}, note || "Pas d'aperçu pour ce type de fichier"));
}

async function buildMedia(file, token, media) {
  const ext = extension(file.name);
  const url = api.fileUrl(file.path);
  const fallback = () => {
    if (token === state.previewToken) media.replaceChildren(genericPreview(ext, "Aperçu impossible pour ce fichier"));
  };

  if (IMAGE.has(ext)) {
    media.replaceChildren(h("img", { src: url, alt: file.name, onerror: fallback }));
  } else if (VIDEO.has(ext)) {
    media.replaceChildren(h("video", { src: url, controls: true, preload: "metadata", onerror: fallback }));
  } else if (AUDIO.has(ext)) {
    media.replaceChildren(h("audio", { src: url, controls: true, preload: "metadata", onerror: fallback }));
  } else if (ext === "pdf") {
    media.replaceChildren(h("iframe", { src: url, title: file.name }));
  } else if (BINARY.has(ext)) {
    media.replaceChildren(genericPreview(ext));
  } else {
    media.replaceChildren(genericPreview(ext, "Chargement…"));
    try {
      const preview = await api.textPreview(file.path);
      if (token !== state.previewToken) return;
      if (preview.binary) media.replaceChildren(genericPreview(ext));
      else media.replaceChildren(h("pre", {}, preview.text + (preview.truncated ? "\n\n… (aperçu tronqué)" : "")));
    } catch {
      fallback();
    }
  }
}

function renderPreview() {
  const token = ++state.previewToken;
  const found = state.current && findFile(state.current);
  if (!found) {
    el.preview.replaceChildren(h("div", { class: "preview-empty" }, "Sélectionnez un fichier pour afficher son aperçu."));
    return;
  }
  const { group, file } = found;
  const media = h("div", { class: "preview-media" });
  const created = h("dd", {}, "…");

  el.preview.replaceChildren(
    media,
    h(
      "div",
      { class: "preview-body" },
      h("h2", { class: "preview-name" }, file.name),
      h(
        "dl",
        { class: "meta" },
        h("dt", {}, "Taille"),
        h("dd", {}, `${formatSize(group.size)} (${nfInt.format(group.size)} octets)`),
        h("dt", {}, "Dossier"),
        h("dd", {}, file.dir),
        h("dt", {}, "Modifié"),
        h("dd", {}, formatDate(file.modified)),
        h("dt", {}, "Créé"),
        created,
        h("dt", {}, "Empreinte"),
        h("dd", { title: group.hash }, group.hash ? `${group.hash.slice(0, 16)}…` : "—"),
      ),
      h(
        "div",
        { class: "preview-actions" },
        h("button", { class: "btn small", type: "button", onclick: () => api.open(file.path).catch((e) => toast(String(e))) }, "Ouvrir"),
        h("button", { class: "btn small", type: "button", onclick: () => api.reveal(file.path).catch((e) => toast(String(e))) }, "Afficher dans le dossier"),
      ),
      h("h3", { class: "copies-title" }, `${group.files.length} copies identiques`),
      h(
        "ul",
        { class: "copies" },
        ...group.files.map((f) =>
          h("li", { class: f.path === file.path ? "current" : "", title: f.path, onclick: () => select(f.path, { scroll: true }) }, f.path),
        ),
      ),
    ),
  );

  buildMedia(file, token, media);
  api
    .details(file.path)
    .then((d) => {
      if (token === state.previewToken) created.textContent = formatDate(d.created);
    })
    .catch(() => {
      if (token === state.previewToken) created.textContent = "—";
    });
}

renderFolders();
