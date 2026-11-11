//! The owner's guest-link commands, as the server's RPC lists them. The work is
//! `core::guest::call`; this list is kept here so the web command inventory
//! (`web-app/scripts/web-command-inventory.ts`) sees them as routed.

pub const GUEST_COMMANDS: [&str; 8] = [
    "guest_share_settings_get",
    "guest_share_settings_set",
    "guest_share_create",
    "guest_share_list",
    "guest_share_stop",
    "guest_share_extend",
    "guest_share_pending",
    "guest_share_resolve",
];

#[cfg(test)]
mod tests {
    #[test]
    fn the_list_matches_what_the_core_answers() {
        for command in super::GUEST_COMMANDS {
            assert!(crate::core::guest::handles(command), "{command}");
        }
        assert!(!crate::core::guest::handles("guest_share_other"));
    }
}
