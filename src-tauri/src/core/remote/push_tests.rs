//! Web Push: RFC 8291 vector, VAPID JWT, subscription storage and gating.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::json;

use super::auth::*;
use super::hub::*;
use super::push::*;

fn d(s: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(s).unwrap()
}

#[test]
fn rfc8291_test_vector() {
    // RFC 8291, Appendix A.
    let as_public = d("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    let ua_public = d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
    let auth = d("BTBZMqHH6r4Tts7J_aSIgg");
    let salt: [u8; 16] = d("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
    let ecdh = d("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs");
    let out = encrypt_with(
        &ecdh,
        &as_public,
        &ua_public,
        &auth,
        &salt,
        b"When I grow up, I want to be a watermelon",
    )
    .unwrap();
    assert_eq!(
        URL_SAFE_NO_PAD.encode(out),
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
    );
}

#[test]
fn encrypt_uses_a_fresh_key_and_salt_with_the_right_header() {
    use ring::agreement::{EphemeralPrivateKey, ECDH_P256};
    let rng = ring::rand::SystemRandom::new();
    let ua = EphemeralPrivateKey::generate(&ECDH_P256, &rng).unwrap();
    let sub = Subscription {
        endpoint: "https://fcm.googleapis.com/fcm/send/x".into(),
        keys: SubscriptionKeys {
            p256dh: URL_SAFE_NO_PAD.encode(ua.compute_public_key().unwrap().as_ref()),
            auth: URL_SAFE_NO_PAD.encode([7u8; 16]),
        },
    };
    let a = encrypt(&sub, b"hi").unwrap();
    let b = encrypt(&sub, b"hi").unwrap();
    assert_ne!(a[..16], b[..16], "salt is random");
    assert_eq!(&a[16..20], &4096u32.to_be_bytes());
    assert_eq!(a[20], 65);
    assert_eq!(a[21], 4);
    // salt + rs + idlen + key + (2 bytes + delimiter) + tag
    assert_eq!(a.len(), 16 + 4 + 1 + 65 + 3 + 16);
}

#[test]
fn vapid_jwt_is_es256_and_verifies() {
    let key = VapidKey::generate().unwrap();
    let jwt = key.jwt("https://fcm.googleapis.com", VAPID_SUBJECT, 1_900_000_000).unwrap();
    let parts: Vec<&str> = jwt.split('.').collect();
    assert_eq!(parts.len(), 3);
    let header: serde_json::Value = serde_json::from_slice(&d(parts[0])).unwrap();
    assert_eq!(header["alg"], "ES256");
    let claims: serde_json::Value = serde_json::from_slice(&d(parts[1])).unwrap();
    assert_eq!(claims["aud"], "https://fcm.googleapis.com");
    assert_eq!(claims["exp"], 1_900_000_000u64);
    let pk = d(&key.public_key_b64());
    assert_eq!(pk.len(), 65);
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, &pk)
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &d(parts[2]))
        .expect("signature verifies");
}

#[test]
fn vapid_key_persists_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("remote").join("vapid.json");
    let a = VapidKey::load_or_create(&p).unwrap();
    let b = VapidKey::load_or_create(&p).unwrap();
    assert_eq!(a.public_key_b64(), b.public_key_b64());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn request_carries_vapid_ttl_urgency_and_topic() {
    let key = VapidKey::generate().unwrap();
    let ua = ring::agreement::EphemeralPrivateKey::generate(
        &ring::agreement::ECDH_P256,
        &ring::rand::SystemRandom::new(),
    )
    .unwrap();
    let sub = Subscription {
        endpoint: "https://web.push.apple.com/abc".into(),
        keys: SubscriptionKeys {
            p256dh: URL_SAFE_NO_PAD.encode(ua.compute_public_key().unwrap().as_ref()),
            auth: URL_SAFE_NO_PAD.encode([1u8; 16]),
        },
    };
    let req = build_request(&key, &sub, &json!({"title":"t","tag":"approval-1"}), Category::Approval, now_ms()).unwrap();
    let h = |k: &str| req.headers.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
    assert!(h("authorization").unwrap().starts_with("vapid t="));
    assert_eq!(h("content-encoding").unwrap(), "aes128gcm");
    assert_eq!(h("urgency").unwrap(), "high");
    assert_eq!(h("ttl").unwrap(), "600");
    assert!(h("topic").unwrap().len() <= 32);
    assert_eq!(outcome_of(410), SendOutcome::Gone);
    assert_eq!(outcome_of(404), SendOutcome::Gone);
    assert_eq!(outcome_of(201), SendOutcome::Delivered);
}

fn sub(host: &str) -> Subscription {
    Subscription {
        endpoint: format!("https://{host}/push/1"),
        keys: SubscriptionKeys {
            p256dh: URL_SAFE_NO_PAD.encode([4u8; 65]),
            auth: URL_SAFE_NO_PAD.encode([0u8; 16]),
        },
    }
}

#[test]
fn only_known_push_services_are_accepted() {
    assert!(validate_subscription(&sub("fcm.googleapis.com")).is_ok());
    assert!(validate_subscription(&sub("web.push.apple.com")).is_ok());
    assert!(validate_subscription(&sub("updates.push.services.mozilla.com")).is_ok());
    assert!(validate_subscription(&sub("192.168.1.10")).is_err());
    assert!(validate_subscription(&sub("evil.example")).is_err());
    assert!(validate_subscription(&sub("googleapis.com.evil.example")).is_err());
    let mut s = sub("fcm.googleapis.com");
    s.endpoint = s.endpoint.replace("https", "http");
    assert!(validate_subscription(&s).is_err());
}

#[test]
fn quiet_hours_let_only_approvals_through() {
    let mut p = PushPrefs::default();
    p.quiet_hours = QuietHours { enabled: true, start: 22 * 60, end: 7 * 60 };
    let at = |h: u64| h * 3_600_000;
    assert!(!allowed(&p, Category::RunFinished, at(23)));
    assert!(!allowed(&p, Category::RunFinished, at(3)));
    assert!(allowed(&p, Category::Approval, at(23)));
    assert!(allowed(&p, Category::RunFinished, at(12)));
    // Offset: 21:00 UTC is 23:00 at +120.
    p.utc_offset_minutes = 120;
    assert!(!allowed(&p, Category::RunFinished, at(21)));
    p.run_finished = false;
    assert!(!allowed(&p, Category::RunFinished, at(12)));
    assert!(!allowed(&PushPrefs::default(), Category::ChatReply, 0));
}

#[test]
fn hide_content_and_url_are_sanitised() {
    let n = PushNotice {
        category: Category::Approval,
        title: "Run shell: rm -rf".into(),
        body: "secret".into(),
        url: "https://evil.example/".into(),
        tag: "approval-r1".into(),
        request_id: Some("r1".into()),
    };
    let mut p = PushPrefs::default();
    let v = payload(&n, &p);
    assert_eq!(v["url"], "/m/");
    assert_eq!(v["requestId"], "r1");
    p.hide_content = true;
    let v = payload(&n, &p);
    assert_eq!(v["title"], "Flint needs you");
    assert_eq!(v["body"], "");
}

struct NoWindow;
impl Frontend for NoWindow {
    fn rpc(&self, _: &RpcRequestEvent) -> bool {
        false
    }
    fn pairing_request(&self, _: &PairingRequestEvent) {}
    fn devices_changed(&self) {}
}

#[test]
fn subscriptions_live_with_the_device_and_go_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devices.json");
    let hub = RemoteHub::new(
        Default::default(),
        DeviceStore::load(path.clone()),
        std::sync::Arc::new(NoWindow),
        None,
    );
    hub.set_vapid(VapidKey::generate().unwrap());
    let start = hub.start_pairing();
    let claim = hub.claim_pairing("100.64.0.9".parse().unwrap(), &start.code, "P").unwrap();
    let dev = hub.confirm_pairing(&claim.request_id, true).unwrap().unwrap();
    let device = DeviceStore::load(path.clone()).list()[0].clone();

    let (r, _) = hub
        .push_rpc(&device, "push.subscribe", &json!({ "subscription": sub("evil.example") }))
        .unwrap();
    assert!(r.is_err());
    let (r, _) = hub
        .push_rpc(&device, "push.subscribe", &json!({ "subscription": sub("fcm.googleapis.com") }))
        .unwrap();
    assert!(r.is_ok());
    assert!(hub.push_rpc(&device, "chat.send", &json!({})).is_none());
    // Persisted with the device.
    let stored = DeviceStore::load(path.clone());
    assert_eq!(stored.list()[0].push.subscription, Some(sub("fcm.googleapis.com")));

    let notice = PushNotice {
        category: Category::RunFinished,
        title: "Done".into(),
        body: String::new(),
        url: "/m/#/c/1".into(),
        tag: "run-1".into(),
        request_id: None,
    };
    assert_eq!(hub.push_targets(&notice, 12 * 3_600_000, None).len(), 1);
    // A page showing on the phone: no push.
    hub.socket_visible(&dev.id, true);
    assert!(hub.push_targets(&notice, 12 * 3_600_000, None).is_empty());
    hub.socket_visible(&dev.id, false);
    assert_eq!(hub.push_targets(&notice, 12 * 3_600_000, None).len(), 1);

    let (r, t) = hub.push_rpc(&device, "push.test", &json!({})).unwrap();
    assert_eq!(r.unwrap()["sent"], 1);
    assert_eq!(t.len(), 1);

    hub.revoke(&dev.id);
    assert!(hub.push_targets(&notice, 12 * 3_600_000, None).is_empty());
    assert!(DeviceStore::load(path).list().is_empty());
}
