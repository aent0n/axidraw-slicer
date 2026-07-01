use std::io::{Read, Write};
use std::time::Duration;
use serialport::SerialPort;

pub const STEPS_PER_MM: f32 = 80.0; // GT2 pulley GT2-20 with 1/16 microstepping

pub struct EbbDriver {
    port: Box<dyn SerialPort>,
}

impl EbbDriver {
    pub fn new(port_name: &str) -> Result<Self, String> {
        let port = serialport::new(port_name, 9600)
            .timeout(Duration::from_millis(2000))
            .open()
            .map_err(|e| format!("Failed to open serial port: {}", e))?;
        
        let mut driver = Self { port };
        
        // Query version to verify it is indeed an EBB board
        let version = driver.send_command("v\r")?;
        if !version.contains("EBB") {
            return Err(format!("Device on {} is not an EBB board: {}", port_name, version));
        }
        
        // Enable motors by default
        driver.enable_motors(true)?;
        
        Ok(driver)
    }

    pub fn send_raw_command(&mut self, cmd: &str) -> Result<String, String> {
        self.port
            .write_all(cmd.as_bytes())
            .map_err(|e| format!("Serial write error: {}", e))?;
        self.port.flush().map_err(|e| format!("Serial flush error: {}", e))?;

        let mut response = String::new();
        let mut buffer = [0u8; 1];
        
        // Read until carriage return or newline
        while !response.ends_with("\r\n") && !response.ends_with("\r") {
            match self.port.read(&mut buffer) {
                Ok(1) => {
                    response.push(buffer[0] as char);
                }
                Ok(_) => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    return Err("Serial read timeout".to_string());
                }
                Err(e) => {
                    return Err(format!("Serial read error: {}", e));
                }
            }
        }
        
        Ok(response.trim().to_string())
    }

    pub fn send_command(&mut self, cmd: &str) -> Result<String, String> {
        let cleaned_cmd = if cmd.ends_with('\r') { cmd.to_string() } else { format!("{}\r", cmd) };
        self.send_raw_command(&cleaned_cmd)
    }

    pub fn enable_motors(&mut self, enable: bool) -> Result<(), String> {
        let val = if enable { "1,1" } else { "0,0" };
        let response = self.send_command(&format!("EM,{}", val))?;
        if response != "OK" {
            return Err(format!("Enable motors failed: {}", response));
        }
        Ok(())
    }

    pub fn toggle_pen(&mut self, down: bool, duration_ms: u32) -> Result<(), String> {
        let state = if down { "1" } else { "0" };
        let response = self.send_command(&format!("SP,{},{}", state, duration_ms))?;
        if response != "OK" {
            return Err(format!("Pen toggle failed: {}", response));
        }
        // Sleep to let the servo finish moving physically
        std::thread::sleep(Duration::from_millis(duration_ms as u64));
        Ok(())
    }

    pub fn configure_pen_heights(&mut self, up_val: u32, down_val: u32) -> Result<(), String> {
        // SC,4,value sets Pen Up position (servo pulse duration in EBB counts)
        // SC,5,value sets Pen Down position
        let response1 = self.send_command(&format!("SC,4,{}", up_val))?;
        let response2 = self.send_command(&format!("SC,5,{}", down_val))?;
        if response1 != "OK" || response2 != "OK" {
            return Err(format!("Config pen heights failed: {} / {}", response1, response2));
        }
        Ok(())
    }

    /// Moves X and Y by relative distances in millimeters.
    /// The CoreXY mixing is handled by EBB in hardware using the XM command.
    pub fn move_relative(&mut self, dx_mm: f32, dy_mm: f32, speed_mm_s: f32) -> Result<(), String> {
        // Calculate steps
        let steps_x = (dx_mm * STEPS_PER_MM).round() as i32;
        let steps_y = (dy_mm * STEPS_PER_MM).round() as i32;

        if steps_x == 0 && steps_y == 0 {
            return Ok(());
        }

        // Calculate travel distance
        let distance = (dx_mm.powi(2) + dy_mm.powi(2)).sqrt();
        
        // Calculate duration in ms
        let mut duration_ms = ((distance / speed_mm_s) * 1000.0).round() as u32;
        
        // Clamp duration to at least 1ms, and max supported duration
        if duration_ms < 1 {
            duration_ms = 1;
        }

        // XM,<duration>,<axisA>,<axisB>
        let cmd = format!("XM,{},{},{}", duration_ms, steps_x, steps_y);
        let response = self.send_command(&cmd)?;
        if response != "OK" {
            return Err(format!("Move command failed: {}", response));
        }

        Ok(())
    }

    pub fn move_relative_steps(&mut self, steps_x: i32, steps_y: i32, speed_mm_s: f32) -> Result<(), String> {
        if steps_x == 0 && steps_y == 0 {
            return Ok(());
        }

        // Calculate travel distance in mm
        let dx_mm = steps_x as f32 / STEPS_PER_MM;
        let dy_mm = steps_y as f32 / STEPS_PER_MM;
        let distance = (dx_mm.powi(2) + dy_mm.powi(2)).sqrt();
        
        // Calculate duration in ms
        let mut duration_ms = ((distance / speed_mm_s) * 1000.0).round() as u32;
        if duration_ms < 1 {
            duration_ms = 1;
        }

        let cmd = format!("XM,{},{},{}", duration_ms, steps_x, steps_y);
        let response = self.send_command(&cmd)?;
        if response != "OK" {
            return Err(format!("Move command failed: {}", response));
        }

        Ok(())
    }

    pub fn clear_motion(&mut self) -> Result<(), String> {
        let response = self.send_command("CM")?;
        if response != "OK" {
            return Err(format!("Clear motion failed: {}", response));
        }
        Ok(())
    }
}
