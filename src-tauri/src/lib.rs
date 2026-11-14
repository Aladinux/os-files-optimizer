//! Backend de OS Files Optimizer.
//!
//! La détection des doublons est déléguée à `czkawka_core` (moteur de
//! https://github.com/qarmin/czkawka, licence MIT) : regroupement par taille,
//! pré-hachage des premiers octets, puis hachage complet Blake3.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use czkawka_core::common::config_cache_path::set_config_cache_path;
use czkawka_core::common::model::{CheckingMethod, HashType};
use czkawka_core::common::progress_data::{DuplicateStage, ProgressData, ToolStage};
use czkawka_core::common::set_number_of_threads;
use czkawka_core::common::tool_data::CommonData;
use czkawka_core::common::traits::Search;
use czkawka_core::tools::duplicate::{DuplicateFinder, DuplicateFinderParameters};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const CACHE_MIN_FILE_SIZE: u64 = 256 * 1024;
const TEXT_PREVIEW_MAX_BYTES: u64 = 256 * 1024;

#[derive(Default)]
struct ScanState {
    stop: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileItem {
    path: String,
    name: String,
    dir: String,
    modified: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DuplicateGroup {
    size: u64,
    hash: String,
    files: Vec<FileItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    groups: Vec<DuplicateGroup>,
    stopped: bool,
    duration_ms: u64,
    warnings: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    stage: &'static str,
    percent: i32,
    entries_checked: usize,
    entries_to_check: usize,
    bytes_checked: u64,
    bytes_to_check: u64,
}

fn stage_label(stage: ToolStage) -> &'static str {
    match stage {
        ToolStage::CollectingFiles(_) => "Recensement des fichiers",
        ToolStage::Duplicate(s) => match s {
            DuplicateStage::HidingHardLinks => "Filtrage des liens physiques",
            DuplicateStage::LoadingPreHashCache(_) | DuplicateStage::LoadingHashCache(_) => "Chargement du cache",
            DuplicateStage::PreHashing => "Pré-hachage (début des fichiers)",
            DuplicateStage::SavingPreHashCache | DuplicateStage::SavingHashCache => "Enregistrement du cache",
            DuplicateStage::FullHashing => "Hachage complet du contenu",
        },
        _ => "Analyse",
    }
}

fn to_file_item(path: &Path, modified: u64) -> FileItem {
    FileItem {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        dir: path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        modified,
    }
}

/// Recherche les doublons avec czkawka_core et renvoie les groupes par taille décroissante.
fn find_duplicates(paths: &[String], min_size: u64, stop: &Arc<AtomicBool>, progress: Option<&crossbeam_channel::Sender<ProgressData>>) -> ScanResult {
    let params = DuplicateFinderParameters::new(CheckingMethod::Hash, HashType::Blake3, true, CACHE_MIN_FILE_SIZE, CACHE_MIN_FILE_SIZE, false);
    let mut finder = DuplicateFinder::new(params);
    finder.set_included_paths(paths.iter().map(PathBuf::from).collect());
    finder.set_recursive_search(true);
    finder.set_minimal_file_size(min_size.max(1));
    finder.set_hide_hard_links(true);
    finder.set_use_cache(true);

    let started = std::time::Instant::now();
    finder.search(stop, progress);
    // BTreeMap trié par taille croissante : on inverse pour obtenir la taille décroissante.
    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for (size, same_size) in finder.get_files_sorted_by_hash().iter().rev() {
        for entries in same_size {
            if entries.len() < 2 {
                continue;
            }
            let mut files: Vec<FileItem> = entries.iter().map(|e| to_file_item(&e.path, e.modified_date)).collect();
            files.sort_by(|a, b| a.path.cmp(&b.path));
            groups.push(DuplicateGroup {
                size: *size,
                hash: entries[0].hash.clone(),
                files,
            });
        }
    }

    let messages = finder.get_text_messages();
    let mut warnings = messages.warnings.clone();
    warnings.extend(messages.errors.iter().cloned());
    if let Some(critical) = &messages.critical {
        warnings.insert(0, critical.clone());
    }

    ScanResult {
        groups,
        stopped: finder.get_stopped_search(),
        duration_ms: started.elapsed().as_millis() as u64,
        warnings,
    }
}

/// Lance la recherche de doublons sur plusieurs dossiers (éventuellement sur
/// des disques différents). Les groupes sont renvoyés par taille décroissante.
#[tauri::command]
async fn scan_duplicates(app: AppHandle, state: State<'_, ScanState>, paths: Vec<String>, min_size: u64) -> Result<ScanResult, String> {
    if paths.is_empty() {
        return Err("Ajoutez au moins un dossier à analyser.".into());
    }
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("Une analyse est déjà en cours.".into());
    }
    let stop = state.stop.clone();
    let running = state.running.clone();
    stop.store(false, Ordering::SeqCst);

    let result = tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = crossbeam_channel::unbounded::<ProgressData>();
        let progress_app = app.clone();
        let forwarder = std::thread::spawn(move || {
            for p in rx {
                let _ = progress_app.emit(
                    "scan-progress",
                    ProgressPayload {
                        stage: stage_label(p.stage),
                        percent: p.all_progress(),
                        entries_checked: p.entries_checked,
                        entries_to_check: p.entries_to_check,
                        bytes_checked: p.bytes_checked,
                        bytes_to_check: p.bytes_to_check,
                    },
                );
            }
        });

        let result = find_duplicates(&paths, min_size, &stop, Some(&tx));
        drop(tx);
        let _ = forwarder.join();
        result
    })
    .await;

    running.store(false, Ordering::SeqCst);
    result.map_err(|e| format!("L'analyse a échoué : {e}"))
}

#[tauri::command]
fn stop_scan(state: State<'_, ScanState>) {
    state.stop.store(true, Ordering::SeqCst);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDetails {
    size: u64,
    modified: Option<u64>,
    created: Option<u64>,
    readonly: bool,
}

fn secs(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs())
}

#[tauri::command]
fn file_details(path: String) -> Result<FileDetails, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(FileDetails {
        size: meta.len(),
        modified: secs(meta.modified()),
        created: secs(meta.created()),
        readonly: meta.permissions().readonly(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextPreview {
    text: String,
    truncated: bool,
    binary: bool,
}

/// Lit le début d'un fichier pour l'aperçu texte de la barre latérale.
#[tauri::command]
fn read_text_preview(path: String) -> Result<TextPreview, String> {
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut buf = Vec::new();
    file.take(TEXT_PREVIEW_MAX_BYTES).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let binary = buf.iter().take(8192).any(|b| *b == 0);
    Ok(TextPreview {
        text: if binary { String::new() } else { String::from_utf8_lossy(&buf).into_owned() },
        truncated: total > buf.len() as u64,
        binary,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashOutcome {
    path: String,
    ok: bool,
    error: Option<String>,
}

/// Envoie les fichiers à la corbeille du système (récupérables), jamais de suppression définitive.
#[tauri::command]
async fn move_to_trash(paths: Vec<String>) -> Result<Vec<TrashOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| match trash::delete(&path) {
                Ok(()) => TrashOutcome { path, ok: true, error: None },
                Err(e) => TrashOutcome {
                    path,
                    ok: false,
                    error: Some(e.to_string()),
                },
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialisations exigées par czkawka_core avant toute analyse.
    set_number_of_threads(0);
    let _ = set_config_cache_path("OSFilesOptimizer", "OSFilesOptimizer");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ScanState::default())
        .invoke_handler(tauri::generate_handler![
            scan_duplicates,
            stop_scan,
            file_details,
            read_text_preview,
            move_to_trash,
            open_file,
            reveal_file
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_duplicates_across_folders_sorted_by_size_desc() {
        set_number_of_threads(0);
        let _ = set_config_cache_path("OSFilesOptimizer", "OSFilesOptimizer");
        let root = std::env::temp_dir().join(format!("ofo-test-{}", std::process::id()));
        let (a, b) = (root.join("disque_a"), root.join("disque_b/sous"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let big = vec![7u8; 300_000];
        let small = vec![3u8; 5_000];
        fs::write(a.join("gros.bin"), &big).unwrap();
        fs::write(b.join("gros-copie.bin"), &big).unwrap();
        fs::write(a.join("petit.txt"), &small).unwrap();
        fs::write(b.join("petit.txt"), &small).unwrap();
        fs::write(a.join("petit-bis.txt"), &small).unwrap();
        // Même taille que "gros" mais contenu différent : ne doit pas être signalé.
        fs::write(b.join("unique.bin"), vec![9u8; 300_000]).unwrap();

        let paths = vec![a.to_string_lossy().into_owned(), root.join("disque_b").to_string_lossy().into_owned()];
        let mut finder_result = find_duplicates(&paths, 1, &Arc::new(AtomicBool::new(false)), None);
        fs::remove_dir_all(&root).unwrap();

        assert!(!finder_result.stopped);
        assert_eq!(finder_result.groups.len(), 2);
        let first = finder_result.groups.remove(0);
        let second = finder_result.groups.remove(0);
        assert_eq!((first.size, first.files.len()), (300_000, 2));
        assert_eq!((second.size, second.files.len()), (5_000, 3));
        assert!(first.files.iter().all(|f| !f.name.contains("unique")));
    }
}
