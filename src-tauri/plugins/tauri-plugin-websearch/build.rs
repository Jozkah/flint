const COMMANDS: &[&str] = &["web_search", "web_fetch", "image_search"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
