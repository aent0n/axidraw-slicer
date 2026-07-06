export interface Point {
  x: number;
  y: number;
}

export interface Toolpath {
  points: Point[];
  isFill?: boolean;
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

function generateHatching(polygons: Point[][], spacingMm: number): Toolpath[] {
  const hatchPaths: Toolpath[] = [];
  if (polygons.length === 0) return hatchPaths;

  // Get bounding box of all polygons combined
  let minY = Infinity, maxY = -Infinity;
  polygons.forEach(poly => {
    poly.forEach(pt => {
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    });
  });

  if (minY === Infinity || maxY === Infinity || (maxY - minY) < spacingMm) {
    return hatchPaths;
  }

  // Generate horizontal lines across the vertical range of the shape
  for (let y = minY + spacingMm / 2; y < maxY; y += spacingMm) {
    const intersections: number[] = [];

    // Find intersections with edges of ALL polygons combined
    polygons.forEach(poly => {
      if (poly.length < 3) return;
      for (let i = 0; i < poly.length; i++) {
        const p1 = poly[i];
        const p2 = poly[(i + 1) % poly.length];

        // Check if edge crosses the horizontal line at y
        if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
          const t = (y - p1.y) / (p2.y - p1.y);
          const intersectX = p1.x + t * (p2.x - p1.x);
          intersections.push(intersectX);
        }
      }
    });

    // Sort intersections from left to right
    intersections.sort((a, b) => a - b);

    // Connect pairs of intersections (Odd-Even fill rule across all sub-paths)
    for (let i = 0; i < intersections.length - 1; i += 2) {
      hatchPaths.push({
        points: [
          { x: intersections[i], y: y },
          { x: intersections[i + 1], y: y }
        ]
      });
    }
  }

  return hatchPaths;
}

export function parseSVG(svgText: string, _bedWidthMm: number = 297, _bedHeightMm: number = 210, svgHatchSpacing: number = 1.0, enableHatching: boolean = false): Toolpath[] {
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

    // Check if the element has a fill color that is not 'none'
    const fillAttr = el.getAttribute("fill");
    const styleAttr = el.getAttribute("style") || "";
    const styleFillMatch = styleAttr.match(/fill\s*:\s*([^;]+)/);
    const styleFill = styleFillMatch ? styleFillMatch[1].trim() : null;
    
    // Check class-based styling computed by the browser
    const computedStyle = window.getComputedStyle(el);
    const computedFill = computedStyle ? computedStyle.fill : "";
    const hasClass = el.getAttribute("class") !== null;

    const finalFill = fillAttr || styleFill;
    const hasFill = (finalFill !== null && finalFill !== "none") ||
                    (hasClass && computedFill !== "none" && computedFill !== "");

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

      paths.push(...elementPaths);

      if (enableHatching && hasFill && elementPaths.length > 0) {
        const polygons = elementPaths.map(ep => ep.points);
        const hatches = generateHatching(polygons, svgHatchSpacing);
        hatches.forEach(h => h.isFill = true);
        paths.push(...hatches);
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

          paths.push(...elementPaths);

          if (enableHatching && hasFill && elementPaths.length > 0) {
            const polygons = elementPaths.map(ep => ep.points);
            const hatches = generateHatching(polygons, svgHatchSpacing);
            hatches.forEach(h => h.isFill = true);
            paths.push(...hatches);
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
