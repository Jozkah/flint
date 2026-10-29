//! One-shot approval tokens (O02-024).
//!
//! An `approval` that widens what the gate allows (`prompted`, `bypass`,
//! `secret`) is no longer taken as a bare string. The renderer first has Rust
//! mint a token for the exact call it is about to send: the session, the call
//! id, the tool name, a hash of the arguments and the approval itself. The
//! execute path then requires that token and consumes it. A token is random
//! (128 bits from the OS generator), lives in plugin memory only, expires after
//! [`TOKEN_TTL`] and is valid once: a replayed, forged or expired token, or one
//! presented with different arguments or a different approval, authorizes
//! nothing.
//!
//! `auto` needs no token: it is recorded in the audit only and never widens
//! what the gate allows.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::commands::ApprovalSource;

/// How long a minted token stays redeemable. The renderer mints immediately
/// before it executes, so this only has to cover IPC latency.
pub const TOKEN_TTL: Duration = Duration::from_secs(120);

/// What a token is bound to. Every field must match at redemption.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub session: String,
    pub call_id: Option<String>,
    pub name: String,
    pub args_hash: [u8; 32],
    pub approval: ApprovalSource,
}

impl Binding {
    pub fn new(
        session: &str,
        call_id: Option<&str>,
        name: &str,
        args: &serde_json::Value,
        approval: ApprovalSource,
    ) -> Self {
        Self {
            session: session.to_string(),
            call_id: call_id.map(str::to_string),
            name: name.to_string(),
            args_hash: hash_args(args),
            approval,
        }
    }
}

fn hash_args(args: &serde_json::Value) -> [u8; 32] {
    let bytes = serde_json::to_vec(args).unwrap_or_default();
    Sha256::digest(&bytes).into()
}

/// Whether `approval` widens the gate and therefore needs a token.
pub fn needs_token(approval: Option<ApprovalSource>) -> bool {
    matches!(
        approval,
        Some(ApprovalSource::Prompted | ApprovalSource::Bypass | ApprovalSource::Secret)
    )
}

#[derive(Default)]
pub struct Tokens {
    inner: Mutex<HashMap<String, (Binding, Instant)>>,
}

impl Tokens {
    pub fn mint(&self, binding: Binding) -> String {
        self.mint_at(binding, Instant::now())
    }

    fn mint_at(&self, binding: Binding, now: Instant) -> String {
        let bytes: [u8; 16] = rand::random();
        let token = format!("appr-{}", hex::encode(bytes));
        if let Ok(mut map) = self.inner.lock() {
            map.retain(|_, (_, issued)| now.duration_since(*issued) < TOKEN_TTL);
            map.insert(token.clone(), (binding, now));
        }
        token
    }

    /// Consume `token` if it was minted for exactly `binding` and is still
    /// live. A token presented by its own session is gone after this whatever
    /// the outcome, so a mismatched attempt cannot be retried with it.
    pub fn redeem(&self, token: &str, binding: &Binding) -> bool {
        self.redeem_at(token, binding, Instant::now())
    }

    fn redeem_at(&self, token: &str, binding: &Binding, now: Instant) -> bool {
        let Ok(mut map) = self.inner.lock() else {
            return false;
        };
        map.retain(|_, (_, issued)| now.duration_since(*issued) < TOKEN_TTL);
        // Another session's token stays put: guessing it must not cancel it.
        match map.get(token) {
            Some((b, _)) if b.session == binding.session => {}
            _ => return false,
        }
        match map.remove(token) {
            Some((b, issued)) => &b == binding && now.duration_since(issued) < TOKEN_TTL,
            None => false,
        }
    }
}

pub fn tokens() -> &'static Tokens {
    static TOKENS: OnceLock<Tokens> = OnceLock::new();
    TOKENS.get_or_init(Default::default)
}

/// The approval the execute path may act on: `approval` itself when it needs
/// no token or its token redeems, otherwise an error naming why.
pub fn verify(
    token: Option<&str>,
    session: &str,
    call_id: Option<&str>,
    name: &str,
    args: &serde_json::Value,
    approval: Option<ApprovalSource>,
) -> Result<Option<ApprovalSource>, String> {
    let approval_kind = match approval {
        Some(kind) if needs_token(approval) => kind,
        _ => return Ok(approval),
    };
    let binding = Binding::new(session, call_id, name, args, approval_kind);
    match token {
        Some(t) if tokens().redeem(t, &binding) => Ok(approval),
        _ => Err(format!(
            "tool '{name}' was refused: its approval token is missing, expired, already used, \
             or was issued for a different call"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn b(args: serde_json::Value) -> Binding {
        Binding::new("s1", Some("c1"), "write", &args, ApprovalSource::Prompted)
    }

    #[test]
    fn valid_token_is_accepted_once() {
        let t = Tokens::default();
        let tok = t.mint(b(json!({"path": "a"})));
        assert!(t.redeem(&tok, &b(json!({"path": "a"}))));
        assert!(!t.redeem(&tok, &b(json!({"path": "a"}))), "replay rejected");
    }

    #[test]
    fn wrong_args_or_scope_rejected_and_consumed() {
        let t = Tokens::default();
        let tok = t.mint(b(json!({"path": "a"})));
        assert!(!t.redeem(&tok, &b(json!({"path": "b"}))));
        assert!(
            !t.redeem(&tok, &b(json!({"path": "a"}))),
            "a failed attempt burns it"
        );

        let tok = t.mint(b(json!({})));
        let mut other = b(json!({}));
        other.approval = ApprovalSource::Bypass;
        assert!(!t.redeem(&tok, &other), "different approval scope");

        let tok = t.mint(b(json!({})));
        let mut other = b(json!({}));
        other.call_id = Some("c2".into());
        assert!(!t.redeem(&tok, &other), "different call id");
    }

    #[test]
    fn other_session_cannot_use_or_cancel() {
        let t = Tokens::default();
        let tok = t.mint(b(json!({})));
        let mut other = b(json!({}));
        other.session = "s2".into();
        assert!(!t.redeem(&tok, &other));
        assert!(
            t.redeem(&tok, &b(json!({}))),
            "still live for its own session"
        );
    }

    #[test]
    fn expired_rejected() {
        let t = Tokens::default();
        let t0 = Instant::now();
        let tok = t.mint_at(b(json!({})), t0);
        assert!(!t.redeem_at(&tok, &b(json!({})), t0 + TOKEN_TTL + Duration::from_secs(1)));
    }

    #[test]
    fn forged_rejected() {
        let t = Tokens::default();
        let _real = t.mint(b(json!({})));
        assert!(!t.redeem("appr-00000000000000000000000000000000", &b(json!({}))));
        assert!(!t.redeem("", &b(json!({}))));
    }

    #[test]
    fn tokens_are_random() {
        let t = Tokens::default();
        assert_ne!(t.mint(b(json!({}))), t.mint(b(json!({}))));
    }

    #[test]
    fn verify_requires_token_only_for_widening_approvals() {
        let args = json!({"x": 1});
        assert_eq!(verify(None, "vs", None, "git", &args, None), Ok(None));
        assert_eq!(
            verify(None, "vs", None, "git", &args, Some(ApprovalSource::Auto)),
            Ok(Some(ApprovalSource::Auto))
        );
        for a in [
            ApprovalSource::Prompted,
            ApprovalSource::Bypass,
            ApprovalSource::Secret,
        ] {
            assert!(
                verify(None, "vs", None, "git", &args, Some(a)).is_err(),
                "bare string {a:?}"
            );
            assert!(verify(Some("appr-forged"), "vs", None, "git", &args, Some(a)).is_err());
            let tok = tokens().mint(Binding::new("vs", None, "git", &args, a));
            assert_eq!(
                verify(Some(&tok), "vs", None, "git", &args, Some(a)),
                Ok(Some(a))
            );
            assert!(
                verify(Some(&tok), "vs", None, "git", &args, Some(a)).is_err(),
                "replay"
            );
        }
    }
}
