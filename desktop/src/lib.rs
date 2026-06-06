use parking_lot::Mutex;
use pdf_core::pdf::document::DocumentMeta;
use pdf_core::pdf::tile_manager::{TileData, TileKey, TileManager, TileQueueState, TILE_SIZE_PX};
use pdf_core::render::worker::{create_tile_manager_with_workers, PreviewData};
use pdf_core::viewport::state::ViewportState;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::mpsc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct AppState {
    pub pdfium_lib_path: String,
    pub tile_cache_dir: String,
    pub renderer_path: String,
    pub open_document: Arc<Mutex<Option<DocumentMeta>>>,
    pub tile_manager: Arc<TileManager>,
    pub render_context: Arc<Mutex<Option<(u32, u8)>>>,
    pub active_project: Arc<Mutex<Option<ActiveProject>>>,
    pub recent_projects: Arc<Mutex<Vec<RecentProject>>>,
    pub registry_db: SqlitePool,
    pub renderer: Arc<Mutex<Option<RendererService>>>,
    pub tile_render_tx: mpsc::UnboundedSender<TileRenderJob>,
    pub next_tile_batch: AtomicU64,
}

#[derive(Clone)]
pub struct TileRenderJob {
    key: TileKey,
    generation: u64,
    dpi: f32,
    pdf_path: String,
    cache_dir: String,
    batch_id: u64,
    order: usize,
}

pub struct RendererService {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: AtomicU64,
}

impl RendererService {
    pub fn spawn(renderer_path: &str, pdfium_lib_path: &str) -> Result<Self, String> {
        use std::process::Stdio;

        let mut cmd = std::process::Command::new(renderer_path);
        cmd.arg(pdfium_lib_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn renderer: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Renderer stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Renderer stdout unavailable".to_string())?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: AtomicU64::new(1),
        })
    }

    pub fn request(&mut self, mut payload: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        payload["id"] = serde_json::json!(id);

        let line = serde_json::to_string(&payload).map_err(|e| format!("Serialise error: {e}"))?;
        writeln!(self.stdin, "{line}").map_err(|e| format!("Renderer stdin write error: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("Renderer stdin flush error: {e}"))?;

        loop {
            let mut response_line = String::new();
            let bytes_read = self
                .stdout
                .read_line(&mut response_line)
                .map_err(|e| format!("Renderer stdout read error: {e}"))?;
            if bytes_read == 0 {
                return Err("Renderer stdout closed".to_string());
            }
            if response_line.trim().is_empty() {
                continue;
            }

            let response: serde_json::Value = serde_json::from_str(response_line.trim())
                .map_err(|e| format!("Response parse error: {e}"))?;
            if response["id"].as_u64() == Some(id) {
                if response["ok"].as_bool() == Some(true) {
                    return Ok(response["data"].clone());
                }
                return Err(response["error"]
                    .as_str()
                    .unwrap_or("unknown renderer error")
                    .to_string());
            }
        }
    }

    pub fn shutdown(&mut self) {
        let _ = self.request(serde_json::json!({ "cmd": "shutdown" }));
        let _ = self.child.wait();
    }
}

impl Drop for RendererService {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, "{{\"id\":0,\"cmd\":\"shutdown\"}}");
        let _ = self.stdin.flush();
        let _ = self.child.wait();
    }
}

pub struct ActiveProject {
    pub meta: ProjectMeta,
    pub db: SqlitePool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ProjectMeta {
    pub name: String,
    pub client: String,
    pub contract_number: String,
    pub status: String,
    pub file_path: String,
    pub created_at: String,
    pub last_opened_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct RecentProject {
    pub name: String,
    pub client: String,
    pub contract_number: String,
    pub status: String,
    pub file_path: String,
    pub last_opened_at: String,
    pub file_exists: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct VectorPrimitive {
    #[serde(rename = "type")]
    pub primitive_type: String,
    pub x1: Option<f64>,
    pub y1: Option<f64>,
    pub x2: Option<f64>,
    pub y2: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PageVectors {
    pub page: u32,
    pub primitives: Vec<VectorPrimitive>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct TreeNodeDto {
    pub id: i64,
    pub tree: String,
    pub node_type: String,
    pub parent_id: Option<i64>,
    pub name: String,
    pub sort_order: i64,
    pub has_children: bool,
    pub file_path: Option<String>,
    pub page_count: Option<i64>,
    pub uom: Option<String>,
    pub colour: Option<String>,
    /// Framing size (e.g. "90x45") for a timber-framing dimension group; `None` otherwise.
    /// Surfaced on the node so the tree row can show it without loading the group's props.
    pub framing_size: Option<String>,
    /// Measurement type from dimension_group_props for dimension_group nodes; `None` for all
    /// other node types. Surfaced here so icons can be shown without loading full props.
    pub measurement_type: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct MeasurementDto {
    pub id: i64,
    pub dimension_group_id: i64,
    pub drawing_id: i64,
    pub page_index: i64,
    pub measurement_type: String,
    pub geometry_json: String,
    pub polarity: i64,
    pub quantity: Option<f64>,
    pub uom: Option<String>,
    /// Per-wall timber-framing extras (door/window openings, raking, manual studs) as an opaque
    /// JSON blob; `None` for non-framing measurements. The frontend owns the shape.
    pub framing_json: Option<String>,
}

/// Per-drawing-page scale. `mm_per_point` converts PDF points to real-world millimetres
/// (the canonical internal unit); `unit` is the user's preferred display unit (e.g. "m").
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PageScaleDto {
    pub drawing_id: i64,
    pub page_index: i64,
    pub mm_per_point: f64,
    pub unit: String,
}

/// CostX-style dimension-group properties. Width/height/offset are in metres (the unit
/// the dialog edits); multiplier is unitless. `measurement_type` is how dimensions are
/// drawn; `default_display` is how the quantity is derived (see the derivation matrix).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DimensionGroupPropsDto {
    pub node_id: i64,
    pub measurement_type: String,
    pub default_display: String,
    pub default_multiplier: f64,
    pub default_width: f64,
    pub default_height: f64,
    pub default_offset: f64,
    pub add_to_gfa: bool,
    pub pos_colour: String,
    pub pos_style: String,
    pub neg_colour: String,
    pub neg_style: String,
    pub weight_uom: Option<String>,
    /// Timber-framing settings (framing size, stud spacing, plate config, wall height, dwang
    /// centres) as an opaque JSON blob. `None` for non-framing groups. The frontend owns the
    /// shape; the backend stores and round-trips it without interpreting it.
    pub framing_props_json: Option<String>,
}

/// A selectable destination folder in the dimensions tree, with its full `/`-joined path.
#[derive(serde::Serialize, Clone, Debug)]
pub struct FolderOptionDto {
    pub id: i64,
    pub path: String,
}

/// A single on-page vertex in PDF points, Y-up. Used to validate `geometry_json`.
#[derive(serde::Deserialize)]
struct GeometryPoint {
    #[allow(dead_code)]
    x: f64,
    #[allow(dead_code)]
    y: f64,
}

fn active_project_db(state: &AppState) -> Result<SqlitePool, String> {
    state
        .active_project
        .lock()
        .as_ref()
        .map(|project| project.db.clone())
        .ok_or_else(|| "No project open".to_string())
}

fn restart_renderer(state: &AppState) -> Result<(), String> {
    let mut renderer_guard = state.renderer.lock();
    if let Some(mut old) = renderer_guard.take() {
        old.shutdown();
    }
    *renderer_guard = Some(
        RendererService::spawn(&state.renderer_path, &state.pdfium_lib_path)
            .map_err(|e| format!("Failed to start renderer: {e}"))?,
    );
    Ok(())
}

fn load_document_meta_via_renderer(
    renderer: &Arc<Mutex<Option<RendererService>>>,
    document_path: &str,
) -> Result<DocumentMeta, String> {
    let request = serde_json::json!({
        "cmd": "meta",
        "pdf_path": document_path,
    });

    let data = {
        let mut renderer = renderer.lock();
        renderer
            .as_mut()
            .ok_or("Renderer not running")?
            .request(request)?
    };

    serde_json::from_value::<DocumentMeta>(data)
        .map_err(|e| format!("DocumentMeta deserialise error: {e}"))
}

#[tauri::command]
async fn get_active_project(state: State<'_, AppState>) -> Result<Option<ProjectMeta>, String> {
    Ok(state
        .active_project
        .lock()
        .as_ref()
        .map(|project| project.meta.clone()))
}

#[tauri::command]
async fn get_recent_projects(state: State<'_, AppState>) -> Result<Vec<RecentProject>, String> {
    let projects = state
        .recent_projects
        .lock()
        .iter()
        .cloned()
        .map(|mut project| {
            project.file_exists = Path::new(&project.file_path).exists();
            project
        })
        .collect();
    Ok(projects)
}

#[tauri::command]
async fn create_project(
    name: String,
    client: String,
    contract_number: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<ProjectMeta, String> {
    let name = clean_required_field(&name, "Project name")?;
    let client = clean_required_field(&client, "Client")?;
    let contract_number = clean_required_field(&contract_number, "Contract number")?;
    let file_path = clean_project_file_path(&file_path)?;

    let db = init_database(Path::new(&file_path)).await?;

    sqlx::query(
        r#"
        INSERT INTO project_meta (id, name, client, contract_number)
        VALUES (1, ?, ?, ?)
        "#,
    )
    .bind(&name)
    .bind(&client)
    .bind(&contract_number)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to create project metadata: {e}"))?;

    let meta = read_project_meta(&db, &file_path).await?;
    upsert_recent_project(&state.registry_db, &meta).await?;
    refresh_recent_projects(state.inner()).await?;

    *state.active_project.lock() = Some(ActiveProject {
        meta: meta.clone(),
        db,
    });
    restart_renderer(&state)?;

    Ok(meta)
}

#[tauri::command]
async fn open_project(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<ProjectMeta, String> {
    let file_path = clean_project_file_path(&file_path)?;
    if !Path::new(&file_path).exists() {
        return Err("Project file not found".to_string());
    }

    let db = init_database(Path::new(&file_path)).await?;
    sqlx::query("UPDATE project_meta SET last_opened_at = datetime('now') WHERE id = 1")
        .execute(&db)
        .await
        .map_err(|e| format!("Failed to update project last opened time: {e}"))?;

    let meta = read_project_meta(&db, &file_path).await?;
    upsert_recent_project(&state.registry_db, &meta).await?;
    refresh_recent_projects(state.inner()).await?;

    *state.active_project.lock() = Some(ActiveProject {
        meta: meta.clone(),
        db,
    });
    restart_renderer(&state)?;

    Ok(meta)
}

#[tauri::command]
async fn close_project(state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut renderer_guard = state.renderer.lock();
        if let Some(mut svc) = renderer_guard.take() {
            svc.shutdown();
        }
    }
    *state.active_project.lock() = None;
    *state.open_document.lock() = None;
    *state.render_context.lock() = None;
    state.tile_manager.clear();
    let _ = std::fs::remove_dir_all(&state.tile_cache_dir);
    let _ = std::fs::create_dir_all(&state.tile_cache_dir);
    refresh_recent_projects(state.inner()).await?;
    Ok(())
}

#[tauri::command]
async fn remove_recent_project(file_path: String, state: State<'_, AppState>) -> Result<(), String> {
    sqlx::query("DELETE FROM recent_projects WHERE file_path = ?")
        .bind(&file_path)
        .execute(&state.registry_db)
        .await
        .map_err(|e| format!("Failed to remove recent project: {e}"))?;
    refresh_recent_projects(state.inner()).await
}

#[tauri::command]
async fn export_project(dest_path: String, state: State<'_, AppState>) -> Result<(), String> {
    let src_path = {
        let guard = state.active_project.lock();
        guard.as_ref().ok_or("No project open")?.meta.file_path.clone()
    };
    std::fs::copy(&src_path, &dest_path).map_err(|e| format!("Failed to export project: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn update_project_meta(
    name: String,
    client: String,
    contract_number: String,
    status: String,
    state: State<'_, AppState>,
) -> Result<ProjectMeta, String> {
    let name = clean_required_field(&name, "Project name")?;
    let client = clean_required_field(&client, "Client")?;
    let contract_number = clean_required_field(&contract_number, "Contract number")?;
    let status = clean_required_field(&status, "Status")?;

    let db = active_project_db(&state)?;
    sqlx::query("UPDATE project_meta SET name = ?, client = ?, contract_number = ?, status = ? WHERE id = 1")
        .bind(&name)
        .bind(&client)
        .bind(&contract_number)
        .bind(&status)
        .execute(&db)
        .await
        .map_err(|e| format!("Failed to update project metadata: {e}"))?;

    let file_path = {
        let guard = state.active_project.lock();
        guard.as_ref().ok_or("No project open")?.meta.file_path.clone()
    };
    let meta = read_project_meta(&db, &file_path).await?;

    {
        let mut guard = state.active_project.lock();
        if let Some(project) = guard.as_mut() {
            project.meta = meta.clone();
        }
    }

    upsert_recent_project(&state.registry_db, &meta).await?;
    refresh_recent_projects(state.inner()).await?;

    Ok(meta)
}

#[tauri::command]
fn open_document(path: String, state: State<'_, AppState>) -> Result<DocumentMeta, String> {
    let meta = load_document_meta_via_renderer(&state.renderer, &path)?;
    *state.open_document.lock() = Some(meta.clone());
    let _ = std::fs::remove_dir_all(&state.tile_cache_dir);
    let _ = std::fs::create_dir_all(&state.tile_cache_dir);
    *state.render_context.lock() = None;
    state.tile_manager.clear();
    Ok(meta)
}

/// Extracts vector primitives from a page via the renderer service.
/// Returns line and rect primitives in PDF point coordinates.
#[tauri::command]
async fn get_page_vectors(
    page_index: u32,
    state: State<'_, AppState>,
) -> Result<PageVectors, String> {
    let doc_path = {
        let guard = state.open_document.lock();
        guard.as_ref().ok_or("No document open")?.path.clone()
    };
    let renderer = Arc::clone(&state.renderer);

    let data = tauri::async_runtime::spawn_blocking(move || {
        let request = serde_json::json!({
            "cmd": "vectors",
            "pdf_path": doc_path,
            "page": page_index,
        });

        let mut renderer = renderer.lock();
        renderer
            .as_mut()
            .ok_or("Renderer not running")?
            .request(request)
    })
    .await
    .map_err(|e| format!("Vectors worker failed: {e}"))??;

    serde_json::from_value::<PageVectors>(data)
        .map_err(|e| format!("PageVectors deserialise error: {e}"))
}

#[tauri::command]
async fn render_preview(
    page_index: u32,
    state: State<'_, AppState>,
) -> Result<PreviewData, String> {
    let (doc_path, output_path) = {
        let guard = state.open_document.lock();
        let doc = guard.as_ref().ok_or("No document open")?;
        let out = std::path::Path::new(&state.tile_cache_dir)
            .join(format!("preview_page_{page_index}.png"))
            .to_string_lossy()
            .to_string();
        (doc.path.clone(), out)
    };
    let renderer = Arc::clone(&state.renderer);

    let data = tauri::async_runtime::spawn_blocking(move || {
        let request = serde_json::json!({
            "cmd": "preview",
            "pdf_path": doc_path,
            "page": page_index,
            "max_dim": 1200,
            "output_path": output_path,
        });

        let mut renderer = renderer.lock();
        renderer
            .as_mut()
            .ok_or("Renderer not running")?
            .request(request)
    })
    .await
    .map_err(|e| format!("Preview worker failed: {e}"))??;

    serde_json::from_value::<PreviewData>(data)
        .map_err(|e| format!("PreviewData deserialise error: {e}"))
}

#[tauri::command]
fn update_viewport(
    viewport: ViewportState,
    state: State<'_, AppState>,
) -> Result<Vec<TileData>, String> {
    let doc = state
        .open_document
        .lock()
        .as_ref()
        .ok_or("No document open")?
        .clone();

    let page = doc
        .pages
        .get(viewport.page_index as usize)
        .ok_or("Page not found")?;
    let zoom_level = ViewportState::zoom_bucket(viewport.zoom);
    {
        let mut render_context = state.render_context.lock();
        let next_context = (viewport.page_index, zoom_level);
        if render_context.as_ref() != Some(&next_context) {
            state.tile_manager.advance_generation();
            *render_context = Some(next_context);
        }
    }

    let bucket_zoom = ViewportState::bucket_zoom(zoom_level);
    let display_scale = viewport.zoom / bucket_zoom;
    let bucket_viewport = ViewportState {
        page_index: viewport.page_index,
        zoom: bucket_zoom,
        pan_x: viewport.pan_x / display_scale,
        pan_y: viewport.pan_y / display_scale,
        width: ((viewport.width as f64) / display_scale).ceil().max(1.0) as u32,
        height: ((viewport.height as f64) / display_scale).ceil().max(1.0) as u32,
    };
    let page_width_px = bucket_viewport.page_width_px(page.width_pts);
    let page_height_px = bucket_viewport.page_height_px(page.height_pts);

    state.tile_manager.drain_completed();

    let keys = bucket_viewport.visible_tiles(page_width_px, page_height_px);
    let batch_id = state.next_tile_batch.fetch_add(1, Ordering::SeqCst);

    let mut tiles = Vec::new();
    for (order, key) in keys.into_iter().enumerate() {
        match state.tile_manager.get_cached_or_mark_queued(key) {
            TileQueueState::Cached(tile) => tiles.push(tile),
            TileQueueState::Queued { generation, dpi }
            | TileQueueState::AlreadyQueued { generation, dpi } => {
                let _ = state.tile_render_tx.send(TileRenderJob {
                    key,
                    generation,
                    dpi,
                    pdf_path: doc.path.clone(),
                    cache_dir: state.tile_cache_dir.clone(),
                    batch_id,
                    order,
                });
            }
        }
    }

    Ok(tiles)
}

fn render_tile_via_renderer(
    renderer: Arc<Mutex<Option<RendererService>>>,
    key: TileKey,
    generation: u64,
    dpi: f32,
    pdf_path: String,
    cache_dir: String,
) -> Result<TileData, String> {
    let tile_px_x = key.tile_x * TILE_SIZE_PX;
    let tile_px_y = key.tile_y * TILE_SIZE_PX;
    let image_path = Path::new(&cache_dir)
        .join(format!(
            "g{}_p{}_z{}_x{}_y{}.png",
            generation, key.page, key.zoom_level, key.tile_x, key.tile_y
        ))
        .to_string_lossy()
        .to_string();

    let request = serde_json::json!({
        "cmd": "tile",
        "pdf_path": pdf_path,
        "page": key.page,
        "dpi": dpi,
        "tile_x": key.tile_x,
        "tile_y": key.tile_y,
        "output_path": image_path,
        "generation": generation,
    });

    {
        let mut renderer = renderer.lock();
        renderer
            .as_mut()
            .ok_or("Renderer not running")?
            .request(request)?;
    }

    Ok(TileData {
        key,
        image_path,
        x: tile_px_x,
        y: tile_px_y,
        generation,
    })
}

async fn run_tile_render_worker(
    mut rx: mpsc::UnboundedReceiver<TileRenderJob>,
    renderer: Arc<Mutex<Option<RendererService>>>,
    tile_manager: Arc<TileManager>,
) {
    let mut pending = Vec::<TileRenderJob>::new();

    loop {
        if pending.is_empty() {
            let Some(job) = rx.recv().await else {
                break;
            };
            upsert_pending_tile_job(&mut pending, job);
        }

        while let Ok(job) = rx.try_recv() {
            upsert_pending_tile_job(&mut pending, job);
        }

        let Some(job) = pop_next_tile_job(&mut pending) else {
            continue;
        };

        if tile_manager.get_cached(&job.key).is_some() {
            tile_manager.fail_render(&job.key);
            continue;
        }

        if job.generation != tile_manager.current_generation() {
            tile_manager.fail_render(&job.key);
            continue;
        }

        let renderer = Arc::clone(&renderer);
        let key = job.key;
        let generation = job.generation;
        let result = tauri::async_runtime::spawn_blocking(move || {
            render_tile_via_renderer(
                renderer,
                key,
                generation,
                job.dpi,
                job.pdf_path,
                job.cache_dir,
            )
        })
        .await
        .map_err(|e| format!("Tile worker failed: {e}"))
        .and_then(|result| result);

        match result {
            Ok(tile) => tile_manager.complete_render(tile),
            Err(error) => {
                tile_manager.fail_render(&key);
                tracing::error!("Tile render failed: {}", error);
            }
        }
    }
}

fn upsert_pending_tile_job(pending: &mut Vec<TileRenderJob>, job: TileRenderJob) {
    if let Some(existing) = pending.iter_mut().find(|existing| existing.key == job.key) {
        if job.generation > existing.generation
            || job.batch_id > existing.batch_id
            || (job.batch_id == existing.batch_id && job.order < existing.order)
        {
            *existing = job;
        }
    } else {
        pending.push(job);
    }
}

fn pop_next_tile_job(pending: &mut Vec<TileRenderJob>) -> Option<TileRenderJob> {
    let mut best_index = None;
    for (index, job) in pending.iter().enumerate() {
        let is_better = best_index
            .map(|best_index| {
                let best: &TileRenderJob = &pending[best_index];
                job.batch_id > best.batch_id
                    || (job.batch_id == best.batch_id && job.order < best.order)
            })
            .unwrap_or(true);
        if is_better {
            best_index = Some(index);
        }
    }

    best_index.map(|index| pending.swap_remove(index))
}

#[tauri::command]
fn poll_tiles(state: State<'_, AppState>) -> Result<Vec<TileData>, String> {
    Ok(state.tile_manager.drain_completed())
}

#[tauri::command]
async fn get_root_nodes(
    tree: String,
    state: State<'_, AppState>,
) -> Result<Vec<TreeNodeDto>, String> {
    let db = active_project_db(&state)?;
    query_tree_nodes(&db, Some(&tree), None).await
}

#[tauri::command]
async fn get_children(
    parent_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<TreeNodeDto>, String> {
    let db = active_project_db(&state)?;
    query_tree_nodes(&db, None, Some(parent_id)).await
}

#[tauri::command]
async fn add_drawing(
    parent_id: Option<i64>,
    name: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<TreeNodeDto, String> {
    let db = active_project_db(&state)?;
    let page_count =
        i64::from(load_document_meta_via_renderer(&state.renderer, &file_path)?.page_count);

    let sort_order: i64 = match parent_id {
        Some(parent_id) => {
            sqlx::query_scalar(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM tree_nodes WHERE parent_id = ?",
            )
            .bind(parent_id)
            .fetch_one(&db)
            .await
        }
        None => {
            sqlx::query_scalar(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM tree_nodes WHERE tree = 'drawings' AND parent_id IS NULL",
            )
            .fetch_one(&db)
            .await
        }
    }
    .map_err(|e| format!("Failed to allocate drawing sort order: {e}"))?;

    let result = sqlx::query(
        r#"
        INSERT INTO tree_nodes
            (tree, node_type, parent_id, name, sort_order, file_path, page_count, uom)
        VALUES
            ('drawings', 'drawing', ?, ?, ?, ?, ?, 'mm')
        "#,
    )
    .bind(parent_id)
    .bind(name)
    .bind(sort_order)
    .bind(file_path)
    .bind(page_count)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to add drawing: {e}"))?;

    get_tree_node(&db, result.last_insert_rowid()).await
}

#[tauri::command]
async fn create_folder(
    tree: String,
    parent_id: Option<i64>,
    name: String,
    state: State<'_, AppState>,
) -> Result<TreeNodeDto, String> {
    let db = active_project_db(&state)?;
    let name = clean_node_name(&name)?;
    let sort_order = next_sort_order(&db, &tree, parent_id).await?;

    let result = sqlx::query(
        r#"
        INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
        VALUES (?, 'folder', ?, ?, ?)
        "#,
    )
    .bind(tree)
    .bind(parent_id)
    .bind(name)
    .bind(sort_order)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to create folder: {e}"))?;

    get_tree_node(&db, result.last_insert_rowid()).await
}

#[tauri::command]
async fn create_dimension_group(
    parent_id: Option<i64>,
    name: String,
    colour: String,
    measurement_type: Option<String>,
    state: State<'_, AppState>,
) -> Result<TreeNodeDto, String> {
    let db = active_project_db(&state)?;
    if let Some(parent_id) = parent_id {
        verify_node_type(&db, parent_id, "folder").await?;
    } else {
        return Err("Dimension groups must be created under a folder".to_string());
    }

    let name = clean_node_name(&name)?;
    let colour = clean_colour(&colour)?;
    let mtype = measurement_type.unwrap_or_else(|| "length".to_string());
    if !MEASUREMENT_TYPES.contains(&mtype.as_str()) {
        return Err(format!("Unsupported measurement_type: {mtype}"));
    }
    let sort_order = next_sort_order(&db, "dimensions", parent_id).await?;

    let result = sqlx::query(
        r#"
        INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order, colour)
        VALUES ('dimensions', 'dimension_group', ?, ?, ?, ?)
        "#,
    )
    .bind(parent_id)
    .bind(name)
    .bind(sort_order)
    .bind(&colour)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to create dimension group: {e}"))?;

    let node_id = result.last_insert_rowid();
    let default_display = if mtype == "timber_framing" { "length" } else { mtype.as_str() };

    sqlx::query(
        r#"
        INSERT INTO dimension_group_props
            (node_id, measurement_type, default_display, default_multiplier, default_width,
             default_height, default_offset, add_to_gfa, pos_colour, pos_style, neg_colour, neg_style)
        VALUES (?, ?, ?, 1.0, 0.0, 0.0, 0.0, 0, ?, 'solid', '#FF0000', 'solid')
        "#,
    )
    .bind(node_id)
    .bind(&mtype)
    .bind(default_display)
    .bind(&colour)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to create dimension group props: {e}"))?;

    get_tree_node(&db, node_id).await
}

#[tauri::command]
async fn create_dimension_group_in_folder_path(
    folder_path: String,
    name: String,
    colour: String,
    measurement_type: Option<String>,
    state: State<'_, AppState>,
) -> Result<TreeNodeDto, String> {
    let db = active_project_db(&state)?;
    let folder_id = ensure_folder_path(&db, "dimensions", &folder_path).await?;
    create_dimension_group(Some(folder_id), name, colour, measurement_type, state).await
}

/// Lists every folder in the dimensions tree with its full `/`-joined path. Drives the
/// "copy to folder" picker, which must show all folders regardless of tree expansion state.
#[tauri::command]
async fn list_dimension_folders(
    state: State<'_, AppState>,
) -> Result<Vec<FolderOptionDto>, String> {
    let db = active_project_db(&state)?;
    let rows = sqlx::query(
        "SELECT id, parent_id, name FROM tree_nodes WHERE tree = 'dimensions' AND node_type = 'folder'",
    )
    .fetch_all(&db)
    .await
    .map_err(|e| format!("Failed to list dimension folders: {e}"))?;

    // id -> (parent_id, name), so each folder's path can be walked up to the root.
    let mut info: std::collections::HashMap<i64, (Option<i64>, String)> = std::collections::HashMap::new();
    for row in &rows {
        let id: i64 = row.try_get("id").map_err(|e: sqlx::Error| e.to_string())?;
        let parent_id: Option<i64> = row.try_get("parent_id").map_err(|e: sqlx::Error| e.to_string())?;
        let name: String = row.try_get("name").map_err(|e: sqlx::Error| e.to_string())?;
        info.insert(id, (parent_id, name));
    }

    let mut options: Vec<FolderOptionDto> = info
        .keys()
        .map(|&id| {
            let mut segments: Vec<String> = Vec::new();
            let mut current = Some(id);
            let mut guard = 0;
            while let Some(node_id) = current {
                let Some((parent, name)) = info.get(&node_id) else { break };
                segments.push(name.clone());
                current = *parent;
                guard += 1;
                if guard > 1000 {
                    break; // defensive cycle guard
                }
            }
            segments.reverse();
            FolderOptionDto { id, path: segments.join("/") }
        })
        .collect();
    options.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(options)
}

/// Copies a dimension group into `target_folder_id` as a new group named `name`. The source
/// colour and CostX props row are duplicated; measurements are duplicated only when
/// `copy_dimensions` is set. Verifies node types before acting (per project convention).
#[tauri::command]
async fn copy_dimension_group(
    source_node_id: i64,
    target_folder_id: i64,
    name: String,
    copy_dimensions: bool,
    state: State<'_, AppState>,
) -> Result<TreeNodeDto, String> {
    let db = active_project_db(&state)?;
    verify_node_type(&db, source_node_id, "dimension_group").await?;
    verify_node_type(&db, target_folder_id, "folder").await?;

    let name = clean_node_name(&name)?;

    let source_colour: String = sqlx::query_scalar::<_, Option<String>>(
        "SELECT colour FROM tree_nodes WHERE id = ?",
    )
    .bind(source_node_id)
    .fetch_optional(&db)
    .await
    .map_err(|e| format!("Failed to read source colour: {e}"))?
    .flatten()
    .unwrap_or_else(|| "#4A9EFF".to_string());

    let sort_order = next_sort_order(&db, "dimensions", Some(target_folder_id)).await?;

    let result = sqlx::query(
        r#"
        INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order, colour)
        VALUES ('dimensions', 'dimension_group', ?, ?, ?, ?)
        "#,
    )
    .bind(target_folder_id)
    .bind(&name)
    .bind(sort_order)
    .bind(&source_colour)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to create dimension group copy: {e}"))?;

    let new_id = result.last_insert_rowid();

    // Duplicate the CostX props row, if the source has one.
    sqlx::query(
        r#"
        INSERT INTO dimension_group_props
            (node_id, measurement_type, default_display, default_multiplier, default_width,
             default_height, default_offset, add_to_gfa, pos_colour, pos_style, neg_colour,
             neg_style, weight_uom, framing_props_json)
        SELECT ?, measurement_type, default_display, default_multiplier, default_width,
               default_height, default_offset, add_to_gfa, pos_colour, pos_style, neg_colour,
               neg_style, weight_uom, framing_props_json
        FROM dimension_group_props WHERE node_id = ?
        "#,
    )
    .bind(new_id)
    .bind(source_node_id)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to copy dimension group props: {e}"))?;

    if copy_dimensions {
        sqlx::query(
            r#"
            INSERT INTO measurements
                (dimension_group_id, drawing_id, page_index, measurement_type,
                 geometry_json, polarity, quantity, uom, framing_json)
            SELECT ?, drawing_id, page_index, measurement_type,
                   geometry_json, polarity, quantity, uom, framing_json
            FROM measurements WHERE dimension_group_id = ?
            "#,
        )
        .bind(new_id)
        .bind(source_node_id)
        .execute(&db)
        .await
        .map_err(|e| format!("Failed to copy dimensions: {e}"))?;
    }

    get_tree_node(&db, new_id).await
}

#[tauri::command]
async fn add_drawing_to_folder_path(
    folder_path: String,
    name: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<TreeNodeDto, String> {
    let db = active_project_db(&state)?;
    let page_count =
        i64::from(load_document_meta_via_renderer(&state.renderer, &file_path)?.page_count);
    let drawing_name = clean_node_name(&name)?;
    let folder_id = ensure_drawing_folder_path(&db, &folder_path).await?;
    let sort_order = next_sort_order(&db, "drawings", Some(folder_id)).await?;

    let result = sqlx::query(
        r#"
        INSERT INTO tree_nodes
            (tree, node_type, parent_id, name, sort_order, file_path, page_count, uom)
        VALUES
            ('drawings', 'drawing', ?, ?, ?, ?, ?, 'mm')
        "#,
    )
    .bind(folder_id)
    .bind(drawing_name)
    .bind(sort_order)
    .bind(file_path)
    .bind(page_count)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to add drawing: {e}"))?;

    get_tree_node(&db, result.last_insert_rowid()).await
}

#[tauri::command]
async fn delete_node(
    node_id: i64,
    expected_node_type: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = active_project_db(&state)?;
    if !matches!(
        expected_node_type.as_str(),
        "folder" | "drawing" | "dimension_group"
    ) {
        return Err("Unsupported node type for delete".to_string());
    }

    let actual_node_type: Option<String> =
        sqlx::query_scalar("SELECT node_type FROM tree_nodes WHERE id = ?")
            .bind(node_id)
            .fetch_optional(&db)
            .await
            .map_err(|e| format!("Failed to verify node before delete: {e}"))?;

    let Some(actual_node_type) = actual_node_type else {
        return Err("Node was not found".to_string());
    };

    if actual_node_type != expected_node_type {
        return Err(format!(
            "Refusing to delete node {node_id}: expected {expected_node_type}, found {actual_node_type}"
        ));
    }

    let result = sqlx::query("DELETE FROM tree_nodes WHERE id = ? AND node_type = ?")
        .bind(node_id)
        .bind(expected_node_type)
        .execute(&db)
        .await
        .map_err(|e| format!("Failed to delete node: {e}"))?;

    if result.rows_affected() == 0 {
        return Err("Node was not found".to_string());
    }

    Ok(())
}

#[tauri::command]
async fn rename_node(
    node_id: i64,
    expected_node_type: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<TreeNodeDto, String> {
    let db = active_project_db(&state)?;
    if !matches!(
        expected_node_type.as_str(),
        "folder" | "drawing" | "dimension_group"
    ) {
        return Err("Unsupported node type for rename".to_string());
    }

    verify_node_type(&db, node_id, &expected_node_type).await?;
    let name = clean_node_name(&name)?;

    sqlx::query("UPDATE tree_nodes SET name = ? WHERE id = ? AND node_type = ?")
        .bind(name)
        .bind(node_id)
        .bind(expected_node_type)
        .execute(&db)
        .await
        .map_err(|e| format!("Failed to rename node: {e}"))?;

    get_tree_node(&db, node_id).await
}

#[tauri::command]
async fn update_dimension_group_colour(
    node_id: i64,
    colour: String,
    state: State<'_, AppState>,
) -> Result<TreeNodeDto, String> {
    let db = active_project_db(&state)?;
    verify_node_type(&db, node_id, "dimension_group").await?;
    let colour = clean_colour(&colour)?;

    sqlx::query("UPDATE tree_nodes SET colour = ? WHERE id = ? AND node_type = 'dimension_group'")
        .bind(colour)
        .bind(node_id)
        .execute(&db)
        .await
        .map_err(|e| format!("Failed to update dimension group colour: {e}"))?;

    get_tree_node(&db, node_id).await
}

#[tauri::command]
async fn get_measurements_for_group(
    group_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<MeasurementDto>, String> {
    let db = active_project_db(&state)?;
    verify_node_type(&db, group_id, "dimension_group").await?;

    let rows = sqlx::query(
        r#"
        SELECT
            id,
            dimension_group_id,
            drawing_id,
            page_index,
            measurement_type,
            geometry_json,
            polarity,
            quantity,
            uom,
            framing_json
        FROM measurements
        WHERE dimension_group_id = ?
        ORDER BY id
    "#,
    )
    .bind(group_id)
    .fetch_all(&db)
    .await
    .map_err(|e| format!("Failed to load measurements: {e}"))?;

    rows.iter().map(measurement_from_row).collect()
}

/// Maps a `measurements` row (selected with the canonical column list) to a `MeasurementDto`.
fn measurement_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<MeasurementDto, String> {
    Ok(MeasurementDto {
        id: row.try_get("id").map_err(|e| e.to_string())?,
        dimension_group_id: row
            .try_get("dimension_group_id")
            .map_err(|e| e.to_string())?,
        drawing_id: row.try_get("drawing_id").map_err(|e| e.to_string())?,
        page_index: row.try_get("page_index").map_err(|e| e.to_string())?,
        measurement_type: row.try_get("measurement_type").map_err(|e| e.to_string())?,
        geometry_json: row.try_get("geometry_json").map_err(|e| e.to_string())?,
        polarity: row.try_get("polarity").map_err(|e| e.to_string())?,
        quantity: row.try_get("quantity").map_err(|e| e.to_string())?,
        uom: row.try_get("uom").map_err(|e| e.to_string())?,
        framing_json: row.try_get("framing_json").map_err(|e| e.to_string())?,
    })
}

async fn get_measurement(pool: &SqlitePool, id: i64) -> Result<MeasurementDto, String> {
    let row = sqlx::query(
        r#"
        SELECT
            id,
            dimension_group_id,
            drawing_id,
            page_index,
            measurement_type,
            geometry_json,
            polarity,
            quantity,
            uom,
            framing_json
        FROM measurements
        WHERE id = ?
    "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to load measurement: {e}"))?
    .ok_or_else(|| "Measurement was not found".to_string())?;

    measurement_from_row(&row)
}

/// Creates a measurement under a dimension group on a drawing page.
///
/// `geometry_json` must be a JSON array of `{ "x": <pt>, "y": <pt> }` in PDF points, Y-up.
/// `polarity` is `1` (positive) or `-1` (negative/cutout). Quantity stays null until the
/// quantity-calculation milestone wires scale + the display derivation.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn create_measurement(
    dimension_group_id: i64,
    drawing_id: i64,
    page_index: i64,
    measurement_type: String,
    geometry_json: String,
    polarity: i64,
    quantity: Option<f64>,
    uom: Option<String>,
    state: State<'_, AppState>,
) -> Result<MeasurementDto, String> {
    let db = active_project_db(&state)?;
    verify_node_type(&db, dimension_group_id, "dimension_group").await?;
    verify_node_type(&db, drawing_id, "drawing").await?;

    if !matches!(measurement_type.as_str(), "count" | "length" | "area" | "timber_framing") {
        return Err(format!(
            "Unsupported measurement_type: {measurement_type}"
        ));
    }
    if !matches!(polarity, 1 | -1) {
        return Err("polarity must be 1 (positive) or -1 (negative)".to_string());
    }

    // Validate geometry parses as a non-empty array of {x, y} points before storing.
    let points: Vec<GeometryPoint> = serde_json::from_str(&geometry_json)
        .map_err(|e| format!("Invalid geometry_json: {e}"))?;
    if points.is_empty() {
        return Err("geometry_json must contain at least one point".to_string());
    }

    let result = sqlx::query(
        r#"
        INSERT INTO measurements
            (dimension_group_id, drawing_id, page_index, measurement_type,
             geometry_json, polarity, quantity, uom)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(dimension_group_id)
    .bind(drawing_id)
    .bind(page_index)
    .bind(&measurement_type)
    .bind(&geometry_json)
    .bind(polarity)
    .bind(quantity)
    .bind(&uom)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to create measurement: {e}"))?;

    get_measurement(&db, result.last_insert_rowid()).await
}

/// Replaces a measurement's geometry (e.g. after dragging a vertex). `geometry_json`
/// must be a JSON array of `{ "x": <pt>, "y": <pt> }` in PDF points, Y-up.
#[tauri::command]
async fn update_measurement_geometry(
    measurement_id: i64,
    geometry_json: String,
    state: State<'_, AppState>,
) -> Result<MeasurementDto, String> {
    let db = active_project_db(&state)?;

    let points: Vec<GeometryPoint> = serde_json::from_str(&geometry_json)
        .map_err(|e| format!("Invalid geometry_json: {e}"))?;
    if points.is_empty() {
        return Err("geometry_json must contain at least one point".to_string());
    }

    let result = sqlx::query("UPDATE measurements SET geometry_json = ? WHERE id = ?")
        .bind(&geometry_json)
        .bind(measurement_id)
        .execute(&db)
        .await
        .map_err(|e| format!("Failed to update measurement: {e}"))?;

    if result.rows_affected() == 0 {
        return Err("Measurement was not found".to_string());
    }

    get_measurement(&db, measurement_id).await
}

/// Replaces a measurement's per-wall framing extras (door/window openings, raking, manual studs).
/// `framing_json` is stored opaquely; pass `None`/null to clear it.
#[tauri::command]
async fn update_measurement_framing(
    measurement_id: i64,
    framing_json: Option<String>,
    state: State<'_, AppState>,
) -> Result<MeasurementDto, String> {
    let db = active_project_db(&state)?;

    let result = sqlx::query("UPDATE measurements SET framing_json = ? WHERE id = ?")
        .bind(&framing_json)
        .bind(measurement_id)
        .execute(&db)
        .await
        .map_err(|e| format!("Failed to update measurement framing: {e}"))?;

    if result.rows_affected() == 0 {
        return Err("Measurement was not found".to_string());
    }

    get_measurement(&db, measurement_id).await
}

#[tauri::command]
async fn delete_measurement(
    measurement_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = active_project_db(&state)?;

    let result = sqlx::query("DELETE FROM measurements WHERE id = ?")
        .bind(measurement_id)
        .execute(&db)
        .await
        .map_err(|e| format!("Failed to delete measurement: {e}"))?;

    if result.rows_affected() == 0 {
        return Err("Measurement was not found".to_string());
    }

    Ok(())
}

/// Stores (or replaces) the scale for a drawing page. `mm_per_point` is real-world
/// millimetres per PDF point; `unit` is the preferred display unit.
#[tauri::command]
async fn set_page_scale(
    drawing_id: i64,
    page_index: i64,
    mm_per_point: f64,
    unit: String,
    state: State<'_, AppState>,
) -> Result<PageScaleDto, String> {
    let db = active_project_db(&state)?;
    verify_node_type(&db, drawing_id, "drawing").await?;

    if !(mm_per_point.is_finite() && mm_per_point > 0.0) {
        return Err("mm_per_point must be a positive number".to_string());
    }
    if !matches!(unit.as_str(), "mm" | "cm" | "m") {
        return Err(format!("Unsupported scale unit: {unit}"));
    }

    sqlx::query(
        r#"
        INSERT INTO page_scales (drawing_id, page_index, mm_per_point, unit)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(drawing_id, page_index)
            DO UPDATE SET mm_per_point = excluded.mm_per_point, unit = excluded.unit
        "#,
    )
    .bind(drawing_id)
    .bind(page_index)
    .bind(mm_per_point)
    .bind(&unit)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to set page scale: {e}"))?;

    Ok(PageScaleDto {
        drawing_id,
        page_index,
        mm_per_point,
        unit,
    })
}

#[tauri::command]
async fn get_page_scale(
    drawing_id: i64,
    page_index: i64,
    state: State<'_, AppState>,
) -> Result<Option<PageScaleDto>, String> {
    let db = active_project_db(&state)?;

    let row = sqlx::query(
        r#"
        SELECT drawing_id, page_index, mm_per_point, unit
        FROM page_scales
        WHERE drawing_id = ? AND page_index = ?
        "#,
    )
    .bind(drawing_id)
    .bind(page_index)
    .fetch_optional(&db)
    .await
    .map_err(|e| format!("Failed to load page scale: {e}"))?;

    row.map(|row| {
        Ok(PageScaleDto {
            drawing_id: row.try_get("drawing_id").map_err(|e: sqlx::Error| e.to_string())?,
            page_index: row.try_get("page_index").map_err(|e: sqlx::Error| e.to_string())?,
            mm_per_point: row.try_get("mm_per_point").map_err(|e: sqlx::Error| e.to_string())?,
            unit: row.try_get("unit").map_err(|e: sqlx::Error| e.to_string())?,
        })
    })
    .transpose()
}

const MEASUREMENT_TYPES: [&str; 4] = ["count", "length", "area", "timber_framing"];
const DISPLAY_TYPES: [&str; 6] = ["count", "length", "area", "wall_area", "volume", "weight"];
const LINE_STYLES: [&str; 4] = ["solid", "dashed", "dotted", "dash_dot"];

/// Returns a dimension group's properties, or sensible defaults if none are stored yet
/// (defaulting `pos_colour` to the group's tree colour).
#[tauri::command]
async fn get_dimension_group_props(
    node_id: i64,
    state: State<'_, AppState>,
) -> Result<DimensionGroupPropsDto, String> {
    let db = active_project_db(&state)?;
    verify_node_type(&db, node_id, "dimension_group").await?;

    // `tree_nodes.colour` is the single source of truth for the positive colour (kept in
    // sync by both "Change Colour" and the properties dialog), so always source it from there.
    let pos_colour: String = sqlx::query_scalar::<_, Option<String>>("SELECT colour FROM tree_nodes WHERE id = ?")
        .bind(node_id)
        .fetch_optional(&db)
        .await
        .map_err(|e| format!("Failed to read group colour: {e}"))?
        .flatten()
        .unwrap_or_else(|| "#4A9EFF".to_string());

    let row = sqlx::query(
        r#"
        SELECT measurement_type, default_display, default_multiplier, default_width,
               default_height, default_offset, add_to_gfa, pos_style,
               neg_colour, neg_style, weight_uom, framing_props_json
        FROM dimension_group_props
        WHERE node_id = ?
        "#,
    )
    .bind(node_id)
    .fetch_optional(&db)
    .await
    .map_err(|e| format!("Failed to load dimension group props: {e}"))?;

    if let Some(row) = row {
        return Ok(DimensionGroupPropsDto {
            node_id,
            measurement_type: row.try_get("measurement_type").map_err(|e| e.to_string())?,
            default_display: row.try_get("default_display").map_err(|e| e.to_string())?,
            default_multiplier: row.try_get("default_multiplier").map_err(|e| e.to_string())?,
            default_width: row.try_get("default_width").map_err(|e| e.to_string())?,
            default_height: row.try_get("default_height").map_err(|e| e.to_string())?,
            default_offset: row.try_get("default_offset").map_err(|e| e.to_string())?,
            add_to_gfa: row.try_get::<i64, _>("add_to_gfa").map_err(|e| e.to_string())? != 0,
            pos_colour,
            pos_style: row.try_get("pos_style").map_err(|e| e.to_string())?,
            neg_colour: row.try_get("neg_colour").map_err(|e| e.to_string())?,
            neg_style: row.try_get("neg_style").map_err(|e| e.to_string())?,
            weight_uom: row.try_get("weight_uom").map_err(|e| e.to_string())?,
            framing_props_json: row.try_get("framing_props_json").map_err(|e| e.to_string())?,
        });
    }

    // No stored row yet — derive defaults.
    Ok(DimensionGroupPropsDto {
        node_id,
        measurement_type: "length".to_string(),
        default_display: "length".to_string(),
        default_multiplier: 1.0,
        default_width: 0.0,
        default_height: 0.0,
        default_offset: 0.0,
        add_to_gfa: false,
        pos_colour,
        pos_style: "solid".to_string(),
        neg_colour: "#FF0000".to_string(),
        neg_style: "solid".to_string(),
        weight_uom: None,
        framing_props_json: None,
    })
}

#[tauri::command]
async fn set_dimension_group_props(
    props: DimensionGroupPropsDto,
    state: State<'_, AppState>,
) -> Result<DimensionGroupPropsDto, String> {
    let db = active_project_db(&state)?;
    verify_node_type(&db, props.node_id, "dimension_group").await?;

    if !MEASUREMENT_TYPES.contains(&props.measurement_type.as_str()) {
        return Err(format!("Unsupported measurement_type: {}", props.measurement_type));
    }
    if !DISPLAY_TYPES.contains(&props.default_display.as_str()) {
        return Err(format!("Unsupported default_display: {}", props.default_display));
    }
    if !LINE_STYLES.contains(&props.pos_style.as_str()) || !LINE_STYLES.contains(&props.neg_style.as_str()) {
        return Err("Unsupported line style".to_string());
    }
    if !props.default_multiplier.is_finite() {
        return Err("default_multiplier must be a finite number".to_string());
    }
    let pos_colour = clean_colour(&props.pos_colour)?;
    let neg_colour = clean_colour(&props.neg_colour)?;

    sqlx::query(
        r#"
        INSERT INTO dimension_group_props
            (node_id, measurement_type, default_display, default_multiplier, default_width,
             default_height, default_offset, add_to_gfa, pos_colour, pos_style, neg_colour,
             neg_style, weight_uom, framing_props_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
            measurement_type = excluded.measurement_type,
            default_display = excluded.default_display,
            default_multiplier = excluded.default_multiplier,
            default_width = excluded.default_width,
            default_height = excluded.default_height,
            default_offset = excluded.default_offset,
            add_to_gfa = excluded.add_to_gfa,
            pos_colour = excluded.pos_colour,
            pos_style = excluded.pos_style,
            neg_colour = excluded.neg_colour,
            neg_style = excluded.neg_style,
            weight_uom = excluded.weight_uom,
            framing_props_json = excluded.framing_props_json
        "#,
    )
    .bind(props.node_id)
    .bind(&props.measurement_type)
    .bind(&props.default_display)
    .bind(props.default_multiplier)
    .bind(props.default_width)
    .bind(props.default_height)
    .bind(props.default_offset)
    .bind(props.add_to_gfa as i64)
    .bind(&pos_colour)
    .bind(&props.pos_style)
    .bind(&neg_colour)
    .bind(&props.neg_style)
    .bind(&props.weight_uom)
    .bind(&props.framing_props_json)
    .execute(&db)
    .await
    .map_err(|e| format!("Failed to save dimension group props: {e}"))?;

    // Keep the tree node's colour in sync with the positive colour (drives the tree swatch).
    sqlx::query("UPDATE tree_nodes SET colour = ? WHERE id = ? AND node_type = 'dimension_group'")
        .bind(&pos_colour)
        .bind(props.node_id)
        .execute(&db)
        .await
        .map_err(|e| format!("Failed to sync group colour: {e}"))?;

    Ok(DimensionGroupPropsDto {
        pos_colour,
        neg_colour,
        ..props
    })
}

async fn init_database(db_path: &Path) -> Result<SqlitePool, String> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .map_err(|e| format!("Failed to connect to database: {e}"))?;

    run_migrations(&pool).await?;

    Ok(pool)
}

async fn init_registry_database(
    db_path: &Path,
) -> Result<(SqlitePool, Vec<RecentProject>), String> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("Failed to connect to recent projects registry: {e}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS recent_projects (
            file_path        TEXT PRIMARY KEY,
            name             TEXT NOT NULL,
            client           TEXT NOT NULL,
            contract_number  TEXT NOT NULL,
            last_opened_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
    .execute(&pool)
    .await
    .map_err(|e| format!("Failed to create recent_projects registry: {e}"))?;

    // Additive migration: add status column to existing registry.
    let _ = sqlx::query(
        "ALTER TABLE recent_projects ADD COLUMN status TEXT NOT NULL DEFAULT 'Tendering'",
    )
    .execute(&pool)
    .await;

    let projects = load_recent_projects_from_registry(&pool).await?;

    Ok((pool, projects))
}

async fn load_recent_projects_from_registry(
    pool: &SqlitePool,
) -> Result<Vec<RecentProject>, String> {
    let rows = sqlx::query(
        r#"
        SELECT file_path, name, client, contract_number, status, last_opened_at
        FROM recent_projects
        ORDER BY last_opened_at DESC
        LIMIT 10
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to load recent projects: {e}"))?;

    rows.into_iter()
        .map(|row| {
            let file_path: String = row.try_get("file_path").map_err(|e| e.to_string())?;
            Ok(RecentProject {
                file_exists: Path::new(&file_path).exists(),
                file_path,
                name: row.try_get("name").map_err(|e| e.to_string())?,
                client: row.try_get("client").map_err(|e| e.to_string())?,
                contract_number: row.try_get("contract_number").map_err(|e| e.to_string())?,
                status: row.try_get("status").map_err(|e| e.to_string())?,
                last_opened_at: row.try_get("last_opened_at").map_err(|e| e.to_string())?,
            })
        })
        .collect()
}

async fn upsert_recent_project(pool: &SqlitePool, meta: &ProjectMeta) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO recent_projects
            (file_path, name, client, contract_number, status, last_opened_at)
        VALUES
            (?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
            name = excluded.name,
            client = excluded.client,
            contract_number = excluded.contract_number,
            status = excluded.status,
            last_opened_at = excluded.last_opened_at
        "#,
    )
    .bind(&meta.file_path)
    .bind(&meta.name)
    .bind(&meta.client)
    .bind(&meta.contract_number)
    .bind(&meta.status)
    .bind(&meta.last_opened_at)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update recent projects registry: {e}"))?;

    sqlx::query(
        r#"
        DELETE FROM recent_projects
        WHERE file_path NOT IN (
            SELECT file_path FROM recent_projects
            ORDER BY last_opened_at DESC
            LIMIT 10
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to trim recent projects registry: {e}"))?;

    Ok(())
}

async fn refresh_recent_projects(state: &AppState) -> Result<(), String> {
    let projects = load_recent_projects_from_registry(&state.registry_db).await?;
    *state.recent_projects.lock() = projects;
    Ok(())
}

async fn read_project_meta(pool: &SqlitePool, file_path: &str) -> Result<ProjectMeta, String> {
    let row = sqlx::query(
        r#"
        SELECT name, client, contract_number, status, created_at, last_opened_at
        FROM project_meta
        WHERE id = 1
        "#,
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to read project metadata: {e}"))?;

    let Some(row) = row else {
        return Err("Project file is missing project metadata".to_string());
    };

    Ok(ProjectMeta {
        name: row.try_get("name").map_err(|e| e.to_string())?,
        client: row.try_get("client").map_err(|e| e.to_string())?,
        contract_number: row.try_get("contract_number").map_err(|e| e.to_string())?,
        status: row.try_get("status").map_err(|e| e.to_string())?,
        file_path: file_path.to_string(),
        created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
        last_opened_at: row.try_get("last_opened_at").map_err(|e| e.to_string())?,
    })
}

async fn run_migrations(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_meta (
            id               INTEGER PRIMARY KEY CHECK (id = 1),
            name             TEXT NOT NULL,
            client           TEXT NOT NULL,
            contract_number  TEXT NOT NULL,
            created_at       TEXT NOT NULL DEFAULT (datetime('now')),
            last_opened_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create project_meta: {e}"))?;

    // Additive migration: add status column to existing project files.
    let _ = sqlx::query(
        "ALTER TABLE project_meta ADD COLUMN status TEXT NOT NULL DEFAULT 'Tendering'",
    )
    .execute(pool)
    .await;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS tree_nodes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            tree        TEXT    NOT NULL,
            node_type   TEXT    NOT NULL,
            parent_id   INTEGER REFERENCES tree_nodes(id) ON DELETE CASCADE,
            name        TEXT    NOT NULL,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            file_path   TEXT,
            page_count  INTEGER,
            uom         TEXT,
            colour      TEXT    DEFAULT '#4A9EFF',
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create tree_nodes: {e}"))?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent
            ON tree_nodes(parent_id, tree, sort_order);
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create idx_tree_nodes_parent: {e}"))?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_tree_nodes_tree
            ON tree_nodes(tree, node_type);
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create idx_tree_nodes_tree: {e}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS measurements (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            dimension_group_id  INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
            drawing_id          INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
            page_index          INTEGER NOT NULL,
            measurement_type    TEXT    NOT NULL,
            geometry_json       TEXT    NOT NULL,
            polarity            INTEGER NOT NULL DEFAULT 1,
            quantity            REAL,
            uom                 TEXT,
            framing_json        TEXT,
            created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create measurements: {e}"))?;

    // Project DBs created before the Timber Framing openings work lack `framing_json`; add it
    // idempotently (same guard pattern as measurements.polarity above).
    if let Err(e) = sqlx::query("ALTER TABLE measurements ADD COLUMN framing_json TEXT")
        .execute(pool)
        .await
    {
        let msg = e.to_string();
        if !msg.contains("duplicate column name") {
            return Err(format!("Failed to add measurements.framing_json: {msg}"));
        }
    }

    // Project DBs created before Phase 3 lack `polarity`; add it idempotently.
    if let Err(e) =
        sqlx::query("ALTER TABLE measurements ADD COLUMN polarity INTEGER NOT NULL DEFAULT 1")
            .execute(pool)
            .await
    {
        let msg = e.to_string();
        if !msg.contains("duplicate column name") {
            return Err(format!("Failed to add measurements.polarity: {msg}"));
        }
    }

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_measurements_group
            ON measurements(dimension_group_id);
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create idx_measurements_group: {e}"))?;

    // CostX-style dimension-group properties (measurement type, display derivation,
    // per-polarity styling). One row per dimension_group tree node. Populated in M4.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS dimension_group_props (
            node_id            INTEGER PRIMARY KEY REFERENCES tree_nodes(id) ON DELETE CASCADE,
            measurement_type   TEXT    NOT NULL DEFAULT 'area',
            default_display    TEXT    NOT NULL DEFAULT 'area',
            default_multiplier REAL    NOT NULL DEFAULT 1.0,
            default_width      REAL    NOT NULL DEFAULT 0.0,
            default_height     REAL    NOT NULL DEFAULT 0.0,
            default_offset     REAL    NOT NULL DEFAULT 0.0,
            add_to_gfa         INTEGER NOT NULL DEFAULT 0,
            pos_colour         TEXT    NOT NULL DEFAULT '#00FF00',
            pos_style          TEXT    NOT NULL DEFAULT 'solid',
            neg_colour         TEXT    NOT NULL DEFAULT '#FF0000',
            neg_style          TEXT    NOT NULL DEFAULT 'solid',
            weight_uom         TEXT,
            framing_props_json TEXT
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create dimension_group_props: {e}"))?;

    // Project DBs created before the Timber Framing feature lack `framing_props_json`; add it
    // idempotently (same pattern as the measurements.polarity migration above).
    if let Err(e) =
        sqlx::query("ALTER TABLE dimension_group_props ADD COLUMN framing_props_json TEXT")
            .execute(pool)
            .await
    {
        let msg = e.to_string();
        if !msg.contains("duplicate column name") {
            return Err(format!(
                "Failed to add dimension_group_props.framing_props_json: {msg}"
            ));
        }
    }

    // Per-drawing-page scale calibration (M3). One row per (drawing, page).
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS page_scales (
            drawing_id    INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
            page_index    INTEGER NOT NULL,
            mm_per_point  REAL    NOT NULL,
            unit          TEXT    NOT NULL DEFAULT 'm',
            created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (drawing_id, page_index)
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create page_scales: {e}"))?;

    Ok(())
}

async fn query_tree_nodes(
    pool: &SqlitePool,
    tree: Option<&str>,
    parent_id: Option<i64>,
) -> Result<Vec<TreeNodeDto>, String> {
    let rows = match (tree, parent_id) {
        (Some(tree), None) => {
            sqlx::query(
                r#"
                SELECT
                    n.id,
                    n.tree,
                    n.node_type,
                    n.parent_id,
                    n.name,
                    n.sort_order,
                    EXISTS(SELECT 1 FROM tree_nodes c WHERE c.parent_id = n.id) AS has_children,
                    n.file_path,
                    n.page_count,
                    n.uom,
                    n.colour,
                    p.measurement_type,
                    CASE WHEN p.measurement_type = 'timber_framing'
                         THEN json_extract(p.framing_props_json, '$.framingSize') END AS framing_size
                FROM tree_nodes n
                LEFT JOIN dimension_group_props p ON p.node_id = n.id
                WHERE n.tree = ? AND n.parent_id IS NULL
                ORDER BY n.sort_order, n.name, n.id
                "#,
            )
            .bind(tree)
            .fetch_all(pool)
            .await
        }
        (None, Some(parent_id)) => {
            sqlx::query(
                r#"
                SELECT
                    n.id,
                    n.tree,
                    n.node_type,
                    n.parent_id,
                    n.name,
                    n.sort_order,
                    EXISTS(SELECT 1 FROM tree_nodes c WHERE c.parent_id = n.id) AS has_children,
                    n.file_path,
                    n.page_count,
                    n.uom,
                    n.colour,
                    p.measurement_type,
                    CASE WHEN p.measurement_type = 'timber_framing'
                         THEN json_extract(p.framing_props_json, '$.framingSize') END AS framing_size
                FROM tree_nodes n
                LEFT JOIN dimension_group_props p ON p.node_id = n.id
                WHERE n.parent_id = ?
                ORDER BY n.sort_order, n.name, n.id
                "#,
            )
            .bind(parent_id)
            .fetch_all(pool)
            .await
        }
        _ => return Err("Invalid tree query".to_string()),
    }
    .map_err(|e| format!("Failed to load tree nodes: {e}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(TreeNodeDto {
                id: row.try_get("id").map_err(|e| e.to_string())?,
                tree: row.try_get("tree").map_err(|e| e.to_string())?,
                node_type: row.try_get("node_type").map_err(|e| e.to_string())?,
                parent_id: row.try_get("parent_id").map_err(|e| e.to_string())?,
                name: row.try_get("name").map_err(|e| e.to_string())?,
                sort_order: row.try_get("sort_order").map_err(|e| e.to_string())?,
                has_children: row
                    .try_get::<i64, _>("has_children")
                    .map_err(|e| e.to_string())?
                    != 0,
                file_path: row.try_get("file_path").map_err(|e| e.to_string())?,
                page_count: row.try_get("page_count").map_err(|e| e.to_string())?,
                uom: row.try_get("uom").map_err(|e| e.to_string())?,
                colour: row.try_get("colour").map_err(|e| e.to_string())?,
                framing_size: row.try_get("framing_size").map_err(|e| e.to_string())?,
                measurement_type: row.try_get("measurement_type").map_err(|e| e.to_string())?,
            })
        })
        .collect()
}

fn clean_node_name(name: &str) -> Result<String, String> {
    let cleaned = name.trim();
    if cleaned.is_empty() {
        return Err("Name is required".to_string());
    }
    Ok(cleaned.to_string())
}

fn clean_required_field(value: &str, label: &str) -> Result<String, String> {
    let cleaned = value.trim();
    if cleaned.is_empty() {
        return Err(format!("{label} is required"));
    }
    Ok(cleaned.to_string())
}

fn clean_project_file_path(file_path: &str) -> Result<String, String> {
    let cleaned = file_path.trim();
    if cleaned.is_empty() {
        return Err("Project file path is required".to_string());
    }

    let path = Path::new(cleaned);
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();

    if !extension.eq_ignore_ascii_case("tcop") {
        return Err("Project file must use the .tcop extension".to_string());
    }

    Ok(cleaned.to_string())
}

fn clean_colour(colour: &str) -> Result<String, String> {
    let cleaned = colour.trim();
    let bytes = cleaned.as_bytes();
    let valid = bytes.len() == 7
        && bytes[0] == b'#'
        && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit());

    if !valid {
        return Err("Colour must use #RRGGBB format".to_string());
    }

    Ok(cleaned.to_string())
}

fn pdfium_library_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "pdfium.dll"
    }
    #[cfg(target_os = "macos")]
    {
        "libpdfium.dylib"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "libpdfium.so"
    }
}

fn renderer_executable_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "pdf_renderer.exe"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "pdf_renderer"
    }
}

async fn next_sort_order(
    pool: &SqlitePool,
    tree: &str,
    parent_id: Option<i64>,
) -> Result<i64, String> {
    match parent_id {
        Some(parent_id) => {
            sqlx::query_scalar(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM tree_nodes WHERE tree = ? AND parent_id = ?",
            )
            .bind(tree)
            .bind(parent_id)
            .fetch_one(pool)
            .await
        }
        None => {
            sqlx::query_scalar(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM tree_nodes WHERE tree = ? AND parent_id IS NULL",
            )
            .bind(tree)
            .fetch_one(pool)
            .await
        }
    }
    .map_err(|e| format!("Failed to allocate sort order: {e}"))
}

async fn ensure_drawing_folder_path(pool: &SqlitePool, folder_path: &str) -> Result<i64, String> {
    ensure_folder_path(pool, "drawings", folder_path).await
}

async fn ensure_folder_path(
    pool: &SqlitePool,
    tree: &str,
    folder_path: &str,
) -> Result<i64, String> {
    let parts: Vec<String> = folder_path
        .split(['/', '\\'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect();

    if parts.is_empty() {
        return Err("Destination folder is required".to_string());
    }

    let mut parent_id = None;
    let mut current_id = None;

    for part in parts {
        let existing_id: Option<i64> = match parent_id {
            Some(parent_id) => {
                sqlx::query_scalar(
                    r#"
                    SELECT id FROM tree_nodes
                    WHERE tree = ? AND node_type = 'folder' AND parent_id = ? AND name = ?
                    LIMIT 1
                    "#,
                )
                .bind(tree)
                .bind(parent_id)
                .bind(&part)
                .fetch_optional(pool)
                .await
            }
            None => {
                sqlx::query_scalar(
                    r#"
                    SELECT id FROM tree_nodes
                    WHERE tree = ? AND node_type = 'folder' AND parent_id IS NULL AND name = ?
                    LIMIT 1
                    "#,
                )
                .bind(tree)
                .bind(&part)
                .fetch_optional(pool)
                .await
            }
        }
        .map_err(|e| format!("Failed to find folder '{part}': {e}"))?;

        let folder_id = if let Some(existing_id) = existing_id {
            existing_id
        } else {
            let sort_order = next_sort_order(pool, tree, parent_id).await?;
            let result = sqlx::query(
                r#"
                INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
                VALUES (?, 'folder', ?, ?, ?)
                "#,
            )
            .bind(tree)
            .bind(parent_id)
            .bind(&part)
            .bind(sort_order)
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to create folder '{part}': {e}"))?;
            result.last_insert_rowid()
        };

        parent_id = Some(folder_id);
        current_id = Some(folder_id);
    }

    current_id.ok_or_else(|| "Destination folder is required".to_string())
}

async fn verify_node_type(
    pool: &SqlitePool,
    node_id: i64,
    expected_node_type: &str,
) -> Result<(), String> {
    let actual_node_type: Option<String> =
        sqlx::query_scalar("SELECT node_type FROM tree_nodes WHERE id = ?")
            .bind(node_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("Failed to verify node type: {e}"))?;

    let Some(actual_node_type) = actual_node_type else {
        return Err("Node was not found".to_string());
    };

    if actual_node_type != expected_node_type {
        return Err(format!(
            "Refusing operation on node {node_id}: expected {expected_node_type}, found {actual_node_type}"
        ));
    }

    Ok(())
}

async fn get_tree_node(pool: &SqlitePool, node_id: i64) -> Result<TreeNodeDto, String> {
    let row = sqlx::query(
        r#"
        SELECT
            n.id,
            n.tree,
            n.node_type,
            n.parent_id,
            n.name,
            n.sort_order,
            EXISTS(SELECT 1 FROM tree_nodes c WHERE c.parent_id = n.id) AS has_children,
            n.file_path,
            n.page_count,
            n.uom,
            n.colour,
            p.measurement_type,
            CASE WHEN p.measurement_type = 'timber_framing'
                 THEN json_extract(p.framing_props_json, '$.framingSize') END AS framing_size
        FROM tree_nodes n
        LEFT JOIN dimension_group_props p ON p.node_id = n.id
        WHERE n.id = ?
        "#,
    )
    .bind(node_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to load tree node: {e}"))?;

    Ok(TreeNodeDto {
        id: row.try_get("id").map_err(|e| e.to_string())?,
        tree: row.try_get("tree").map_err(|e| e.to_string())?,
        node_type: row.try_get("node_type").map_err(|e| e.to_string())?,
        parent_id: row.try_get("parent_id").map_err(|e| e.to_string())?,
        name: row.try_get("name").map_err(|e| e.to_string())?,
        sort_order: row.try_get("sort_order").map_err(|e| e.to_string())?,
        has_children: row
            .try_get::<i64, _>("has_children")
            .map_err(|e| e.to_string())?
            != 0,
        file_path: row.try_get("file_path").map_err(|e| e.to_string())?,
        page_count: row.try_get("page_count").map_err(|e| e.to_string())?,
        uom: row.try_get("uom").map_err(|e| e.to_string())?,
        colour: row.try_get("colour").map_err(|e| e.to_string())?,
        framing_size: row.try_get("framing_size").map_err(|e| e.to_string())?,
        measurement_type: row.try_get("measurement_type").map_err(|e| e.to_string())?,
    })
}

pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("Could not resolve resource directory");
            let pdfium_lib_path = resource_dir
                .join("libs")
                .join("pdfium")
                .join(pdfium_library_name())
                .to_string_lossy()
                .to_string();
            let tile_cache_dir = app
                .path()
                .app_cache_dir()
                .expect("Could not resolve app cache directory")
                .join("tiles")
                .to_string_lossy()
                .to_string();
            let sibling_renderer_path = std::env::current_exe()
                .expect("Could not resolve current executable path")
                .with_file_name(renderer_executable_name())
                .to_string_lossy()
                .to_string();
            let bundled_renderer_path = resource_dir
                .join(renderer_executable_name())
                .to_string_lossy()
                .to_string();
            let renderer_path = if Path::new(&sibling_renderer_path).exists() {
                sibling_renderer_path
            } else {
                bundled_renderer_path
            };
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Could not resolve app data directory");
            std::fs::create_dir_all(&app_data_dir).expect("Could not create app data directory");
            let registry_path = app_data_dir.join("registry.db");
            let (registry_db, recent_projects) =
                tauri::async_runtime::block_on(init_registry_database(&registry_path))
                    .expect("Recent projects registry initialisation failed");

            tracing::info!("pdfium path: {}", pdfium_lib_path);

            let worker_count = 1;
            let startup_renderer = RendererService::spawn(&renderer_path, &pdfium_lib_path)
                .expect("Failed to start renderer on startup");
            let renderer = Arc::new(Mutex::new(Some(startup_renderer)));
            let tile_manager = Arc::new(create_tile_manager_with_workers(worker_count));
            let (tile_render_tx, tile_render_rx) = mpsc::unbounded_channel();

            tauri::async_runtime::spawn(run_tile_render_worker(
                tile_render_rx,
                Arc::clone(&renderer),
                Arc::clone(&tile_manager),
            ));

            app.manage(AppState {
                pdfium_lib_path,
                tile_cache_dir,
                renderer_path,
                open_document: Arc::new(Mutex::new(None)),
                tile_manager,
                render_context: Arc::new(Mutex::new(None)),
                active_project: Arc::new(Mutex::new(None)),
                recent_projects: Arc::new(Mutex::new(recent_projects)),
                registry_db,
                renderer,
                tile_render_tx,
                next_tile_batch: AtomicU64::new(1),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_active_project,
            get_recent_projects,
            remove_recent_project,
            create_project,
            open_project,
            close_project,
            export_project,
            update_project_meta,
            open_document,
            get_page_vectors,
            render_preview,
            update_viewport,
            poll_tiles,
            get_root_nodes,
            get_children,
            create_folder,
            create_dimension_group,
            create_dimension_group_in_folder_path,
            list_dimension_folders,
            copy_dimension_group,
            add_drawing,
            add_drawing_to_folder_path,
            delete_node,
            rename_node,
            update_dimension_group_colour,
            get_measurements_for_group,
            create_measurement,
            update_measurement_geometry,
            update_measurement_framing,
            delete_measurement,
            set_page_scale,
            get_page_scale,
            get_dimension_group_props,
            set_dimension_group_props
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
