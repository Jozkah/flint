//! CoreGraphics posts bounded input events without an external automation app.
use super::{Action, output};
use std::ffi::c_void;
type Event = *mut c_void;
#[repr(C)] #[derive(Clone, Copy)] struct Point { x: f64, y: f64 }
#[repr(C)] struct Size { width: f64, height: f64 }
#[repr(C)] struct Rect { origin: Point, size: Size }
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> Rect;
    fn AXIsProcessTrusted() -> bool;
    fn CGEventCreateMouseEvent(source: Event, kind: u32, point: Point, button: u32) -> Event;
    fn CGEventCreateKeyboardEvent(source: Event, key: u16, down: bool) -> Event;
    fn CGEventKeyboardSetUnicodeString(event: Event, length: usize, text: *const u16);
    fn CGEventSetFlags(event: Event, flags: u64);
    fn CGEventSetIntegerValueField(event: Event, field: u32, value: i64);
    fn CGEventCreateScrollWheelEvent(source: Event, units: u32, wheels: u32, ...) -> Event;
    fn CGEventPost(tap: u32, event: Event);
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" { fn CFRelease(object: Event); }
pub fn capture_note(width: u32, height: u32) -> String {
    let bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    let scale = width as f64 / bounds.size.width;
    format!("Captured the primary display at {width} × {height} image pixels. Desktop coordinates use logical points: divide image x and y by {scale}, then add origin ({}, {}). Verify the target before acting.", bounds.origin.x, bounds.origin.y)
}
unsafe fn post(event: Event) -> Result<(), String> {
    if event.is_null() { return Err("macOS could not create an input event".into()); }
    CGEventPost(0, event);
    CFRelease(event);
    Ok(())
}
fn keycode(key: &str) -> u16 {
    match key {
        "a"=>0,"s"=>1,"d"=>2,"f"=>3,"h"=>4,"g"=>5,"z"=>6,"x"=>7,"c"=>8,"v"=>9,"b"=>11,"q"=>12,"w"=>13,"e"=>14,"r"=>15,"y"=>16,"t"=>17,
        "1"=>18,"2"=>19,"3"=>20,"4"=>21,"6"=>22,"5"=>23,"9"=>25,"7"=>26,"8"=>28,"0"=>29,"o"=>31,"u"=>32,"i"=>34,"p"=>35,"enter"=>36,"l"=>37,"j"=>38,"k"=>40,"n"=>45,"m"=>46,
        "tab"=>48,"space"=>49,"backspace"=>51,"escape"=>53,"meta"=>55,"shift"=>56,"alt"=>58,"ctrl"=>59,"home"=>115,"pageup"=>116,"delete"=>117,"end"=>119,"pagedown"=>121,"left"=>123,"right"=>124,"down"=>125,"up"=>126,
        _=>unreachable!("validated key"),
    }
}
unsafe fn input(action: &Action, cancel: Option<&crate::lifecycle::Token>) -> Result<(), String> {
    if cancel.is_some_and(|t| t.is_stopped()) { return Err("desktop input cancelled".into()); }
    if !AXIsProcessTrusted() { return Err("Allow Flint in System Settings → Privacy & Security → Accessibility before using desktop input".into()); }
    let source = std::ptr::null_mut();
    match action {
        Action::Move { x, y } => post(CGEventCreateMouseEvent(source, 5, Point { x:*x as f64, y:*y as f64 }, 0))?,
        Action::Click { x, y, button, count } => {
            let (button, down, up) = match button.as_str() { "right"=>(1,3,4), "middle"=>(2,25,26), _=>(0,1,2) };
            let point = Point { x:*x as f64, y:*y as f64 };
            post(CGEventCreateMouseEvent(source,5,point,0))?;
            for click in 1..=*count {
                for kind in [down, up] {
                    let event = CGEventCreateMouseEvent(source,kind,point,button);
                    if event.is_null() { return Err("macOS could not create a click event".into()); }
                    CGEventSetIntegerValueField(event, 1, click as i64); // click count
                    post(event)?;
                }
            }
        }
        Action::Type { x, y, text, replace } => {
            input(&Action::Click { x:*x, y:*y, button:"left".into(), count:1 }, cancel)?;
            if *replace { input(&Action::Key { x:*x, y:*y, keys:vec!["meta".into(),"a".into()] }, cancel)?; }
            for c in text.chars() {
                if cancel.is_some_and(|t| t.is_stopped()) { return Err("desktop input cancelled; some text may have been sent".into()); }
                if c == '\r' { continue; }
                for down in [true,false] {
                    let code = match c { '\n'=>36,'\t'=>48,_=>0 };
                    let event = CGEventCreateKeyboardEvent(source,code,down);
                    if event.is_null() { return Err("macOS could not create a keyboard event".into()); }
                    if c != '\n' && c != '\t' { let mut buffer = [0;2]; let utf16 = c.encode_utf16(&mut buffer); CGEventKeyboardSetUnicodeString(event,utf16.len(),utf16.as_ptr()); }
                    post(event)?;
                }
            }
        }
        Action::Key { x, y, keys } => {
            input(&Action::Click { x:*x, y:*y, button:"left".into(), count:1 }, cancel)?;
            let mut flags = 0;
            for key in keys {
                flags |= match key.as_str() { "shift"=>1<<17,"ctrl"=>1<<18,"alt"=>1<<19,"meta"=>1<<20,_=>0 };
            }
            // Attach modifiers to the event instead of leaving physical keys held.
            for key in keys.iter().filter(|k| !["ctrl","alt","shift","meta"].contains(&k.as_str())) {
                for down in [true,false] {
                    let event = CGEventCreateKeyboardEvent(source,keycode(key),down);
                    if event.is_null() { return Err("macOS could not create a keyboard event".into()); }
                    CGEventSetFlags(event, flags);
                    post(event)?;
                }
            }
        }
        Action::Scroll { x, y, amount } => {
            input(&Action::Click { x:*x, y:*y, button:"left".into(), count:1 }, cancel)?;
            post(CGEventCreateScrollWheelEvent(source, 1, 1, -*amount))?;
        }
        Action::Screenshot => unreachable!(),
    }
    Ok(())
}
pub async fn perform(action: &Action) -> Result<Option<Vec<u8>>, String> {
    if matches!(action, Action::Screenshot) {
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let path = dir.path().join("desktop.png");
        let mut cmd = tokio::process::Command::new("/usr/sbin/screencapture");
        cmd.args(["-x", "-m", "-t", "png"]).arg(&path);
        output(cmd).await.map_err(|e| format!("{e}. Allow Flint in macOS Screen Recording settings."))?;
        return Ok(Some(std::fs::read(path).map_err(|e| e.to_string())?));
    }
    let action = action.clone();
    let cancel = crate::lifecycle::current();
    tokio::task::spawn_blocking(move || unsafe { input(&action, cancel.as_ref()) }).await.map_err(|e| e.to_string())??;
    Ok(None)
}
