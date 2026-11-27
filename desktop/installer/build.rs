use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=AI_PROXY_INNER_SETUP_PATH");
    println!("cargo:rerun-if-env-changed=AI_PROXY_VERSION");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let dest = out_dir.join("inner-setup.exe");

    if let Ok(src) = env::var("AI_PROXY_INNER_SETUP_PATH") {
        let src_path = PathBuf::from(&src);
        if src_path.exists() {
            println!("cargo:rerun-if-changed={src}");
            fs::copy(&src_path, &dest).expect("copy AI_PROXY_INNER_SETUP_PATH");
        } else {
            panic!("AI_PROXY_INNER_SETUP_PATH does not exist: {src}");
        }
    } else {
        fs::write(&dest, []).expect("write empty placeholder inner-setup.exe");
    }

    let version = env::var("AI_PROXY_VERSION")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.2.1".into()));
    println!("cargo:rustc-env=AI_PROXY_INSTALLER_VERSION={version}");

    #[cfg(windows)]
    {
        let icon_path = PathBuf::from("../src-tauri/icons/icon.ico");
        if icon_path.exists() {
            println!("cargo:rerun-if-changed=../src-tauri/icons/icon.ico");
            let mut res = tauri_winres::WindowsResource::new();
            res.set_icon(icon_path.to_str().expect("icon path"));
            res.set("ProductName", "AI Proxy Setup");
            res.set("FileDescription", "Установщик AI Proxy");
            let _ = res.compile();
        }
    }
}
