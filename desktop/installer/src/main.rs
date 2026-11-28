#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

static INNER_SETUP_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/inner-setup.exe"));
const INSTALLER_VERSION: &str = env!("AI_PROXY_INSTALLER_VERSION");
const UI_HTML: &str = include_str!("../ui.html");

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone)]
enum UserEvent {
    Eval(String),
    Drag,
    Minimize,
    Close,
    Install {
        launch_after: bool,
        desktop_shortcut: bool,
    },
    LaunchAndClose,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum IpcMsg {
    Ready,
    Drag,
    Minimize,
    Close,
    Install {
        #[serde(rename = "launchAfter")]
        launch_after: bool,
        #[serde(rename = "desktopShortcut")]
        desktop_shortcut: bool,
    },
    LaunchAndClose,
}

fn default_install_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\Public"))
        .join("AI Proxy")
}

fn installed_exe_path() -> PathBuf {
    default_install_dir().join("AI Proxy.exe")
}

#[cfg(target_os = "windows")]
fn detect_existing_version() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Proxy",
            "/v",
            "DisplayVersion",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if line.contains("DisplayVersion") {
                if let Some(ver) = line.split_whitespace().last() {
                    return Some(ver.trim().to_string());
                }
            }
        }
    }
    if installed_exe_path().exists() {
        return Some("установлена".to_string());
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn detect_existing_version() -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn kill_running_app() {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "AI Proxy.exe", "/T"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    thread::sleep(std::time::Duration::from_millis(350));
}

#[cfg(not(target_os = "windows"))]
fn kill_running_app() {}

#[cfg(target_os = "windows")]
fn create_desktop_shortcut(exe: &Path) {
    use std::os::windows::process::CommandExt;
    let esc = |s: &str| s.replace('\'', "''");
    let script = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI Proxy.lnk'; \
         $sc = $ws.CreateShortcut($lnk); \
         $sc.TargetPath = '{}'; \
         $sc.WorkingDirectory = '{}'; \
         $sc.Save()",
        esc(&exe.to_string_lossy()),
        esc(&exe.parent().unwrap_or(exe).to_string_lossy()),
    );
    let _ = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(target_os = "windows"))]
fn create_desktop_shortcut(_exe: &Path) {}

fn run_embedded_installer(silent: bool, extra_args: &[String]) -> Result<(), String> {
    if INNER_SETUP_BYTES.is_empty() {
        return Err("Внутренний пакет установки не встроен в эту dev-сборку.".to_string());
    }
    let temp_path = std::env::temp_dir().join(format!("ai-proxy-inner-{}.exe", std::process::id()));
    fs::write(&temp_path, INNER_SETUP_BYTES)
        .map_err(|e| format!("Не удалось распаковать установщик: {e}"))?;

    let mut cmd = Command::new(&temp_path);
    if silent {
        cmd.arg("/S");
    }
    for a in extra_args {
        if a != "/S" && a != "--silent" {
            cmd.arg(a);
        }
    }

    let status = cmd
        .status()
        .map_err(|e| format!("Не удалось запустить установщик: {e}"));
    let _ = fs::remove_file(&temp_path);

    let exit_status = status?;
    if !exit_status.success() {
        return Err(format!("Установщик завершился с кодом {:?}", exit_status.code()));
    }
    Ok(())
}

fn launch_installed_app() {
    let exe = installed_exe_path();
    if exe.exists() {
        let _ = Command::new(&exe).spawn();
    }
}

fn send_eval(proxy: &EventLoopProxy<UserEvent>, js: String) {
    let _ = proxy.send_event(UserEvent::Eval(js));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a.eq_ignore_ascii_case("/S") || a == "--silent") {
        kill_running_app();
        match run_embedded_installer(true, &args) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("Установка AI Proxy")
        .with_inner_size(LogicalSize::new(500.0, 410.0))
        .with_decorations(false)
        .with_resizable(false)
        .build(&event_loop)
        .expect("build setup window");

    if let Some(monitor) = window.current_monitor() {
        let screen = monitor.size();
        let win = window.inner_size();
        let origin = monitor.position();
        let x = origin.x + ((screen.width as i32 - win.width as i32) / 2).max(0);
        let y = origin.y + ((screen.height as i32 - win.height as i32) / 2).max(0);
        window.set_outer_position(PhysicalPosition::new(x, y));
    }

    let proxy_ipc = proxy.clone();
    let webview_res = WebViewBuilder::new()
        .with_html(UI_HTML)
        .with_ipc_handler(move |req| {
            if let Ok(msg) = serde_json::from_str::<IpcMsg>(req.body()) {
                match msg {
                    IpcMsg::Ready => {
                        let payload = serde_json::json!({
                            "version": INSTALLER_VERSION,
                            "installDir": default_install_dir().to_string_lossy(),
                            "existingVersion": detect_existing_version(),
                        });
                        send_eval(
                            &proxy_ipc,
                            format!("window.__SETUP_INIT__({})", payload),
                        );
                    }
                    IpcMsg::Drag => {
                        let _ = proxy_ipc.send_event(UserEvent::Drag);
                    }
                    IpcMsg::Minimize => {
                        let _ = proxy_ipc.send_event(UserEvent::Minimize);
                    }
                    IpcMsg::Close => {
                        let _ = proxy_ipc.send_event(UserEvent::Close);
                    }
                    IpcMsg::Install {
                        launch_after,
                        desktop_shortcut,
                    } => {
                        let _ = proxy_ipc.send_event(UserEvent::Install {
                            launch_after,
                            desktop_shortcut,
                        });
                    }
                    IpcMsg::LaunchAndClose => {
                        let _ = proxy_ipc.send_event(UserEvent::LaunchAndClose);
                    }
                }
            }
        })
        .build(&window);

    let webview = match webview_res {
        Ok(wv) => wv,
        Err(_) => {
            // Fallback to native installer if WebView2 is not available on this host
            kill_running_app();
            let _ = run_embedded_installer(false, &args);
            return;
        }
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(ev) => match ev {
                UserEvent::Eval(js) => {
                    let _ = webview.evaluate_script(&js);
                }
                UserEvent::Drag => {
                    let _ = window.drag_window();
                }
                UserEvent::Minimize => {
                    window.set_minimized(true);
                }
                UserEvent::Close => {
                    *control_flow = ControlFlow::Exit;
                }
                UserEvent::LaunchAndClose => {
                    launch_installed_app();
                    *control_flow = ControlFlow::Exit;
                }
                UserEvent::Install {
                    launch_after,
                    desktop_shortcut,
                } => {
                    let p = proxy.clone();
                    thread::spawn(move || {
                        send_eval(&p, "window.__SETUP_PROGRESS__(18, 'Остановка запущенных процессов...')".into());
                        kill_running_app();

                        send_eval(&p, "window.__SETUP_PROGRESS__(42, 'Установка файлов AI Proxy...')".into());
                        if let Err(err) = run_embedded_installer(true, &[]) {
                            let err_json = serde_json::to_string(&err).unwrap_or_else(|_| "\"Ошибка установки\"".into());
                            send_eval(&p, format!("window.__SETUP_ERROR__({err_json})"));
                            return;
                        }

                        if desktop_shortcut {
                            send_eval(&p, "window.__SETUP_PROGRESS__(84, 'Создание ярлыка на рабочем столе...')".into());
                            let exe = installed_exe_path();
                            if exe.exists() {
                                create_desktop_shortcut(&exe);
                            }
                        }

                        if launch_after {
                            send_eval(&p, "window.__SETUP_PROGRESS__(96, 'Запуск AI Proxy...')".into());
                            launch_installed_app();
                        }

                        send_eval(&p, format!("window.__SETUP_DONE__({launch_after})"));
                    });
                }
            },
            _ => {}
        }
    });
}
