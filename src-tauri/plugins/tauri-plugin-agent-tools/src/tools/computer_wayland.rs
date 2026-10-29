//! Wayland desktop capture via the XDG portal, and input via the user's uinput
//! service. No root process is started by Flint and no XWayland fallback is used.
use super::{Action, output};

fn code(key: &str) -> u16 {
    match key {
        "ctrl"=>29,"alt"=>56,"shift"=>42,"meta"=>125,"enter"=>28,"tab"=>15,"escape"=>1,"backspace"=>14,"delete"=>111,"space"=>57,"up"=>103,"down"=>108,"left"=>105,"right"=>106,"home"=>102,"end"=>107,"pageup"=>104,"pagedown"=>109,
        "1"=>2,"2"=>3,"3"=>4,"4"=>5,"5"=>6,"6"=>7,"7"=>8,"8"=>9,"9"=>10,"0"=>11,
        "q"=>16,"w"=>17,"e"=>18,"r"=>19,"t"=>20,"y"=>21,"u"=>22,"i"=>23,"o"=>24,"p"=>25,
        "a"=>30,"s"=>31,"d"=>32,"f"=>33,"g"=>34,"h"=>35,"j"=>36,"k"=>37,"l"=>38,
        "z"=>44,"x"=>45,"c"=>46,"v"=>47,"b"=>48,"n"=>49,"m"=>50,
        _=>unreachable!("validated key"),
    }
}
fn chord(keys: &[String]) -> Vec<String> {
    let mut args = vec!["key".into(), "--key-delay".into(), "12".into()];
    args.extend(keys.iter().map(|key| format!("{}:1",code(key))));
    args.extend(keys.iter().rev().map(|key| format!("{}:0",code(key))));
    args
}
fn steps(action: &Action) -> Vec<(&'static str, Vec<String>)> {
    let mut steps = Vec::new();
    let target = match action {
        Action::Move { x,y } | Action::Click { x,y,.. } | Action::Type { x,y,.. } | Action::Key { x,y,.. } | Action::Scroll { x,y,.. } => Some((*x,*y)),
        _=>None,
    };
    if let Some((x,y)) = target { steps.push(("ydotool",vec!["mousemove".into(),"--absolute".into(),"-x".into(),x.to_string(),"-y".into(),y.to_string()])); }
    if matches!(action, Action::Type {..} | Action::Key {..} | Action::Scroll {..}) { steps.push(("ydotool",vec!["click".into(),"0xC0".into()])); }
    match action {
        Action::Click { button,count,.. } => steps.push(("ydotool",vec!["click".into(),"--repeat".into(),count.to_string(),"--next-delay".into(),"100".into(),match button.as_str() {"right"=>"0xC1","middle"=>"0xC2",_=>"0xC0"}.into()])),
        Action::Type { text,replace,.. } => {
            if *replace { steps.push(("ydotool",chord(&["ctrl".into(),"a".into()]))); }
            // Clipboard paste handles Unicode without depending on a US layout
            // or compositor-specific Unicode keyboard composition sequences.
            steps.push(("wl-copy",vec!["--type".into(),"text/plain;charset=utf-8".into(),"--".into(),text.clone()]));
            steps.push(("ydotool",chord(&["ctrl".into(),"v".into()])));
        }
        Action::Key { keys,.. } => steps.push(("ydotool",chord(keys))),
        Action::Scroll { amount,.. } => steps.push(("ydotool",vec!["mousemove".into(),"--wheel".into(),"-x".into(),"0".into(),"-y".into(),(-amount).to_string()])),
        _=>{},
    }
    steps
}

pub async fn perform(action: &Action) -> Result<Option<Vec<u8>>, String> {
    if matches!(action, Action::Screenshot) {
        let reply = ashpd::desktop::screenshot::Screenshot::request()
            .interactive(false).modal(true).send().await
            .map_err(|e| format!("Desktop screenshot portal failed: {e}. Install xdg-desktop-portal and your desktop's portal backend."))?
            .response().map_err(|e| format!("Desktop screenshot was not granted: {e}"))?;
        let path = reply.uri().to_file_path().map_err(|_| "The portal returned a non-file screenshot URI".to_string())?;
        let size = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?.len();
        if size > 20 * 1024 * 1024 { return Err("Desktop capture exceeds 20 MB".into()); }
        return Ok(Some(tokio::fs::read(path).await.map_err(|e| e.to_string())?));
    }
    // Typing goes through the clipboard (F06-006): keep what the user had
    // there and put it back afterwards, whether or not the input went through.
    let saved = if matches!(action, Action::Type {..}) { Some(clipboard_snapshot().await) } else { None };
    let result = run_steps(action).await;
    if let Some(saved) = saved { clipboard_restore(saved).await; }
    result.map(|()| None)
}

async fn run_steps(action: &Action) -> Result<(), String> {
    for (program,args) in steps(action) {
        let mut cmd = tokio::process::Command::new(program);
        // ydotool and wl-copy are the host's: keep an AppImage's bundled libs out.
        jan_process::HostProcessEnv::host_env(&mut cmd);
        cmd.args(args);
        output(cmd).await.map_err(|e| format!("{e}. Wayland input requires ydotool 1.x, a running ydotoold with uinput access, and an accessible YDOTOOL_SOCKET. Text entry also needs wl-clipboard (wl-copy). Flint does not start a privileged daemon."))?;
    }
    Ok(())
}

/// Largest clipboard content saved and put back; bigger content is left alone.
const CLIPBOARD_SAVE_CAP: usize = 8 * 1024 * 1024;

/// What the clipboard held before typing: `Some(bytes)` to put back, `None`
/// when it was empty (cleared afterwards), or `Err` when it cannot be read or
/// is too large (left with the typed text, as before).
async fn clipboard_snapshot() -> Result<Option<Vec<u8>>, ()> {
    let mut cmd = tokio::process::Command::new("wl-paste");
    jan_process::HostProcessEnv::host_env(&mut cmd);
    cmd.arg("--no-newline");
    match output(cmd).await {
        Ok(out) if out.stdout.len() <= CLIPBOARD_SAVE_CAP => Ok(Some(out.stdout)),
        Ok(_) => Err(()),
        // wl-paste exits non-zero with "Nothing is copied" on an empty clipboard.
        Err(e) if e.to_ascii_lowercase().contains("nothing is copied") => Ok(None),
        Err(_) => Err(()),
    }
}

async fn clipboard_restore(saved: Result<Option<Vec<u8>>, ()>) {
    use tokio::io::AsyncWriteExt;
    let Ok(saved) = saved else { return };
    let mut cmd = tokio::process::Command::new("wl-copy");
    jan_process::HostProcessEnv::host_env(&mut cmd);
    // Let the paste land before the content is swapped back.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let Some(bytes) = saved else {
        cmd.arg("--clear");
        let _ = output(cmd).await;
        return;
    };
    cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    let Ok(mut child) = cmd.spawn() else { return };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&bytes).await;
    }
    // wl-copy forks a server and returns once it holds the content.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_is_pasted_as_literal_data_after_focus_and_selection() {
        let text = "Olá 🐧 $(never-execute)";
        let plan = steps(&Action::Type {x:12,y:34,text:text.into(),replace:true});
        assert_eq!(plan[0].1, ["mousemove","--absolute","-x","12","-y","34"]);
        assert_eq!(plan[1].1, ["click","0xC0"]);
        assert_eq!(plan[2].1, ["key","--key-delay","12","29:1","30:1","30:0","29:0"]);
        assert_eq!(plan[3].0,"wl-copy");
        assert_eq!(plan[3].1.last().unwrap(),text);
        assert_eq!(plan[4].1, ["key","--key-delay","12","29:1","47:1","47:0","29:0"]);
    }
    #[test]
    fn scrolling_reverses_the_evdev_wheel_direction() {
        let plan = steps(&Action::Scroll {x:1,y:2,amount:3});
        assert_eq!(plan.last().unwrap().1.last().unwrap(),"-3");
    }
}
