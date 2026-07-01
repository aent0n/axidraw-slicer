pub mod ebb;
pub mod vectorizer;

use std::io::{BufRead, BufReader, Read, Write as IoWrite};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ebb::EbbDriver;
use crate::vectorizer::{Point, Toolpath, VectorizerSettings};

pub struct PlotterState {
    pub driver: Mutex<Option<EbbDriver>>,
}

pub struct PlotStatusState {
    pub is_plotting: Arc<AtomicBool>,
    pub is_paused: Arc<AtomicBool>,
    pub current_x: Mutex<f32>,
    pub current_y: Mutex<f32>,
}

#[derive(serde::Serialize)]
pub struct SerialPortDetails {
    pub port_name: String,
    pub display_name: String,
    pub is_axidraw: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct ProgressPayload {
    pub path_index: usize,
    pub point_index: usize,
    pub global_point_index: usize,
    pub total_points: usize,
    pub x: f32,
    pub y: f32,
    pub loop_index: usize,
    pub total_loops: usize,
}

#[tauri::command]
fn list_serial_ports() -> Vec<SerialPortDetails> {
    match serialport::available_ports() {
        Ok(ports) => ports
            .into_iter()
            .map(|p| {
                let mut display_name = p.port_name.clone();
                let mut is_axidraw = false;
                
                if let serialport::SerialPortType::UsbPort(usb_info) = p.port_type {
                    if usb_info.vid == 0x04d8 && usb_info.pid == 0xfd92 {
                        is_axidraw = true;
                        display_name = format!("AxiDraw V3 ({})", p.port_name);
                    } else if let Some(mfg) = &usb_info.manufacturer {
                        if mfg.contains("Evil Mad Science") {
                            is_axidraw = true;
                            display_name = format!("AxiDraw V3 ({})", p.port_name);
                        }
                    }
                }
                
                SerialPortDetails {
                    port_name: p.port_name,
                    display_name,
                    is_axidraw,
                }
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
fn connect_plotter(port_name: String, app: AppHandle, state: State<'_, PlotterState>) -> Result<String, String> {
    let mut driver_guard = state.driver.lock().unwrap();
    
    // Close existing connection if any
    *driver_guard = None;
    
    let _ = app.emit("ebb-log", format!("Sent: v (Query version on {})", port_name));
    match EbbDriver::new(&port_name) {
        Ok(mut driver) => {
            let version = "Connected to AxiDraw EBB board".to_string();
            let _ = app.emit("ebb-log", "Received: EBB v13.1 found. Motors enabled.".to_string());
            
            // Send pen up twice to ensure pen is UP immediately on connection
            let _ = app.emit("ebb-log", "Sent: SP,0,300 (Set Pen Position UP)".to_string());
            let _ = driver.toggle_pen(false, 300);
            std::thread::sleep(std::time::Duration::from_millis(150));
            let _ = app.emit("ebb-log", "Sent: SP,0,300 (Set Pen Position UP - second attempt)".to_string());
            let _ = driver.toggle_pen(false, 300);
            
            *driver_guard = Some(driver);
            Ok(version)
        }
        Err(e) => {
            let _ = app.emit("ebb-log", format!("Error: Connection failed: {}", e));
            Err(e)
        }
    }
}

#[tauri::command]
fn disconnect_plotter(app: AppHandle, state: State<'_, PlotterState>) -> Result<(), String> {
    let mut driver_guard = state.driver.lock().unwrap();
    let _ = app.emit("ebb-log", "Sent: EM,0,0 (Disable motors & Disconnect)".to_string());
    if let Some(mut driver) = driver_guard.take() {
        let _ = driver.enable_motors(false); // disable steppers on disconnect
    }
    let _ = app.emit("ebb-log", "Received: Disconnected".to_string());
    Ok(())
}

#[tauri::command]
fn run_vectorization(
    image_bytes: Vec<u8>,
    settings: VectorizerSettings,
) -> Result<Vec<Toolpath>, String> {
    vectorizer::vectorize_image(&image_bytes, &settings)
}

#[tauri::command]
fn configure_pen_heights(
    up_height: u32,
    down_height: u32,
    app: AppHandle,
    state: State<'_, PlotterState>,
) -> Result<(), String> {
    let mut driver_guard = state.driver.lock().unwrap();
    let _ = app.emit("ebb-log", format!("Sent: SC,4,{} (Set Pen UP) & SC,5,{} (Set Pen DOWN)", up_height, down_height));
    if let Some(ref mut driver) = *driver_guard {
        let res = driver.configure_pen_heights(up_height, down_height);
        if res.is_ok() {
            let _ = app.emit("ebb-log", "Received: OK".to_string());
        }
        res
    } else {
        Err("Plotter not connected".to_string())
    }
}

#[tauri::command]
fn toggle_pen(down: bool, duration_ms: u32, app: AppHandle, state: State<'_, PlotterState>) -> Result<(), String> {
    let mut driver_guard = state.driver.lock().unwrap();
    let _ = app.emit("ebb-log", format!("Sent: SP,{},{} (Set Pen Position)", if down { 1 } else { 0 }, duration_ms));
    if let Some(ref mut driver) = *driver_guard {
        let res = driver.toggle_pen(down, duration_ms);
        if res.is_ok() {
            let _ = app.emit("ebb-log", "Received: OK".to_string());
        }
        res
    } else {
        Err("Plotter not connected".to_string())
    }
}

#[tauri::command]
fn enable_motors(enable: bool, app: AppHandle, state: State<'_, PlotterState>) -> Result<(), String> {
    let mut driver_guard = state.driver.lock().unwrap();
    let _ = app.emit("ebb-log", format!("Sent: EM,{} (Enable/Disable steppers)", if enable { "1,1" } else { "0,0" }));
    if let Some(ref mut driver) = *driver_guard {
        let res = driver.enable_motors(enable);
        if res.is_ok() {
            let _ = app.emit("ebb-log", "Received: OK".to_string());
        }
        res
    } else {
        Err("Plotter not connected".to_string())
    }
}

#[tauri::command]
fn zero_plotter_coordinates(app: AppHandle, status: State<'_, PlotStatusState>) -> Result<(), String> {
    let mut cx = status.current_x.lock().unwrap();
    let mut cy = status.current_y.lock().unwrap();
    *cx = 0.0;
    *cy = 0.0;
    let _ = app.emit("ebb-log", "Local coordinates reset to (0,0) home".to_string());
    Ok(())
}

#[tauri::command]
fn jog_plotter(
    dx: f32,
    dy: f32,
    speed: f32,
    bed_width: f32,
    bed_height: f32,
    app: AppHandle,
    state: State<'_, PlotterState>,
    status: State<'_, PlotStatusState>,
) -> Result<(), String> {
    let mut driver_guard = state.driver.lock().unwrap();
    if let Some(ref mut driver) = *driver_guard {
        let mut cx = status.current_x.lock().unwrap();
        let mut cy = status.current_y.lock().unwrap();
        
        // Soft Limits clamp
        let target_x = (*cx + dx).clamp(0.0, bed_width);
        let target_y = (*cy + dy).clamp(0.0, bed_height);
        
        let safe_dx = target_x - *cx;
        let safe_dy = target_y - *cy;
        
        if safe_dx.abs() > 0.001 || safe_dy.abs() > 0.001 {
            let steps_x = (safe_dx * 80.0).round() as i32;
            let steps_y = (safe_dy * 80.0).round() as i32;
            let dist = (safe_dx.powi(2) + safe_dy.powi(2)).sqrt();
            let duration_ms = ((dist / speed) * 1000.0).round() as u64;

            let _ = app.emit("ebb-log", format!("Sent: XM,{},{},{} (Jogging pen carriage)", duration_ms, steps_x, steps_y));
            
            let start_x = *cx;
            let start_y = *cy;
            
            driver.move_relative(safe_dx, safe_dy, speed)?;

            // Wait and interpolate live coordinates for smooth progress feedback (60 FPS)
            if duration_ms > 0 {
                let steps = duration_ms / 16;
                for step in 0..steps {
                    std::thread::sleep(std::time::Duration::from_millis(16));
                    let t = (step as f32 + 1.0) / (steps as f32);
                    let interp_x = start_x + safe_dx * t;
                    let interp_y = start_y + safe_dy * t;

                    // Emit live progress coordinates
                    let _ = app.emit(
                        "plot-progress",
                        ProgressPayload {
                            path_index: 0,
                            point_index: 0,
                            global_point_index: 0,
                            total_points: 1,
                            x: interp_x,
                            y: interp_y,
                            loop_index: 0,
                            total_loops: 1,
                        },
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(duration_ms % 16));
            }

            let _ = app.emit("ebb-log", "Received: OK".to_string());

            *cx = target_x;
            *cy = target_y;

            // Final jog position emit
            let _ = app.emit(
                "plot-progress",
                ProgressPayload {
                    path_index: 0,
                    point_index: 0,
                    global_point_index: 0,
                    total_points: 1,
                    x: target_x,
                    y: target_y,
                    loop_index: 0,
                    total_loops: 1,
                },
            );
        }
        Ok(())
    } else {
        Err("Plotter not connected".to_string())
    }
}

#[tauri::command]
fn home_plotter(
    speed: f32,
    app: AppHandle,
    state: State<'_, PlotterState>,
    status: State<'_, PlotStatusState>,
) -> Result<(), String> {
    let mut driver_guard = state.driver.lock().unwrap();
    if let Some(ref mut driver) = *driver_guard {
        // Enable motors first so we can physically move back to home!
        let _ = driver.enable_motors(true);
        let _ = app.emit("ebb-log", "Sent: EM,1,1 (Enable motors for homing)".to_string());
        let _ = app.emit("ebb-log", "Received: OK".to_string());

        let mut cx = status.current_x.lock().unwrap();
        let mut cy = status.current_y.lock().unwrap();
        
        let steps_x = (-(*cx) * 80.0).round() as i32;
        let steps_y = (-(*cy) * 80.0).round() as i32;
        
        if steps_x != 0 || steps_y != 0 {
            let dx = steps_x as f32 / 80.0;
            let dy = steps_y as f32 / 80.0;
            let dist = (dx.powi(2) + dy.powi(2)).sqrt();
            let duration_ms = ((dist / speed) * 1000.0).round() as u64;

            let _ = app.emit("ebb-log", format!("Sent: XM,{},{},{} (Homing carriage back to home)", duration_ms, steps_x, steps_y));
            
            let start_x = *cx;
            let start_y = *cy;
            
            driver.move_relative_steps(steps_x, steps_y, speed)?;

            // Wait and interpolate live coordinates (60 FPS)
            if duration_ms > 0 {
                let steps = duration_ms / 16;
                for step in 0..steps {
                    std::thread::sleep(std::time::Duration::from_millis(16));
                    let t = (step as f32 + 1.0) / (steps as f32);
                    let interp_x = start_x + (0.0 - start_x) * t;
                    let interp_y = start_y + (0.0 - start_y) * t;

                    // Emit live progress coordinates
                    let _ = app.emit(
                        "plot-progress",
                        ProgressPayload {
                            path_index: 0,
                            point_index: 0,
                            global_point_index: 0,
                            total_points: 1,
                            x: interp_x,
                            y: interp_y,
                            loop_index: 0,
                            total_loops: 1,
                        },
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(duration_ms % 16));
            }
            
            let _ = app.emit("ebb-log", "Received: OK (Pen at home origin)".to_string());
        }
        
        // Release motors at the end of homing
        let _ = driver.enable_motors(false);
        let _ = app.emit("ebb-log", "Sent: EM,0,0 (Release motors at home)".to_string());
        let _ = app.emit("ebb-log", "Received: OK".to_string());

        *cx = 0.0;
        *cy = 0.0;
        
        // Final home emit
        let _ = app.emit(
            "plot-progress",
            ProgressPayload {
                path_index: 0,
                point_index: 0,
                global_point_index: 0,
                total_points: 1,
                x: 0.0,
                y: 0.0,
                loop_index: 0,
                total_loops: 1,
            },
        );

        Ok(())
    } else {
        Err("Plotter not connected".to_string())
    }
}

#[tauri::command]
fn run_frame_preview(
    points: Vec<Point>,
    speed: f32,
    app: AppHandle,
    state: State<'_, PlotterState>,
    status: State<'_, PlotStatusState>,
) -> Result<(), String> {
    let is_plotting = status.is_plotting.clone();
    let is_paused = status.is_paused.clone();

    // Check connection first
    {
        let driver_guard = state.driver.lock().unwrap();
        if driver_guard.is_none() {
            return Err("Plotter not connected".to_string());
        }
    }

    is_plotting.store(true, Ordering::SeqCst);
    is_paused.store(false, Ordering::SeqCst);

    let app_clone = app.clone();

    std::thread::spawn(move || {
        let state_clone = app_clone.state::<PlotterState>();
        let status_clone = app_clone.state::<PlotStatusState>();
        
        let mut steps_x_acc = 0;
        let mut steps_y_acc = 0;
        let total_points = points.len();

        // Ensure pen is UP
        {
            let mut driver_guard = state_clone.driver.lock().unwrap();
            if let Some(ref mut driver) = *driver_guard {
                let _ = driver.toggle_pen(false, 300);
            }
        }

        let mut aborted = false;
        let mut loop_count = 0;

        'outer: while is_plotting.load(Ordering::SeqCst) && loop_count < 10 {
            for (pt_idx, pt) in points.iter().enumerate() {
                // Check pause/stop
                while is_paused.load(Ordering::SeqCst) && is_plotting.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }

                if !is_plotting.load(Ordering::SeqCst) {
                    aborted = true;
                    break 'outer;
                }

                let target_steps_x = (pt.x * 80.0).round() as i32;
                let target_steps_y = (pt.y * 80.0).round() as i32;
                let total_dx_steps = target_steps_x - steps_x_acc;
                let total_dy_steps = target_steps_y - steps_y_acc;

                let total_dx = total_dx_steps as f32 / 80.0;
                let total_dy = total_dy_steps as f32 / 80.0;
                let total_dist = (total_dx.powi(2) + total_dy.powi(2)).sqrt();

                if total_dist > 0.001 {
                    let segment_size = 40.0f32; // 40mm segments
                    let num_segments = (total_dist / segment_size).ceil() as i32;
                    let start_steps_x = steps_x_acc;
                    let start_steps_y = steps_y_acc;

                    for seg in 1..=num_segments {
                        let seg_target_steps_x = if seg == num_segments { target_steps_x } else { start_steps_x + ((total_dx_steps * seg) / num_segments) };
                        let seg_target_steps_y = if seg == num_segments { target_steps_y } else { start_steps_y + ((total_dy_steps * seg) / num_segments) };

                        let dx_steps = seg_target_steps_x - steps_x_acc;
                        let dy_steps = seg_target_steps_y - steps_y_acc;

                        let mut move_duration_ms = 0;
                        let mut move_ok = false;
                        {
                            let mut driver_guard = state_clone.driver.lock().unwrap();
                            if let Some(ref mut driver) = *driver_guard {
                                if driver.move_relative_steps(dx_steps, dy_steps, speed).is_ok() {
                                    let dx = dx_steps as f32 / 80.0;
                                    let dy = dy_steps as f32 / 80.0;
                                    let distance = (dx.powi(2) + dy.powi(2)).sqrt();
                                    move_duration_ms = ((distance / speed) * 1000.0).round() as u64;
                                    let _ = app_clone.emit("ebb-log", format!("Sent: XM,{},{},{} (Boundary Trace)", move_duration_ms, dx_steps, dy_steps));
                                    move_ok = true;
                                }
                            }
                        }

                        if move_ok {
                            let prev_x = steps_x_acc as f32 / 80.0;
                            let prev_y = steps_y_acc as f32 / 80.0;
                            steps_x_acc = seg_target_steps_x;
                            steps_y_acc = seg_target_steps_y;
                            let target_x = seg_target_steps_x as f32 / 80.0;
                            let target_y = seg_target_steps_y as f32 / 80.0;
                            let _ = app_clone.emit("ebb-log", "Received: OK".to_string());

                            if move_duration_ms > 0 {
                                let steps = move_duration_ms / 16;
                                for step in 0..steps {
                                    std::thread::sleep(std::time::Duration::from_millis(16));
                                    let t = (step as f32 + 1.0) / (steps as f32);
                                    let interp_x = prev_x + (target_x - prev_x) * t;
                                    let interp_y = prev_y + (target_y - prev_y) * t;

                                    {
                                        let mut cx = status_clone.current_x.lock().unwrap();
                                        let mut cy = status_clone.current_y.lock().unwrap();
                                        *cx = interp_x;
                                        *cy = interp_y;
                                    }

                                    let _ = app_clone.emit(
                                        "plot-progress",
                                        ProgressPayload {
                                            path_index: 0,
                                            point_index: pt_idx,
                                            global_point_index: pt_idx + 1,
                                            total_points,
                                            x: interp_x,
                                            y: interp_y,
                                            loop_index: loop_count,
                                            total_loops: 10,
                                        },
                                    );
                                }
                                std::thread::sleep(std::time::Duration::from_millis(move_duration_ms % 16));
                            }

                            // Finally, set coordinates to target exactly and emit progress
                            {
                                let mut cx = status_clone.current_x.lock().unwrap();
                                let mut cy = status_clone.current_y.lock().unwrap();
                                *cx = target_x;
                                *cy = target_y;
                            }
                            let _ = app_clone.emit(
                                "plot-progress",
                                ProgressPayload {
                                    path_index: 0,
                                    point_index: pt_idx,
                                    global_point_index: pt_idx + 1,
                                    total_points,
                                    x: target_x,
                                    y: target_y,
                                    loop_index: loop_count,
                                    total_loops: 10,
                                },
                            );
                        }
                    }
                }
            }
            loop_count += 1;
        }

        if !aborted {
            // Return home
            let mut duration_ms = 0;
            {
                let mut driver_guard = state_clone.driver.lock().unwrap();
                if let Some(ref mut driver) = *driver_guard {
                    let dx_steps = -steps_x_acc;
                    let dy_steps = -steps_y_acc;
                    if driver.move_relative_steps(dx_steps, dy_steps, speed).is_ok() {
                        let dx = dx_steps as f32 / 80.0;
                        let dy = dy_steps as f32 / 80.0;
                        let dist = (dx.powi(2) + dy.powi(2)).sqrt();
                        duration_ms = ((dist / speed) * 1000.0).round() as u64;
                        let _ = app_clone.emit("ebb-log", format!("Sent: XM,{},{},{} (Homing carriage back to home)", duration_ms, dx_steps, dy_steps));
                    }
                }
            }

            if duration_ms > 0 {
                let steps = duration_ms / 16;
                let start_x = steps_x_acc as f32 / 80.0;
                let start_y = steps_y_acc as f32 / 80.0;
                for step in 0..steps {
                    std::thread::sleep(std::time::Duration::from_millis(16));
                    let t = (step as f32 + 1.0) / (steps as f32);
                    let interp_x = start_x + (0.0 - start_x) * t;
                    let interp_y = start_y + (0.0 - start_y) * t;

                    {
                        let mut cx = status_clone.current_x.lock().unwrap();
                        let mut cy = status_clone.current_y.lock().unwrap();
                        *cx = interp_x;
                        *cy = interp_y;
                    }

                    let _ = app_clone.emit(
                        "plot-progress",
                        ProgressPayload {
                            path_index: 0,
                            point_index: 0,
                            global_point_index: 0,
                            total_points: 1,
                            x: interp_x,
                            y: interp_y,
                            loop_index: 0,
                            total_loops: 1,
                        },
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(duration_ms % 16 + 100));
            }

            // Reset tracked position to home (0,0)
            {
                let mut cx = status_clone.current_x.lock().unwrap();
                let mut cy = status_clone.current_y.lock().unwrap();
                *cx = 0.0;
                *cy = 0.0;
            }
        } else {
            // Aborted! Stop motion immediately, raise pen, and return home safely
            let mut driver_guard = state_clone.driver.lock().unwrap();
            if let Some(ref mut driver) = *driver_guard {
                // Raise pen immediately on abort!
                let _ = driver.toggle_pen(false, 300);
                let _ = app_clone.emit("ebb-log", "Sent: SP,0,300 (Raise Pen on abort)".to_string());

                let _ = driver.clear_motion();
                let _ = app_clone.emit("ebb-log", "Sent: CM (Clear EBB buffer)".to_string());
                
                // Re-enable motors to home safely
                let _ = driver.enable_motors(true);
                let _ = app_clone.emit("ebb-log", "Sent: EM,1,1 (Re-enable motors for homing)".to_string());

                let dx_steps = -steps_x_acc;
                let dy_steps = -steps_y_acc;
                if dx_steps != 0 || dy_steps != 0 {
                    let dx = dx_steps as f32 / 80.0;
                    let dy = dy_steps as f32 / 80.0;
                    let dist = (dx.powi(2) + dy.powi(2)).sqrt();
                    let duration_ms = ((dist / 50.0) * 1000.0).round() as u32;

                    let _ = app_clone.emit("ebb-log", format!("Sent: XM,{},{},{} (Homing carriage back to home)", duration_ms, dx_steps, dy_steps));
                    let _ = driver.move_relative_steps(dx_steps, dy_steps, 50.0);
                    
                    if duration_ms > 0 {
                        let steps = duration_ms / 16;
                        let start_x = { *status_clone.current_x.lock().unwrap() };
                        let start_y = { *status_clone.current_y.lock().unwrap() };
                        for step in 0..steps {
                            std::thread::sleep(std::time::Duration::from_millis(16));
                            let t = (step as f32 + 1.0) / (steps as f32);
                            let interp_x = start_x + (0.0 - start_x) * t;
                            let interp_y = start_y + (0.0 - start_y) * t;

                            {
                                let mut cx = status_clone.current_x.lock().unwrap();
                                let mut cy = status_clone.current_y.lock().unwrap();
                                *cx = interp_x;
                                *cy = interp_y;
                            }

                            let _ = app_clone.emit(
                                "plot-progress",
                                ProgressPayload {
                                    path_index: 0,
                                    point_index: 0,
                                    global_point_index: 0,
                                    total_points: 1,
                                    x: interp_x,
                                    y: interp_y,
                                    loop_index: 0,
                                    total_loops: 1,
                                },
                            );
                        }
                        std::thread::sleep(std::time::Duration::from_millis((duration_ms % 16) as u64 + 100));
                    }
                }

                let _ = driver.enable_motors(false); // release motors
                let _ = app_clone.emit("ebb-log", "Sent: EM,0,0 (Release motors at home)".to_string());
            }
            
            // Reset tracked position to home (0,0)
            {
                let mut cx = status_clone.current_x.lock().unwrap();
                let mut cy = status_clone.current_y.lock().unwrap();
                *cx = 0.0;
                *cy = 0.0;
            }
        }

        is_plotting.store(false, Ordering::SeqCst);
        is_paused.store(false, Ordering::SeqCst);
        let _ = app_clone.emit("plot-finished", ());
    });

    Ok(())
}

#[tauri::command]
fn start_plot(
    paths: Vec<Toolpath>,
    speed: f32,
    air_speed: f32,
    pen_up_duration: u32,
    pen_down_duration: u32,
    app: AppHandle,
    state: State<'_, PlotterState>,
    status: State<'_, PlotStatusState>,
) -> Result<(), String> {
    let is_plotting = status.is_plotting.clone();
    let is_paused = status.is_paused.clone();
    
    // Check connection first
    {
        let driver_guard = state.driver.lock().unwrap();
        if driver_guard.is_none() {
            return Err("Plotter not connected".to_string());
        }
    }
    
    // Set status
    is_plotting.store(true, Ordering::SeqCst);
    is_paused.store(false, Ordering::SeqCst);
    
    // Count total points for progress tracking
    let total_points: usize = paths.iter().map(|p| p.points.len()).sum();
    if total_points == 0 {
        is_plotting.store(false, Ordering::SeqCst);
        return Ok(());
    }

    // Spawn plotting thread
    let app_clone = app.clone();
    
    std::thread::spawn(move || {
        let state_clone = app_clone.state::<PlotterState>();
        let status_clone = app_clone.state::<PlotStatusState>();
        let mut steps_x_acc = 0;
        let mut steps_y_acc = 0;
        let mut global_point_counter = 0;

        // Ensure pen is up to start
        {
            let mut driver_guard = state_clone.driver.lock().unwrap();
            if let Some(ref mut driver) = *driver_guard {
                let _ = driver.toggle_pen(false, pen_up_duration);
            }
        }
        let _ = app_clone.emit("ebb-log", format!("Sent: SP,0,{} (Ensure Pen UP to start)", pen_up_duration));
        let _ = app_clone.emit("ebb-log", "Received: OK".to_string());

        for (path_idx, path) in paths.iter().enumerate() {
            if !is_plotting.load(Ordering::SeqCst) {
                break;
            }

            if path.points.is_empty() {
                continue;
            }

            // Move to start of path (pen up)
            let start_pt = &path.points[0];
            let target_steps_x = (start_pt.x * 80.0).round() as i32;
            let target_steps_y = (start_pt.y * 80.0).round() as i32;
            let dx_steps = target_steps_x - steps_x_acc;
            let dy_steps = target_steps_y - steps_y_acc;

            let dx = dx_steps as f32 / 80.0;
            let dy = dy_steps as f32 / 80.0;
            let travel_dist = (dx.powi(2) + dy.powi(2)).sqrt();
            let travel_duration_ms = ((travel_dist / air_speed) * 1000.0).round() as u64;

            {
                let mut driver_guard = state_clone.driver.lock().unwrap();
                if let Some(ref mut driver) = *driver_guard {
                    let _ = driver.move_relative_steps(dx_steps, dy_steps, air_speed);
                }
            }
            let _ = app_clone.emit("ebb-log", format!("Sent: XM,{},{},{} (Travel to path start)", travel_duration_ms, dx_steps, dy_steps));
            
            let prev_x = steps_x_acc as f32 / 80.0;
            let prev_y = steps_y_acc as f32 / 80.0;
            steps_x_acc = target_steps_x;
            steps_y_acc = target_steps_y;
            let target_x = target_steps_x as f32 / 80.0;
            let target_y = target_steps_y as f32 / 80.0;

            // Set coordinates to start of travel move to prevent ghosting
            {
                let mut cx = status_clone.current_x.lock().unwrap();
                let mut cy = status_clone.current_y.lock().unwrap();
                *cx = prev_x;
                *cy = prev_y;
            }

            // Wait for travel move to finish, interpolating coordinates live
            if travel_duration_ms > 0 {
                let steps = travel_duration_ms / 16;
                for step in 0..steps {
                    if !is_plotting.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(16));
                    
                    // Interpolate coordinates
                    let t = (step as f32 + 1.0) / (steps as f32);
                    let interp_x = prev_x + (target_x - prev_x) * t;
                    let interp_y = prev_y + (target_y - prev_y) * t;

                    {
                        let mut cx = status_clone.current_x.lock().unwrap();
                        let mut cy = status_clone.current_y.lock().unwrap();
                        *cx = interp_x;
                        *cy = interp_y;
                    }

                    // Emit live progress
                    let _ = app_clone.emit(
                        "plot-progress",
                        ProgressPayload {
                            path_index: path_idx,
                            point_index: 0,
                            global_point_index: global_point_counter,
                            total_points,
                            x: interp_x,
                            y: interp_y,
                            loop_index: 0,
                            total_loops: 1,
                        },
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(travel_duration_ms % 16));
            }
            
            // Snap to target exactly at the end of travel move
            {
                let mut cx = status_clone.current_x.lock().unwrap();
                let mut cy = status_clone.current_y.lock().unwrap();
                *cx = target_x;
                *cy = target_y;
            }
            let _ = app_clone.emit("ebb-log", "Received: OK".to_string());

            if !is_plotting.load(Ordering::SeqCst) {
                break;
            }

            // Lower pen
            {
                let mut driver_guard = state_clone.driver.lock().unwrap();
                if let Some(ref mut driver) = *driver_guard {
                    let _ = driver.toggle_pen(true, pen_down_duration);
                }
            }
            let _ = app_clone.emit("ebb-log", format!("Sent: SP,1,{} (Lower Pen)", pen_down_duration));
            let _ = app_clone.emit("ebb-log", "Received: OK".to_string());

            // Draw path points
            for (pt_idx, pt) in path.points.iter().enumerate() {
                // Check pause/stop
                while is_paused.load(Ordering::SeqCst) && is_plotting.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                
                if !is_plotting.load(Ordering::SeqCst) {
                    break;
                }

                // Skip first point since we are already there
                if pt_idx > 0 {
                    let target_steps_x = (pt.x * 80.0).round() as i32;
                    let target_steps_y = (pt.y * 80.0).round() as i32;
                    let dx_steps = target_steps_x - steps_x_acc;
                    let dy_steps = target_steps_y - steps_y_acc;

                    let dx = dx_steps as f32 / 80.0;
                    let dy = dy_steps as f32 / 80.0;
                    let draw_dist = (dx.powi(2) + dy.powi(2)).sqrt();
                    let draw_duration_ms = ((draw_dist / speed) * 1000.0).round() as u64;

                    {
                        let mut driver_guard = state_clone.driver.lock().unwrap();
                        if let Some(ref mut driver) = *driver_guard {
                            let _ = driver.move_relative_steps(dx_steps, dy_steps, speed);
                        }
                    }
                    let _ = app_clone.emit("ebb-log", format!("Sent: XM,{},{},{} (Drawing stroke)", draw_duration_ms, dx_steps, dy_steps));

                    let prev_x = steps_x_acc as f32 / 80.0;
                    let prev_y = steps_y_acc as f32 / 80.0;
                    steps_x_acc = target_steps_x;
                    steps_y_acc = target_steps_y;
                    let target_x = target_steps_x as f32 / 80.0;
                    let target_y = target_steps_y as f32 / 80.0;

                    // Set coordinates to start of drawing move to prevent ghosting
                    {
                        let mut cx = status_clone.current_x.lock().unwrap();
                        let mut cy = status_clone.current_y.lock().unwrap();
                        *cx = prev_x;
                        *cy = prev_y;
                    }

                    // Wait for drawing move to finish, interpolating coordinates live
                    if draw_duration_ms > 0 {
                        let steps = draw_duration_ms / 16;
                        for step in 0..steps {
                            if !is_plotting.load(Ordering::SeqCst) {
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(16));
                            
                            // Interpolate coordinates
                            let t = (step as f32 + 1.0) / (steps as f32);
                            let interp_x = prev_x + (target_x - prev_x) * t;
                            let interp_y = prev_y + (target_y - prev_y) * t;

                            {
                                let mut cx = status_clone.current_x.lock().unwrap();
                                let mut cy = status_clone.current_y.lock().unwrap();
                                *cx = interp_x;
                                *cy = interp_y;
                            }

                            // Emit live progress
                            let _ = app_clone.emit(
                                "plot-progress",
                                ProgressPayload {
                                    path_index: path_idx,
                                    point_index: pt_idx,
                                    global_point_index: global_point_counter,
                                    total_points,
                                    x: interp_x,
                                    y: interp_y,
                                    loop_index: 0,
                                    total_loops: 1,
                                },
                            );
                        }
                        std::thread::sleep(std::time::Duration::from_millis(draw_duration_ms % 16));
                    }

                    // Snap to target exactly at the end of drawing move
                    {
                        let mut cx = status_clone.current_x.lock().unwrap();
                        let mut cy = status_clone.current_y.lock().unwrap();
                        *cx = target_x;
                        *cy = target_y;
                    }
                    let _ = app_clone.emit("ebb-log", "Received: OK".to_string());
                }

                global_point_counter += 1;

                // Emit progress to frontend
                let _ = app_clone.emit(
                    "plot-progress",
                    ProgressPayload {
                        path_index: path_idx,
                        point_index: pt_idx,
                        global_point_index: global_point_counter,
                        total_points,
                        x: pt.x,
                        y: pt.y,
                        loop_index: 0,
                        total_loops: 1,
                    },
                );
            }

            if !is_plotting.load(Ordering::SeqCst) {
                break;
            }

            // Raise pen at the end of drawing this path
            {
                let mut driver_guard = state_clone.driver.lock().unwrap();
                if let Some(ref mut driver) = *driver_guard {
                    let _ = driver.toggle_pen(false, pen_up_duration);
                }
            }
            let _ = app_clone.emit("ebb-log", format!("Sent: SP,0,{} (Raise Pen)", pen_up_duration));
            let _ = app_clone.emit("ebb-log", "Received: OK".to_string());
        }

        let aborted = !is_plotting.load(Ordering::SeqCst);

        // Return home at the end of plot only if NOT aborted!
        if !aborted {
            let mut duration_ms = 0;
            {
                let mut driver_guard = state_clone.driver.lock().unwrap();
                if let Some(ref mut driver) = *driver_guard {
                    let dx_steps = -steps_x_acc;
                    let dy_steps = -steps_y_acc;
                    if driver.move_relative_steps(dx_steps, dy_steps, 50.0).is_ok() {
                        let dx = dx_steps as f32 / 80.0;
                        let dy = dy_steps as f32 / 80.0;
                        let dist = (dx.powi(2) + dy.powi(2)).sqrt();
                        duration_ms = ((dist / 50.0) * 1000.0).round() as u64;
                        let _ = app_clone.emit("ebb-log", format!("Sent: XM,{},{},{} (Return Home)", duration_ms, dx_steps, dy_steps));
                    }
                }
            }

            if duration_ms > 0 {
                let steps = duration_ms / 16;
                let start_x = steps_x_acc as f32 / 80.0;
                let start_y = steps_y_acc as f32 / 80.0;
                for step in 0..steps {
                    std::thread::sleep(std::time::Duration::from_millis(16));
                    let t = (step as f32 + 1.0) / (steps as f32);
                    let interp_x = start_x + (0.0 - start_x) * t;
                    let interp_y = start_y + (0.0 - start_y) * t;

                    {
                        let mut cx = status_clone.current_x.lock().unwrap();
                        let mut cy = status_clone.current_y.lock().unwrap();
                        *cx = interp_x;
                        *cy = interp_y;
                    }

                    let _ = app_clone.emit(
                        "plot-progress",
                        ProgressPayload {
                            path_index: 0,
                            point_index: 0,
                            global_point_index: 0,
                            total_points: 1,
                            x: interp_x,
                            y: interp_y,
                            loop_index: 0,
                            total_loops: 1,
                        },
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(duration_ms % 16 + 100));
            }

            // Release motors
            {
                let mut driver_guard = state_clone.driver.lock().unwrap();
                if let Some(ref mut driver) = *driver_guard {
                    let _ = driver.enable_motors(false); // release motors
                    let _ = app_clone.emit("ebb-log", "Sent: EM,0,0 (Release motors at home)".to_string());
                }
            }

            // Reset tracked position to home (0,0)
            {
                let mut cx = status_clone.current_x.lock().unwrap();
                let mut cy = status_clone.current_y.lock().unwrap();
                *cx = 0.0;
                *cy = 0.0;
            }
        } else {
            // Aborted! Stop motion immediately, raise pen, and return home safely
            let mut driver_guard = state_clone.driver.lock().unwrap();
            if let Some(ref mut driver) = *driver_guard {
                // Raise pen immediately on abort!
                let _ = driver.toggle_pen(false, pen_up_duration);
                let _ = app_clone.emit("ebb-log", format!("Sent: SP,0,{} (Raise Pen on abort)", pen_up_duration));
                let _ = app_clone.emit("ebb-log", "Received: OK".to_string());

                let _ = driver.clear_motion();
                let _ = app_clone.emit("ebb-log", "Sent: CM (Clear EBB buffer)".to_string());
                
                // Re-enable motors to home safely
                let _ = driver.enable_motors(true);
                let _ = app_clone.emit("ebb-log", "Sent: EM,1,1 (Re-enable motors for homing)".to_string());

                let dx_steps = -steps_x_acc;
                let dy_steps = -steps_y_acc;
                if dx_steps != 0 || dy_steps != 0 {
                    let dx = dx_steps as f32 / 80.0;
                    let dy = dy_steps as f32 / 80.0;
                    let dist = (dx.powi(2) + dy.powi(2)).sqrt();
                    let duration_ms = ((dist / 50.0) * 1000.0).round() as u32; // return home at 50mm/s

                    let _ = app_clone.emit("ebb-log", format!("Sent: XM,{},{},{} (Homing carriage back to home)", duration_ms, dx_steps, dy_steps));
                    let _ = driver.move_relative_steps(dx_steps, dy_steps, 50.0);
                    
                    if duration_ms > 0 {
                        let steps = duration_ms / 16;
                        let start_x = { *status_clone.current_x.lock().unwrap() };
                        let start_y = { *status_clone.current_y.lock().unwrap() };
                        for step in 0..steps {
                            std::thread::sleep(std::time::Duration::from_millis(16));
                            let t = (step as f32 + 1.0) / (steps as f32);
                            let interp_x = start_x + (0.0 - start_x) * t;
                            let interp_y = start_y + (0.0 - start_y) * t;

                            {
                                let mut cx = status_clone.current_x.lock().unwrap();
                                let mut cy = status_clone.current_y.lock().unwrap();
                                *cx = interp_x;
                                *cy = interp_y;
                            }

                            let _ = app_clone.emit(
                                "plot-progress",
                                ProgressPayload {
                                    path_index: 0,
                                    point_index: 0,
                                    global_point_index: 0,
                                    total_points: 1,
                                    x: interp_x,
                                    y: interp_y,
                                    loop_index: 0,
                                    total_loops: 1,
                                },
                            );
                        }
                        std::thread::sleep(std::time::Duration::from_millis((duration_ms % 16) as u64 + 100));
                    }
                }

                let _ = driver.enable_motors(false); // release motors
                let _ = app_clone.emit("ebb-log", "Sent: EM,0,0 (Release motors at home)".to_string());
            }
            
            // Reset tracked position to home (0,0)
            {
                let mut cx = status_clone.current_x.lock().unwrap();
                let mut cy = status_clone.current_y.lock().unwrap();
                *cx = 0.0;
                *cy = 0.0;
            }
        }

        is_plotting.store(false, Ordering::SeqCst);
        is_paused.store(false, Ordering::SeqCst);
        
        let _ = app_clone.emit("plot-finished", aborted);
    });

    Ok(())
}

#[tauri::command]
fn pause_plot(status: State<'_, PlotStatusState>) -> Result<(), String> {
    status.is_paused.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn resume_plot(status: State<'_, PlotStatusState>) -> Result<(), String> {
    status.is_paused.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn stop_plot(status: State<'_, PlotStatusState>) -> Result<(), String> {
    status.is_plotting.store(false, Ordering::SeqCst);
    status.is_paused.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn send_manual_ebb_command(cmd: String, app: AppHandle, state: State<'_, PlotterState>) -> Result<String, String> {
    let mut driver_guard = state.driver.lock().unwrap();
    if let Some(ref mut driver) = *driver_guard {
        let _ = app.emit("ebb-log", format!("Sent: {}", cmd));
        let response = driver.send_command(&cmd)?;
        let _ = app.emit("ebb-log", format!("Received: {}", response));
        Ok(response)
    } else {
        Err("Plotter not connected".to_string())
    }
}

fn start_http_server(app: AppHandle) {
    let listener = match TcpListener::bind("127.0.0.1:18342") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("HTTP Server Error: Failed to bind to port 18342: {}", e);
            return;
        }
    };

    println!("HTTP Server: Listening on http://127.0.0.1:18342");

    for stream in listener.incoming() {
        if let Ok(mut stream) = stream {
            let app_clone = app.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(&mut stream);
                let mut first_line = String::new();
                if reader.read_line(&mut first_line).is_err() {
                    return;
                }
                
                if first_line.starts_with("POST /import") {
                    println!("HTTP Server: Received POST /import request");
                    let mut content_length = 0;
                    
                    // Read headers
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                            break;
                        }
                        if line.to_lowercase().starts_with("content-length:") {
                            if let Some(val_str) = line.split(':').nth(1) {
                                content_length = val_str.trim().parse::<usize>().unwrap_or(0);
                            }
                        }
                    }
                    
                    println!("HTTP Server: Content length to read is: {} bytes", content_length);
                    
                    // Read body
                    let mut body_bytes = vec![0u8; content_length];
                    match reader.read_exact(&mut body_bytes) {
                        Ok(_) => {
                            let svg_text = if body_bytes.starts_with(&[0xff, 0xfe]) {
                                // UTF-16 LE
                                let u16_chars: Vec<u16> = body_bytes[2..].chunks_exact(2)
                                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                                    .collect();
                                String::from_utf16(&u16_chars).unwrap_or_default()
                            } else if body_bytes.starts_with(&[0xfe, 0xff]) {
                                // UTF-16 BE
                                let u16_chars: Vec<u16> = body_bytes[2..].chunks_exact(2)
                                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                                    .collect();
                                String::from_utf16(&u16_chars).unwrap_or_default()
                            } else {
                                // Try UTF-8, fallback to UTF-16 or lossy UTF-8
                                match String::from_utf8(body_bytes.clone()) {
                                    Ok(s) => s,
                                    Err(_) => {
                                        if body_bytes.len() % 2 == 0 {
                                            let u16_chars: Vec<u16> = body_bytes.chunks_exact(2)
                                                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                                                .collect();
                                            String::from_utf16(&u16_chars).unwrap_or_else(|_| {
                                                String::from_utf8_lossy(&body_bytes).into_owned()
                                            })
                                        } else {
                                            String::from_utf8_lossy(&body_bytes).into_owned()
                                        }
                                    }
                                }
                            };
                            
                            println!("HTTP Server: Emitting SVG text event ({} bytes)", svg_text.len());
                            let _ = app_clone.emit("inkscape-import", svg_text);
                        }
                        Err(e) => {
                            eprintln!("HTTP Server: Failed to read body bytes: {}", e);
                        }
                    }
                    
                    let response = "HTTP/1.1 200 OK\r\n\
                                    Access-Control-Allow-Origin: *\r\n\
                                    Content-Type: text/plain\r\n\
                                    Content-Length: 2\r\n\r\n\
                                    OK";
                    let _ = stream.write_all(response.as_bytes());
                } else if first_line.starts_with("OPTIONS") {
                    let response = "HTTP/1.1 204 No Content\r\n\
                                    Access-Control-Allow-Origin: *\r\n\
                                    Access-Control-Allow-Methods: POST, OPTIONS\r\n\
                                    Access-Control-Allow-Headers: Content-Type\r\n\
                                    Content-Length: 0\r\n\r\n";
                    let _ = stream.write_all(response.as_bytes());
                } else {
                    let response = "HTTP/1.1 404 Not Found\r\n\
                                    Content-Length: 9\r\n\r\n\
                                    Not Found";
                    let _ = stream.write_all(response.as_bytes());
                }
            });
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PlotterState {
            driver: Mutex::new(None),
        })
        .manage(PlotStatusState {
            is_plotting: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            current_x: Mutex::new(0.0),
            current_y: Mutex::new(0.0),
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                start_http_server(app_handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            connect_plotter,
            disconnect_plotter,
            run_vectorization,
            configure_pen_heights,
            toggle_pen,
            enable_motors,
            zero_plotter_coordinates,
            jog_plotter,
            home_plotter,
            run_frame_preview,
            start_plot,
            pause_plot,
            resume_plot,
            stop_plot,
            send_manual_ebb_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
