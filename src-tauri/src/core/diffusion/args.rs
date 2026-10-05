//! What is passed to `sd-server` and what is sent to it.
//!
//! Pure functions: the argument list and the request bodies are the part of
//! image generation most likely to go wrong silently (a flag spelled wrong, a
//! value out of range), so they are built here and tested without a GPU.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The model files one load needs, as absolute paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelFiles {
    pub diffusion_model: PathBuf,
    pub vae: PathBuf,
    /// The text encoder: a decoder-only LLM for Z-Image (`--llm`).
    pub llm: Option<PathBuf>,
    /// The text encoder for the Wan family (`--t5xxl`).
    pub t5xxl: Option<PathBuf>,
    /// The CLIP-L text encoder FLUX.1 takes beside its T5 (`--clip_l`).
    pub clip_l: Option<PathBuf>,
}

/// Where the weights sit while generating, trading speed for memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Offload {
    /// Everything on the GPU. Fastest, needs the most memory.
    #[default]
    None,
    /// Keep inactive parts in system memory and move them in as needed.
    Group,
    /// As much as possible in system memory. Slowest, for small GPUs.
    Model,
}

impl Offload {
    /// The next policy that uses less graphics memory, or `None` when this one
    /// already keeps as much as possible in system memory.
    pub fn lighter(self) -> Option<Offload> {
        match self {
            Offload::None => Some(Offload::Group),
            Offload::Group => Some(Offload::Model),
            Offload::Model => None,
        }
    }

    fn flags(self) -> &'static [&'static str] {
        match self {
            Offload::None => &[],
            Offload::Group => &["--offload-to-cpu", "--diffusion-fa"],
            Offload::Model => &[
                "--offload-to-cpu",
                "--clip-on-cpu",
                "--vae-on-cpu",
                "--diffusion-fa",
                "--vae-tiling",
            ],
        }
    }
}

fn path_arg(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The argument list that starts `sd-server` for `files`, listening on `port`.
///
/// `scratch` is an empty folder given for the three directories the server
/// insists on reading (LoRAs, upscalers, embeddings). They are not optional.
/// `extra` is appended last: the server takes the last value of a repeated flag.
pub fn build_server_args(
    files: &ModelFiles,
    port: u16,
    scratch: &Path,
    offload: Offload,
    backend: Option<&str>,
    extra: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--diffusion-model".into(),
        path_arg(&files.diffusion_model),
        "--vae".into(),
        path_arg(&files.vae),
    ];
    if let Some(llm) = &files.llm {
        args.push("--llm".into());
        args.push(path_arg(llm));
    }
    if let Some(t5) = &files.t5xxl {
        args.push("--t5xxl".into());
        args.push(path_arg(t5));
    }
    if let Some(clip) = &files.clip_l {
        args.push("--clip_l".into());
        args.push(path_arg(clip));
    }
    args.extend([
        "--listen-ip".into(),
        "127.0.0.1".into(),
        "--listen-port".into(),
        port.to_string(),
        "--lora-model-dir".into(),
        path_arg(scratch),
        "--hires-upscalers-dir".into(),
        path_arg(scratch),
        "--embd-dir".into(),
        path_arg(scratch),
    ]);
    // Flash attention and direct convolution are measured faster and harmless,
    // so every load has them; the offload policy may add `--diffusion-fa` again.
    let mut hardware: Vec<&str> = vec!["--diffusion-fa", "--diffusion-conv-direct"];
    for flag in offload.flags() {
        if !hardware.contains(flag) {
            hardware.push(flag);
        }
    }
    args.extend(hardware.into_iter().map(String::from));
    if let Some(backend) = backend {
        args.push("--backend".into());
        args.push(backend.to_string());
    }
    // Progress is read from the verbose log.
    args.push("-v".into());
    args.extend(extra.iter().cloned());
    args
}

/// Remove every `--backend <value>` pair, so a retry on the CPU can add its own:
/// the server joins repeated values instead of replacing them.
pub fn without_backend(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut skip = false;
    for arg in args {
        if skip {
            skip = false;
            continue;
        }
        if arg == "--backend" {
            skip = true;
            continue;
        }
        out.push(arg.clone());
    }
    out
}

/// Sampling settings that depend on the model, with the request overriding
/// only what it names.
#[derive(Debug, Clone, PartialEq)]
pub struct Sampling {
    pub steps: u32,
    pub cfg_scale: f64,
    pub sample_method: Option<String>,
    pub flow_shift: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageRequest {
    pub prompt: String,
    pub negative_prompt: String,
    pub width: u32,
    pub height: u32,
    pub batch: u32,
    pub seed: u32,
    pub sampling: Sampling,
    pub lora: Vec<(String, f64)>,
}

/// Bigger than this and the VAE decodes in tiles, or it runs out of memory.
const TILING_PIXELS: u64 = 1024 * 1024;

/// The body of `POST /sdcpp/v1/img_gen`.
pub fn build_img_gen_request(req: &ImageRequest) -> Value {
    let mut sample = json!({
        "sample_steps": req.sampling.steps,
        "guidance": { "txt_cfg": req.sampling.cfg_scale },
    });
    if let Some(method) = &req.sampling.sample_method {
        sample["sample_method"] = json!(method);
    }
    if let Some(shift) = req.sampling.flow_shift {
        sample["flow_shift"] = json!(shift);
    }
    let mut body = json!({
        "prompt": req.prompt,
        "negative_prompt": req.negative_prompt,
        "width": req.width,
        "height": req.height,
        "batch_count": req.batch,
        "output_format": "png",
        "seed": req.seed,
        "sample_params": sample,
        "lora": req.lora.iter().map(|(path, multiplier)| json!({ "path": path, "multiplier": multiplier })).collect::<Vec<_>>(),
    });
    if u64::from(req.width) * u64::from(req.height) > TILING_PIXELS {
        body["vae_tiling_params"] = json!({ "enabled": true });
    }
    body
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoRequest {
    pub prompt: String,
    pub negative_prompt: String,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub fps: u32,
    pub seed: u32,
    pub sampling: Sampling,
    pub lora: Vec<(String, f64)>,
}

/// The frame counts a video model can make: four times something, plus one.
pub fn snap_frames(frames: u32) -> u32 {
    let frames = frames.clamp(5, 241);
    ((frames - 1) / 4) * 4 + 1
}

/// The body of `POST /sdcpp/v1/vid_gen`.
pub fn build_vid_gen_request(req: &VideoRequest) -> Value {
    let mut sample = json!({
        "sample_steps": req.sampling.steps,
        "guidance": { "txt_cfg": req.sampling.cfg_scale },
    });
    if let Some(method) = &req.sampling.sample_method {
        sample["sample_method"] = json!(method);
    }
    if let Some(shift) = req.sampling.flow_shift {
        sample["flow_shift"] = json!(shift);
    }
    json!({
        "prompt": req.prompt,
        "negative_prompt": req.negative_prompt,
        "width": req.width,
        "height": req.height,
        "seed": req.seed,
        "video_frames": snap_frames(req.frames),
        "fps": req.fps,
        "sample_params": sample,
        "lora": req.lora.iter().map(|(path, multiplier)| json!({ "path": path, "multiplier": multiplier })).collect::<Vec<_>>(),
        // The video decoder is the part that runs out of memory first.
        "vae_tiling_params": { "enabled": true },
        "output_format": "webm",
    })
}

/// Why a size was refused, or `None` when it is fine.
pub fn size_problem(width: u32, height: u32, min: u32, max: u32) -> Option<String> {
    for (name, side) in [("width", width), ("height", height)] {
        if side < min || side > max {
            return Some(format!("The {name} must be between {min} and {max}."));
        }
        if side % 16 != 0 {
            return Some(format!("The {name} must be a multiple of 16."));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files() -> ModelFiles {
        ModelFiles {
            diffusion_model: "C:\\m\\z-image-turbo-Q4_K_M.gguf".into(),
            vae: "C:\\m\\ae.safetensors".into(),
            llm: Some("C:\\m\\Qwen3-4B-Instruct-2507-Q4_K_M.gguf".into()),
            t5xxl: None,
            clip_l: None,
        }
    }

    fn pairs(args: &[String]) -> Vec<(&str, &str)> {
        args.windows(2)
            .filter(|w| w[0].starts_with("--"))
            .map(|w| (w[0].as_str(), w[1].as_str()))
            .collect()
    }

    #[test]
    fn a_z_image_load_names_its_files_listener_and_scratch_folders() {
        let args = build_server_args(&files(), 5555, Path::new("C:\\s"), Offload::None, None, &[]);
        let p = pairs(&args);
        assert!(p.contains(&("--diffusion-model", "C:\\m\\z-image-turbo-Q4_K_M.gguf")));
        assert!(p.contains(&("--vae", "C:\\m\\ae.safetensors")));
        assert!(p.contains(&("--llm", "C:\\m\\Qwen3-4B-Instruct-2507-Q4_K_M.gguf")));
        assert!(p.contains(&("--listen-ip", "127.0.0.1")));
        assert!(p.contains(&("--listen-port", "5555")));
        for dir in ["--lora-model-dir", "--hires-upscalers-dir", "--embd-dir"] {
            assert!(p.contains(&(dir, "C:\\s")), "{dir}");
        }
        assert!(args.contains(&"--diffusion-fa".to_string()));
        assert!(args.contains(&"--diffusion-conv-direct".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("-v"));
    }

    #[test]
    fn a_wan_load_passes_the_encoder_as_t5xxl() {
        let wan = ModelFiles {
            llm: None,
            t5xxl: Some("C:\\m\\umt5.gguf".into()),
            ..files()
        };
        let args = build_server_args(&wan, 1, Path::new("s"), Offload::None, None, &[]);
        assert!(pairs(&args).contains(&("--t5xxl", "C:\\m\\umt5.gguf")));
        assert!(!args.contains(&"--llm".to_string()));
    }

    #[test]
    fn flux_passes_its_clip_encoder_beside_the_t5() {
        let flux = ModelFiles {
            diffusion_model: "m/flux.gguf".into(),
            vae: "m/ae.safetensors".into(),
            llm: None,
            t5xxl: Some("m/t5.gguf".into()),
            clip_l: Some("m/clip_l.safetensors".into()),
        };
        let args = build_server_args(&flux, 9, Path::new("s"), Offload::None, None, &[]);
        let at = args.iter().position(|a| a == "--clip_l").expect("--clip_l");
        assert_eq!(args[at + 1], "m/clip_l.safetensors");
        assert!(args.contains(&"--t5xxl".to_string()));
        // The others do not get one.
        let plain = build_server_args(&files(), 9, Path::new("s"), Offload::None, None, &[]);
        assert!(!plain.contains(&"--clip_l".to_string()));
    }

    #[test]
    fn lighter_offload_steps_down_and_stops() {
        assert_eq!(Offload::None.lighter(), Some(Offload::Group));
        assert_eq!(Offload::Group.lighter(), Some(Offload::Model));
        assert_eq!(Offload::Model.lighter(), None);
    }

    #[test]
    fn offload_policies_add_their_flags_once() {
        let none = build_server_args(&files(), 1, Path::new("s"), Offload::None, None, &[]);
        assert!(!none.contains(&"--offload-to-cpu".to_string()));
        let model = build_server_args(&files(), 1, Path::new("s"), Offload::Model, None, &[]);
        for flag in ["--offload-to-cpu", "--clip-on-cpu", "--vae-on-cpu", "--vae-tiling"] {
            assert!(model.contains(&flag.to_string()), "{flag}");
        }
        assert_eq!(model.iter().filter(|a| *a == "--diffusion-fa").count(), 1);
    }

    #[test]
    fn extra_arguments_come_last_so_they_win() {
        let args = build_server_args(
            &files(),
            1,
            Path::new("s"),
            Offload::None,
            Some("Vulkan0"),
            &["--threads".into(), "4".into()],
        );
        assert!(pairs(&args).contains(&("--backend", "Vulkan0")));
        assert_eq!(&args[args.len() - 2..], ["--threads", "4"]);
    }

    #[test]
    fn a_retry_on_the_cpu_replaces_the_backend() {
        let args = build_server_args(&files(), 1, Path::new("s"), Offload::None, Some("Vulkan0"), &[]);
        let stripped = without_backend(&args);
        assert!(!stripped.contains(&"--backend".to_string()));
        assert!(!stripped.contains(&"Vulkan0".to_string()));
        assert_eq!(stripped.len(), args.len() - 2);
    }

    fn sampling() -> Sampling {
        Sampling { steps: 8, cfg_scale: 1.0, sample_method: None, flow_shift: None }
    }

    #[test]
    fn an_image_request_carries_the_prompt_size_seed_and_steps() {
        let body = build_img_gen_request(&ImageRequest {
            prompt: "a cat".into(),
            negative_prompt: String::new(),
            width: 1024,
            height: 1024,
            batch: 2,
            seed: 42,
            sampling: sampling(),
            lora: vec![],
        });
        assert_eq!(body["prompt"], "a cat");
        assert_eq!(body["batch_count"], 2);
        assert_eq!(body["seed"], 42);
        assert_eq!(body["output_format"], "png");
        assert_eq!(body["sample_params"]["sample_steps"], 8);
        assert_eq!(body["sample_params"]["guidance"]["txt_cfg"], 1.0);
        assert!(body["sample_params"].get("sample_method").is_none());
        assert!(body.get("vae_tiling_params").is_none());
    }

    #[test]
    fn a_large_image_turns_on_vae_tiling_and_optional_sampling_is_sent_only_when_set() {
        let body = build_img_gen_request(&ImageRequest {
            prompt: "x".into(),
            negative_prompt: "blurry".into(),
            width: 1536,
            height: 1024,
            batch: 1,
            seed: 1,
            sampling: Sampling { sample_method: Some("euler".into()), flow_shift: Some(3.0), ..sampling() },
            lora: vec![("style.safetensors".into(), 0.7)],
        });
        assert_eq!(body["vae_tiling_params"]["enabled"], true);
        assert_eq!(body["negative_prompt"], "blurry");
        assert_eq!(body["sample_params"]["sample_method"], "euler");
        assert_eq!(body["sample_params"]["flow_shift"], 3.0);
        assert_eq!(body["lora"][0]["multiplier"], 0.7);
        assert_eq!(body["lora"][0]["path"], "style.safetensors");
    }

    #[test]
    fn video_frames_snap_to_four_times_something_plus_one_within_range() {
        assert_eq!(snap_frames(121), 121);
        assert_eq!(snap_frames(120), 117);
        assert_eq!(snap_frames(1), 5);
        assert_eq!(snap_frames(500), 241);
        assert_eq!(snap_frames(6), 5);
    }

    #[test]
    fn a_video_request_is_webm_with_tiling_and_snapped_frames() {
        let body = build_vid_gen_request(&VideoRequest {
            prompt: "a cat walking".into(),
            negative_prompt: String::new(),
            width: 832,
            height: 480,
            frames: 120,
            fps: 24,
            seed: 7,
            sampling: Sampling { steps: 30, cfg_scale: 5.0, sample_method: Some("euler".into()), flow_shift: Some(5.0) },
            lora: vec![],
        });
        assert_eq!(body["video_frames"], 117);
        assert_eq!(body["fps"], 24);
        assert_eq!(body["output_format"], "webm");
        assert_eq!(body["vae_tiling_params"]["enabled"], true);
        assert_eq!(body["sample_params"]["sample_steps"], 30);
    }

    #[test]
    fn sizes_must_be_in_range_and_a_multiple_of_sixteen() {
        assert_eq!(size_problem(1024, 1024, 256, 2048), None);
        assert!(size_problem(255, 1024, 256, 2048).unwrap().contains("width"));
        assert!(size_problem(1024, 2064, 256, 2048).unwrap().contains("height"));
        assert!(size_problem(1000, 1024, 256, 2048).unwrap().contains("multiple of 16"));
    }
}
