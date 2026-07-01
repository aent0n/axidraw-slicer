use image::{GenericImageView, ImageBuffer, Luma};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Toolpath {
    pub points: Vec<Point>,
}

#[derive(Debug, Deserialize)]
pub struct VectorizerSettings {
    pub algorithm: String, // "sketch", "hatch", "tsp"
    pub max_lines: u32,
    pub line_density: f32,  // 1.0 to 10.0
    pub resolution: u32,    // target width for processing (e.g. 500px)
    pub scale_width: f32,   // physical size in mm (e.g. 210 for A4 width)
    pub scale_height: f32,  // physical size in mm (e.g. 297 for A4 height)
}

pub fn vectorize_image(image_bytes: &[u8], settings: &VectorizerSettings) -> Result<Vec<Toolpath>, String> {
    let img = image::load_from_memory(image_bytes)
        .map_err(|e| format!("Failed to load image from memory: {}", e))?;
    
    // Resize image to target resolution to keep computing times short and uniform
    let (orig_w, orig_h) = img.dimensions();
    let aspect = orig_h as f32 / orig_w as f32;
    let target_w = settings.resolution;
    let target_h = (target_w as f32 * aspect).round() as u32;
    let img_gray = img.resize(target_w, target_h, image::imageops::FilterType::Lanczos3).into_luma8();
    
    match settings.algorithm.as_str() {
        "sketch" => run_sketch(&img_gray, settings, target_w, target_h),
        "hatch" => run_hatch(&img_gray, settings, target_w, target_h),
        "tsp" => run_tsp(&img_gray, settings, target_w, target_h),
        _ => Err("Unknown algorithm".to_string()),
    }
}

// Convert pixel coords (px) to physical coords (mm)
fn to_physical(px_x: f32, px_y: f32, img_w: u32, img_h: u32, phys_w: f32, phys_h: f32) -> Point {
    Point {
        x: (px_x / img_w as f32) * phys_w,
        y: (px_y / img_h as f32) * phys_h,
    }
}

/// 1. SKETCH / SQUIGGLE ALGORITHM
fn run_sketch(
    img: &ImageBuffer<Luma<u8>, Vec<u8>>,
    settings: &VectorizerSettings,
    w: u32,
    h: u32,
) -> Result<Vec<Toolpath>, String> {
    let mut darkness = vec![0.0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let pixel = img.get_pixel(x, y);
            // 0 is black, 255 is white. Convert to darkness (0.0 = white, 1.0 = black)
            darkness[(y * w + x) as usize] = 1.0 - (pixel[0] as f32 / 255.0);
        }
    }

    let mut toolpaths = Vec::new();
    let max_lines = settings.max_lines;
    let line_len = 50; // max length of a single stroke
    let step_size = 1.5; // step distance in pixels
    let erase_radius = 5.0f32; // radius to erase drawn pixels

    for _ in 0..max_lines {
        // Find darkest pixel
        let mut best_val = -1.0;
        let mut start_idx = 0;
        for (idx, &val) in darkness.iter().enumerate() {
            if val > best_val {
                best_val = val;
                start_idx = idx;
            }
        }

        // If overall image is brightened enough, stop
        if best_val < 0.1 {
            break;
        }

        let mut curr_x = (start_idx % w as usize) as f32;
        let mut curr_y = (start_idx / w as usize) as f32;
        let mut path_points = Vec::new();
        path_points.push(to_physical(curr_x, curr_y, w, h, settings.scale_width, settings.scale_height));

        for _ in 0..line_len {
            // Find best next step around curr_x, curr_y
            let mut best_next_val = -1.0;
            let mut best_nx = curr_x;
            let mut best_ny = curr_y;
            
            // Look at 16 angles around current position
            for a in 0..16 {
                let angle = (a as f32) * (std::f32::consts::PI / 8.0);
                let nx = curr_x + angle.cos() * step_size;
                let ny = curr_y + angle.sin() * step_size;

                if nx >= 0.0 && nx < w as f32 && ny >= 0.0 && ny < h as f32 {
                    let val = darkness[(ny as u32 * w + nx as u32) as usize];
                    if val > best_next_val {
                        best_next_val = val;
                        best_nx = nx;
                        best_ny = ny;
                    }
                }
            }

            if best_next_val < 0.05 {
                break; // Too light, stop this stroke
            }

            curr_x = best_nx;
            curr_y = best_ny;
            path_points.push(to_physical(curr_x, curr_y, w, h, settings.scale_width, settings.scale_height));

            // Erase/brighten darkness around current point to avoid retracing
            let r_start_x = (curr_x - erase_radius).max(0.0) as u32;
            let r_end_x = (curr_x + erase_radius).min(w as f32 - 1.0) as u32;
            let r_start_y = (curr_y - erase_radius).max(0.0) as u32;
            let r_end_y = (curr_y + erase_radius).min(h as f32 - 1.0) as u32;

            for ey in r_start_y..=r_end_y {
                for ex in r_start_x..=r_end_x {
                    let dx = ex as f32 - curr_x;
                    let dy = ey as f32 - curr_y;
                    let dist_sq = dx*dx + dy*dy;
                    if dist_sq < erase_radius * erase_radius {
                        let idx = (ey * w + ex) as usize;
                        // Reduce darkness intensity
                        let factor = (dist_sq.sqrt() / erase_radius).min(1.0);
                        darkness[idx] *= 0.1 + 0.9 * factor;
                    }
                }
            }
        }

        if path_points.len() > 1 {
            toolpaths.push(Toolpath { points: path_points });
        }
    }

    Ok(toolpaths)
}

/// 2. HATCHING / WAVY LINE ALGORITHM
fn run_hatch(
    img: &ImageBuffer<Luma<u8>, Vec<u8>>,
    settings: &VectorizerSettings,
    w: u32,
    h: u32,
) -> Result<Vec<Toolpath>, String> {
    let mut toolpaths = Vec::new();
    
    // Spacing between lines (pixels)
    let spacing = (12.0 / settings.line_density).max(2.0);
    let mut y = spacing / 2.0;

    while y < h as f32 {
        let mut path_points = Vec::new();
        let mut x = 0.0f32;
        
        while x < w as f32 {
            let px = x.min(w as f32 - 1.0) as u32;
            let py = y.min(h as f32 - 1.0) as u32;
            let pixel = img.get_pixel(px, py);
            let darkness = 1.0 - (pixel[0] as f32 / 255.0);

            // Modulate vertical amplitude (waves) based on darkness
            // A sine wave whose amplitude grows in dark spots
            let amplitude = spacing * 0.8 * darkness;
            let freq = 0.25; // frequency of the sine wave
            let dy = (x * freq).sin() * amplitude;

            path_points.push(to_physical(x, y + dy, w, h, settings.scale_width, settings.scale_height));
            
            x += 1.5; // step size in pixels
        }

        if !path_points.is_empty() {
            toolpaths.push(Toolpath { points: path_points });
        }
        
        y += spacing;
    }

    Ok(toolpaths)
}

/// 3. TSP (TRAVELING SALESPERSON PROBLEM) ALGORITHM
fn run_tsp(
    img: &ImageBuffer<Luma<u8>, Vec<u8>>,
    settings: &VectorizerSettings,
    w: u32,
    h: u32,
) -> Result<Vec<Toolpath>, String> {
    // Step 1: Dither the image to get stipple points
    // Let's use simple error diffusion dither
    let mut dither_img = img.clone();
    let mut points = Vec::new();

    // Downscale target point density using settings
    let target_points = (settings.max_lines * 5).clamp(500, 8000) as usize;
    
    // We scan and dither
    for y in 0..h {
        for x in 0..w {
            let old_pixel = dither_img.get_pixel(x, y)[0] as f32;
            // Threshold
            let new_val = if old_pixel < 128.0 { 0.0 } else { 255.0 };
            dither_img.put_pixel(x, y, Luma([new_val as u8]));

            let err = old_pixel - new_val;
            
            // Distribute error
            if x + 1 < w {
                let p = dither_img.get_pixel(x + 1, y)[0] as f32 + err * (7.0 / 16.0);
                dither_img.put_pixel(x + 1, y, Luma([p.clamp(0.0, 255.0) as u8]));
            }
            if y + 1 < h {
                if x > 0 {
                    let p = dither_img.get_pixel(x - 1, y + 1)[0] as f32 + err * (3.0 / 16.0);
                    dither_img.put_pixel(x - 1, y + 1, Luma([p.clamp(0.0, 255.0) as u8]));
                }
                let p = dither_img.get_pixel(x, y + 1)[0] as f32 + err * (5.0 / 16.0);
                dither_img.put_pixel(x, y + 1, Luma([p.clamp(0.0, 255.0) as u8]));
                if x + 1 < w {
                    let p = dither_img.get_pixel(x + 1, y + 1)[0] as f32 + err * (1.0 / 16.0);
                    dither_img.put_pixel(x + 1, y + 1, Luma([p.clamp(0.0, 255.0) as u8]));
                }
            }

            // If it's a dithered black point, add it as a candidate
            if new_val == 0.0 {
                points.push(Point { x: x as f32, y: y as f32 });
            }
        }
    }

    // Downsample points if there are too many, to ensure TSP completes fast
    if points.len() > target_points {
        let skip = points.len() / target_points;
        points = points.into_iter().step_by(skip).collect();
    }

    if points.is_empty() {
        return Ok(Vec::new());
    }

    // Step 2: Nearest-Neighbor route initialization
    let mut tour = Vec::new();
    let mut unvisited = points;
    let mut current = unvisited.remove(0);
    tour.push(current.clone());

    while !unvisited.is_empty() {
        let mut min_dist_sq = f32::MAX;
        let mut best_idx = 0;

        for (idx, pt) in unvisited.iter().enumerate() {
            let dx = pt.x - current.x;
            let dy = pt.y - current.y;
            let dist_sq = dx*dx + dy*dy;
            if dist_sq < min_dist_sq {
                min_dist_sq = dist_sq;
                best_idx = idx;
            }
        }

        current = unvisited.remove(best_idx);
        tour.push(current.clone());
    }

    // Step 3: Run 2-opt local search optimization (reduces crossings)
    // We run it for a fixed number of iterations or until no improvement is found
    let mut improved = true;
    let mut iterations = 0;
    let max_iterations = 200000; // safety ceiling

    let n = tour.len();
    while improved && iterations < max_iterations {
        improved = false;
        for i in 1..n - 2 {
            for j in i + 1..n {
                // Measure current cost vs swapped cost
                // Edges: (i-1 -> i) and (j -> j+1)
                // Swapped: (i-1 -> j) and (i -> j+1)
                let p1 = &tour[i - 1];
                let p2 = &tour[i];
                let p3 = &tour[j];
                let p4 = if j + 1 < n { &tour[j + 1] } else { &tour[0] };

                let current_dist = dist(p1, p2) + dist(p3, p4);
                let swapped_dist = dist(p1, p3) + dist(p2, p4);

                if swapped_dist < current_dist {
                    // Reverse tour slice from i to j
                    tour[i..=j].reverse();
                    improved = true;
                    iterations += 1;
                }
            }
        }
    }

    // Step 4: Convert tour points to physical coordinate system
    let physical_points: Vec<Point> = tour
        .into_iter()
        .map(|pt| to_physical(pt.x, pt.y, w, h, settings.scale_width, settings.scale_height))
        .collect();

    Ok(vec![Toolpath { points: physical_points }])
}

#[inline(always)]
fn dist(p1: &Point, p2: &Point) -> f32 {
    let dx = p1.x - p2.x;
    let dy = p1.y - p2.y;
    (dx*dx + dy*dy).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dist() {
        let p1 = Point { x: 0.0, y: 0.0 };
        let p2 = Point { x: 3.0, y: 4.0 };
        assert_eq!(dist(&p1, &p2), 5.0);
    }

    #[test]
    fn test_to_physical() {
        let pt = to_physical(100.0, 100.0, 200, 200, 210.0, 297.0);
        assert_eq!(pt.x, 105.0);
        assert_eq!(pt.y, 148.5);
    }
}

