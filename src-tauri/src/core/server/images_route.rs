//! `POST /v1/images/generations`, the OpenAI-shaped way to make an image with the
//! model that is resident in the image engine.
//!
//! Only `response_format: "b64_json"` is served, so the response never carries a
//! URL to a file on this computer. The model must be the one already loaded: the
//! API does not load models, so a request cannot make the engine swap out a model
//! the user is using.

use crate::core::diffusion::{catalog, runtime};
use base64::Engine as _;
use serde_json::{json, Value};

#[derive(Debug, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
    pub param: Option<&'static str>,
    pub code: &'static str,
}

impl ApiError {
    fn invalid(message: impl Into<String>, param: &'static str) -> Self {
        Self { status: 400, message: message.into(), param: Some(param), code: "invalid_request" }
    }

    pub fn body(&self) -> Value {
        json!({ "error": {
            "message": self.message,
            "type": if self.status >= 500 { "server_error" } else { "invalid_request_error" },
            "param": self.param,
            "code": self.code,
        }})
    }
}

#[derive(Debug, PartialEq)]
pub struct Parsed {
    pub prompt: String,
    pub count: u32,
    pub size: Option<(u32, u32)>,
    pub seed: Option<u32>,
    pub negative_prompt: Option<String>,
    pub model: Option<String>,
}

/// `"1024x768"` (either `x`), or `auto` / empty for the model's own size.
fn parse_size(text: &str) -> Result<Option<(u32, u32)>, ApiError> {
    let text = text.trim();
    if text.is_empty() || text.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    let bad = || ApiError::invalid("size must be WIDTHxHEIGHT, such as 1024x1024, or auto.", "size");
    let (w, h) = text.split_once(['x', 'X']).ok_or_else(bad)?;
    let width: u32 = w.trim().parse().map_err(|_| bad())?;
    let height: u32 = h.trim().parse().map_err(|_| bad())?;
    Ok(Some((width, height)))
}

pub fn parse_request(body: &Value) -> Result<Parsed, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("The request body must be a JSON object.", "body"))?;
    let prompt = object
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| ApiError::invalid("prompt is required.", "prompt"))?
        .to_string();
    let count = match object.get("n") {
        None | Some(Value::Null) => 1,
        Some(n) => n
            .as_u64()
            .filter(|n| (1..=4).contains(n))
            .ok_or_else(|| ApiError::invalid("n must be a whole number from 1 to 4.", "n"))? as u32,
    };
    let size = match object.get("size") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => parse_size(s)?,
        Some(_) => return Err(ApiError::invalid("size must be a string such as 1024x1024.", "size")),
    };
    match object.get("response_format") {
        None | Some(Value::Null) => {}
        Some(Value::String(f)) if f == "b64_json" => {}
        Some(_) => {
            return Err(ApiError::invalid(
                "Only response_format b64_json is supported.",
                "response_format",
            ))
        }
    }
    let seed = match object.get("seed") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_u64()
                .filter(|s| *s <= u64::from(u32::MAX))
                .ok_or_else(|| ApiError::invalid("seed must be a whole number from 0 to 4294967295.", "seed"))?
                as u32,
        ),
    };
    let negative_prompt = object
        .get("negative_prompt")
        .and_then(Value::as_str)
        .map(String::from);
    let model = object.get("model").and_then(Value::as_str).map(String::from);
    Ok(Parsed { prompt, count, size, seed, negative_prompt, model })
}

/// Whether the requested model name refers to the resident model.
pub fn names_model(requested: &str, id: &str) -> bool {
    let requested = requested.trim();
    requested.eq_ignore_ascii_case(id)
        || catalog::model(id).is_some_and(|m| m.display_name.eq_ignore_ascii_case(requested))
}

/// Serve one request. `Ok` is the 200 body; `Err` carries its own status.
pub async fn generate(body: &Value) -> Result<Value, ApiError> {
    let parsed = parse_request(body)?;
    let app = crate::core::diffusion::app().ok_or(ApiError {
        status: 503,
        message: "The image engine is not available.".into(),
        param: None,
        code: "model_not_loaded",
    })?;
    let not_loaded = |what: String| ApiError {
        status: 503,
        message: what,
        param: Some("model"),
        code: "model_not_loaded",
    };
    let resident = runtime::resident_info()
        .await
        .filter(|r| r.kind == catalog::Kind::Image)
        .ok_or_else(|| not_loaded("No image model is loaded. Load one in Flint first.".into()))?;
    if let Some(requested) = &parsed.model {
        if !names_model(requested, &resident.model_id) {
            return Err(not_loaded(format!(
                "The loaded image model is {}, not {requested}.",
                resident.model_id
            )));
        }
    }
    let (width, height) = parsed.size.unzip();
    let generated = runtime::generate_image(
        app,
        runtime::ImageParams {
            model: resident.model_id.clone(),
            prompt: parsed.prompt,
            negative_prompt: parsed.negative_prompt,
            width,
            height,
            count: Some(parsed.count),
            seed: parsed.seed,
            steps: None,
        },
    )
    .await
    .map_err(|message| {
        let busy = message.contains("busy");
        let memory = message.contains("ran out of memory");
        ApiError {
            status: if busy { 429 } else { 500 },
            message,
            param: None,
            code: if busy { "busy" } else if memory { "insufficient_memory" } else { "server_error" },
        }
    })?;
    let mut data = Vec::new();
    for path in &generated.paths {
        let bytes = tokio::fs::read(path).await.map_err(|e| ApiError {
            status: 500,
            message: format!("Could not read the result: {e}"),
            param: None,
            code: "server_error",
        })?;
        data.push(json!({ "b64_json": base64::engine::general_purpose::STANDARD.encode(bytes) }));
    }
    Ok(json!({
        "created": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "data": data,
        "flint": { "job_id": generated.job_id, "seed": generated.seed },
    }))
}

// ---- /v1/videos ---------------------------------------------------------
//
// A video takes minutes, so the request returns at once with a job id and the
// client polls it, as with OpenAI's Videos API. Jobs live in memory: they are
// gone after a restart, but the file stays in the gallery.

use std::collections::HashMap;
use std::sync::{Mutex as StdMutex, OnceLock};

#[derive(Debug, Clone, PartialEq)]
enum VideoStatus {
    Queued,
    InProgress,
    Completed(String),
    Failed(String),
}

struct VideoJob {
    status: VideoStatus,
    model: String,
    seconds: u32,
    created: u64,
}

fn video_jobs() -> &'static StdMutex<HashMap<String, VideoJob>> {
    static JOBS: OnceLock<StdMutex<HashMap<String, VideoJob>>> = OnceLock::new();
    JOBS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, PartialEq)]
pub struct ParsedVideo {
    pub prompt: String,
    pub seconds: u32,
    pub size: Option<(u32, u32)>,
    pub seed: Option<u32>,
    pub negative_prompt: Option<String>,
    pub model: Option<String>,
}

/// The frame count a clip of `seconds` is made with: four times something, plus one.
pub fn frames_for_seconds(seconds: u32, fps: u32) -> u32 {
    let wanted = (seconds * fps + 1).max(5);
    (((wanted - 1) / 4) * 4 + 1).min(241)
}

pub fn parse_video_request(body: &Value) -> Result<ParsedVideo, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("The request body must be a JSON object.", "body"))?;
    let prompt = object
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| ApiError::invalid("prompt is required.", "prompt"))?
        .to_string();
    // OpenAI sends `seconds` as a string ("4"); accept a number too.
    let seconds = match object.get("seconds") {
        None | Some(Value::Null) => Some(5),
        Some(Value::String(s)) => s.trim().parse::<u32>().ok().filter(|n| (1..=10).contains(n)),
        Some(v) => v.as_u64().filter(|n| (1..=10).contains(n)).map(|n| n as u32),
    }
    .ok_or_else(|| ApiError::invalid("seconds must be a whole number from 1 to 10.", "seconds"))?;
    let size = match object.get("size") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => parse_size(s)?,
        Some(_) => return Err(ApiError::invalid("size must be a string such as 832x480.", "size")),
    };
    let seed = match object.get("seed") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_u64()
                .filter(|s| *s <= u64::from(u32::MAX))
                .ok_or_else(|| ApiError::invalid("seed must be a whole number from 0 to 4294967295.", "seed"))?
                as u32,
        ),
    };
    Ok(ParsedVideo {
        prompt,
        seconds,
        size,
        seed,
        negative_prompt: object.get("negative_prompt").and_then(Value::as_str).map(String::from),
        model: object.get("model").and_then(Value::as_str).map(String::from),
    })
}

fn video_json(id: &str, job: &VideoJob) -> Value {
    let (status, error) = match &job.status {
        VideoStatus::Queued => ("queued", Value::Null),
        VideoStatus::InProgress => ("in_progress", Value::Null),
        VideoStatus::Completed(_) => ("completed", Value::Null),
        VideoStatus::Failed(message) => ("failed", json!({ "message": message })),
    };
    json!({
        "id": id,
        "object": "video",
        "model": job.model,
        "status": status,
        "seconds": job.seconds.to_string(),
        "created_at": job.created,
        "error": error,
    })
}

fn not_found() -> ApiError {
    ApiError { status: 404, message: "No such video.".into(), param: Some("video_id"), code: "not_found" }
}

/// `POST /v1/videos`: start a clip and answer at once.
pub async fn create_video(body: &Value) -> Result<Value, ApiError> {
    let parsed = parse_video_request(body)?;
    let app = crate::core::diffusion::app().ok_or(ApiError {
        status: 503,
        message: "The image engine is not available.".into(),
        param: None,
        code: "model_not_loaded",
    })?;
    let not_loaded = |what: String| ApiError {
        status: 503,
        message: what,
        param: Some("model"),
        code: "model_not_loaded",
    };
    let resident = runtime::resident_info()
        .await
        .filter(|r| r.kind == catalog::Kind::Video)
        .ok_or_else(|| not_loaded("No video model is loaded. Load one in Flint first.".into()))?;
    if let Some(requested) = &parsed.model {
        if !names_model(requested, &resident.model_id) {
            return Err(not_loaded(format!(
                "The loaded video model is {}, not {requested}.",
                resident.model_id
            )));
        }
    }
    if resident.busy {
        return Err(ApiError {
            status: 429,
            message: "The engine is busy with another generation.".into(),
            param: None,
            code: "busy",
        });
    }
    let fps = catalog::model(&resident.model_id)
        .and_then(|m| m.video)
        .map(|v| v.fps)
        .unwrap_or(24);
    let id = format!("video_{}", uuid::Uuid::new_v4().simple());
    let job = VideoJob {
        status: VideoStatus::Queued,
        model: resident.model_id.clone(),
        seconds: parsed.seconds,
        created: now_secs(),
    };
    let reply = video_json(&id, &job);
    video_jobs().lock().unwrap().insert(id.clone(), job);

    let (width, height) = parsed.size.unzip();
    let params = runtime::VideoParams {
        model: resident.model_id,
        prompt: parsed.prompt,
        negative_prompt: parsed.negative_prompt,
        width,
        height,
        frames: Some(frames_for_seconds(parsed.seconds, fps)),
        seed: parsed.seed,
        steps: None,
    };
    let job_id = id.clone();
    tokio::spawn(async move {
        if let Some(j) = video_jobs().lock().unwrap().get_mut(&job_id) {
            j.status = VideoStatus::InProgress;
        }
        let outcome = runtime::generate_video(app, params).await;
        if let Some(j) = video_jobs().lock().unwrap().get_mut(&job_id) {
            j.status = match outcome {
                Ok(done) => match done.paths.first() {
                    Some(path) => VideoStatus::Completed(path.clone()),
                    None => VideoStatus::Failed("The engine returned no video.".into()),
                },
                Err(message) => VideoStatus::Failed(message),
            };
        }
    });
    Ok(reply)
}

/// `GET /v1/videos/{id}`.
pub fn get_video(id: &str) -> Result<Value, ApiError> {
    let jobs = video_jobs().lock().unwrap();
    jobs.get(id).map(|job| video_json(id, job)).ok_or_else(not_found)
}

/// `GET /v1/videos/{id}/content`: the WebM bytes of a finished clip.
pub async fn video_content(id: &str) -> Result<Vec<u8>, ApiError> {
    let path = {
        let jobs = video_jobs().lock().unwrap();
        match jobs.get(id).map(|j| j.status.clone()) {
            None => return Err(not_found()),
            Some(VideoStatus::Completed(path)) => path,
            Some(_) => {
                return Err(ApiError {
                    status: 409,
                    message: "The video is not finished yet.".into(),
                    param: None,
                    code: "not_ready",
                })
            }
        }
    };
    tokio::fs::read(&path).await.map_err(|e| ApiError {
        status: 500,
        message: format!("Could not read the video: {e}"),
        param: None,
        code: "server_error",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(body: Value) -> Result<Parsed, ApiError> {
        parse_request(&body)
    }

    #[test]
    fn a_minimal_request_gets_the_defaults() {
        let p = parse(json!({ "prompt": "  a cat  " })).unwrap();
        assert_eq!(p.prompt, "a cat");
        assert_eq!((p.count, p.size, p.seed), (1, None, None));
    }

    #[test]
    fn size_accepts_either_x_and_auto() {
        assert_eq!(parse(json!({"prompt":"p","size":"512x768"})).unwrap().size, Some((512, 768)));
        assert_eq!(parse(json!({"prompt":"p","size":"512X768"})).unwrap().size, Some((512, 768)));
        assert_eq!(parse(json!({"prompt":"p","size":"auto"})).unwrap().size, None);
        assert_eq!(parse(json!({"prompt":"p","size":""})).unwrap().size, None);
        let err = parse(json!({"prompt":"p","size":"big"})).unwrap_err();
        assert_eq!((err.status, err.param), (400, Some("size")));
    }

    #[test]
    fn each_bad_field_is_named() {
        for (body, param) in [
            (json!([1]), "body"),
            (json!({}), "prompt"),
            (json!({"prompt":"  "}), "prompt"),
            (json!({"prompt":"p","n":0}), "n"),
            (json!({"prompt":"p","n":5}), "n"),
            (json!({"prompt":"p","response_format":"url"}), "response_format"),
            (json!({"prompt":"p","seed":-1}), "seed"),
            (json!({"prompt":"p","seed":4294967296u64}), "seed"),
            (json!({"prompt":"p","size":7}), "size"),
        ] {
            let err = parse(body).unwrap_err();
            assert_eq!(err.param, Some(param));
            assert_eq!(err.status, 400);
        }
    }

    #[test]
    fn valid_options_are_kept() {
        let p = parse(json!({
            "prompt":"p","n":3,"seed":99,"negative_prompt":"blurry",
            "response_format":"b64_json","model":"Z-Image Turbo"
        }))
        .unwrap();
        assert_eq!((p.count, p.seed), (3, Some(99)));
        assert_eq!(p.negative_prompt.as_deref(), Some("blurry"));
        assert_eq!(p.model.as_deref(), Some("Z-Image Turbo"));
    }

    #[test]
    fn a_model_is_named_by_its_id_or_display_name_in_any_case() {
        assert!(names_model("z-image-turbo", "z-image-turbo"));
        assert!(names_model("Z-IMAGE-TURBO", "z-image-turbo"));
        assert!(names_model("z-image turbo", "z-image-turbo"));
        assert!(!names_model("z-image-turbo-x", "z-image-turbo"));
        assert!(names_model("Z-Image Turbo", "z-image-turbo"));
        assert!(!names_model("dall-e-3", "z-image-turbo"));
    }

    #[test]
    fn a_video_request_takes_seconds_as_text_or_number() {
        let a = parse_video_request(&json!({"prompt":"p","seconds":"4"})).unwrap();
        let b = parse_video_request(&json!({"prompt":"p","seconds":4})).unwrap();
        assert_eq!((a.seconds, b.seconds), (4, 4));
        assert_eq!(parse_video_request(&json!({"prompt":"p"})).unwrap().seconds, 5);
        for bad in [
            json!({"prompt":"p","seconds":"0"}),
            json!({"prompt":"p","seconds":11}),
            json!({"prompt":"p","seconds":"x"}),
        ] {
            assert_eq!(parse_video_request(&bad).unwrap_err().param, Some("seconds"));
        }
        assert_eq!(parse_video_request(&json!({"seconds":3})).unwrap_err().param, Some("prompt"));
    }

    #[test]
    fn seconds_become_frames_on_the_four_k_plus_one_lattice() {
        assert_eq!([1, 2, 3, 5].map(|s| frames_for_seconds(s, 24)), [25, 49, 73, 121]);
        assert_eq!(frames_for_seconds(10, 30), 241);
        assert_eq!(frames_for_seconds(0, 24), 5);
    }

    #[test]
    fn video_jobs_are_reported_and_unknown_ones_are_404() {
        let id = "video_test_1";
        video_jobs().lock().unwrap().insert(
            id.to_string(),
            VideoJob {
                status: VideoStatus::Failed("boom".into()),
                model: "wan2.2-ti2v-5b".into(),
                seconds: 2,
                created: 1,
            },
        );
        let body = get_video(id).unwrap();
        assert_eq!(body["status"], "failed");
        assert_eq!(body["error"]["message"], "boom");
        assert_eq!(body["seconds"], "2");
        assert_eq!(get_video("video_missing").unwrap_err().status, 404);
    }

    #[test]
    fn an_error_body_has_the_openai_shape() {
        let body = ApiError::invalid("nope", "n").body();
        assert_eq!(body["error"]["param"], "n");
        assert_eq!(body["error"]["type"], "invalid_request_error");
        assert_eq!(body["error"]["code"], "invalid_request");
    }
}
