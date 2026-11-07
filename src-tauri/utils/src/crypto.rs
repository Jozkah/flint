use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use rand::{distributions::Alphanumeric, Rng};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Generates random app token
pub fn generate_app_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// Generate API key using HMAC-SHA256
pub fn generate_api_key(model_id: String, api_secret: String) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(api_secret.as_bytes())
        .map_err(|e| format!("Invalid key length: {}", e))?;
    mac.update(model_id.as_bytes());
    let result = mac.finalize();
    let code_bytes = result.into_bytes();
    let hash = general_purpose::STANDARD.encode(code_bytes);
    Ok(hash)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_app_token() {
        let token1 = generate_app_token();
        let token2 = generate_app_token();
        
        // Should be 32 characters long
        assert_eq!(token1.len(), 32);
        assert_eq!(token2.len(), 32);
        
        // Should be different each time
        assert_ne!(token1, token2);
        
        // Should only contain alphanumeric characters
        assert!(token1.chars().all(|c| c.is_alphanumeric()));
        assert!(token2.chars().all(|c| c.is_alphanumeric()));
    }

    #[test]
    fn test_generate_api_key() {
        let model_id = "test-model".to_string();
        let api_secret = "test-secret".to_string();
        
        let key1 = generate_api_key(model_id.clone(), api_secret.clone()).unwrap();
        let key2 = generate_api_key(model_id.clone(), api_secret.clone()).unwrap();
        
        // Should generate same key for same inputs
        assert_eq!(key1, key2);
        
        // Should be base64 encoded (and thus contain base64 characters)
        assert!(key1.chars().all(|c| c.is_alphanumeric() || c == '+' || c == '/' || c == '='));
        
        // Different model_id should produce different key
        let different_key = generate_api_key("different-model".to_string(), api_secret).unwrap();
        assert_ne!(key1, different_key);
    }

    #[test]
    fn test_generate_api_key_empty_inputs() {
        let result = generate_api_key("".to_string(), "secret".to_string());
        assert!(result.is_ok()); // Should still work with empty model_id
        
        let result = generate_api_key("model".to_string(), "".to_string());
        assert!(result.is_ok()); // Should still work with empty secret
    }
}
