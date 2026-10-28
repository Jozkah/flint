//! `message_send` and `message_check`: mail between runs.

use super::*;

/// Record a fact the model inferred, subject to Jan's own gates.
///
/// The model proposes; it does not decide. `memory::inferred::decide` reads the
/// "Automatically save local memories" setting and the existing records, and
/// answers with one of three outcomes. The reply tells the model what happened
/// in a sentence, because a tool that silently succeeds teaches it to propose
/// more, and one that silently fails teaches it to propose the same thing
/// again.
///
/// A proposal is never authority. Nothing here can widen what the model may do:
/// the worst case is a record the user is asked about.
/// AH-103. Who the message is from is this run, as the loop told us; the
/// model supplies only who it is for and what it says.
pub(super) fn message_send(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let (Some(data), Some(run), Some(session)) = (ctx.data_folder, ctx.run_id, ctx.session_id)
    else {
        return "ERROR [unsupported]: this surface has no run mailbox, so there is nobody to \
                write to."
            .to_string();
    };
    let to = args.get("to").and_then(|v| v.as_str()).unwrap_or_default().trim();
    let body = args.get("body").and_then(|v| v.as_str()).unwrap_or_default();
    if to.is_empty() || body.trim().is_empty() {
        return "ERROR [invalid_input]: message_send needs `to` and a non-empty `body`."
            .to_string();
    }
    let subject = args.get("subject").and_then(|v| v.as_str()).unwrap_or_default();

    let parsed = crate::identity::SessionId::parse(session).and_then(|session| {
        let from = crate::identity::RunId::parse(run)?;
        let to = crate::identity::RunId::parse(to)?;
        Ok((session, from, to))
    });
    let (session, from, to) = match parsed {
        Ok(ids) => ids,
        Err(e) => return format!("ERROR [{}]: {}", e.kind().tag(), e.message()),
    };
    match crate::mailbox::send(data, &session, &from, &to, subject, body) {
        Ok(message) => format!(
            "Delivered to {} as message {} of their mailbox.",
            message.to, message.seq
        ),
        Err(e) => {
            let harness: crate::harness_error::HarnessError = (&e).into();
            format!("ERROR [{}]: {}", harness.kind().tag(), e.message)
        }
    }
}

/// AH-103. What other runs have said to this one since it last looked.
pub(super) fn message_check(ctx: &ToolContext<'_>) -> String {
    let (Some(data), Some(run)) = (ctx.data_folder, ctx.run_id) else {
        return "ERROR [unsupported]: this surface has no run mailbox.".to_string();
    };
    let run = match crate::identity::RunId::parse(run) {
        Ok(run) => run,
        Err(e) => return format!("ERROR [{}]: {}", e.kind().tag(), e.message()),
    };
    // One step, so what is handed back is exactly what was marked delivered:
    // asking what is unread and then marking everything unread would stamp a
    // message that arrived in between and never show it to anyone.
    match crate::mailbox::collect(data, &run) {
        Ok(fresh) => {
            if fresh.is_empty() {
                return "No messages.".to_string();
            }
            let mut out = String::new();
            for message in &fresh {
                // Named as what it is: another agent's words, which are
                // information and not an instruction this run has to follow.
                // Text in them that imitates the harness is neutralized, and
                // the message says so in one line.
                let (subject, in_subject) = crate::control_tags::neutralize(&message.subject);
                let (body, in_body) = crate::control_tags::neutralize(&message.body);
                let screened = in_subject + in_body;
                out.push_str(&format!(
                    "From run {} at {}{}\n{}{}\n\n",
                    message.from,
                    message.at,
                    if subject.is_empty() {
                        String::new()
                    } else {
                        format!(" -- {subject}")
                    },
                    body,
                    if screened == 0 {
                        String::new()
                    } else {
                        format!("\n{}", crate::control_tags::note(screened))
                    }
                ));
            }
            out.trim_end().to_string()
        }
        Err(e) => {
            let harness: crate::harness_error::HarnessError = (&e).into();
            format!("ERROR [{}]: {}", harness.kind().tag(), e.message)
        }
    }
}
