use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// The ICU major version that the bundled `icudtl.dat` was built for.
/// Update this constant (and the `icudtl.dat` file) when upgrading the V8
/// crate to a version that ships a different ICU.
///
/// To update:
///   1. Check the new ICU version in the V8 crate's
///      `third_party/icu/source/common/unicode/uvernum.h` (U_ICU_VERSION_MAJOR_NUM).
///   2. Download the matching full ICU data from:
///      https://github.com/unicode-org/icu/releases/download/release-{MAJOR}-{MINOR}/icu4c-{MAJOR}_{MINOR}-data-bin-l.zip
///   3. Extract `icudt{MAJOR}l.dat`, rename to `icudtl.dat`, and place it
///      in this directory (`native/v8-runtime/icudtl.dat`).
///   4. Update `BUNDLED_ICU_MAJOR_VERSION` below.
const BUNDLED_ICU_MAJOR_VERSION: u32 = 74;

fn cargo_home() -> PathBuf {
    if let Some(home) = env::var_os("CARGO_HOME") {
        return PathBuf::from(home);
    }

    let home = env::var_os("HOME").expect("HOME must be set when CARGO_HOME is unset");
    PathBuf::from(home).join(".cargo")
}

fn read_v8_version(lock_path: &Path) -> String {
    let lock = fs::read_to_string(lock_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", lock_path.display(), error));

    let mut in_v8_package = false;
    for line in lock.lines() {
        match line.trim() {
            "[[package]]" => in_v8_package = false,
            "name = \"v8\"" => in_v8_package = true,
            _ if in_v8_package && line.trim_start().starts_with("version = \"") => {
                let version = line
                    .trim()
                    .trim_start_matches("version = \"")
                    .trim_end_matches('"');
                return version.to_owned();
            }
            _ => {}
        }
    }

    panic!("failed to locate v8 version in {}", lock_path.display());
}

/// Read U_ICU_VERSION_MAJOR_NUM from the V8 crate's uvernum.h header.
fn read_v8_icu_major_version(v8_version: &str) -> Option<u32> {
    let registry_src = cargo_home().join("registry").join("src");
    let entries = fs::read_dir(&registry_src).ok()?;

    for entry in entries.flatten() {
        let header = entry
            .path()
            .join(format!("v8-{}", v8_version))
            .join("third_party/icu/source/common/unicode/uvernum.h");
        if let Ok(content) = fs::read_to_string(&header) {
            for line in content.lines() {
                if line.contains("U_ICU_VERSION_MAJOR_NUM") && !line.contains("ifndef") {
                    if let Some(num) = line.split_whitespace().last() {
                        return num.parse().ok();
                    }
                }
            }
        }
    }

    None
}

fn find_v8_icu_data(v8_version: &str, manifest_dir: &Path) -> PathBuf {
    // Prefer the full ICU data bundled in the repo. The V8 crate only ships a
    // stripped-down flutter_desktop/icudtl.dat (~1.6 MB) that excludes locale
    // data for NumberFormat, DateTimeFormat, and most non-English locales,
    // causing "Internal error. Icu error." at runtime.
    let bundled = manifest_dir.join("icudtl.dat");
    if bundled.exists() {
        // Verify the bundled data matches the V8 crate's ICU version.
        if let Some(v8_icu_major) = read_v8_icu_major_version(v8_version) {
            if v8_icu_major != BUNDLED_ICU_MAJOR_VERSION {
                panic!(
                    "\n\n\
                    *** ICU version mismatch ***\n\
                    The V8 crate (v8-{v8}) uses ICU {v8_icu}, but the bundled icudtl.dat \
                    is for ICU {bundled}.\n\n\
                    To fix:\n  \
                    1. Download: https://github.com/unicode-org/icu/releases/download/\
                    release-{v8_icu}-1/icu4c-{v8_icu}_1-data-bin-l.zip\n  \
                    2. Extract the .dat file and save as native/v8-runtime/icudtl.dat\n  \
                    3. Update BUNDLED_ICU_MAJOR_VERSION to {v8_icu} in build.rs\n\n",
                    v8 = v8_version,
                    v8_icu = v8_icu_major,
                    bundled = BUNDLED_ICU_MAJOR_VERSION,
                );
            }
        }
        return bundled;
    }

    // Fallback: search the V8 crate in the cargo registry.
    let registry_src = cargo_home().join("registry").join("src");
    let candidates = [
        Path::new("third_party/icu/flutter_desktop/icudtl.dat"),
        Path::new("third_party/icu/common/icudtl.dat"),
        Path::new("third_party/icu/chromecast_video/icudtl.dat"),
    ];

    let entries = fs::read_dir(&registry_src).unwrap_or_else(|error| {
        panic!(
            "failed to read cargo registry src {}: {}",
            registry_src.display(),
            error
        )
    });

    for entry in entries {
        let entry = entry
            .unwrap_or_else(|error| panic!("failed to inspect cargo registry entry: {}", error));
        let crate_root = entry.path().join(format!("v8-{}", v8_version));
        for relative in candidates {
            let candidate = crate_root.join(relative);
            if candidate.exists() {
                println!(
                    "cargo:warning=Using stripped ICU data from V8 crate. \
                    Intl.NumberFormat/DateTimeFormat may fail for non-English locales. \
                    See native/v8-runtime/build.rs for instructions on bundling full ICU data."
                );
                return candidate;
            }
        }
    }

    panic!(
        "failed to locate ICU data for v8-{} under {}",
        v8_version,
        registry_src.display(),
    );
}

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));
    let lock_path = manifest_dir.join("Cargo.lock");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR must be set"));

    println!("cargo:rerun-if-changed={}", lock_path.display());
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=icudtl.dat");

    let v8_version = read_v8_version(&lock_path);
    let icu_data = find_v8_icu_data(&v8_version, &manifest_dir);
    let dest_path = out_dir.join("icudtl.dat");

    fs::copy(&icu_data, &dest_path).unwrap_or_else(|error| {
        panic!(
            "failed to copy ICU data from {} to {}: {}",
            icu_data.display(),
            dest_path.display(),
            error,
        )
    });
}
