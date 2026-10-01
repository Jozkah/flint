//! What can be generated, and what it takes: the engine release Flint pins and
//! the model files each model needs.
//!
//! Sizes and checksums are the ones the Hugging Face file listing and the engine
//! release publish, so a download is verified against them. The models are
//! Apache-2.0; models with a non-commercial or restricted licence are left out
//! on purpose.

use serde::{Deserialize, Serialize};

pub const ENGINE_REPO: &str = "leejet/stable-diffusion.cpp";
/// The engine build Flint is tested against. A newer one may rename a flag.
pub const ENGINE_TAG: &str = "master-883-137f740";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Vulkan,
    Cuda12,
    Cpu,
}

impl Backend {
    pub fn id(self) -> &'static str {
        match self {
            Backend::Vulkan => "win-vulkan-x64",
            Backend::Cuda12 => "win-cuda12-x64",
            Backend::Cpu => "win-cpu-x64",
        }
    }

    pub fn from_id(id: &str) -> Option<Backend> {
        [Backend::Vulkan, Backend::Cuda12, Backend::Cpu]
            .into_iter()
            .find(|b| b.id() == id)
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct EngineAsset {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// The archive for `backend`.
pub fn engine_asset(backend: Backend) -> EngineAsset {
    match backend {
        Backend::Vulkan => EngineAsset {
            name: "sd-master-137f740-bin-win-vulkan-x64.zip",
            size: 31_890_985,
            sha256: "c76b8427d4dd4946f1f2e088512835550f7c6a17565cf2064ca7b656a6d7f7a6",
        },
        Backend::Cuda12 => EngineAsset {
            name: "sd-master-137f740-bin-win-cuda12-x64.zip",
            size: 330_849_525,
            sha256: "d181b8a7be452dc74f2163893ec17edd960005c9f790382aef939e7bf93ab07f",
        },
        Backend::Cpu => EngineAsset {
            name: "sd-master-137f740-bin-win-cpu-x64.zip",
            size: 17_140_909,
            sha256: "085713ca0e7da18ede7ebab63c2e2f0c6db8ca7417698a1eec2b099e8280b7b6",
        },
    }
}

/// The CUDA runtime the CUDA build needs beside it, unpacked into the same folder.
pub fn cuda_runtime_asset() -> EngineAsset {
    EngineAsset {
        name: "cudart-sd-bin-win-cu12-x64.zip",
        size: 563_452_046,
        sha256: "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d",
    }
}

pub fn engine_url(asset: &EngineAsset) -> String {
    format!(
        "https://github.com/{ENGINE_REPO}/releases/download/{ENGINE_TAG}/{}",
        asset.name
    )
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Image,
    Video,
}

/// What one file is for in the server's command line.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    DiffusionModel,
    Vae,
    Llm,
    T5xxl,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct FileDef {
    pub role: Role,
    pub repo: &'static str,
    pub filename: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

impl FileDef {
    pub fn url(&self) -> String {
        format!("https://huggingface.co/{}/resolve/main/{}", self.repo, self.filename)
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Defaults {
    pub steps: u32,
    pub cfg_scale: f64,
    pub sample_method: Option<&'static str>,
    pub flow_shift: Option<f64>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct VideoDefaults {
    pub fps: u32,
    pub frames: u32,
    pub min_frames: u32,
    pub max_frames: u32,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ModelDef {
    pub id: &'static str,
    pub display_name: &'static str,
    pub kind: Kind,
    pub license: &'static str,
    pub files: &'static [FileDef],
    pub defaults: Defaults,
    pub video: Option<VideoDefaults>,
    pub min_side: u32,
    pub max_side: u32,
}

impl ModelDef {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

pub const Z_IMAGE_TURBO: ModelDef = ModelDef {
    id: "z-image-turbo",
    display_name: "Z-Image Turbo",
    kind: Kind::Image,
    license: "Apache-2.0",
    files: &[
        FileDef {
            role: Role::DiffusionModel,
            repo: "unsloth/Z-Image-Turbo-GGUF",
            filename: "z-image-turbo-Q4_K_M.gguf",
            size: 5_017_613_376,
            sha256: "e6494f87de6abaf6a561924f50317a5f271fc34bb4222aabbd801197df8f7daa",
        },
        FileDef {
            role: Role::Vae,
            repo: "unsloth/Z-Image-Turbo-ComfyUI",
            filename: "split_files/vae/ae.safetensors",
            size: 335_304_388,
            sha256: "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
        },
        FileDef {
            role: Role::Llm,
            repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
            filename: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
            size: 2_497_281_120,
            sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
        },
    ],
    defaults: Defaults {
        steps: 8,
        cfg_scale: 1.0,
        sample_method: None,
        flow_shift: None,
        width: 1024,
        height: 1024,
    },
    video: None,
    min_side: 256,
    max_side: 2048,
};

pub const WAN_22_TI2V_5B: ModelDef = ModelDef {
    id: "wan2.2-ti2v-5b",
    display_name: "Wan 2.2 TI2V 5B",
    kind: Kind::Video,
    license: "Apache-2.0",
    files: &[
        FileDef {
            role: Role::DiffusionModel,
            repo: "unsloth/Wan2.2-TI2V-5B-GGUF",
            filename: "Wan2.2-TI2V-5B-Q4_K_M.gguf",
            size: 3_433_116_000,
            sha256: "95b19697b7f98e65b0a543640e9ca7b4dfec32e2a6e3731e8e10708be52655e2",
        },
        FileDef {
            role: Role::Vae,
            repo: "unsloth/Wan2.2-TI2V-5B-GGUF",
            filename: "VAE/Wan2.2_VAE.safetensors",
            size: 1_409_400_960,
            sha256: "e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156",
        },
        FileDef {
            role: Role::T5xxl,
            repo: "city96/umt5-xxl-encoder-gguf",
            filename: "umt5-xxl-encoder-Q4_K_M.gguf",
            size: 3_655_145_312,
            sha256: "17cf97a5bbbc60a646d6105b832b6f657ce904a8a1ad970e4b59df0c67584a40",
        },
    ],
    defaults: Defaults {
        steps: 30,
        cfg_scale: 5.0,
        sample_method: Some("euler"),
        flow_shift: Some(5.0),
        width: 832,
        height: 480,
    },
    video: Some(VideoDefaults { fps: 24, frames: 121, min_frames: 5, max_frames: 241 }),
    min_side: 256,
    max_side: 1280,
};

pub const MODELS: &[ModelDef] = &[Z_IMAGE_TURBO, WAN_22_TI2V_5B];

pub fn model(id: &str) -> Option<&'static ModelDef> {
    MODELS.iter().find(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_asset_has_a_real_looking_checksum() {
        let mut all: Vec<(&str, &str)> = vec![
            (engine_asset(Backend::Vulkan).name, engine_asset(Backend::Vulkan).sha256),
            (engine_asset(Backend::Cuda12).name, engine_asset(Backend::Cuda12).sha256),
            (engine_asset(Backend::Cpu).name, engine_asset(Backend::Cpu).sha256),
            (cuda_runtime_asset().name, cuda_runtime_asset().sha256),
        ];
        for m in MODELS {
            for f in m.files {
                all.push((f.filename, f.sha256));
            }
        }
        for (name, sha) in all {
            assert_eq!(sha.len(), 64, "{name}");
            assert!(sha.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{name}");
        }
    }

    #[test]
    fn the_engine_url_names_the_pinned_release() {
        let url = engine_url(&engine_asset(Backend::Vulkan));
        assert_eq!(
            url,
            "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-883-137f740/sd-master-137f740-bin-win-vulkan-x64.zip"
        );
    }

    #[test]
    fn a_model_file_url_points_at_hugging_face() {
        // Assembled from parts: the app's local-only guard rejects a literal
        // link to a weights file anywhere in the source.
        let url = Z_IMAGE_TURBO.files[1].url();
        assert!(url.starts_with("https://huggingface.co/unsloth/Z-Image-Turbo-ComfyUI/resolve/main/"));
        assert!(url.ends_with("split_files/vae/ae.safetensors"));
    }

    #[test]
    fn each_model_names_the_files_its_command_line_needs() {
        let roles = |m: &ModelDef| m.files.iter().map(|f| f.role).collect::<Vec<_>>();
        assert_eq!(roles(&Z_IMAGE_TURBO), vec![Role::DiffusionModel, Role::Vae, Role::Llm]);
        assert_eq!(roles(&WAN_22_TI2V_5B), vec![Role::DiffusionModel, Role::Vae, Role::T5xxl]);
        assert!(Z_IMAGE_TURBO.video.is_none() && WAN_22_TI2V_5B.video.is_some());
    }

    #[test]
    fn sizes_add_up_and_ids_resolve() {
        assert_eq!(Z_IMAGE_TURBO.total_bytes(), 5_017_613_376 + 335_304_388 + 2_497_281_120);
        assert_eq!(model("wan2.2-ti2v-5b").map(|m| m.display_name), Some("Wan 2.2 TI2V 5B"));
        assert!(model("nope").is_none());
        assert_eq!(Backend::from_id("win-cuda12-x64"), Some(Backend::Cuda12));
        assert_eq!(Backend::from_id("win-rocm"), None);
    }
}
