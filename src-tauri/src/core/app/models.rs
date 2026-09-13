use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AppConfiguration {
    pub data_folder: String,
    /// The saved data folder, when it could not be used this run and
    /// `data_folder` is the default instead (janhq/jan#8855). Reported so the
    /// settings page can say so; never written back to the configuration file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_data_folder: Option<String>,
}

impl Default for AppConfiguration {
    fn default() -> Self {
        Self {
            data_folder: String::from("./data"),
            unavailable_data_folder: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_uses_relative_data_folder() {
        let config = AppConfiguration::default();
        assert_eq!(config.data_folder, "./data");
    }

    #[test]
    fn serializes_round_trip_via_json() {
        let config = AppConfiguration {
            data_folder: "/tmp/jan".to_string(),
            unavailable_data_folder: None,
        };
        let json = serde_json::to_string(&config).expect("serialize");
        assert!(json.contains("\"data_folder\""));
        assert!(json.contains("/tmp/jan"));
        // The run-time report stays out of the file.
        assert!(!json.contains("unavailable_data_folder"));

        let parsed: AppConfiguration = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.data_folder, config.data_folder);
    }

    #[test]
    fn deserializes_from_known_payload() {
        let json = r#"{"data_folder":"/var/lib/jan"}"#;
        let parsed: AppConfiguration = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.data_folder, "/var/lib/jan");
    }

    #[test]
    fn clone_preserves_data_folder() {
        let config = AppConfiguration {
            data_folder: "x".into(),
            unavailable_data_folder: None,
        };
        let dup = config.clone();
        assert_eq!(config.data_folder, dup.data_folder);
    }
}
