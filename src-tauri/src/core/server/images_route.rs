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
    fn an_error_body_has_the_openai_shape() {
        let body = ApiError::invalid("nope", "n").body();
        assert_eq!(body["error"]["param"], "n");
        assert_eq!(body["error"]["type"], "invalid_request_error");
        assert_eq!(body["error"]["code"], "invalid_request");
    }
}
