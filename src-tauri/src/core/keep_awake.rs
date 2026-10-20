//! Keep the machine from sleeping while an agent run is live.
//!
//! The web app turns it on when a run starts (if the user's setting allows) and
//! off when the last run ends. Windows only: `SetThreadExecutionState` is a
//! per-thread request, so one dedicated thread owns it and the commands only
//! send it messages. Other platforms have no API already linked here, so the
//! command is a no-op that reports `false`. The display may still sleep; only
//! system sleep is held off, and the request ends with the process.

/// Hold off system sleep (`true`) or release the hold (`false`). Returns
/// whether a hold is now in place.
#[tauri::command]
pub fn set_keep_awake(active: bool) -> bool {
    imp::set(active)
}

#[cfg(windows)]
mod imp {
    use std::sync::{mpsc, Mutex, OnceLock};
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    static TX: OnceLock<Mutex<mpsc::Sender<bool>>> = OnceLock::new();

    pub fn set(active: bool) -> bool {
        let tx = TX.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<bool>();
            std::thread::Builder::new()
                .name("keep-awake".into())
                .spawn(move || {
                    // The request is tied to this thread; it ends when the
                    // thread (or the process) does.
                    while let Ok(on) = rx.recv() {
                        let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
                        // SAFETY: plain Win32 call with documented flag values.
                        unsafe { SetThreadExecutionState(flags) };
                    }
                })
                .ok();
            Mutex::new(tx)
        });
        let sent = tx.lock().map(|tx| tx.send(active).is_ok()).unwrap_or(false);
        sent && active
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn set(_active: bool) -> bool {
        false
    }
}
