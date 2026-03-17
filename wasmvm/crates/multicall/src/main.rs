#![cfg_attr(target_os = "wasi", feature(wasi_ext))]

mod awk;
mod builtins;
mod column;
mod diff;
mod dispatch;
mod du;
mod expr;
mod file;
mod find;
mod gzip;
mod grep;
mod jq;
mod rev;
mod rg;
mod strings;
mod tar_cmd;
mod tree;
mod yq;

use std::ffi::OsString;

/// Deserialize argv from WASM linear memory.
///
/// `argv_ptr` points to `argc` consecutive entries, each 8 bytes:
///   - bytes 0..4: pointer to UTF-8 string (u32 little-endian)
///   - bytes 4..8: length of string (u32 little-endian)
unsafe fn deserialize_argv(argc: u32, argv_ptr: *const u8) -> Vec<OsString> {
    let mut args = Vec::with_capacity(argc as usize);
    for i in 0..argc as usize {
        let entry_ptr = argv_ptr.add(i * 8);
        let str_ptr = u32::from_le_bytes([
            *entry_ptr,
            *entry_ptr.add(1),
            *entry_ptr.add(2),
            *entry_ptr.add(3),
        ]) as usize;
        let str_len = u32::from_le_bytes([
            *entry_ptr.add(4),
            *entry_ptr.add(5),
            *entry_ptr.add(6),
            *entry_ptr.add(7),
        ]) as usize;
        let bytes = std::slice::from_raw_parts(str_ptr as *const u8, str_len);
        let s = std::str::from_utf8_unchecked(bytes);
        args.push(OsString::from(s));
    }
    args
}

/// Primary WASM entry point for the multicall binary.
/// The JS host calls this to dispatch commands.
#[no_mangle]
pub extern "C" fn dispatch(
    cmd_ptr: *const u8,
    cmd_len: u32,
    argc: u32,
    argv_ptr: *const u8,
) -> i32 {
    let cmd = unsafe {
        std::str::from_utf8_unchecked(std::slice::from_raw_parts(cmd_ptr, cmd_len as usize))
    };
    let args = unsafe { deserialize_argv(argc, argv_ptr) };

    dispatch::run(cmd, args)
}

/// Extract the basename from a path string (e.g., "/usr/bin/cat" -> "cat").
/// Uses manual '/' split instead of std::path::Path::file_name() because
/// the WASI Path implementation may not handle Unix-style paths correctly.
fn basename(s: &str) -> &str {
    match s.rfind('/') {
        Some(pos) => &s[pos + 1..],
        None => s,
    }
}

fn main() {
    let args: Vec<OsString> = std::env::args_os().collect();
    if args.is_empty() {
        eprintln!("multicall: no command specified");
        std::process::exit(1);
    }
    // Extract just the command name from the path (e.g., "/usr/bin/cat" -> "cat")
    let cmd = args[0].to_str().map(basename).unwrap_or("").to_string();
    let exit_code = dispatch::run(&cmd, args);
    std::process::exit(exit_code);
}
