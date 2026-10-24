//! Removes a temporary test directory on drop without masking an active panic.

/// Removes `path`, reporting cleanup errors unless the thread is already unwinding.
pub fn remove_on_drop(path: &std::path::Path) {
    if let Err(error) = std::fs::remove_dir_all(path) {
        if !std::thread::panicking() {
            panic!("remove {}: {error}", path.display());
        }
    }
}
