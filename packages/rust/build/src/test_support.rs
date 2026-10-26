use std::ffi::OsString;
use std::path::Path;

#[cfg(any(unix, windows))]
pub(crate) fn non_unicode_manifest_dir(base: &Path) -> OsString {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};

        let mut bytes = base.as_os_str().as_bytes().to_vec();
        bytes.push(0xff);
        OsString::from_vec(bytes)
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let mut wide = base.as_os_str().encode_wide().collect::<Vec<_>>();
        wide.push(0xd800);
        OsString::from_wide(&wide)
    }
}

#[cfg(not(any(unix, windows)))]
compile_error!("the build environment tests require a platform-native non-Unicode path constructor");
