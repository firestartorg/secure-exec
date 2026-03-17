use std::ffi::OsString;

use crate::awk;
use crate::builtins;
use crate::column;
use crate::diff;
use crate::du;
use crate::expr;
use crate::file;
use crate::find;
use crate::grep;
use crate::gzip;
use crate::jq;
use crate::rev;
use crate::yq;
use crate::rg;
use crate::strings;
use crate::tar_cmd;
use crate::tree;

/// Command dispatch table.
/// Routes command names to their corresponding uutils entry points,
/// built-in implementations, or shim commands.
///
/// Commands are organized into categories:
/// - uutils crates: compiled from uutils/coreutils 0.7.0
/// - Built-in: minimal POSIX implementations for commands that don't compile for WASI
/// - Shims: commands requiring subprocess support via wasi-ext proc_spawn
/// - Stubs: commands impossible in WASM, returning helpful error messages
pub fn run(cmd: &str, args: Vec<OsString>) -> i32 {
    match cmd {
        // ===== shell (brush-shell, bash 5.x compatible) =====
        "sh" | "bash" => {
            // brush-shell reads from std::env::args() and calls std::process::exit().
            // In WASI, each command runs in its own Worker, so this is safe.
            brush_shell::entry::run();
            0 // unreachable — run() calls process::exit()
        }

        // ===== grep (POSIX BRE/ERE/fixed shim) + rg (ripgrep-compatible search) =====
        "grep" => grep::grep(args),
        "egrep" => grep::egrep(args),
        "fgrep" => grep::fgrep(args),
        "rg" => rg::rg(args),

        // ===== sed (uutils/sed, GNU sed compatible, MIT) =====
        "sed" => sed::sed::uumain(args.into_iter()),

        // ===== awk (awk-rs, pure Rust POSIX awk) =====
        "awk" => awk::awk(args),

        // ===== find (custom POSIX find, pure Rust) =====
        "find" => find::find(args),

        // ===== jq/yq (jaq, pure Rust jq implementation + format converters) =====
        "jq" => jq::jq(args),
        "yq" => yq::yq(args),

        // ===== uutils crate commands (patched for WASI, US-008) =====
        "cat" => uu_cat::uumain(args.into_iter()),
        "head" => uu_head::uumain(args.into_iter()),
        "ls" | "dir" | "vdir" => uu_ls::uumain(args.into_iter()),
        "sort" => uu_sort::uumain(args.into_iter()),
        "tail" => uu_tail::uumain(args.into_iter()),

        // ===== uutils crate commands (patched for WASI, US-009) =====
        "chmod" => uu_chmod::uumain(args.into_iter()),
        "cp" => uu_cp::uumain(args.into_iter()),
        "mkdir" => uu_mkdir::uumain(args.into_iter()),
        "mv" => uu_mv::uumain(args.into_iter()),
        "rm" => uu_rm::uumain(args.into_iter()),

        // ===== uutils crate commands (patched for WASI, US-010/US-015) =====
        "dd" => uu_dd::uumain(args.into_iter()),
        "ln" => uu_ln::uumain(args.into_iter()),
        "logname" => uu_logname::uumain(args.into_iter()),
        "mktemp" => uu_mktemp::uumain(args.into_iter()),
        "pathchk" => uu_pathchk::uumain(args.into_iter()),
        "split" => uu_split::uumain(args.into_iter()),
        "stat" => uu_stat::uumain(args.into_iter()),
        "tac" => uu_tac::uumain(args.into_iter()),
        "touch" => uu_touch::uumain(args.into_iter()),
        "tsort" => uu_tsort::uumain(args.into_iter()),

        // ===== Compression & Archiving (flate2 + tar, pure Rust) =====
        "gzip" | "gunzip" | "zcat" => gzip::gzip(args),
        "tar" => tar_cmd::tar_cmd(args),

        // ===== Diff (similar crate, MIT/Apache-2.0) =====
        "diff" => diff::diff(args),

        // ===== Custom builtins (trivial, no upstream crate) =====
        "rev" => rev::rev(args),
        "strings" => strings::strings(args),
        "column" => column::column(args),
        "du" => du::du(args),
        "expr" => expr::expr(args),
        "file" => file::file(args),
        "tree" => tree::tree(args),

        // ===== Built-in implementations =====
        // (minimal, WASM-specific — uutils versions impractical for these)
        "sleep" => builtins::sleep(args),
        "test" | "[" => builtins::test_cmd(args),
        "whoami" => builtins::whoami(args),

        // ===== Shim commands (require subprocess support) =====
        "env" => shims::env::env(args),
        "nice" => shims::nice::nice(args),
        "nohup" => shims::nohup::nohup(args),
        "stdbuf" => shims::stdbuf::stdbuf(args),
        "timeout" => shims::timeout::timeout(args),
        "xargs" => shims::xargs::xargs(args),

        // ===== uutils crate commands =====
        // -- Text processing / encoding --
        "base32" => uu_base32::uumain(args.into_iter()),
        "base64" => uu_base64::uumain(args.into_iter()),
        "basenc" => uu_basenc::uumain(args.into_iter()),
        "basename" => uu_basename::uumain(args.into_iter()),
        "comm" => uu_comm::uumain(args.into_iter()),
        "cut" => uu_cut::uumain(args.into_iter()),
        "dircolors" => uu_dircolors::uumain(args.into_iter()),
        "dirname" => uu_dirname::uumain(args.into_iter()),
        "echo" => uu_echo::uumain(args.into_iter()),
        "expand" => uu_expand::uumain(args.into_iter()),
        "factor" => uu_factor::uumain(args.into_iter()),
        "false" => uu_false::uumain(args.into_iter()),
        "fmt" => uu_fmt::uumain(args.into_iter()),
        "fold" => uu_fold::uumain(args.into_iter()),
        "join" => uu_join::uumain(args.into_iter()),
        "nl" => uu_nl::uumain(args.into_iter()),
        "numfmt" => uu_numfmt::uumain(args.into_iter()),
        "od" => uu_od::uumain(args.into_iter()),
        "paste" => uu_paste::uumain(args.into_iter()),
        "printenv" => uu_printenv::uumain(args.into_iter()),
        "printf" => uu_printf::uumain(args.into_iter()),
        "ptx" => uu_ptx::uumain(args.into_iter()),
        "seq" => uu_seq::uumain(args.into_iter()),
        "shuf" => uu_shuf::uumain(args.into_iter()),
        "tr" => uu_tr::uumain(args.into_iter()),
        "true" => uu_true::uumain(args.into_iter()),
        "unexpand" => uu_unexpand::uumain(args.into_iter()),
        "uniq" => uu_uniq::uumain(args.into_iter()),
        "wc" => uu_wc::uumain(args.into_iter()),
        "yes" => uu_yes::uumain(args.into_iter()),

        // -- Checksums --
        "b2sum" => uu_b2sum::uumain(args.into_iter()),
        "cksum" => uu_cksum::uumain(args.into_iter()),
        "md5sum" => uu_md5sum::uumain(args.into_iter()),
        "sha1sum" => uu_sha1sum::uumain(args.into_iter()),
        "sha224sum" => uu_sha224sum::uumain(args.into_iter()),
        "sha256sum" => uu_sha256sum::uumain(args.into_iter()),
        "sha384sum" => uu_sha384sum::uumain(args.into_iter()),
        "sha512sum" => uu_sha512sum::uumain(args.into_iter()),
        "sum" => uu_sum::uumain(args.into_iter()),

        // -- File operations --
        "link" => uu_link::uumain(args.into_iter()),
        "pwd" => uu_pwd::uumain(args.into_iter()),
        "readlink" => uu_readlink::uumain(args.into_iter()),
        "realpath" => uu_realpath::uumain(args.into_iter()),
        "rmdir" => uu_rmdir::uumain(args.into_iter()),
        "shred" => uu_shred::uumain(args.into_iter()),
        "tee" => uu_tee::uumain(args.into_iter()),
        "truncate" => uu_truncate::uumain(args.into_iter()),
        "unlink" => uu_unlink::uumain(args.into_iter()),

        // -- System info --
        "arch" => uu_arch::uumain(args.into_iter()),
        "date" => uu_date::uumain(args.into_iter()),
        "nproc" => uu_nproc::uumain(args.into_iter()),
        "uname" => uu_uname::uumain(args.into_iter()),

        // ===== Stubbed commands (impossible in WASM) =====
        "chcon" | "runcon" => {
            eprintln!("{}: SELinux is not supported in WASM", cmd);
            1
        }
        "chgrp" | "chown" => {
            eprintln!("{}: user/group ownership changes are not supported in WASM", cmd);
            1
        }
        "chroot" => {
            eprintln!("chroot: not supported in WASM (no filesystem root change)");
            1
        }
        "df" => {
            eprintln!("df: filesystem stats are not available in WASM");
            1
        }
        "groups" | "id" => {
            eprintln!("{}: user database queries are not supported in WASM", cmd);
            1
        }
        "hostname" => {
            // Provide a reasonable default
            println!("wasm-host");
            0
        }
        "hostid" => {
            println!("00000000");
            0
        }
        "install" => {
            eprintln!("install: file permission management not fully supported in WASM");
            1
        }
        "kill" => {
            eprintln!("kill: process signals are not supported in WASM");
            1
        }
        "mkfifo" | "mknod" => {
            eprintln!("{}: special file creation is not supported in WASM", cmd);
            1
        }
        "more" => {
            // Fall back to cat behavior
            uu_cat::uumain(args.into_iter())
        }
        "pinky" | "who" | "users" | "uptime" => {
            eprintln!("{}: login records (utmp) are not available in WASM", cmd);
            1
        }
        "stty" => {
            eprintln!("stty: terminal control is not supported in WASM");
            1
        }
        "sync" => {
            // No-op in WASM (VFS is in-memory)
            0
        }
        "tty" => {
            eprintln!("not a tty");
            1
        }

        // Process spawning test (internal)
        "spawn-test" => builtins::spawn_test(args),

        _ => {
            eprintln!("{}: command not found", cmd);
            127
        }
    }
}
