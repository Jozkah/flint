use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};

const OTHER_LABEL: &str = "Other (type your own)";
static NEXT_ASK_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct AskRequest {
    pub(crate) questions: Vec<Question>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub(crate) struct Question {
    pub id: String,
    pub question: String,
    pub options: Vec<OptionItem>,
    #[serde(default)]
    pub multi: bool,
    #[serde(default)]
    pub recommended: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub(crate) struct OptionItem {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct QuestionResult {
    pub id: String,
    #[serde(default)]
    pub selected: Vec<String>,
    #[serde(default)]
    pub custom_input: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum AskError {
    Cancelled,
}

pub(crate) type AskOutcome = Result<Vec<QuestionResult>, AskError>;
pub(crate) type AskRegistry = Arc<Mutex<HashMap<String, oneshot::Sender<AskOutcome>>>>;

impl AskRequest {
    pub(crate) fn parse(value: &Value) -> Result<Self, String> {
        let request: Self = serde_json::from_value(value.clone())
            .map_err(|e| format!("invalid ask request: {e}"))?;
        if request.questions.is_empty() {
            return Err("ask requires at least one question".into());
        }
        let mut ids = HashSet::new();
        for question in &request.questions {
            if question.id.trim().is_empty() || !ids.insert(question.id.as_str()) {
                return Err("question ids must be non-empty and unique".into());
            }
            if question.question.trim().is_empty() {
                return Err(format!("question '{}' has no prompt", question.id));
            }
            if !(2..=5).contains(&question.options.len()) {
                return Err(format!(
                    "question '{}' requires 2 to 5 options",
                    question.id
                ));
            }
            let mut labels = HashSet::new();
            for option in &question.options {
                if option.label.trim().is_empty()
                    || option.label == OTHER_LABEL
                    || !labels.insert(option.label.as_str())
                {
                    return Err(format!(
                        "question '{}' option labels must be non-empty, unique, and omit '{OTHER_LABEL}'",
                        question.id
                    ));
                }
            }
            if question
                .recommended
                .is_some_and(|index| index >= question.options.len())
            {
                return Err(format!(
                    "question '{}' recommended index is out of range",
                    question.id
                ));
            }
        }
        Ok(request)
    }

    pub(crate) fn validate_results(&self, results: &[QuestionResult]) -> Result<(), String> {
        if results.len() != self.questions.len() {
            return Err("ask response must answer every question exactly once".into());
        }
        let mut ids = HashSet::new();
        for result in results {
            if !ids.insert(result.id.as_str()) {
                return Err(format!("duplicate answer for '{}'", result.id));
            }
            let question = self
                .questions
                .iter()
                .find(|question| question.id == result.id)
                .ok_or_else(|| format!("unknown question id '{}'", result.id))?;
            let has_custom = result
                .custom_input
                .as_deref()
                .is_some_and(|text| !text.trim().is_empty());
            if result.custom_input.is_some() && !has_custom {
                return Err(format!("custom answer for '{}' cannot be empty", result.id));
            }
            if has_custom && !result.selected.is_empty() {
                return Err(format!(
                    "answer '{}' cannot select options and custom text",
                    result.id
                ));
            }
            if !has_custom && result.selected.is_empty() {
                return Err(format!("question '{}' requires an answer", result.id));
            }
            if !question.multi && result.selected.len() > 1 {
                return Err(format!("question '{}' accepts one option", result.id));
            }
            let mut selected = HashSet::new();
            for label in &result.selected {
                if !selected.insert(label.as_str())
                    || !question.options.iter().any(|option| option.label == *label)
                {
                    return Err(format!("invalid option '{label}' for '{}'", result.id));
                }
            }
        }
        Ok(())
    }

    /// What the model reads back: each question in its own words, then what
    /// the user chose (option labels) or wrote (their own text), so an answer
    /// never has to be matched to its question by id alone.
    pub(crate) fn render_results(&self, results: &[QuestionResult]) -> String {
        results
            .iter()
            .map(|result| {
                let id = serde_json::to_string(&result.id).expect("question ids serialize");
                let question = self
                    .questions
                    .iter()
                    .find(|question| question.id == result.id)
                    .map(|question| question.question.as_str())
                    .unwrap_or_default();
                let answer = match result.custom_input.as_deref() {
                    Some(text) => format!("User wrote: {text}"),
                    None => format!("User chose: {}", result.selected.join(", ")),
                };
                format!("Question {id}: {question}\n{answer}")
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// The results the loop falls back to when an `ask` times out with no user
    /// answer: each question resolved to its `recommended` option, or its first
    /// option when none is recommended. A multi-select question collapses to a
    /// single selected label. `parse` guarantees the index is in range and that
    /// no real option carries `OTHER_LABEL` (it is appended only for the user's
    /// UI), so every label here is one `validate_results` accepts.
    pub(crate) fn auto_selected_results(&self) -> Vec<QuestionResult> {
        self.questions
            .iter()
            .map(|question| {
                let index = question.recommended.unwrap_or(0);
                QuestionResult {
                    id: question.id.clone(),
                    selected: vec![question.options[index].label.clone()],
                    custom_input: None,
                }
            })
            .collect()
    }
}

/// What the model is told about `ask`. The web Cowork runner carries the same
/// text (web-app/src/lib/coworkTools.ts); keep the two in step.
pub(crate) const ASK_TOOL_DESCRIPTION: &str = "Ask the user one or more multiple-choice questions and wait for the answers. Use it when you need the user's input to proceed well: the request is ambiguous, there are several reasonable approaches and the choice is theirs, or a preference (naming, scope, library, style) is missing. Do not ask what you can find out yourself by reading files or searching, and do not ask for permission to use tools. For each question propose 2-4 concrete options, each a short label with a one-line description of what it means or costs. Set `recommended` to the index of the option you would pick. Set `multi` when the choices are not exclusive. The user can always type their own answer instead, so never add an \"Other\" option. Batch related questions into one call rather than asking one at a time. Each answer comes back as the question followed by the chosen label(s) or the user's own text.";

pub(crate) fn ask_tool_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "ask",
            "description": ASK_TOOL_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "minItems": 1,
                        "description": "One or more questions; batch related questions into one call.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string", "description": "Short stable key for this question, unique in the call (e.g. \"db\"). The answer comes back under it." },
                                "question": { "type": "string", "description": "The full question, one decision, ending with a question mark." },
                                "options": {
                                    "type": "array",
                                    "minItems": 2,
                                    "maxItems": 5,
                                    "description": "2-4 concrete choices you propose (at most 5). Do not add an \"Other\" option; the user can always type their own answer.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": { "type": "string", "description": "A few words naming the choice." },
                                            "description": { "type": "string", "description": "One short line: what this choice means or its trade-off." }
                                        },
                                        "required": ["label"],
                                        "additionalProperties": false
                                    }
                                },
                                "multi": { "type": "boolean", "description": "true when choices are not exclusive and the user may pick several." },
                                "recommended": { "type": "integer", "minimum": 0, "description": "0-based index of the option you recommend; it is marked in the UI." }
                            },
                            "required": ["id", "question", "options"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["questions"],
                "additionalProperties": false
            }
        }
    })
}

// Only the TUI owns an ask registry; the desktop `ask` IPC surface is not wired
// up yet, so these are absent from that build.
#[cfg(any(feature = "cli", test))]
pub(crate) fn new_registry() -> AskRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

pub(crate) async fn register(registry: &AskRegistry) -> (String, oneshot::Receiver<AskOutcome>) {
    let id = format!("ask-{}", NEXT_ASK_ID.fetch_add(1, Ordering::Relaxed));
    let (sender, receiver) = oneshot::channel();
    registry.lock().await.insert(id.clone(), sender);
    (id, receiver)
}

pub(crate) async fn respond(
    registry: &AskRegistry,
    request_id: &str,
    outcome: AskOutcome,
) -> Result<(), String> {
    let sender = registry
        .lock()
        .await
        .remove(request_id)
        .ok_or_else(|| format!("ask request '{request_id}' is no longer pending"))?;
    sender
        .send(outcome)
        .map_err(|_| format!("ask request '{request_id}' is no longer pending"))
}

#[cfg(any(feature = "cli", test))]
pub(crate) async fn cancel_all(registry: &AskRegistry) {
    let pending = std::mem::take(&mut *registry.lock().await);
    for (_, sender) in pending {
        let _ = sender.send(Err(AskError::Cancelled));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> AskRequest {
        AskRequest::parse(&json!({
            "questions": [{
                "id": "scope",
                "question": "Which scope?",
                "options": [
                    {"label": "Small", "description": "Only this module"},
                    {"label": "Large"}
                ],
                "multi": false,
                "recommended": 0
            }]
        }))
        .unwrap()
    }

    #[test]
    fn parses_valid_request_and_rejects_invalid_shapes() {
        let parsed = request();
        assert_eq!(parsed.questions[0].id, "scope");
        assert_eq!(parsed.questions[0].options.len(), 2);
        assert_eq!(parsed.questions[0].recommended, Some(0));

        for invalid in [
            json!({"questions": []}),
            json!({"questions": [{"id":"x","question":"?","options":[{"label":"one"}]}]}),
            json!({"questions": [
                {"id":"x","question":"?","options":[{"label":"one"},{"label":"two"}]},
                {"id":"x","question":"again?","options":[{"label":"one"},{"label":"two"}]}
            ]}),
            json!({"questions": [{"id":"x","question":"?","options":[{"label":"one"},{"label":"Other (type your own)"}]}]}),
            json!({"questions": [{"id":"x","question":"?","options":[{"label":"one"},{"label":"two"}],"recommended":2}]}),
        ] {
            assert!(AskRequest::parse(&invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn validates_structured_results_against_stable_ids_and_labels() {
        let req = request();
        let result = vec![QuestionResult {
            id: "scope".into(),
            selected: vec!["Small".into()],
            custom_input: None,
        }];
        assert!(req.validate_results(&result).is_ok());

        let unknown = vec![QuestionResult {
            id: "scope".into(),
            selected: vec!["Missing".into()],
            custom_input: None,
        }];
        assert!(req.validate_results(&unknown).is_err());

        let both = vec![QuestionResult {
            id: "scope".into(),
            selected: vec!["Small".into()],
            custom_input: Some("custom".into()),
        }];
        assert!(req.validate_results(&both).is_err());
    }

    #[test]
    fn render_results_pairs_each_question_with_its_answer() {
        let req = AskRequest::parse(&json!({
            "questions": [
                {"id": "db", "question": "Which database?", "options": [{"label": "SQLite"}, {"label": "Postgres"}]},
                {"id": "extras", "question": "Which extras?", "multi": true,
                 "options": [{"label": "Auth"}, {"label": "Logging"}, {"label": "Metrics"}]}
            ]
        }))
        .unwrap();
        let out = req.render_results(&[
            QuestionResult {
                id: "db".into(),
                selected: vec![],
                custom_input: Some("DuckDB".into()),
            },
            QuestionResult {
                id: "extras".into(),
                selected: vec!["Auth".into(), "Metrics".into()],
                custom_input: None,
            },
        ]);
        assert_eq!(
            out,
            "Question \"db\": Which database?\nUser wrote: DuckDB\n\nQuestion \"extras\": Which extras?\nUser chose: Auth, Metrics"
        );
    }

    #[test]
    fn tool_description_teaches_when_and_how_to_ask() {
        let schema = ask_tool_schema();
        let description = schema["function"]["description"].as_str().unwrap();
        for needle in [
            "ambiguous",
            "2-4 concrete options",
            "recommended",
            "multi",
            "type their own answer",
            "Batch related questions",
            "find out yourself",
        ] {
            assert!(description.contains(needle), "missing {needle}");
        }
        let item = &schema["function"]["parameters"]["properties"]["questions"]["items"];
        assert_eq!(item["required"], json!(["id", "question", "options"]));
        assert!(item["properties"]["recommended"]["description"].is_string());
        assert!(
            item["properties"]["options"]["items"]["properties"]["description"]["description"]
                .is_string()
        );
        // Backward compatible: an old-shape request still parses.
        assert!(AskRequest::parse(&json!({"questions": [{"id": "x", "question": "?", "options": [{"label": "a"}, {"label": "b"}]}]})).is_ok());
    }

    #[test]
    fn auto_selection_follows_recommended_then_first_and_validates() {
        // Recommended present -> that option; multi-select collapses to one.
        let recommended = AskRequest::parse(&json!({
            "questions": [{
                "id": "scope",
                "question": "Which scope?",
                "options": [{"label": "Small"}, {"label": "Large"}, {"label": "Huge"}],
                "multi": true,
                "recommended": 1
            }]
        }))
        .unwrap();
        let results = recommended.auto_selected_results();
        assert_eq!(results[0].selected, vec!["Large"]);
        assert!(recommended.validate_results(&results).is_ok());

        // No recommended -> first option.
        let first = AskRequest::parse(&json!({
            "questions": [{
                "id": "scope",
                "question": "Which scope?",
                "options": [{"label": "Alpha"}, {"label": "Beta"}]
            }]
        }))
        .unwrap();
        let results = first.auto_selected_results();
        assert_eq!(results[0].selected, vec!["Alpha"]);
        assert!(first.validate_results(&results).is_ok());

        // Every auto-selected label is a real option, never the UI-only OTHER.
        for question in first.questions.iter().chain(recommended.questions.iter()) {
            let picked = &question.options[question.recommended.unwrap_or(0)].label;
            assert_ne!(picked, OTHER_LABEL);
        }
    }

    #[tokio::test]
    async fn registry_rejects_stale_response_and_cancel_drains_waiters() {
        let registry = new_registry();
        let (first_id, first_rx) = register(&registry).await;
        let (second_id, second_rx) = register(&registry).await;
        assert_ne!(first_id, second_id);
        assert_eq!(registry.lock().await.len(), 2);

        assert!(respond(&registry, "missing", Ok(vec![])).await.is_err());
        cancel_all(&registry).await;
        assert!(matches!(first_rx.await.unwrap(), Err(AskError::Cancelled)));
        assert!(matches!(second_rx.await.unwrap(), Err(AskError::Cancelled)));
        assert!(registry.lock().await.is_empty());
    }
}
