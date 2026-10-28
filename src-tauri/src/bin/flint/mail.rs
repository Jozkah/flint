//! `flint agent mail`: send or peek at a run's mailbox. The arm body moved
//! verbatim out of `handle_agent`.

use super::*;

/// `flint agent mail`.
pub(crate) fn mail(run: String, session: Option<String>, from: Option<String>, body: Option<String>, subject: String, peek: bool) -> Result<(), HarnessError> {
    use tauri_plugin_agent_tools::identity::{RunId, SessionId};
    let data = app_lib::core::app::commands::resolve_jan_data_folder();
    let to = RunId::parse(run);
    match (to, from, body) {
        (Err(e), _, _) => Err(e),
        (Ok(to), Some(from), Some(body)) => session
            .ok_or_else(|| {
                HarnessError::new(
                    tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                    "sending needs --session: a message belongs to one conversation",
                )
            })
            .and_then(SessionId::parse)
            .and_then(|session| RunId::parse(from).map(|from| (session, from)))
            .and_then(|(session, from)| {
                tauri_plugin_agent_tools::mailbox::send(
                    &data, &session, &from, &to, &subject, &body,
                )
                .map_err(|e| HarnessError::from(&e))
            })
            .map(|message| {
                println!("delivered to {} as message {}", message.to, message.seq);
            }),
        (Ok(to), _, _) => {
            tauri_plugin_agent_tools::mailbox::read(&data, &to, !peek)
                .map_err(|e| HarnessError::from(&e))
                .map(|messages| {
                    if messages.is_empty() {
                        println!("no messages");
                    }
                    for message in messages {
                        println!(
                            "{} from {}{} [{}]",
                            message.at,
                            message.from,
                            if message.subject.is_empty() {
                                String::new()
                            } else {
                                format!(" -- {}", message.subject)
                            },
                            if message.delivered_at.is_some() { "read" } else { "unread" }
                        );
                        println!("  {}", message.body);
                    }
                })
        }
    }
}
