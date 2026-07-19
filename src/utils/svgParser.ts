export interface Point {
  x: number;
  y: number;
}

export interface Toolpath {
  points: Point[];
  isFill?: boolean;
  originallyFilled?: boolean;
  objectId?: string;
}

function parseUnitToMm(valStr: string | null, defaultValue: number): number {
  if (!valStr) return defaultValue;
  const val = parseFloat(valStr);
  if (isNaN(val)) return defaultValue;

  const unit = valStr.replace(/[0-9.-]/g, "").trim().toLowerCase();
  switch (unit) {
    case "mm": return val;
    case "cm": return val * 10;
    case "in": return val * 25.4;
    case "pt": return val * 0.352778; // 1 pt = 1/72 inch
    case "pc": return val * 4.233333; // 1 pica = 12 pt
    case "px":
    default:
      // Assuming standard 96 DPI (1 inch = 96px). So 1px = 25.4 / 96 = 0.264583 mm
      return val * 0.264583;
  }
}

// Sub-path parser helper
function parsePathElement(
  pathEl: SVGPathElement,
  tempSvg: SVGSVGElement,
  scaleX: number,
  scaleY: number,
  resolution: number,
  paths: Toolpath[]
) {
  try {
    const length = pathEl.getTotalLength();
    const points: Point[] = [];
    const ctm = pathEl.getCTM();

    if (length === 0) {
      // Fallback if browser layout fails to measure path length (common in headless/webview elements)
      const dAttr = pathEl.getAttribute("d") || "";
      const numbers = dAttr.match(/-?[\d.]+/g)?.map(parseFloat) || [];
      const pts: Point[] = [];
      for (let i = 0; i < numbers.length - 1; i += 2) {
        pts.push({ x: numbers[i], y: numbers[i+1] });
      }
      if (ctm && pts.length > 0) {
        pts.forEach(pt => {
          const svgPt = tempSvg.createSVGPoint();
          svgPt.x = pt.x;
          svgPt.y = pt.y;
          const transformedPt = svgPt.matrixTransform(ctm);
          pt.x = transformedPt.x;
          pt.y = transformedPt.y;
        });
      }
      pts.forEach(pt => {
        points.push({ x: pt.x * scaleX, y: pt.y * scaleY });
      });
    } else {
      // Determine sample resolution based on physical size
      const physicalLengthMm = length * Math.max(scaleX, scaleY);
      let numPoints = Math.max(2, Math.round(physicalLengthMm / resolution));
      if (isNaN(numPoints) || !isFinite(numPoints)) {
        numPoints = 2;
      }
      if (numPoints > 2000) {
        numPoints = 2000; // Cap to prevent UI freezes on very large SVGs
      }

      for (let i = 0; i <= numPoints; i++) {
        const dist = (i / numPoints) * length;
        const localPt = pathEl.getPointAtLength(dist);

        let x = localPt.x;
        let y = localPt.y;

        // Apply SVG transform hierarchy
        if (ctm) {
          const svgPt = tempSvg.createSVGPoint();
          svgPt.x = x;
          svgPt.y = y;
          const transformedPt = svgPt.matrixTransform(ctm);
          x = transformedPt.x;
          y = transformedPt.y;
        }

        // Convert to physical millimeters
        points.push({
          x: x * scaleX,
          y: y * scaleY,
        });
      }
    }

    if (points.length > 0) {
      paths.push({ points });
    }
  } catch (pathErr) {
    console.error("Failed to parse individual SVG path:", pathErr);
  }
}

function isPointInPolygon(pt: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y))
        && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function generateOffsetFill(polygons: Point[][], spacingMm: number): Toolpath[] {
  const fillPaths: Toolpath[] = [];
  if (polygons.length === 0) return fillPaths;

  // Clean polygons: remove consecutive duplicates
  const cleanedPolys = polygons.map(poly => {
    return poly.filter((pt, idx) => {
      const next = poly[(idx + 1) % poly.length];
      return Math.hypot(pt.x - next.x, pt.y - next.y) > 0.01;
    });
  }).filter(poly => poly.length >= 3);

  cleanedPolys.forEach((poly, polyIdx) => {
    // Determine if this polygon is a hole (contained by an odd number of other polygons)
    let containCount = 0;
    if (poly.length > 0) {
      const pt = poly[0];
      for (let j = 0; j < cleanedPolys.length; j++) {
        if (j !== polyIdx) {
          if (isPointInPolygon(pt, cleanedPolys[j])) {
            containCount++;
          }
        }
      }
    }
    const isHole = (containCount % 2) === 1;

    // Calculate signed area
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      area += (p1.x * p2.y - p2.x * p1.y);
    }

    let currentPoly = [...poly];
    // Enforce orientation: CCW for outer, CW for hole
    if (isHole) {
      if (area > 0) currentPoly.reverse();
    } else {
      if (area < 0) currentPoly.reverse();
    }

    // Keep offsetting inward/outward
    const distance = spacingMm;
    let limit = 500; // safety limit to prevent infinite loops
    while (limit-- > 0) {
      const offsetPoly: Point[] = [];
      const N = currentPoly.length;
      let collapsed = false;

      for (let i = 0; i < N; i++) {
        const p1 = currentPoly[(i - 1 + N) % N];
        const p2 = currentPoly[i];
        const p3 = currentPoly[(i + 1) % N];

        const v1 = { x: p2.x - p1.x, y: p2.y - p1.y };
        const v2 = { x: p3.x - p2.x, y: p3.y - p2.y };

        const len1 = Math.hypot(v1.x, v1.y);
        const len2 = Math.hypot(v2.x, v2.y);

        if (len1 < 0.001 || len2 < 0.001) {
          collapsed = true;
          break;
        }

        const u1 = { x: v1.x / len1, y: v1.y / len1 };
        const u2 = { x: v2.x / len2, y: v2.y / len2 };

        // Left normal: (-u_y, u_x)
        const n1 = { x: -u1.y, y: u1.x };
        const n2 = { x: -u2.y, y: u2.x };

        const bis = { x: n1.x + n2.x, y: n1.y + n2.y };
        const bisLen = Math.hypot(bis.x, bis.y);

        if (bisLen < 0.01) {
          offsetPoly.push({ x: p2.x + distance * n1.x, y: p2.y + distance * n1.y });
          continue;
        }

        const bisNorm = { x: bis.x / bisLen, y: bis.y / bisLen };
        const dot = bisNorm.x * n1.x + bisNorm.y * n1.y;

        if (dot < 0.01) {
          collapsed = true;
          break;
        }

        const s = 1.0 / dot;
        const scaleFactor = Math.min(s, 3.0); // limit extreme spikes at sharp corners

        offsetPoly.push({
          x: p2.x + distance * scaleFactor * bisNorm.x,
          y: p2.y + distance * scaleFactor * bisNorm.y
        });
      }

      if (collapsed || offsetPoly.length < 3) break;

      // Check if area orientation has inverted
      let offsetArea = 0;
      for (let i = 0; i < offsetPoly.length; i++) {
        const p1 = offsetPoly[i];
        const p2 = offsetPoly[(i + 1) % offsetPoly.length];
        offsetArea += (p1.x * p2.y - p2.x * p1.y);
      }

      // If area changed sign or collapsed, stop
      if (isHole) {
        if (offsetArea >= -0.01) break;
      } else {
        if (offsetArea <= 0.01) break;
      }

      // Clean duplicates
      const cleaned = offsetPoly.filter((pt, idx) => {
        const next = offsetPoly[(idx + 1) % offsetPoly.length];
        return Math.hypot(pt.x - next.x, pt.y - next.y) > 0.05;
      });

      if (cleaned.length < 3) break;

      fillPaths.push({
        points: [...cleaned, cleaned[0]]
      });

      currentPoly = cleaned;
    }
  });

  return fillPaths;
}

function generateHatching(
  polygons: Point[][],
  spacingMm: number,
  angleDeg: number = 0,
  crossHatch: boolean = false
): Toolpath[] {
  const generateSingleHatch = (ang: number): Toolpath[] => {
    const hatchPaths: Toolpath[] = [];
    if (polygons.length === 0) return hatchPaths;

    // 1. Calculate center of all polygons combined
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    polygons.forEach(poly => {
      poly.forEach(pt => {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      });
    });

    if (minX === Infinity || minY === Infinity) return hatchPaths;
    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const rad = (ang * Math.PI) / 180;

    // 2. Rotate all polygons by -rad around center
    const rotatedPolys = polygons.map(poly =>
      poly.map(pt => {
        const dx = pt.x - center.x;
        const dy = pt.y - center.y;
        return {
          x: center.x + dx * Math.cos(-rad) - dy * Math.sin(-rad),
          y: center.y + dx * Math.sin(-rad) + dy * Math.cos(-rad)
        };
      })
    );

    // 3. Find rotated bounding box
    let rMinY = Infinity, rMaxY = -Infinity;
    rotatedPolys.forEach(poly => {
      poly.forEach(pt => {
        if (pt.y < rMinY) rMinY = pt.y;
        if (pt.y > rMaxY) rMaxY = pt.y;
      });
    });

    if (rMinY === Infinity || (rMaxY - rMinY) < spacingMm) {
      return hatchPaths;
    }

    // 4. Generate scanlines in rotated space
    for (let y = rMinY + spacingMm / 2; y < rMaxY; y += spacingMm) {
      const intersections: number[] = [];

      rotatedPolys.forEach(poly => {
        if (poly.length < 3) return;
        for (let i = 0; i < poly.length; i++) {
          const p1 = poly[i];
          const p2 = poly[(i + 1) % poly.length];

          if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
            const t = (y - p1.y) / (p2.y - p1.y);
            const intersectX = p1.x + t * (p2.x - p1.x);
            intersections.push(intersectX);
          }
        }
      });

      intersections.sort((a, b) => a - b);

      for (let i = 0; i < intersections.length - 1; i += 2) {
        const p1Rotated = { x: intersections[i], y: y };
        const p2Rotated = { x: intersections[i + 1], y: y };

        const rotateBack = (pt: Point) => {
          const dx = pt.x - center.x;
          const dy = pt.y - center.y;
          return {
            x: center.x + dx * Math.cos(rad) - dy * Math.sin(rad),
            y: center.y + dx * Math.sin(rad) + dy * Math.cos(rad)
          };
        };

        hatchPaths.push({
          points: [rotateBack(p1Rotated), rotateBack(p2Rotated)]
        });
      }
    }

    return hatchPaths;
  };

  const results = generateSingleHatch(angleDeg);
  if (crossHatch) {
    results.push(...generateSingleHatch((angleDeg + 90) % 180));
  }
  return results;
}

function isColorDark(colorStr: string): boolean {
  const str = colorStr.trim().toLowerCase();
  if (str === "none" || str === "transparent" || str === "") return false;
  
  // Hex formats
  if (str.startsWith("#")) {
    const hex = str.substring(1);
    let r = 255, g = 255, b = 255;
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.substring(0, 2), 16);
      g = parseInt(hex.substring(2, 4), 16);
      b = parseInt(hex.substring(4, 6), 16);
    }
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance < 200;
  }
  
  // RGB formats
  if (str.startsWith("rgb")) {
    const parts = str.match(/\d+/g);
    if (parts && parts.length >= 3) {
      const r = parseInt(parts[0]);
      const g = parseInt(parts[1]);
      const b = parseInt(parts[2]);
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      return luminance < 200;
    }
  }
  
  // Named colors
  const lightColors = ["white", "yellow", "ivory", "lightyellow", "lightgray", "lightgrey", "whitesmoke", "beige", "transparent"];
  if (lightColors.includes(str)) return false;
  
  return true; // Default to dark/drawable if unknown
}

function getElementFillColor(el: Element): string {
  // 1. Direct attribute
  const fillAttr = el.getAttribute("fill");
  if (fillAttr) return fillAttr.trim();
  
  // 2. Inline style attribute
  const styleAttr = el.getAttribute("style");
  if (styleAttr) {
    const match = styleAttr.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/);
    if (match) return match[1].trim();
  }
  
  // 3. Fallback to computed style (only if available)
  try {
    const computedStyle = window.getComputedStyle(el);
    if (computedStyle && computedStyle.fill) {
      return computedStyle.fill.trim();
    }
  } catch (e) {}
  
  return "";
}

function shouldFillElement(el: Element, dAttr: string): boolean {
  const tag = el.tagName.toLowerCase();
  
  // Lines and polylines are open strokes, never filled/hatched
  if (tag === "line" || tag === "polyline") {
    return false;
  }
  
  // Paths must be closed to be filled/hatched (contain 'z' command)
  if (tag === "path") {
    const dLower = dAttr.toLowerCase();
    if (!dLower.includes("z")) {
      return false; // Open path, do not fill
    }
  }

  const fillColor = getElementFillColor(el).toLowerCase();
  if (fillColor === "none" || fillColor === "") {
    return false;
  }

  // Skip white or light fills which usually represent background/paper card backing
  if (!isColorDark(fillColor)) {
    return false;
  }

  return true;
}

export function parseSVG(
  svgText: string,
  _bedWidthMm: number = 297,
  _bedHeightMm: number = 210,
  svgHatchSpacing: number = 1.0,
  enableHatching: boolean = false,
  svgHatchStyle: "hatch" | "concentric" = "hatch",
  svgHatchAngle: number = 0,
  svgCrossHatch: boolean = false
): Toolpath[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svgEl = doc.querySelector("svg");
  
  if (!svgEl) {
    throw new Error("Invalid SVG: No <svg> tag found");
  }

  // Create an offscreen SVG to measure transforms
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.visibility = "hidden";
  container.style.width = "0px";
  container.style.height = "0px";
  document.body.appendChild(container);
  
  // Clone the SVG element into our container
  const tempSvg = svgEl.cloneNode(true) as SVGSVGElement;
  container.appendChild(tempSvg);

  // Get viewbox to establish user space coordinates
  const viewBoxAttr = tempSvg.getAttribute("viewBox");
  let viewBoxW = 800;
  let viewBoxH = 600;
  
  if (viewBoxAttr) {
    const parts = viewBoxAttr.split(/[\s,]+/).map(parseFloat);
    if (parts.length === 4) {
      viewBoxW = parts[2];
      viewBoxH = parts[3];
    }
  }

  // Determine physical size of SVG. If missing, treat viewBox coords as pixels (96 DPI)
  const physicalWidthMm = parseUnitToMm(tempSvg.getAttribute("width"), viewBoxW * 0.264583);
  const physicalHeightMm = parseUnitToMm(tempSvg.getAttribute("height"), viewBoxH * 0.264583);

  // Scaling factor from SVG user space coordinates (viewBox) to physical millimeters
  const scaleX = physicalWidthMm / viewBoxW;
  const scaleY = physicalHeightMm / viewBoxH;

  const paths: Toolpath[] = [];
  const resolution = 1.0; // sample point every 1mm in physical space

  // Select all drawable elements
  const drawables = tempSvg.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon");

  drawables.forEach((el) => {
    let dAttr = el.getAttribute("d") || "";
    const hasFill = shouldFillElement(el, dAttr);

    if (el.tagName.toLowerCase() === "path") {
      // Split the path data by 'M' or 'm' commands using positive lookahead
      const subPathDatas = dAttr.split(/(?=[Mm])/).map(s => s.trim()).filter(s => s.length > 0);
      
      const elementPaths: Toolpath[] = [];
      subPathDatas.forEach((subD) => {
        const subPathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
        subPathEl.setAttribute("d", subD);
        
        const transform = el.getAttribute("transform");
        if (transform) subPathEl.setAttribute("transform", transform);

        // Keep style attributes if any (e.g. vector-effect)
        const style = el.getAttribute("style");
        if (style) subPathEl.setAttribute("style", style);
        
        // Append temporarily to measure
        tempSvg.appendChild(subPathEl);
        
        parsePathElement(subPathEl, tempSvg, scaleX, scaleY, resolution, elementPaths);
        
        // Cleanup
        tempSvg.removeChild(subPathEl);
      });

      elementPaths.forEach(ep => ep.originallyFilled = hasFill);
      paths.push(...elementPaths);

      if (enableHatching && hasFill && elementPaths.length > 0) {
        const polygons = elementPaths.map(ep => ep.points);
        const fillPaths = svgHatchStyle === "concentric"
          ? generateOffsetFill(polygons, svgHatchSpacing)
          : generateHatching(polygons, svgHatchSpacing, svgHatchAngle, svgCrossHatch);
        fillPaths.forEach(h => h.isFill = true);
        paths.push(...fillPaths);
      }
    } else {
      // Convert other shapes to path data
      try {
        const d = convertShapeToPathData(el);
        if (d) {
          const newPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
          newPath.setAttribute("d", d);
          const transform = el.getAttribute("transform");
          if (transform) newPath.setAttribute("transform", transform);
          
          tempSvg.appendChild(newPath);
          const elementPaths: Toolpath[] = [];
          parsePathElement(newPath, tempSvg, scaleX, scaleY, resolution, elementPaths);
          tempSvg.removeChild(newPath);

          elementPaths.forEach(ep => ep.originallyFilled = hasFill);
          paths.push(...elementPaths);

          if (enableHatching && hasFill && elementPaths.length > 0) {
            const polygons = elementPaths.map(ep => ep.points);
            const fillPaths = svgHatchStyle === "concentric"
              ? generateOffsetFill(polygons, svgHatchSpacing)
              : generateHatching(polygons, svgHatchSpacing, svgHatchAngle, svgCrossHatch);
            fillPaths.forEach(h => h.isFill = true);
            paths.push(...fillPaths);
          }
        }
      } catch (err) {
        console.error("Failed to convert shape to path:", el, err);
      }
    }
  });

  // Clean up
  document.body.removeChild(container);

  return paths;
}

function convertShapeToPathData(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "rect") {
    const x = parseFloat(el.getAttribute("x") || "0");
    const y = parseFloat(el.getAttribute("y") || "0");
    const w = parseFloat(el.getAttribute("width") || "0");
    const h = parseFloat(el.getAttribute("height") || "0");
    return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
  } else if (tag === "circle") {
    const cx = parseFloat(el.getAttribute("cx") || "0");
    const cy = parseFloat(el.getAttribute("cy") || "0");
    const r = parseFloat(el.getAttribute("r") || "0");
    return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy}`;
  } else if (tag === "ellipse") {
    const cx = parseFloat(el.getAttribute("cx") || "0");
    const cy = parseFloat(el.getAttribute("cy") || "0");
    const rx = parseFloat(el.getAttribute("rx") || "0");
    const ry = parseFloat(el.getAttribute("ry") || "0");
    return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy}`;
  } else if (tag === "line") {
    const x1 = parseFloat(el.getAttribute("x1") || "0");
    const y1 = parseFloat(el.getAttribute("y1") || "0");
    const x2 = parseFloat(el.getAttribute("x2") || "0");
    const y2 = parseFloat(el.getAttribute("y2") || "0");
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  } else if (tag === "polyline" || tag === "polygon") {
    const pointsStr = el.getAttribute("points") || "";
    const coords = pointsStr.trim().split(/[\s,]+/).map(parseFloat).filter(c => !isNaN(c));
    if (coords.length < 4) return null;
    
    let path = `M ${coords[0]} ${coords[1]}`;
    for (let i = 2; i < coords.length - 1; i += 2) {
      path += ` L ${coords[i]} ${coords[i+1]}`;
    }
    if (tag === "polygon") {
      path += " Z";
    }
    return path;
  }
  return null;
}
