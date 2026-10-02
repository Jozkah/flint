//! Models the person adds from Discover: a diffusion weights file on Hugging Face
//! plus the family it belongs to.
//!
//! A family says what else the model needs (text encoder, VAE) and how to run
//! it, and those companion files are the same checksummed ones the built-in
//! models use, so only the weights file is the person's choice. The weights file
//! itself is verified against the size and SHA-256 Hugging Face publishes for
//! it, like every other download.
//!
//! The records live in `<data>/diffusion/custom-models.json`. A loaded record
//! becomes a `ModelDef` that is leaked once, so it can be used anywhere a
//! built-in one is (`&'static ModelDef`); a person's own list is a handful of
//! entries, so that is a few hundred bytes each for the life of the process.

use super::catalog::{Defaults, FileDef, Kind, ModelDef, Role};
use crate::core::app::commands::get_jan_data_folder_path;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::Runtime;

/// What a family of models needs and how it is run.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Family {
    pub id: &'static str,
    pub label: &'static str,
    /// One line for the picker: what it is and what else gets downloaded.
    pub description: &'static str,
    /// Lowercase fragments of a repo or file name that suggest this family.
    pub hints: &'static [&'static str],
    #[serde(skip)]
    pub companions: &'static [FileDef],
    #[serde(skip)]
    pub defaults: Defaults,
    pub min_side: u32,
    pub max_side: u32,
}

impl Family {
    pub fn companion_bytes(&self) -> u64 {
        self.companions.iter().map(|f| f.size).sum()
    }
}

// The Flux VAE: the same file Z-Image uses, published in an ungated repository.
const FLUX_AE: FileDef = FileDef {
    role: Role::Vae,
    repo: "unsloth/Z-Image-Turbo-ComfyUI",
    filename: "split_files/vae/ae.safetensors",
    size: 335_304_388,
    sha256: "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
};

const Z_IMAGE_COMPANIONS: &[FileDef] = &[
    FLUX_AE,
    FileDef {
        role: Role::Llm,
        repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
        filename: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        size: 2_497_281_120,
        sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
    },
];

const QWEN_IMAGE_COMPANIONS: &[FileDef] = &[
    FileDef {
        role: Role::Vae,
        repo: "Comfy-Org/Qwen-Image_ComfyUI",
        filename: "split_files/vae/qwen_image_vae.safetensors",
        size: 253_806_246,
        sha256: "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
    },
    FileDef {
        role: Role::Llm,
        repo: "mradermacher/Qwen2.5-VL-7B-Instruct-GGUF",
        filename: "Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf",
        size: 4_683_072_512,
        sha256: "0f00a930ba3108b6861ddadf74d8ebbd82e257c63eba728e62c3e8970f5eed94",
    },
];

const QWEN_IMAGE_21_COMPANIONS: &[FileDef] = &[
    FileDef {
        role: Role::Vae,
        repo: "Comfy-Org/Qwen-Image-2.1",
        filename: "vae/qwen_image_2.1_vae_bf16.safetensors",
        size: 675_509_688,
        sha256: "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9",
    },
    FileDef {
        role: Role::Llm,
        repo: "Qwen/Qwen3-VL-8B-Instruct-GGUF",
        filename: "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
        size: 5_027_784_800,
        sha256: "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
    },
];

const FLUX1_COMPANIONS: &[FileDef] = &[
    FLUX_AE,
    FileDef {
        role: Role::ClipL,
        repo: "comfyanonymous/flux_text_encoders",
        filename: "clip_l.safetensors",
        size: 246_144_152,
        sha256: "660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
    },
    FileDef {
        role: Role::T5xxl,
        repo: "city96/t5-v1_1-xxl-encoder-gguf",
        filename: "t5-v1_1-xxl-encoder-Q4_K_M.gguf",
        size: 2_896_123_072,
        sha256: "6be2b0b7e2de7cf2919340c88cb802a103a997ce46c53131cec91958c1db1af4",
    },
];

pub const FAMILIES: &[Family] = &[
    Family {
        id: "z-image",
        label: "Z-Image",
        description: "A fast model. Also downloads a text encoder (2.5 GB) and a VAE (0.3 GB).",
        hints: &["z-image", "z_image", "zimage"],
        companions: Z_IMAGE_COMPANIONS,
        defaults: Defaults {
            steps: 8,
            cfg_scale: 1.0,
            sample_method: None,
            flow_shift: None,
            width: 1024,
            height: 1024,
        },
        min_side: 256,
        max_side: 2048,
    },
    Family {
        id: "qwen-image-2.1",
        label: "Qwen-Image 2.1",
        description: "The 2.1 release only. Also downloads an 8B text encoder (5.0 GB) and its own VAE (0.7 GB).",
        hints: &["qwen-image-2.1", "qwen_image_2.1", "qwen-image-2-1", "qwenimage2.1"],
        companions: QWEN_IMAGE_21_COMPANIONS,
        defaults: Defaults {
            steps: 20,
            cfg_scale: 6.0,
            sample_method: Some("euler"),
            flow_shift: None,
            width: 1024,
            height: 1024,
        },
        min_side: 256,
        max_side: 2048,
    },
    Family {
        id: "qwen-image",
        label: "Qwen-Image",
        description: "Qwen-Image and Qwen-Image 2512, not 2.1. Also downloads a 7B text encoder (4.7 GB) and a VAE (0.3 GB).",
        hints: &["qwen-image", "qwen_image", "qwenimage"],
        companions: QWEN_IMAGE_COMPANIONS,
        defaults: Defaults {
            steps: 20,
            cfg_scale: 2.5,
            sample_method: Some("euler"),
            flow_shift: Some(3.0),
            width: 1024,
            height: 1024,
        },
        min_side: 256,
        max_side: 2048,
    },
    Family {
        id: "flux1",
        label: "FLUX.1",
        description: "FLUX.1 dev or schnell. Also downloads two text encoders (3.1 GB) and a VAE (0.3 GB).",
        hints: &["flux1", "flux.1", "flux-1", "flux_1"],
        companions: FLUX1_COMPANIONS,
        defaults: Defaults {
            steps: 20,
            cfg_scale: 1.0,
            sample_method: Some("euler"),
            flow_shift: None,
            width: 1024,
            height: 1024,
        },
        min_side: 256,
        max_side: 2048,
    },
];

pub fn family(id: &str) -> Option<&'static Family> {
    FAMILIES.iter().find(|f| f.id == id)
}

/// What is kept for one added model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomModel {
    pub id: String,
    pub display_name: String,
    pub family: String,
    pub repo: String,
    pub filename: String,
    pub size: u64,
    pub sha256: String,
    pub license: String,
}

struct Registry {
    records: Vec<CustomModel>,
    /// Records of a family this build does not know (written by a newer one):
    /// not usable, but kept in the file so they come back when it does.
    unknown: Vec<CustomModel>,
    defs: Vec<&'static ModelDef>,
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry { records: Vec::new(), unknown: Vec::new(), defs: Vec::new() }))
}

fn leak(text: &str) -> &'static str {
    Box::leak(text.to_string().into_boxed_str())
}

/// The runnable definition of a record, or `None` for a family that no longer exists.
pub fn def_of(record: &CustomModel) -> Option<ModelDef> {
    let family = family(&record.family)?;
    let mut files = vec![FileDef {
        role: Role::DiffusionModel,
        repo: leak(&record.repo),
        filename: leak(&record.filename),
        size: record.size,
        sha256: leak(&record.sha256),
    }];
    files.extend(family.companions.iter().copied());
    let mut defaults = family.defaults;
    // The fast FLUX.1 variant needs only a few steps.
    if family.id == "flux1" && record.filename.to_ascii_lowercase().contains("schnell") {
        defaults.steps = 4;
    }
    Some(ModelDef {
        id: leak(&record.id),
        display_name: leak(&record.display_name),
        kind: Kind::Image,
        license: leak(&record.license),
        files: Box::leak(files.into_boxed_slice()),
        defaults,
        video: None,
        min_side: family.min_side,
        max_side: family.max_side,
    })
}

pub fn lookup(id: &str) -> Option<&'static ModelDef> {
    registry().lock().ok()?.defs.iter().copied().find(|d| d.id == id)
}

pub fn all() -> Vec<&'static ModelDef> {
    registry().lock().map(|r| r.defs.clone()).unwrap_or_default()
}

/// The family a custom model belongs to.
pub fn family_of(id: &str) -> Option<&'static str> {
    let reg = registry().lock().ok()?;
    let record = reg.records.iter().find(|r| r.id == id)?;
    family(&record.family).map(|f| f.id)
}

pub fn is_custom(id: &str) -> bool {
    lookup(id).is_some()
}

fn store_path<R: Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    get_jan_data_folder_path(app.clone()).join("diffusion").join("custom-models.json")
}

/// Read the saved records into the registry. A missing or unreadable file is an empty list.
pub fn load<R: Runtime>(app: &tauri::AppHandle<R>) {
    let path = store_path(app);
    let records: Vec<CustomModel> = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            // A file that cannot be read is set aside, not overwritten by the next add.
            let _ = std::fs::rename(&path, path.with_extension("json.bad"));
            Vec::new()
        }),
        Err(_) => Vec::new(),
    };
    if let Ok(mut reg) = registry().lock() {
        reg.records.clear();
        reg.unknown.clear();
        reg.defs.clear();
        for record in records {
            match def_of(&record) {
                Some(def) => {
                    reg.defs.push(Box::leak(Box::new(def)));
                    reg.records.push(record);
                }
                None => reg.unknown.push(record),
            }
        }
    }
}

fn save<R: Runtime>(app: &tauri::AppHandle<R>, records: &[CustomModel]) -> Result<(), String> {
    let path = store_path(app);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not save the model list: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(records).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Could not save the model list: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not save the model list: {e}")
    })
}

/// A file-system-safe, readable id for a repo and file: `custom-owner-name-file`.
pub fn id_for(repo: &str, filename: &str) -> String {
    let stem = filename.rsplit('/').next().unwrap_or(filename);
    let stem = stem.rsplit_once('.').map(|(s, _)| s).unwrap_or(stem);
    let clean = |text: &str| -> String {
        text.chars()
            .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("-")
    };
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{repo}\0{filename}").as_bytes());
    let hash: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    let readable: String = format!("custom-{}-{}", clean(repo), clean(stem)).chars().take(80).collect();
    format!("{}-{hash}", readable.trim_end_matches('-'))
}

/// The family whose hints appear in a repo or file name, for the picker's default.
pub fn guess_family(repo: &str, filename: &str) -> Option<&'static str> {
    let haystack = format!("{repo} {filename}").to_ascii_lowercase();
    // Editing and fill variants of a family need a reference image and other
    // arguments, so they are not offered as a plain picture model.
    if ["kontext", "-fill", "_fill", "edit", "redux", "inpaint"].iter().any(|w| haystack.contains(w)) {
        return None;
    }
    // The longest matching hint wins, so "qwen-image-2.1" is not taken for "qwen-image".
    FAMILIES
        .iter()
        .flat_map(|f| f.hints.iter().filter(|h| haystack.contains(*h)).map(move |h| (h.len(), f.id)))
        .max_by_key(|(len, _)| *len)
        .map(|(_, id)| id)
}

/// A weights file a person may add: GGUF or safetensors, a plain path, no more than ~60 GB.
pub fn weights_file_problem(filename: &str, size: u64) -> Option<&'static str> {
    let lower = filename.to_ascii_lowercase();
    if !(lower.ends_with(".gguf") || lower.ends_with(".safetensors")) {
        return Some("Pick a .gguf or .safetensors weights file.");
    }
    if size == 0 {
        return Some("Hugging Face does not list a size for that file.");
    }
    if size > 60 * 1024 * 1024 * 1024 {
        return Some("That file is too large to use here.");
    }
    None
}

/// Keep a record (replacing one with the same id) and make it usable.
pub fn add<R: Runtime>(app: &tauri::AppHandle<R>, record: CustomModel) -> Result<&'static ModelDef, String> {
    let def = def_of(&record).ok_or("That model family is not supported.")?;
    let leaked: &'static ModelDef = Box::leak(Box::new(def));
    let mut reg = registry().lock().map_err(|_| "The model list is busy.".to_string())?;
    let mut records: Vec<CustomModel> = reg.records.iter().filter(|r| r.id != record.id).cloned().collect();
    records.push(record);
    let mut everything = records.clone();
    everything.extend(reg.unknown.iter().cloned());
    save(app, &everything)?;
    reg.defs.retain(|d| d.id != leaked.id);
    reg.defs.push(leaked);
    reg.records = records;
    Ok(leaked)
}

/// Forget an added model. Its downloaded files are left where they are.
pub fn remove<R: Runtime>(app: &tauri::AppHandle<R>, id: &str) -> Result<(), String> {
    let mut reg = registry().lock().map_err(|_| "The model list is busy.".to_string())?;
    let records: Vec<CustomModel> = reg.records.iter().filter(|r| r.id != id).cloned().collect();
    if records.len() == reg.records.len() {
        return Err("That is not one of your added models.".to_string());
    }
    let mut everything = records.clone();
    everything.extend(reg.unknown.iter().cloned());
    save(app, &everything)?;
    reg.defs.retain(|d| d.id != id);
    reg.records = records;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(family: &str, filename: &str) -> CustomModel {
        CustomModel {
            id: id_for("QuantStack/Qwen-Image-GGUF", filename),
            display_name: "Qwen-Image Q4".into(),
            family: family.into(),
            repo: "QuantStack/Qwen-Image-GGUF".into(),
            filename: filename.into(),
            size: 13_065_746_976,
            sha256: "645473886d7dbb0103f84c563c798f7b0867293d919752d4d6be6a432b0bc988".into(),
            license: "apache-2.0".into(),
        }
    }

    #[test]
    fn every_companion_has_a_real_looking_checksum_and_a_path() {
        for family in FAMILIES {
            assert!(!family.companions.is_empty(), "{}", family.id);
            for f in family.companions {
                assert_eq!(f.sha256.len(), 64, "{}", f.filename);
                assert!(f.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{}", f.filename);
                assert!(f.size > 0 && !f.repo.is_empty() && !f.filename.starts_with('/'), "{}", f.filename);
            }
        }
    }

    #[test]
    fn each_family_asks_for_the_encoders_its_command_line_needs() {
        let roles = |id: &str| family(id).unwrap().companions.iter().map(|f| f.role).collect::<Vec<_>>();
        assert_eq!(roles("z-image"), vec![Role::Vae, Role::Llm]);
        assert_eq!(roles("qwen-image"), vec![Role::Vae, Role::Llm]);
        assert_eq!(roles("qwen-image-2.1"), vec![Role::Vae, Role::Llm]);
        assert_eq!(roles("flux1"), vec![Role::Vae, Role::ClipL, Role::T5xxl]);
    }

    #[test]
    fn a_record_becomes_the_weights_plus_its_family_companions() {
        let def = def_of(&record("qwen-image", "Qwen_Image-Q4_K_M.gguf")).unwrap();
        assert_eq!(def.files.len(), 3);
        assert_eq!(def.files[0].role, Role::DiffusionModel);
        assert_eq!(def.files[0].filename, "Qwen_Image-Q4_K_M.gguf");
        assert_eq!(def.defaults.cfg_scale, 2.5);
        assert_eq!(def.total_bytes(), 13_065_746_976 + 253_806_246 + 4_683_072_512);
        assert!(def_of(&record("nonexistent", "x.gguf")).is_none());
    }

    #[test]
    fn the_fast_flux_variant_runs_in_four_steps() {
        let mut schnell = record("flux1", "flux1-schnell-q4_k.gguf");
        schnell.repo = "leejet/FLUX.1-schnell-gguf".into();
        assert_eq!(def_of(&schnell).unwrap().defaults.steps, 4);
        assert_eq!(def_of(&record("flux1", "flux1-dev-q4_k.gguf")).unwrap().defaults.steps, 20);
    }

    #[test]
    fn ids_are_readable_and_safe() {
        let id = id_for("QuantStack/Qwen-Image-GGUF", "Qwen_Image-Q4_K_M.gguf");
        assert!(id.starts_with("custom-quantstack-qwen-image-gguf-qwen-image-q4-k-m-"), "{id}");
        assert!(id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        assert!(id_for("a/b", "dir/../x y.gguf").starts_with("custom-a-b-x-y-"));
        assert!(id_for(&"x".repeat(200), "f.gguf").len() <= 96);
    }

    #[test]
    fn different_files_never_share_an_id() {
        // These spell the same once punctuation is dropped.
        assert_ne!(id_for("a/b-c", "d.gguf"), id_for("a-b/c", "d.gguf"));
        assert_ne!(id_for("a/b", "x_q4.gguf"), id_for("a/b", "x-q4.gguf"));
        assert_ne!(id_for(&"x".repeat(200), "one.gguf"), id_for(&"x".repeat(200), "two.gguf"));
        assert_eq!(id_for("a/b", "c.gguf"), id_for("a/b", "c.gguf"));
    }

    #[test]
    fn the_family_is_guessed_from_the_names() {
        assert_eq!(guess_family("QuantStack/Qwen-Image-GGUF", "Qwen_Image-Q4_K_M.gguf"), Some("qwen-image"));
        assert_eq!(guess_family("leejet/FLUX.1-dev-gguf", "flux1-dev-q4_k.gguf"), Some("flux1"));
        assert_eq!(guess_family("unsloth/Z-Image-Turbo-GGUF", "z-image-turbo-Q4_K_M.gguf"), Some("z-image"));
        assert_eq!(guess_family("someone/unknown-model", "m.gguf"), None);
        // The 2.1 release is not the original Qwen-Image, though both contain its name.
        assert_eq!(guess_family("unsloth/Qwen-Image-2.1-GGUF", "qwen-image-2.1-Q4_K_M.gguf"), Some("qwen-image-2.1"));
        assert_eq!(guess_family("unsloth/Qwen-Image-2512-GGUF", "qwen-image-2512-Q4_K_M.gguf"), Some("qwen-image"));
        // Editing variants need other arguments and are not guessed.
        assert_eq!(guess_family("x/FLUX.1-Kontext-dev-gguf", "flux1-kontext-dev-Q4_K_M.gguf"), None);
        assert_eq!(guess_family("x/Qwen-Image-Edit-GGUF", "qwen-image-edit-Q4_K_M.gguf"), None);
    }

    #[test]
    fn only_plausible_weights_files_are_accepted() {
        assert!(weights_file_problem("m.gguf", 1_000).is_none());
        assert!(weights_file_problem("dir/m.SAFETENSORS", 1_000).is_none());
        assert!(weights_file_problem("m.bin", 1_000).is_some());
        assert!(weights_file_problem("m.gguf", 0).is_some());
        assert!(weights_file_problem("m.gguf", 61 * 1024 * 1024 * 1024).is_some());
    }

    #[test]
    fn a_record_round_trips_in_camel_case() {
        let r = record("flux1", "f.gguf");
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"displayName\"") && json.contains("\"sha256\""));
        assert_eq!(serde_json::from_str::<CustomModel>(&json).unwrap(), r);
    }
}
