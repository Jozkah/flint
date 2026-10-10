use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    BinaryNotFound,
    ModelFileNotFound,
    ModelLoadFailed,
    ModelLoadTimedOut,
    ModelArchNotSupported,
    OutOfMemory,
    MlxProcessError,
    IoError,
    InternalError,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("MlxError {{ code: {code:?}, message: \"{message}\" }}")]
pub struct MlxError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl MlxError {
    pub fn new(code: ErrorCode, message: String, details: Option<String>) -> Self {
        Self {
            code,
            message,
            details,
        }
    }

    /// Parses stderr from the MLX server and creates a specific MlxError.
    pub fn from_stderr(stderr: &str) -> Self {
        let lower_stderr = stderr.to_lowercase();

        // MLX runs on Metal, where weights and KV cache must fit the GPU's
        // working set, and its allocator words that failure in several ways.
        let is_out_of_memory = lower_stderr.contains("out of memory")
            || lower_stderr.contains("failed to allocate")
            || lower_stderr.contains("insufficient memory")
            || lower_stderr.contains("metal::malloc") // MLX Metal allocator throw
            || lower_stderr.contains("maximum allowed buffer size")
            || lower_stderr.contains("recommended max working set size")
            || lower_stderr.contains("recommended working set size")
            || lower_stderr.contains("kiogpucommandbuffercallbackerroroutofmemory");

        if is_out_of_memory {
            return Self::new(
                ErrorCode::OutOfMemory,
                "Out of memory. The model requires more RAM than available.".into(),
                Some(stderr.into()),
            );
        }

        // The bundled mlx-vlm does not know this model's architecture, which
        // a model newer than the sidecar produces; retrying cannot help.
        let is_unsupported_arch = (lower_stderr.contains("model type")
            && lower_stderr.contains("not supported"))
            || lower_stderr.contains("unknown model type")
            || lower_stderr.contains("no module named 'mlx_vlm.models");

        if is_unsupported_arch {
            return Self::new(
                ErrorCode::ModelArchNotSupported,
                "This model's architecture is not supported by the MLX backend yet.".into(),
                Some(stderr.into()),
            );
        }

        Self::new(
            ErrorCode::MlxProcessError,
            "The MLX model process encountered an unexpected error.".into(),
            Some(stderr.into()),
        )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error(transparent)]
    Mlx(#[from] MlxError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Tauri error: {0}")]
    Tauri(#[from] tauri::Error),
}

impl serde::Serialize for ServerError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let error_to_serialize: MlxError = match self {
            ServerError::Mlx(err) => err.clone(),
            ServerError::Io(e) => MlxError::new(
                ErrorCode::IoError,
                "An input/output error occurred.".into(),
                Some(e.to_string()),
            ),
            ServerError::Tauri(e) => MlxError::new(
                ErrorCode::InternalError,
                "An internal application error occurred.".into(),
                Some(e.to_string()),
            ),
        };
        error_to_serialize.serialize(serializer)
    }
}

pub type ServerResult<T> = Result<T, ServerError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_generic_out_of_memory() {
        let err = MlxError::from_stderr("RuntimeError: Out of memory");
        assert!(matches!(err.code, ErrorCode::OutOfMemory), "{err:?}");
    }

    // Atomic-Chat#76: the allocator and the command buffer each word an
    // out-of-memory differently, and neither says "out of memory".
    #[test]
    fn classifies_metal_allocator_and_command_buffer_oom() {
        for stderr in [
            "std::runtime_error: [metal::malloc] Attempting to allocate 18253611008 bytes \
             which is greater than the maximum allowed buffer size of 17179869184 bytes.",
            "[METAL] Command buffer execution failed: Insufficient Memory \
             (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)",
            "exceeds the recommended working set size of this device",
        ] {
            let err = MlxError::from_stderr(stderr);
            assert!(matches!(err.code, ErrorCode::OutOfMemory), "{stderr}: {err:?}");
        }
    }

    #[test]
    fn classifies_an_unsupported_architecture() {
        for stderr in [
            "ValueError: Model type qwen3_5_moe not supported.",
            "ModuleNotFoundError: No module named 'mlx_vlm.models.gemma5'",
        ] {
            let err = MlxError::from_stderr(stderr);
            assert!(
                matches!(err.code, ErrorCode::ModelArchNotSupported),
                "{stderr}: {err:?}"
            );
        }
    }

    #[test]
    fn anything_else_stays_a_process_error() {
        let err = MlxError::from_stderr("Traceback: KeyError: 'x'");
        assert!(matches!(err.code, ErrorCode::MlxProcessError), "{err:?}");
    }
}
