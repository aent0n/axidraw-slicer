import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseSVG } from "./utils/svgParser";

interface Point {
  x: number;
  y: number;
}

interface Toolpath {
  points: Point[];
  isFill?: boolean;
  originallyFilled?: boolean;
  objectId?: string;
}

interface ProgressPayload {
  path_index: number;
  point_index: number;
  global_point_index: number;
  total_points: number;
  x: number;
  y: number;
  loop_index: number;
  total_loops: number;
}

interface SerialPortDetails {
  port_name: string;
  display_name: string;
  is_axidraw: boolean;
}

interface SlicingStats {
  drawDist: number;
  airDist: number;
  numLifts: number;
  timeEst: number;
  airTimeEst: number;
}

interface PenProfile {
  id: string;
  name: string;
  capacityMeters: number;
  accumulatedDistanceMeters: number;
  tipSizeMm: number;
}

interface PastJob {
  id: string;
  name: string;
  timestamp: string;
  paths: Toolpath[];
  stats: SlicingStats | null;
  status: "completed" | "aborted";
}

interface SlicerObject {
  id: string;
  name: string;
  rawPaths: Toolpath[];
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  svgText?: string;
  isMonoline?: boolean;
}

const formatTime = (secs: number): string => {
  const mins = Math.floor(secs / 60);
  const remainingSecs = Math.round(secs % 60);
  return `${mins}m ${remainingSecs}s`;
};

const CANVAS_PADDING = 20;

function skeletonize(width: number, height: number, pixels: Uint8ClampedArray): Uint8Array {
  const grid = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b);
    // Permissive threshold to capture faint anti-aliased pixels of thin paths
    grid[i / 4] = (luminance < 240 && a > 30) ? 1 : 0;
  }

  let changed = true;
  const toDelete: number[] = [];

  const getNeighbors = (x: number, y: number) => {
    const n = new Uint8Array(9);
    n[0] = 0;
    n[1] = y > 0 ? grid[(y - 1) * width + x] : 0; 
    n[2] = (y > 0 && x < width - 1) ? grid[(y - 1) * width + x + 1] : 0; 
    n[3] = x < width - 1 ? grid[y * width + x + 1] : 0; 
    n[4] = (y < height - 1 && x < width - 1) ? grid[(y + 1) * width + x + 1] : 0; 
    n[5] = y < height - 1 ? grid[(y + 1) * width + x] : 0; 
    n[6] = (y < height - 1 && x > 0) ? grid[(y + 1) * width + x - 1] : 0; 
    n[7] = x > 0 ? grid[y * width + x - 1] : 0; 
    n[8] = (y > 0 && x > 0) ? grid[(y - 1) * width + x - 1] : 0; 
    return n;
  };

  while (changed) {
    changed = false;
    
    toDelete.length = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        if (grid[idx] === 0) continue;

        const n = getNeighbors(x, y);
        const B = n[1] + n[2] + n[3] + n[4] + n[5] + n[6] + n[7] + n[8];
        let A = 0;
        for (let i = 1; i < 8; i++) {
          if (n[i] === 0 && n[i + 1] === 1) A++;
        }
        if (n[8] === 0 && n[1] === 1) A++;

        if (B >= 2 && B <= 6 && A === 1) {
          const cond1 = n[1] * n[3] * n[5] === 0; 
          const cond2 = n[3] * n[5] * n[7] === 0; 
          if (cond1 && cond2) {
            toDelete.push(idx);
          }
        }
      }
    }
    if (toDelete.length > 0) {
      toDelete.forEach(idx => grid[idx] = 0);
      changed = true;
    }

    toDelete.length = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        if (grid[idx] === 0) continue;

        const n = getNeighbors(x, y);
        const B = n[1] + n[2] + n[3] + n[4] + n[5] + n[6] + n[7] + n[8];
        let A = 0;
        for (let i = 1; i < 8; i++) {
          if (n[i] === 0 && n[i + 1] === 1) A++;
        }
        if (n[8] === 0 && n[1] === 1) A++;

        if (B >= 2 && B <= 6 && A === 1) {
          const cond1 = n[1] * n[3] * n[7] === 0; 
          const cond2 = n[1] * n[5] * n[7] === 0; 
          if (cond1 && cond2) {
            toDelete.push(idx);
          }
        }
      }
    }
    if (toDelete.length > 0) {
      toDelete.forEach(idx => grid[idx] = 0);
      changed = true;
    }
  }

  return grid;
}

function traceSkeleton(width: number, height: number, grid: Uint8Array): Point[][] {
  const paths: Point[][] = [];
  const visited = new Uint8Array(width * height);

  const countNeighbors = (x: number, y: number) => {
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          if (grid[ny * width + nx] === 1) {
            count++;
          }
        }
      }
    }
    return count;
  };

  const getNextNeighbor = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const idx = ny * width + nx;
          if (grid[idx] === 1 && visited[idx] === 0) {
            return { x: nx, y: ny };
          }
        }
      }
    }
    return null;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (grid[idx] === 1 && visited[idx] === 0) {
        const neighbors = countNeighbors(x, y);
        if (neighbors === 1) {
          const path: Point[] = [];
          let cx = x;
          let cy = y;
          
          while (true) {
            const cidx = cy * width + cx;
            visited[cidx] = 1;
            path.push({ x: cx, y: cy });
            
            const next = getNextNeighbor(cx, cy);
            if (!next) break;
            cx = next.x;
            cy = next.y;
          }
          if (path.length >= 2) {
            paths.push(path);
          }
        }
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (grid[idx] === 1 && visited[idx] === 0) {
        const path: Point[] = [];
        let cx = x;
        let cy = y;
        
        while (true) {
          const cidx = cy * width + cx;
          visited[cidx] = 1;
          path.push({ x: cx, y: cy });
          
          const next = getNextNeighbor(cx, cy);
          if (!next) break;
          cx = next.x;
          cy = next.y;
        }
        
        if (path.length >= 3) {
          const first = path[0];
          const last = path[path.length - 1];
          if (Math.abs(first.x - last.x) <= 1 && Math.abs(first.y - last.y) <= 1) {
            path.push({ ...first });
          }
        }
        
        if (path.length >= 2) {
          paths.push(path);
        }
      }
    }
  }

  return paths;
}


function smoothPath(points: Point[], iterations: number = 3): Point[] {
  if (points.length <= 2) return points;
  let curr = [...points];
  for (let iter = 0; iter < iterations; iter++) {
    const next: Point[] = [];
    next.push({ ...curr[0] }); // keep start point
    for (let i = 1; i < curr.length - 1; i++) {
      const prev = curr[i - 1];
      const c = curr[i];
      const n = curr[i + 1];
      next.push({
        x: (prev.x + 2 * c.x + n.x) / 4,
        y: (prev.y + 2 * c.y + n.y) / 4
      });
    }
    next.push({ ...curr[curr.length - 1] }); // keep end point
    curr = next;
  }
  return curr;
}

function App() {
  // Navigation Tabs: Prepare / Preview / Monitor
  const [activeTab, setActiveTab] = useState<"prepare" | "preview" | "monitor">("prepare");

  // Serial Port, Origin Corner & Connection
  const [ports, setPorts] = useState<SerialPortDetails[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [connected, setConnected] = useState(false);
  const [originCorner, setOriginCorner] = useState<"top-left" | "top-right">("top-left");
  const [statusMsg, setStatusMsg] = useState("Disconnected");

  // Home timestamp tracking
  const [homeSetTimestamp, setHomeSetTimestamp] = useState<string | null>(null);

  // Job Finished Modal states
  const [showFinishedModal, setShowFinishedModal] = useState(false);
  const [jobStartTime, setJobStartTime] = useState<number | null>(null);
  const [actualElapsedSeconds, setActualElapsedSeconds] = useState<number>(0);

  // Live Position Feedback
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 });

  // Plotter & Queue Status
  const [isPlotting, setIsPlotting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);

  // File Loading
  const [tracingBoundary, setTracingBoundary] = useState<{ minX: number, maxX: number, minY: number, maxY: number } | null>(null);
  const [fileType, setFileType] = useState<"none" | "image" | "svg">("none");
  const [fileName, setFileName] = useState("");
  const [imageBytes, setImageBytes] = useState<Uint8Array | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState("");

  // Bed & Layout Settings (Default A4 Landscape)
  const [scaleWidth, setScaleWidth] = useState(297);
  const [scaleHeight, setScaleHeight] = useState(210);
  const [orientation, setOrientation] = useState<"landscape" | "portrait">("landscape");
  const [margin, setMargin] = useState(10); // Safety margin in mm
  const [showBedWarning, setShowBedWarning] = useState(false);
  const [zoom, setZoom] = useState(1.0); // Canvas Zoom level
  const [bedPreset, setBedPreset] = useState("A4");

  // Background Visual Template Image States
  const [templateImage, setTemplateImage] = useState<HTMLImageElement | null>(null);
  const [templateOpacity, setTemplateOpacity] = useState<number>(50);
  const [templateScale, setTemplateScale] = useState<number>(100);
  const [templateOffsetX, setTemplateOffsetX] = useState<number>(0);
  const [templateOffsetY, setTemplateOffsetY] = useState<number>(0);
  const [templateRotation, setTemplateRotation] = useState<number>(0);
  const [isTemplateLocked, setIsTemplateLocked] = useState<boolean>(false);

  // Priming Line States
  const [enablePrimingLine, setEnablePrimingLine] = useState<boolean>(false);
  const [primingStartX, setPrimingStartX] = useState<number>(10);
  const [primingStartY, setPrimingStartY] = useState<number>(10);
  const [primingLength, setPrimingLength] = useState<number>(30);
  const [primingDirection, setPrimingDirection] = useState<"horizontal" | "vertical">("vertical");

  // SVG Fill settings
  const [svgHatchSpacing, setSvgHatchSpacing] = useState<number>(1.0); // mm
  const [enableSvgHatching, setEnableSvgHatching] = useState<boolean>(false);
  const [svgHatchStyle, setSvgHatchStyle] = useState<"hatch" | "concentric">("hatch");
  const [svgHatchAngle, setSvgHatchAngle] = useState<number>(45); // degrees
  const [svgCrossHatch, setSvgCrossHatch] = useState<boolean>(false);

  // Local input buffer states for smooth dragging
  const [localHatchSpacing, setLocalHatchSpacing] = useState<number>(1.0);
  const [localHatchAngle, setLocalHatchAngle] = useState<number>(45);

  // Slicer Multi-Object State & Selection Grouping
  const [objects, setObjects] = useState<SlicerObject[]>([]);
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const selectedObjectId = selectedObjectIds[selectedObjectIds.length - 1] || null;

  // Input text buffer states (to prevent snapping/resetting while typing)
  const [inputScaleText, setInputScaleText] = useState("");
  const [inputRotationText, setInputRotationText] = useState("");
  const [inputWidthText, setInputWidthText] = useState("");
  const [inputHeightText, setInputHeightText] = useState("");

  // Loading states
  const [isCalculatingHatch, setIsCalculatingHatch] = useState(false);
  const [loadingText, setLoadingText] = useState<string | null>(null);

  // Mouse Drag-and-Drop Positioning / Scaling / Rotating states
  const [isDragging, setIsDragging] = useState(false);
  const [dragMode, setDragMode] = useState<"translate" | "scale" | "rotate" | null>(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, initOffsetX: 0, initOffsetY: 0 });
  const [dragStartOffsets, setDragStartOffsets] = useState<{ [id: string]: { x: number, y: number } }>({});

  // Vectorizer Settings (Only for single image vectorization)
  const [algorithm, setAlgorithm] = useState("sketch");
  const [maxLines, setMaxLines] = useState(1500);
  const [lineDensity, setLineDensity] = useState(5.0);
  const [resolution, setResolution] = useState(500);
  const [isGenerating, setIsGenerating] = useState(false);

  // Slicing Stats & Path simulation
  const [slicingStats, setSlicingStats] = useState<SlicingStats | null>(null);
  const [simulatedPointsCount, setSimulatedPointsCount] = useState<number | null>(null);
  const [slicedPaths, setSlicedPaths] = useState<Toolpath[]>([]); // NN-optimized paths
  const [rawSlicedPaths, setRawSlicedPaths] = useState<Toolpath[]>([]); // Sliced paths without priming line
  const [recoverySession, setRecoverySession] = useState<any | null>(null);

  // Pen Profiles Manager
  const [penProfiles, setPenProfiles] = useState<PenProfile[]>(() => {
    try {
      const saved = localStorage.getItem("axidraw_pen_profiles");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.error("Error loading pen profiles:", e);
    }
    return [
      { id: "default-fine", name: "Ultra Fine (0.2mm)", capacityMeters: 1000, accumulatedDistanceMeters: 0, tipSizeMm: 0.2 },
      { id: "default-medium", name: "Medium Fine (0.4mm)", capacityMeters: 1500, accumulatedDistanceMeters: 0, tipSizeMm: 0.4 },
      { id: "default-broad", name: "Broad Sharpie (1.0mm)", capacityMeters: 2000, accumulatedDistanceMeters: 0, tipSizeMm: 1.0 }
    ];
  });
  const [activeProfileId, setActiveProfileId] = useState<string>(() => {
    return localStorage.getItem("axidraw_active_profile_id") || "default-medium";
  });
  
  // Custom Profile Add
  const [newPenName, setNewPenName] = useState("");
  const [newPenCapacity, setNewPenCapacity] = useState(1000);
  const [newPenTipSize, setNewPenTipSize] = useState<number>(0.4);

  // Pen State tracking (UP / DOWN)
  const [isPenDown, setIsPenDown] = useState(false);

  // Motors State (ENABLED / RELEASED)
  const [areMotorsEnabled, setAreMotorsEnabled] = useState(true);

  // Jog Settings
  const [jogStep, setJogStep] = useState(10); // mm
  const [jogSpeed, setJogSpeed] = useState(30); // mm/s
  const [ebbSpeed, setEbbSpeed] = useState(25); // mm/s plotting speed
  const [airSpeed, setAirSpeed] = useState(60); // mm/s travel speed in air
  const [penUpHeight, setPenUpHeight] = useState(12000); // UP is 1.2ms pulse
  const [penDownHeight, setPenDownHeight] = useState(16000); // DOWN is 1.6ms pulse
  const [penDelay, setPenDelay] = useState(300); // ms delay for pen lift

  // Axis inversion settings
  const [invertX, setInvertX] = useState(false);
  const [invertY, setInvertY] = useState(false);

  // Fluidd-Style live monitoring telemetry
  const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
  const [speedMultiplier, setSpeedMultiplier] = useState(100); // % multiplier override
  const [manualCommandText, setManualCommandText] = useState("");
  const [consoleHeight, setConsoleHeight] = useState(450); // Drag-to-resize EBB logs console height
  const [isResizingConsole, setIsResizingConsole] = useState(false);
  const [showFuturePath, setShowFuturePath] = useState(true);
  const [simulatePenWidth, setSimulatePenWidth] = useState(true);
  const [monolineMergeWidth, setMonolineMergeWidth] = useState(0.8);
  const [monitorZoom, setMonitorZoom] = useState(1.0);

  // Live print job metrics state
  const [jobStats, setJobStats] = useState<{
    status: "idle" | "printing" | "paused" | "aborted" | "completed";
    pointsCompleted: number;
    totalPoints: number;
    pathsCompleted: number;
    totalPaths: number;
    distanceDrawn: number;
    distanceTraveled: number;
    elapsedTime: number;
    estimatedRemaining: number;
    airTravelTime: number;
  }>({
    status: "idle",
    pointsCompleted: 0,
    totalPoints: 0,
    pathsCompleted: 0,
    totalPaths: 0,
    distanceDrawn: 0.0,
    distanceTraveled: 0.0,
    elapsedTime: 0,
    estimatedRemaining: 0,
    airTravelTime: 0
  });

  // Canvas & Scroll-wheel References
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null);
  const consoleContainerRef = useRef<HTMLDivElement | null>(null);
  const monitorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const consoleCardRef = useRef<HTMLDivElement | null>(null);
  
  const monitorCanvasContainerRef = useRef<HTMLDivElement | null>(null);
  const monitorCanvasContainerCallback = useCallback((node: HTMLDivElement | null) => {
    monitorCanvasContainerRef.current = node;
    if (node) {
      const handleWheel = (e: WheelEvent) => {
        if (!e.ctrlKey) return; // Only zoom if Ctrl key is held!
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 0.25 : -0.25;
        setMonitorZoom(prev => Math.max(1.0, Math.min(5.0, prev + zoomFactor)));
      };
      node.addEventListener("wheel", handleWheel, { passive: false });
    }
  }, []);

  const prepareScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const prepareScrollContainerCallback = useCallback((node: HTMLDivElement | null) => {
    prepareScrollContainerRef.current = node;
    if (node) {
      const handleWheel = (e: WheelEvent) => {
        if (!e.ctrlKey) return; // Only zoom if Ctrl key is held!
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 0.15 : -0.15;
        setZoom(prev => Math.max(1.0, Math.min(5.0, prev + zoomFactor)));
      };
      node.addEventListener("wheel", handleWheel, { passive: false });
    }
  }, []);

  // Refs to avoid stale closures in event listeners
  const slicingStatsRef = useRef(slicingStats);
  useEffect(() => { slicingStatsRef.current = slicingStats; }, [slicingStats]);

  const enableSvgHatchingRef = useRef(enableSvgHatching);
  useEffect(() => { enableSvgHatchingRef.current = enableSvgHatching; }, [enableSvgHatching]);

  const svgHatchSpacingRef = useRef(svgHatchSpacing);
  useEffect(() => { svgHatchSpacingRef.current = svgHatchSpacing; }, [svgHatchSpacing]);

  const jobStartTimeRef = useRef(jobStartTime);
  useEffect(() => { jobStartTimeRef.current = jobStartTime; }, [jobStartTime]);

  const isPausedRef = useRef(isPaused);
  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);

  const slicedPathsRef = useRef(slicedPaths);
  useEffect(() => { slicedPathsRef.current = slicedPaths; }, [slicedPaths]);

  const isPlottingRef = useRef(isPlotting);
  useEffect(() => { isPlottingRef.current = isPlotting; }, [isPlotting]);

  // Click-and-drag panning states
  const [isPanningPrepare, setIsPanningPrepare] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });
  const [isPanningMonitor, setIsPanningMonitor] = useState(false);
  const [panStartMonitor, setPanStartMonitor] = useState({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  // Slicer Clipboard
  const [clipboard, setClipboard] = useState<SlicerObject | null>(null);
  const [allowArrangeResize, setAllowArrangeResize] = useState<boolean>(false);
  const [jobHistory, setJobHistory] = useState<PastJob[]>(() => {
    try {
      const saved = localStorage.getItem("axidraw_job_history");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {
      console.error("Error loading job history:", e);
    }
    return [];
  });

  // LocalStorage Persistence Hooks
  useEffect(() => {
    localStorage.setItem("axidraw_pen_profiles", JSON.stringify(penProfiles));
  }, [penProfiles]);

  useEffect(() => {
    localStorage.setItem("axidraw_active_profile_id", activeProfileId);
  }, [activeProfileId]);

  useEffect(() => {
    localStorage.setItem("axidraw_job_history", JSON.stringify(jobHistory));
  }, [jobHistory]);

  const scaleWidthRef = useRef(scaleWidth);
  useEffect(() => { scaleWidthRef.current = scaleWidth; }, [scaleWidth]);

  const scaleHeightRef = useRef(scaleHeight);
  useEffect(() => { scaleHeightRef.current = scaleHeight; }, [scaleHeight]);

  const objectsRef = useRef(objects);
  useEffect(() => { objectsRef.current = objects; }, [objects]);

  const activeProfileIdRef = useRef(activeProfileId);
  useEffect(() => { activeProfileIdRef.current = activeProfileId; }, [activeProfileId]);

  const addToJobHistoryRef = useRef<((aborted: boolean) => void) | null>(null);
  useEffect(() => { addToJobHistoryRef.current = addToJobHistory; }, [addToJobHistory]);

  const svgHatchStyleRef = useRef(svgHatchStyle);
  useEffect(() => { svgHatchStyleRef.current = svgHatchStyle; }, [svgHatchStyle]);

  const svgHatchAngleRef = useRef(svgHatchAngle);
  useEffect(() => { svgHatchAngleRef.current = svgHatchAngle; }, [svgHatchAngle]);

   const svgCrossHatchRef = useRef(svgCrossHatch);
  useEffect(() => { svgCrossHatchRef.current = svgCrossHatch; }, [svgCrossHatch]);

  const lastDistanceDrawnRef = useRef(0);
  const initialDrawnMetersOfRunRef = useRef(0);

  // Synchronize local slider buffer states with primary states
  useEffect(() => {
    setLocalHatchSpacing(svgHatchSpacing);
  }, [svgHatchSpacing]);

  useEffect(() => {
    setLocalHatchAngle(svgHatchAngle);
  }, [svgHatchAngle]);

  const getRawObjectBounds = (obj: SlicerObject) => {
    if (obj.rawPaths.length === 0) return null;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    obj.rawPaths.forEach((path) => {
      path.points.forEach((pt) => {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      });
    });

    if (minX === Infinity || minY === Infinity) return null;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const scaleFactorX = obj.scaleX / 100;
    const scaleFactorY = obj.scaleY / 100;
    const rad = (obj.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const bedCenterX = scaleWidth / 2;
    const bedCenterY = scaleHeight / 2;

    let pMinX = Infinity, pMaxX = -Infinity;
    let pMinY = Infinity, pMaxY = -Infinity;

    obj.rawPaths.forEach((path) => {
      path.points.forEach((pt) => {
        let x = pt.x - cx;
        let y = pt.y - cy;
        x *= scaleFactorX;
        y *= scaleFactorY;
        const rx = x * cos - y * sin;
        const ry = x * sin + y * cos;
        const finalX = bedCenterX + rx;
        const finalY = bedCenterY + ry;

        if (finalX < pMinX) pMinX = finalX;
        if (finalX > pMaxX) pMaxX = finalX;
        if (finalY < pMinY) pMinY = finalY;
        if (finalY > pMaxY) pMaxY = finalY;
      });
    });

    return { minX: pMinX, maxX: pMaxX, minY: pMinY, maxY: pMaxY };
  };

  const getObjectBounds = (obj: SlicerObject) => {
    const raw = getRawObjectBounds(obj);
    if (!raw) return null;
    return {
      minX: raw.minX + obj.offsetX,
      maxX: raw.maxX + obj.offsetX,
      minY: raw.minY + obj.offsetY,
      maxY: raw.maxY + obj.offsetY
    };
  };

  const getCombinedObjectsBounds = () => {
    if (objects.length === 0) return null;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    objects.forEach(obj => {
      const bounds = getObjectBounds(obj);
      if (bounds) {
        if (bounds.minX < minX) minX = bounds.minX;
        if (bounds.maxX > maxX) maxX = bounds.maxX;
        if (bounds.minY < minY) minY = bounds.minY;
        if (bounds.maxY > maxY) maxY = bounds.maxY;
      }
    });
    if (minX === Infinity || minY === Infinity) return null;
    return { minX, maxX, minY, maxY };
  };

  const getTemplateBounds = () => {
    if (!templateImage) return null;
    const imgW = templateImage.naturalWidth;
    const imgH = templateImage.naturalHeight;
    const aspect = imgH / imgW;
    const physicalW = scaleWidth * (templateScale / 100);
    const physicalH = (scaleWidth * aspect) * (templateScale / 100);

    return {
      minX: templateOffsetX,
      maxX: templateOffsetX + physicalW,
      minY: templateOffsetY,
      maxY: templateOffsetY + physicalH,
      width: physicalW,
      height: physicalH
    };
  };

  // Ramer-Douglas-Peucker (RDP) path simplification helpers to prevent EBB stepper motors from slipping due to chatter at high speed
  const getSqSegDist = (p: Point, p1: Point, p2: Point) => {
    let x = p1.x;
    let y = p1.y;
    let dx = p2.x - x;
    let dy = p2.y - y;

    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = p2.x;
        y = p2.y;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }

    dx = p.x - x;
    dy = p.y - y;

    return dx * dx + dy * dy;
  };

  const simplifyDPStep = (points: Point[], first: number, last: number, sqTolerance: number, simplified: Point[]) => {
    let maxSqDist = sqTolerance;
    let index = -1;

    for (let i = first + 1; i < last; i++) {
      const sqDist = getSqSegDist(points[i], points[first], points[last]);
      if (sqDist > maxSqDist) {
        index = i;
        maxSqDist = sqDist;
      }
    }

    if (index > -1) {
      if (index - first > 1) simplifyDPStep(points, first, index, sqTolerance, simplified);
      simplified.push(points[index]);
      if (last - index > 1) simplifyDPStep(points, index, last, sqTolerance, simplified);
    }
  };

  const simplifyRDP = (points: Point[], tolerance: number) => {
    if (points.length <= 2) return points;
    const sqTolerance = tolerance * tolerance;
    const simplified: Point[] = [points[0]];
    simplifyDPStep(points, 0, points.length - 1, sqTolerance, simplified);
    simplified.push(points[points.length - 1]);
    return simplified;
  };

  const getProcessedToolpaths = (): Toolpath[] => {
    const allPaths: Toolpath[] = [];

    objects.forEach((obj) => {
      if (obj.rawPaths.length === 0) return;

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;

      obj.rawPaths.forEach((path) => {
        path.points.forEach((pt) => {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.y > maxY) maxY = pt.y;
        });
      });

      if (minX === Infinity || minY === Infinity) return;

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      const scaleFactorX = obj.scaleX / 100;
      const scaleFactorY = obj.scaleY / 100;
      const rad = (obj.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      const bedCenterX = scaleWidth / 2;
      const bedCenterY = scaleHeight / 2;

      const processedObjPaths = obj.rawPaths.map((path) => {
        const points = path.points.map((pt) => {
          let x = pt.x - cx;
          let y = pt.y - cy;

          x *= scaleFactorX;
          y *= scaleFactorY;

          const rx = x * cos - y * sin;
          const ry = x * sin + y * cos;

          let finalX = bedCenterX + rx + obj.offsetX;
          let finalY = bedCenterY + ry + obj.offsetY;

          // Clamp only in preview/slicing stage
          if (margin > 0 && activeTab === "preview") {
            finalX = Math.max(margin, Math.min(scaleWidth - margin, finalX));
            finalY = Math.max(margin, Math.min(scaleHeight - margin, finalY));
          }

          return { x: finalX, y: finalY };
        });

        // Apply Ramer-Douglas-Peucker simplification with 0.04mm tolerance (invisible, but huge EBB speed stability gain)
        const simplifiedPoints = simplifyRDP(points, 0.04);
        return { 
          points: simplifiedPoints,
          isFill: path.isFill,
          originallyFilled: path.originallyFilled,
          objectId: obj.id
        };
      });

      allPaths.push(...processedObjPaths);
    });

    return allPaths;
  };

  const handleConnect = async () => {
    if (connected) {
      try {
        await invoke("disconnect_plotter");
        setConnected(false);
        setHomeSetTimestamp(null);
        setStatusMsg("Disconnected");
      } catch (err: any) {
        setStatusMsg(`Error: ${err}`);
      }
    } else {
      if (!selectedPort) {
        setStatusMsg("Please select a port");
        return;
      }
      setStatusMsg("Connecting...");
      try {
        const info: string = await invoke("connect_plotter", { portName: selectedPort });
        await invoke("configure_pen_heights", { upHeight: penUpHeight, downHeight: penDownHeight });
        setConnected(true);
        setAreMotorsEnabled(true);
        updateHomeTimestamp();
        setStatusMsg(info);
      } catch (err: any) {
        setConnected(false);
        setStatusMsg(`Failed: ${err}`);
      }
    }
  };

  const processFile = (file: File) => {
    setLoadingText("Importing File...");
    setTimeout(() => {
      const reader = new FileReader();
      const fileNameLower = file.name.toLowerCase();
      if (fileNameLower.endsWith(".svg")) {
        setFileType("svg");
        reader.onload = (event) => {
          const svgText = event.target?.result as string;
          try {
            // First check if it is a valid XML file using DOMParser
            const xmlParser = new DOMParser();
            const xmlDoc = xmlParser.parseFromString(svgText, "image/svg+xml");
            const parserError = xmlDoc.querySelector("parsererror");
            if (parserError) {
              throw new Error(`XML Syntax Error: ${parserError.textContent}`);
            }

            const parsed = parseSVG(
              svgText, 
              scaleWidth, 
              scaleHeight, 
              svgHatchSpacing, 
              enableSvgHatching,
              svgHatchStyle,
              svgHatchAngle,
              svgCrossHatch
            );

            if (parsed.length === 0) {
              throw new Error("No printable paths or vector elements found. Verify that the file contains vector shapes or lines, not just embedded raster images.");
            }
            
            // Resolve duplicate name
            let finalName = file.name;
            let count = 1;
            const extIdx = file.name.lastIndexOf(".");
            const base = extIdx !== -1 ? file.name.substring(0, extIdx) : file.name;
            const ext = extIdx !== -1 ? file.name.substring(extIdx) : "";
            
            while (objects.some(o => o.name === finalName)) {
              finalName = `${base} (${count})${ext}`;
              count++;
            }

            const newObj: SlicerObject = {
              id: `obj-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              name: finalName,
              rawPaths: parsed,
              offsetX: 0,
              offsetY: 0,
              scaleX: 100,
              scaleY: 100,
              rotation: 0,
              svgText: svgText
            };
            setObjects(prev => [...prev, newObj]);
            setSelectedObjectIds([newObj.id]);
            setSlicingStats(null);
            setRawSlicedPaths([]);
            setStatusMsg(`Loaded SVG object: ${finalName}`);
          } catch (err: any) {
            console.error("SVG Import failed:", err);
            const errMsg = err.message || err;
            setStatusMsg(`SVG Error: ${errMsg}`);
            alert(`Failed to parse SVG file: ${file.name}\n\nReason: ${errMsg}\n\nTroubleshooting suggestions:\n- If you exported from Illustrator/Inkscape/Figma, make sure to export as standard SVG (not proprietary/editor formats).\n- Check that the file actually contains vector paths or shapes.\n- Convert text elements to paths (curves/contours) before exporting.`);
          } finally {
            setLoadingText(null);
          }
        };
        reader.onerror = () => {
          setStatusMsg("Error reading file.");
          setLoadingText(null);
        };
        reader.readAsText(file);
      } else {
        setFileType("image");
        setImagePreviewUrl(URL.createObjectURL(file));
        setFileName(file.name);
        reader.onload = (event) => {
          const buffer = event.target?.result as ArrayBuffer;
          setImageBytes(new Uint8Array(buffer));
          setStatusMsg("Image loaded. Configure vectorizer and click Generate.");
          setLoadingText(null);
        };
        reader.onerror = () => {
          setStatusMsg("Error reading file.");
          setLoadingText(null);
        };
        reader.readAsArrayBuffer(file);
      }
    }, 50);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  };

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const processTemplateFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        setTemplateImage(img);
        setStatusMsg("Background template loaded successfully!");
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleTemplateUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processTemplateFile(file);
    e.target.value = "";
  };

  const handleTemplateDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) processTemplateFile(file);
  };

  const handleGenerateToolpath = async () => {
    if (fileType === "svg") {
      setStatusMsg("SVG does not require generation");
      return;
    }
    if (!imageBytes) {
      setStatusMsg("Please load an image first");
      return;
    }

    setIsGenerating(true);
    setStatusMsg("Vectorizing image in Rust...");
    try {
      const settings = {
        algorithm,
        max_lines: maxLines,
        line_density: lineDensity,
        resolution,
        scale_width: scaleWidth,
        scale_height: scaleHeight,
      };

      const result: Toolpath[] = await invoke("run_vectorization", {
        imageBytes: Array.from(imageBytes),
        settings,
      });

      const newObj: SlicerObject = {
        id: `obj-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: `Vectorizer: ${fileName}`,
        rawPaths: result,
        offsetX: 0,
        offsetY: 0,
        scaleX: 100,
        scaleY: 100,
        rotation: 0
      };

      setObjects(prev => [...prev, newObj]);
      setSelectedObjectIds([newObj.id]);
      setSlicingStats(null);
      setRawSlicedPaths([]);
      setStatusMsg("Generated vectorized object from image");
    } catch (err: any) {
      setStatusMsg(`Vectorizer failed: ${err}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleOptimizeVectorizerScale = async () => {
    if (!imageBytes) {
      setStatusMsg("No loaded image bytes found to optimize");
      return;
    }
    const selected = objects.find(o => o.id === selectedObjectId);
    if (!selected) return;

    setIsGenerating(true);
    setStatusMsg("Optimizing vector density to current scale...");
    try {
      const scaleFactor = selected.scaleX / 100;
      // Calculate target physical size based on the current scale percentage
      const targetW = scaleWidth * scaleFactor;
      const targetH = scaleHeight * scaleFactor;

      // Scale down density parameters proportionally to the scale factor to simplify the design
      // instead of keeping it extremely dense/condensed at smaller sizes!
      const optMaxLines = Math.max(100, Math.round(maxLines * scaleFactor));
      const optLineDensity = Math.max(0.5, lineDensity * scaleFactor);

      const settings = {
        algorithm,
        max_lines: optMaxLines,
        line_density: optLineDensity,
        resolution,
        scale_width: targetW,
        scale_height: targetH,
      };

      const result: Toolpath[] = await invoke("run_vectorization", {
        imageBytes: Array.from(imageBytes),
        settings,
      });

      // Update the object with the new paths, reset scale back to 100 (since the paths are pre-scaled physically)
      // and preserve offset and name!
      setObjects(prev => prev.map(o => {
        if (o.id === selected.id) {
          return {
            ...o,
            rawPaths: result,
            scaleX: 100,
            scaleY: 100 // Reset scale to 100% since its physical paths are now exactly sized!
          };
        }
        return o;
      }));

      setSlicingStats(null);
      setRawSlicedPaths([]);
      setStatusMsg("Vector density optimized successfully for current scale!");
    } catch (err: any) {
      setStatusMsg(`Optimization failed: ${err}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleConvertToMonoline = (objId: string) => {
    const obj = objects.find(o => o.id === objId);
    if (!obj || obj.rawPaths.length === 0) return;

    setLoadingText("Converting to Monoline...");
    setTimeout(() => {
      try {
        const rawBounds = getUnrotatedObjectBounds(obj);
        if (!rawBounds) throw new Error("Could not calculate object bounds");

        const rawW = rawBounds.maxX - rawBounds.minX;
        const rawH = rawBounds.maxY - rawBounds.minY;
        if (rawW <= 0.1 || rawH <= 0.1) throw new Error("Object is too small to vectorize");

        // Create offscreen canvas at high resolution
        const canvasW = 2000; // Increased resolution for better precision
        const canvasH = Math.max(10, Math.round(canvasW * (rawH / rawW)));

        const canvas = document.createElement("canvas");
        canvas.width = canvasW;
        canvas.height = canvasH;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Could not get 2D canvas context");

        // Clear canvas to white
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvasW, canvasH);

        const scale = canvasW / rawW;

        // Convert the merge width in mm to canvas pixels.
        // We draw outline paths with a base 3.0px width so they never disappear or get anti-aliased away.
        const mergePixelWidth = (monolineMergeWidth / rawW) * canvasW;
        const desiredPixelWidth = Math.max(3.0, mergePixelWidth);

        ctx.strokeStyle = "black";
        ctx.fillStyle = "black";
        ctx.lineWidth = desiredPixelWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        obj.rawPaths.forEach(path => {
          if (path.points.length < 2) return;
          ctx.beginPath();
          
          // Map coordinates manually to canvas pixel space
          const startX = (path.points[0].x - rawBounds.minX) * scale;
          const startY = (path.points[0].y - rawBounds.minY) * scale;
          ctx.moveTo(startX, startY);
          
          for (let i = 1; i < path.points.length; i++) {
            const px = (path.points[i].x - rawBounds.minX) * scale;
            const py = (path.points[i].y - rawBounds.minY) * scale;
            ctx.lineTo(px, py);
          }

          // Check if path is closed and was originally filled in the SVG
          const first = path.points[0];
          const last = path.points[path.points.length - 1];
          const isClosed = path.points.length >= 3 && Math.hypot(first.x - last.x, first.y - last.y) < 0.05;

          // Safeguard: detect background cards / framing rectangles (>85% size and originally filled) and skip filling them.
          // Also only fill closed paths that are small (<= 40mm) to prevent larger panel shapes from painting the canvas black.
          let isBackgroundCard = false;
          let isSmallShape = true;
          if (isClosed) {
            let pMinX = Infinity, pMaxX = -Infinity;
            let pMinY = Infinity, pMaxY = -Infinity;
            path.points.forEach(pt => {
              if (pt.x < pMinX) pMinX = pt.x;
              if (pt.x > pMaxX) pMaxX = pt.x;
              if (pt.y < pMinY) pMinY = pt.y;
              if (pt.y > pMaxY) pMaxY = pt.y;
            });
            const pW = pMaxX - pMinX;
            const pH = pMaxY - pMinY;
            if (path.originallyFilled) {
              isBackgroundCard = (pW > 0.85 * rawW) && (pH > 0.85 * rawH);
              isSmallShape = (pW <= 40.0) && (pH <= 40.0);
            }
          }

          if (isClosed && path.originallyFilled && isSmallShape && !isBackgroundCard) {
            ctx.fill();
          } else if (!isBackgroundCard) {
            ctx.stroke();
          }
        });

        // Debug filled paths
        let filledCount = 0;
        let skippedBgCount = 0;
        let largeFilledInfo: string[] = [];
        obj.rawPaths.forEach((path, idx) => {
          if (path.points.length < 2) return;
          const first = path.points[0];
          const last = path.points[path.points.length - 1];
          const isClosed = path.points.length >= 3 && Math.hypot(first.x - last.x, first.y - last.y) < 0.05;
          if (isClosed && path.originallyFilled) {
            let pMinX = Infinity, pMaxX = -Infinity;
            let pMinY = Infinity, pMaxY = -Infinity;
            path.points.forEach(pt => {
              if (pt.x < pMinX) pMinX = pt.x;
              if (pt.x > pMaxX) pMaxX = pt.x;
              if (pt.y < pMinY) pMinY = pt.y;
              if (pt.y > pMaxY) pMaxY = pt.y;
            });
            const pW = pMaxX - pMinX;
            const pH = pMaxY - pMinY;
            const isBg = (pW > 0.85 * rawW) && (pH > 0.85 * rawH);
            if (isBg) {
              skippedBgCount++;
            } else {
              filledCount++;
              if (pW > 20 || pH > 20) {
                largeFilledInfo.push(`[Path #${idx}] ${pW.toFixed(1)}x${pH.toFixed(1)}mm bounds=[${pMinX.toFixed(1)},${pMaxX.toFixed(1)}]`);
              }
            }
          }
        });

        // Get image data
        const imgData = ctx.getImageData(0, 0, canvasW, canvasH);
        const pixels = imgData.data;

        // Run skeletonization on raw thresholded pixels
        const grid = skeletonize(canvasW, canvasH, pixels);

        // Trace thinned lines to paths
        const tracedPixelPaths = traceSkeleton(canvasW, canvasH, grid);

        // Convert pixel paths back to raw millimeter coordinates
        const monolinePaths: Toolpath[] = tracedPixelPaths.map(pixelPath => {
          const points = pixelPath.map(pt => {
            const rawX = rawBounds.minX + (pt.x / canvasW) * rawW;
            const rawY = rawBounds.minY + (pt.y / canvasH) * rawH;
            return { x: rawX, y: rawY };
          });
          
          // Apply moving average smoothing to eliminate grid staircase artifacts and recover smooth, supple curves
          const smoothedPoints = smoothPath(points, 4);

          // Calculate an adaptive RDP simplification tolerance based on the pixel size to smooth out staircases
          // while preserving fine design features.
          const pixelSizeMm = rawW / canvasW;
          const adaptiveTolerance = Math.max(0.03, 0.6 * pixelSizeMm);
          const simplifiedPoints = simplifyRDP(smoothedPoints, adaptiveTolerance);

          return {
            points: simplifiedPoints
          };
        }).filter(p => p.points.length >= 2);

        if (monolinePaths.length === 0) {
          throw new Error("Skeletonization resulted in empty paths. Try reducing the Merge Gap Width or ensuring the design is not too thin.");
        }

        let blackPixels = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] < 240) blackPixels++;
        }
        const diag = {
          originalPathsCount: obj.rawPaths.length,
          canvasW,
          canvasH,
          rawBounds,
          rawW: parseFloat(rawW.toFixed(3)),
          rawH: parseFloat(rawH.toFixed(3)),
          blackPixels,
          tracedPixelPathsCount: tracedPixelPaths.length,
          monolinePathsCount: monolinePaths.length,
          filledCount,
          skippedBgCount,
          largeFilledInfo
        };
        console.log("ConvertToMonoline Diagnostic:", diag);
        setConsoleLogs(prev => [...prev, `[MONOLINE DIAG] ${JSON.stringify(diag)}`]);

        setObjects(prev => prev.map(o => {
          if (o.id === objId) {
            return {
              ...o,
              name: o.name.endsWith(" (Monoline)") ? o.name : `${o.name} (Monoline)`,
              rawPaths: monolinePaths,
              isMonoline: true
            };
          }
          return o;
        }));

        setSlicingStats(null);
        setRawSlicedPaths([]);
        setStatusMsg(`Converted "${obj.name}" to monoline (${monolinePaths.length} paths).`);
      } catch (err: any) {
        console.error("Monoline conversion failed:", err);
        setStatusMsg(`Monoline Error: ${err.message || err}`);
        alert(`Monoline Conversion Failed:\n\n${err.message || err}`);
      } finally {
        setLoadingText(null);
      }
    }, 50);
  };

  const handleAddPenProfile = () => {
    if (!newPenName.trim()) return;
    const newId = `custom-${Date.now()}`;
    const newProfile: PenProfile = {
      id: newId,
      name: newPenName,
      capacityMeters: newPenCapacity,
      accumulatedDistanceMeters: 0,
      tipSizeMm: newPenTipSize
    };
    setPenProfiles(prev => [...prev, newProfile]);
    setActiveProfileId(newId);
    setNewPenName("");
    setNewPenTipSize(0.4);
    setStatusMsg(`Added custom pen profile: ${newPenName}`);
  };

  const rotate90 = (direction: "left" | "right") => {
    if (activeTab === "preview") return;
    if (selectedObjectIds.includes("template-object")) {
      setTemplateRotation(prev => {
        let newRot = prev + (direction === "right" ? 90 : -90);
        if (newRot < 0) newRot += 360;
        if (newRot >= 360) newRot -= 360;
        return newRot;
      });
      return;
    }
    if (selectedObjectIds.length === 0) return;
    setObjects(prev => prev.map(obj => {
      if (selectedObjectIds.includes(obj.id)) {
        let newRot = obj.rotation + (direction === "right" ? 90 : -90);
        if (newRot < 0) newRot += 360;
        if (newRot >= 360) newRot -= 360;
        return { ...obj, rotation: newRot };
      }
      return obj;
    }));
    setSlicingStats(null); // Force re-slice
    setRawSlicedPaths([]);
  };

  const getUnrotatedObjectBounds = (obj: SlicerObject) => {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    obj.rawPaths.forEach(path => {
      path.points.forEach(pt => {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      });
    });
    if (minX === Infinity || minY === Infinity) return null;
    return { minX, maxX, minY, maxY };
  };

  const flipObject = (direction: "horizontal" | "vertical") => {
    if (activeTab === "preview") return;
    if (selectedObjectIds.length === 0) return;
    setObjects(prev => prev.map(obj => {
      if (selectedObjectIds.includes(obj.id)) {
        const bounds = getUnrotatedObjectBounds(obj);
        if (!bounds) return obj;
        const midX = (bounds.minX + bounds.maxX) / 2;
        const midY = (bounds.minY + bounds.maxY) / 2;
        const flippedPaths = obj.rawPaths.map(path => ({
          points: path.points.map(pt => ({
            x: direction === "horizontal" ? (2 * midX - pt.x) : pt.x,
            y: direction === "vertical" ? (2 * midY - pt.y) : pt.y
          }))
        }));
        return {
          ...obj,
          rawPaths: flippedPaths
        };
      }
      return obj;
    }));
    setSlicingStats(null); // Force re-slice
    setRawSlicedPaths([]);
    setStatusMsg(`Flipped selection ${direction === "horizontal" ? "horizontally" : "vertically"}`);
  };

  const handleWidthChange = (valStr: string) => {
    setInputWidthText(valStr);
    const val = parseFloat(valStr);
    if (!isNaN(val) && val > 0 && selectedObjectId && selectedObjectId !== "template-object") {
      const selected = objects.find(o => o.id === selectedObjectId);
      if (selected) {
        const bounds = getUnrotatedObjectBounds(selected);
        if (bounds) {
          const rawW = bounds.maxX - bounds.minX;
          if (rawW > 0) {
            const newScaleX = Math.round((val / rawW) * 100);
            if (newScaleX > 0) {
              setObjects(prev => prev.map(o => selectedObjectIds.includes(o.id) ? { ...o, scaleX: newScaleX } : o));
              setRawSlicedPaths([]);
              setSlicingStats(null);
            }
          }
        }
      }
    }
  };

  const handleHeightChange = (valStr: string) => {
    setInputHeightText(valStr);
    const val = parseFloat(valStr);
    if (!isNaN(val) && val > 0 && selectedObjectId && selectedObjectId !== "template-object") {
      const selected = objects.find(o => o.id === selectedObjectId);
      if (selected) {
        const bounds = getUnrotatedObjectBounds(selected);
        if (bounds) {
          const rawH = bounds.maxY - bounds.minY;
          if (rawH > 0) {
            const newScaleY = Math.round((val / rawH) * 100);
            if (newScaleY > 0) {
              setObjects(prev => prev.map(o => selectedObjectIds.includes(o.id) ? { ...o, scaleY: newScaleY } : o));
              setRawSlicedPaths([]);
              setSlicingStats(null);
            }
          }
        }
      }
    }
  };

  const handleArrangeAll = async () => {
    if (activeTab === "preview") return;
    const N = objects.length;
    if (N === 0) return;

    setLoadingText("Auto-Arranging Designs...");
    // Wait for React to render loading overlay
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      const startX = margin;
      const startY = margin;
      const spacing = 15.0; // 15mm comfortable safety spacing between designs for cutting

      const bedCenterX = scaleWidth / 2;
      const bedCenterY = scaleHeight / 2;

      let currentX = startX;
      let currentY = startY;
      let maxRowHeight = 0;

      const arranged = objects.map((obj) => {
        // Get original unscaled bounds
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        obj.rawPaths.forEach(path => {
          path.points.forEach(pt => {
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
          });
        });

        if (minX === Infinity) return obj;

        const rawW = maxX - minX;
        const rawH = maxY - minY;

        let newScaleX = obj.scaleX;
        let newScaleY = obj.scaleY;
        let objW = rawW * (newScaleX / 100);
        let objH = rawH * (newScaleY / 100);

        if (allowArrangeResize) {
          // If auto-scale is allowed, fit inside a default cell width/height
          const cols = Math.ceil(Math.sqrt(N));
          const rows = Math.ceil(N / cols);
          const cellW = (scaleWidth - margin * 2) / cols;
          const cellH = (scaleHeight - margin * 2) / rows;
          const maxFitW = cellW * 0.9;
          const maxFitH = cellH * 0.9;
          const scaleRatio = Math.min(maxFitW / rawW, maxFitH / rawH);
          const fitScale = Math.max(10, Math.min(400, Math.floor(scaleRatio * 100)));
          newScaleX = fitScale;
          newScaleY = fitScale;
          objW = rawW * (newScaleX / 100);
          objH = rawH * (newScaleY / 100);
        }

        // Check if it fits on the current row
        if (currentX + objW > scaleWidth - margin && currentX > startX) {
          // Wrap to next row
          currentX = startX;
          currentY += maxRowHeight + spacing;
          maxRowHeight = 0;
        }

        // Check if it exceeds the bed height margin warning
        if (currentY + objH > scaleHeight - margin) {
          // Just place it at the last row anyway, or overlap
        }

        // Target center coordinates of this object cell in bed workspace
        const cellCenterX = currentX + objW / 2;
        const cellCenterY = currentY + objH / 2;

        // Update row measurements
        if (objH > maxRowHeight) {
          maxRowHeight = objH;
        }

        // Move cursor forward for next object
        currentX += objW + spacing;

        // Offset coordinates relative to the bed center
        const newOffsetX = cellCenterX - bedCenterX;
        const newOffsetY = cellCenterY - bedCenterY;

        return {
          ...obj,
          scaleX: newScaleX,
          scaleY: newScaleY,
          offsetX: newOffsetX,
          offsetY: newOffsetY
        };
      });

      setObjects(arranged);
      setSlicingStats(null);
      setRawSlicedPaths([]);
      setStatusMsg(`Arranged ${N} designs compactly near home with ${spacing}mm safety spacing.`);
    } finally {
      setLoadingText(null);
    }
  };

  const handleSlice = async () => {
    const combinedPaths = getProcessedToolpaths();
    if (combinedPaths.length === 0) return;

    setLoadingText("Slicing & Optimizing Toolpaths...");
    // Wait for React to render loading overlay
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      setStatusMsg("Slicing and optimizing toolpath...");
      
      // Separate fills and outlines
      const fillPaths = combinedPaths.filter(p => p.isFill);
      const outlinePaths = combinedPaths.filter(p => !p.isFill);

      const optimizePathsNN = (paths: Toolpath[], startPoint: Point): { optimized: Toolpath[], endPoint: Point } => {
        const unvisited = [...paths];
        const optimized: Toolpath[] = [];
        let currPos = { ...startPoint };

        while (unvisited.length > 0) {
          let minSqDist = Infinity;
          let bestIdx = 0;
          let shouldReverse = false;

          for (let i = 0; i < unvisited.length; i++) {
            const path = unvisited[i];
            if (path.points.length === 0) continue;
            const startPt = path.points[0];
            const endPt = path.points[path.points.length - 1];
            
            const dxStart = startPt.x - currPos.x;
            const dyStart = startPt.y - currPos.y;
            const dStartSq = dxStart * dxStart + dyStart * dyStart;

            const dxEnd = endPt.x - currPos.x;
            const dyEnd = endPt.y - currPos.y;
            const dEndSq = dxEnd * dxEnd + dyEnd * dyEnd;

            if (dStartSq < minSqDist) {
              minSqDist = dStartSq;
              bestIdx = i;
              shouldReverse = false;
            }
            if (dEndSq < minSqDist) {
              minSqDist = dEndSq;
              bestIdx = i;
              shouldReverse = true;
            }
          }

          const nextPath = unvisited[bestIdx];
          // Swap with last and pop for O(1) removal
          unvisited[bestIdx] = unvisited[unvisited.length - 1];
          unvisited.pop();

          if (shouldReverse) {
            nextPath.points.reverse();
          }
          
          currPos = nextPath.points[nextPath.points.length - 1];
          optimized.push(nextPath);
        }

        return { optimized, endPoint: currPos };
      };

      // Optimize fills first, starting from origin (0, 0)
      const fillsResult = optimizePathsNN(fillPaths, { x: 0, y: 0 });

      // Optimize outlines second, starting from where the fills ended
      const outlinesResult = optimizePathsNN(outlinePaths, fillsResult.endPoint);

      const optimizedPaths = [...fillsResult.optimized, ...outlinesResult.optimized];

      setRawSlicedPaths(optimizedPaths);

      // Auto-position the priming line relative to new sliced design boundaries
      const bounds = getCombinedObjectsBounds();
      if (bounds) {
        if (primingDirection === "vertical") {
          let targetX = bounds.minX - 8;
          if (targetX < margin) {
            targetX = bounds.maxX + 8;
            if (targetX > scaleWidth - margin) {
              targetX = margin;
            }
          }
          let targetY = bounds.minY;
          if (targetY < margin) targetY = margin;
          if (targetY + primingLength > scaleHeight - margin) {
            targetY = Math.max(margin, scaleHeight - margin - primingLength);
          }
          setPrimingStartX(parseFloat(targetX.toFixed(1)));
          setPrimingStartY(parseFloat(targetY.toFixed(1)));
        } else {
          let targetY = bounds.maxY + 8;
          if (targetY > scaleHeight - margin) {
            targetY = bounds.minY - 8;
            if (targetY < margin) {
              targetY = margin;
            }
          }
          let targetX = bounds.minX;
          if (targetX < margin) targetX = margin;
          if (targetX + primingLength > scaleWidth - margin) {
            targetX = Math.max(margin, scaleWidth - margin - primingLength);
          }
          setPrimingStartX(parseFloat(targetX.toFixed(1)));
          setPrimingStartY(parseFloat(targetY.toFixed(1)));
        }
      }

      setActiveTab("preview");
      setStatusMsg("Toolpath sliced and optimized successfully!");
    } finally {
      setLoadingText(null);
    }
  };

  const handleAutoPositionPriming = () => {
    const bounds = getCombinedObjectsBounds();
    if (!bounds) {
      setStatusMsg("No designs loaded on the bed to align priming line.");
      return;
    }

    if (primingDirection === "vertical") {
      // Try to place to the left first
      let targetX = bounds.minX - 8;
      if (targetX < margin) {
        // If not enough space on the left, place to the right
        targetX = bounds.maxX + 8;
        if (targetX > scaleWidth - margin) {
          // If no space on right either, default to margin
          targetX = margin;
        }
      }
      
      // Align Y with the top of the design boundary, clamping it to fit the length
      let targetY = bounds.minY;
      if (targetY < margin) targetY = margin;
      if (targetY + primingLength > scaleHeight - margin) {
        targetY = Math.max(margin, scaleHeight - margin - primingLength);
      }
      
      setPrimingStartX(parseFloat(targetX.toFixed(1)));
      setPrimingStartY(parseFloat(targetY.toFixed(1)));
      setStatusMsg(`Aligned vertical priming line near design bounds: X=${targetX.toFixed(1)}mm`);
    } else {
      // Try to place below the design first
      let targetY = bounds.maxY + 8;
      if (targetY > scaleHeight - margin) {
        // If not enough space below, place above
        targetY = bounds.minY - 8;
        if (targetY < margin) {
          // If no space above either, default to margin
          targetY = margin;
        }
      }
      
      // Align X with the left of the design boundary, clamping it to fit the length
      let targetX = bounds.minX;
      if (targetX < margin) targetX = margin;
      if (targetX + primingLength > scaleWidth - margin) {
        targetX = Math.max(margin, scaleWidth - margin - primingLength);
      }
      
      setPrimingStartX(parseFloat(targetX.toFixed(1)));
      setPrimingStartY(parseFloat(targetY.toFixed(1)));
      setStatusMsg(`Aligned horizontal priming line near design bounds: Y=${targetY.toFixed(1)}mm`);
    }
  };

  const handleConsoleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingConsole(true);
  };



  // Prepare Panning Handlers
  const handlePrepareMouseDown = (e: React.MouseEvent) => {
    // Only pan on middle-click (button 1) to avoid conflicts with left-click design movements
    if (e.button !== 1) return;

    e.preventDefault(); // Block browser's default autoscroll behavior

    setIsPanningPrepare(true);
    setPanStart({
      x: e.clientX,
      y: e.clientY,
      scrollLeft: prepareScrollContainerRef.current?.scrollLeft || 0,
      scrollTop: prepareScrollContainerRef.current?.scrollTop || 0
    });
  };

  const handlePrepareMouseMove = (e: React.MouseEvent) => {
    if (!isPanningPrepare || !prepareScrollContainerRef.current) return;
    e.preventDefault();
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    prepareScrollContainerRef.current.scrollLeft = panStart.scrollLeft - dx;
    prepareScrollContainerRef.current.scrollTop = panStart.scrollTop - dy;
  };

  const handlePrepareMouseUp = () => {
    setIsPanningPrepare(false);
  };

  // Monitor Panning Handlers
  const handleMonitorMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
    }
    setIsPanningMonitor(true);
    setPanStartMonitor({
      x: e.clientX,
      y: e.clientY,
      scrollLeft: monitorCanvasContainerRef.current?.scrollLeft || 0,
      scrollTop: monitorCanvasContainerRef.current?.scrollTop || 0
    });
  };

  const handleMonitorMouseMove = (e: React.MouseEvent) => {
    if (!isPanningMonitor || !monitorCanvasContainerRef.current) return;
    e.preventDefault();
    const dx = e.clientX - panStartMonitor.x;
    const dy = e.clientY - panStartMonitor.y;
    monitorCanvasContainerRef.current.scrollLeft = panStartMonitor.scrollLeft - dx;
    monitorCanvasContainerRef.current.scrollTop = panStartMonitor.scrollTop - dy;
  };

  const handleMonitorMouseUp = () => {
    setIsPanningMonitor(false);
  };

  const handleCenterMonitorView = () => {
    setMonitorZoom(1.0);
    setTimeout(() => {
      if (monitorCanvasContainerRef.current) {
        const container = monitorCanvasContainerRef.current;
        container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2;
        container.scrollTop = (container.scrollHeight - container.clientHeight) / 2;
      }
    }, 50);
  };

  const updateHomeTimestamp = () => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setHomeSetTimestamp(timeStr);
  };

  const handleCopy = () => {
    if (activeTab === "preview" || activeTab === "monitor") return;
    const selected = objects.find(o => o.id === selectedObjectId);
    if (selected) {
      setClipboard(selected);
      setStatusMsg(`Copied: ${selected.name}`);
    }
  };

  const handleCut = () => {
    if (activeTab === "preview" || activeTab === "monitor") return;
    const selected = objects.find(o => o.id === selectedObjectId);
    if (selected) {
      setClipboard(selected);
      setObjects(prev => prev.filter(o => o.id !== selected.id));
      setSelectedObjectIds([]);
      setSlicingStats(null);
      setStatusMsg(`Cut: ${selected.name}`);
    }
  };

  const handlePaste = () => {
    if (activeTab === "preview" || activeTab === "monitor") return;
    if (clipboard) {
      const newId = `obj-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      let finalName = clipboard.name;
      const extIdx = finalName.lastIndexOf(".");
      const base = extIdx !== -1 ? finalName.substring(0, extIdx) : finalName;
      const ext = extIdx !== -1 ? finalName.substring(extIdx) : "";
      
      const cleanBase = base.replace(/\s\(\d+\)$/, "").replace(/\s-\sCopy$/, "");
      
      let count = 1;
      let checkName = `${cleanBase} - Copy${ext}`;
      while (objects.some(o => o.name === checkName)) {
        checkName = `${cleanBase} - Copy (${count})${ext}`;
        count++;
      }

      const pasted: SlicerObject = {
        ...clipboard,
        id: newId,
        name: checkName,
        offsetX: clipboard.offsetX + 10,
        offsetY: clipboard.offsetY + 10,
      };

      setObjects(prev => [...prev, pasted]);
      setSelectedObjectIds([newId]);
      setSlicingStats(null);
      setStatusMsg(`Pasted: ${checkName}`);
    }
  };

  // Sync input text states when selected object changes
  useEffect(() => {
    if (selectedObjectId === "template-object") {
      setInputScaleText(templateScale.toString());
      setInputRotationText(templateRotation.toString());
      setInputWidthText("");
      setInputHeightText("");
    } else {
      const selected = objects.find(o => o.id === selectedObjectId);
      if (selected) {
        setInputScaleText(selected.scaleX.toString());
        setInputRotationText(selected.rotation.toString());
        
        const bounds = getUnrotatedObjectBounds(selected);
        if (bounds) {
          const rawW = bounds.maxX - bounds.minX;
          const rawH = bounds.maxY - bounds.minY;
          const currentW = rawW * (selected.scaleX / 100);
          const currentH = rawH * (selected.scaleY / 100);
          setInputWidthText(currentW.toFixed(1));
          setInputHeightText(currentH.toFixed(1));
        } else {
          setInputWidthText("");
          setInputHeightText("");
        }
      } else {
        setInputScaleText("");
        setInputRotationText("");
        setInputWidthText("");
        setInputHeightText("");
      }
    }
  }, [selectedObjectId, objects, templateScale, templateRotation]);

  // Prevent default drag-and-drop behavior globally to avoid window navigation
  useEffect(() => {
    const preventDefault = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", preventDefault);
    window.addEventListener("drop", preventDefault);
    return () => {
      window.removeEventListener("dragover", preventDefault);
      window.removeEventListener("drop", preventDefault);
    };
  }, []);

  // Global error listener to display console/runtime errors right in the statusMsg
  useEffect(() => {
    const handleError = (e: ErrorEvent) => {
      setStatusMsg(`App Error: ${e.message}`);
      setConsoleLogs(prev => [...prev, `App Error: ${e.message} at ${e.filename}:${e.lineno}`]);
    };
    window.addEventListener("error", handleError);
    return () => {
      window.removeEventListener("error", handleError);
    };
  }, []);

  // Keyboard Shortcuts Hook
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeTab === "preview" || activeTab === "monitor") return;

      const activeEl = document.activeElement?.tagName.toLowerCase();
      if (activeEl === "input" || activeEl === "select" || activeEl === "textarea") {
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "c") {
          e.preventDefault();
          handleCopy();
        } else if (e.key.toLowerCase() === "v") {
          e.preventDefault();
          handlePaste();
        } else if (e.key.toLowerCase() === "x") {
          e.preventDefault();
          handleCut();
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedObjectIds.length > 0) {
          e.preventDefault();
          if (selectedObjectIds.includes("template-object")) {
            setTemplateImage(null);
            setSelectedObjectIds([]);
            setStatusMsg("Template removed");
          } else {
            setObjects(prev => prev.filter(o => !selectedObjectIds.includes(o.id)));
            setSelectedObjectIds([]);
            setSlicingStats(null);
            setStatusMsg("Deleted selected objects");
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [objects, selectedObjectIds, clipboard, activeTab]);



  // Autoscroll monitor console
  useEffect(() => {
    if (consoleContainerRef.current) {
      consoleContainerRef.current.scrollTop = consoleContainerRef.current.scrollHeight;
    }
  }, [consoleLogs]);

  // Drag-to-resize EBB logs console widget height
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingConsole && consoleCardRef.current) {
        const top = consoleCardRef.current.getBoundingClientRect().top;
        const newHeight = Math.max(150, e.clientY - top - 30);
        setConsoleHeight(newHeight);
      }
    };
    const handleMouseUp = () => {
      setIsResizingConsole(false);
    };

    if (isResizingConsole) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizingConsole]);

  // Slicing parameters dynamic estimation re-calculation in real-time
  useEffect(() => {
    if (slicedPaths.length === 0) {
      setSlicingStats(null);
      return;
    }

    let currPos: Point = { x: 0, y: 0 };
    let drawDist = 0;
    let airDist = 0;
    let numLifts = 0;

    slicedPaths.forEach((path) => {
      if (path.points.length === 0) return;
      
      // Air travel
      airDist += Math.hypot(path.points[0].x - currPos.x, path.points[0].y - currPos.y);
      numLifts += 1;

      // Draw distance
      for (let i = 1; i < path.points.length; i++) {
        drawDist += Math.hypot(path.points[i].x - path.points[i-1].x, path.points[i].y - path.points[i-1].y);
      }

      currPos = path.points[path.points.length - 1];
    });

    airDist += Math.hypot(0 - currPos.x, 0 - currPos.y);

    // Speed override factor applied
    const activePlotSpeed = ebbSpeed * (speedMultiplier / 100);
    const activeAirSpeed = airSpeed * (speedMultiplier / 100);
    
    const airTimeEst = airDist / activeAirSpeed;
    const timeEst = (drawDist / activePlotSpeed) + airTimeEst + (numLifts * penDelay * 2 / 1000);
    const totalPts = slicedPaths.reduce((sum, p) => sum + p.points.length, 0);

    setSlicingStats({ drawDist, airDist, numLifts, timeEst, airTimeEst });
    setSimulatedPointsCount(totalPts);
  }, [slicedPaths, ebbSpeed, airSpeed, penDelay, speedMultiplier]);

  // Scan serial ports on mount
  useEffect(() => {
    scanPorts();
  }, []);

  // Load recovery session on startup if present
  useEffect(() => {
    try {
      const saved = localStorage.getItem("axidraw_recovery_session");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.progress && parsed.progress.global_point_index > 0) {
          setRecoverySession(parsed);
        }
      }
    } catch (e) {
      console.error("Error reading recovery session:", e);
    }
  }, []);

  // Synchronize hatch spacing with active pen profile tip size
  useEffect(() => {
    const profile = penProfiles.find(p => p.id === activeProfileId);
    if (profile && profile.tipSizeMm !== undefined) {
      setSvgHatchSpacing(profile.tipSizeMm);
      setLocalHatchSpacing(profile.tipSizeMm);
    }
  }, [activeProfileId, penProfiles]);

  // Set default inversions based on origin selection
  useEffect(() => {
    if (originCorner === "top-right") {
      setInvertX(true);
      setInvertY(true);
    } else {
      setInvertX(false);
      setInvertY(false);
    }
  }, [originCorner]);

  // Listen to Tauri events for plotting progress, console logging, and Inkscape imports
  useEffect(() => {
    let active = true;
    let unlistenProgress: (() => void) | null = null;
    let unlistenFinished: (() => void) | null = null;
    let unlistenInkscape: (() => void) | null = null;
    let unlistenLog: (() => void) | null = null;

    listen<ProgressPayload>("plot-progress", (event) => {
      setCurrentPos({ x: event.payload.x, y: event.payload.y });

      if (isPlottingRef.current) {
        setProgress(event.payload);

        const payload = event.payload;
        const elapsed = jobStartTimeRef.current ? Math.round((Date.now() - jobStartTimeRef.current) / 1000) : 0;
        const totalPoints = payload.total_points > 0 ? payload.total_points : 1;
        const ratio = payload.global_point_index / totalPoints;
        
        const drawM = slicingStatsRef.current ? (slicingStatsRef.current.drawDist * ratio) / 1000.0 : 0.0;
        lastDistanceDrawnRef.current = drawM;
        const travelM = slicingStatsRef.current ? (slicingStatsRef.current.airDist * ratio) / 1000.0 : 0.0;
        const remaining = slicingStatsRef.current ? Math.max(0, Math.round(slicingStatsRef.current.timeEst - elapsed)) : 0;
        const airTravelSecs = slicingStatsRef.current ? slicingStatsRef.current.airTimeEst * ratio : 0.0;

        const updatedStats = {
          status: (isPausedRef.current ? "paused" : "printing") as any,
          pointsCompleted: payload.global_point_index,
          totalPoints: payload.total_points,
          pathsCompleted: payload.path_index,
          totalPaths: slicedPathsRef.current.length,
          distanceDrawn: parseFloat(drawM.toFixed(2)),
          distanceTraveled: parseFloat(travelM.toFixed(2)),
          elapsedTime: elapsed,
          estimatedRemaining: remaining,
          airTravelTime: Math.round(airTravelSecs)
        };

        setJobStats(updatedStats);

        // Save recovery session for real jobs
        if (jobStartTimeRef.current) {
          const recoveryData = {
            objects: objectsRef.current,
            slicedPaths: slicedPathsRef.current,
            slicingStats: slicingStatsRef.current,
            jobStats: updatedStats,
            progress: payload,
            activeProfileId: activeProfileIdRef.current,
            timestamp: Date.now()
          };
          localStorage.setItem("axidraw_recovery_session", JSON.stringify(recoveryData));
        }
      }
    }).then((fn) => {
      if (!active) fn();
      else unlistenProgress = fn;
    });

    listen<string>("ebb-log", (event) => {
      setConsoleLogs(prev => [...prev.slice(-99), event.payload]);
    }).then((fn) => {
      if (!active) fn();
      else unlistenLog = fn;
    });

    listen<boolean>("plot-finished", (event) => {
      const aborted = event.payload;
      setIsPlotting(false);
      setIsPaused(false);
      setProgress(null);
      setCurrentPos({ x: 0, y: 0 });
      setIsPenDown(false);
      setTracingBoundary(null);
      setStatusMsg(aborted ? "Job Aborted" : "Job Finished");

      setJobStats((prev) => {
        return {
          ...prev,
          status: aborted ? "aborted" : "completed"
        };
      });
      
      const wasRealJob = jobStartTimeRef.current !== null;

      // Clear recovery session state on completion or abort
      if (wasRealJob) {
        localStorage.removeItem("axidraw_recovery_session");
      }

      // Calculate elapsed time and open completion screen only if not aborted
      if (!aborted && jobStartTimeRef.current) {
        const elapsed = Math.round((Date.now() - jobStartTimeRef.current) / 1000);
        setActualElapsedSeconds(elapsed);
        setShowFinishedModal(true);
      }
      setJobStartTime(null);

      // Add to job history list only for real plot jobs
      if (wasRealJob && addToJobHistoryRef.current) {
        addToJobHistoryRef.current(aborted);
      }

      // Update pen profiles distance tracker upon job completion/abort based on actual net drawn distance
      if (wasRealJob) {
        const netDrawnMeters = Math.max(0, lastDistanceDrawnRef.current - initialDrawnMetersOfRunRef.current);
        if (netDrawnMeters > 0) {
          setPenProfiles(prev => prev.map(p => {
            if (p.id === activeProfileIdRef.current) {
              return {
                ...p,
                accumulatedDistanceMeters: p.accumulatedDistanceMeters + netDrawnMeters
              };
            }
            return p;
          }));
        }
      }
    }).then((fn) => {
      if (!active) fn();
      else unlistenFinished = fn;
    });

    listen<string>("inkscape-import", (event) => {
      const svgText = event.payload;
      try {
        const parsed = parseSVG(
          svgText, 
          scaleWidthRef.current, 
          scaleHeightRef.current, 
          svgHatchSpacingRef.current, 
          enableSvgHatchingRef.current,
          svgHatchStyleRef.current,
          svgHatchAngleRef.current,
          svgCrossHatchRef.current
        );
        setObjects((prev) => {
          const newObj: SlicerObject = {
            id: `obj-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            name: `Inkscape Import ${prev.length + 1}`,
            rawPaths: parsed,
            offsetX: 0,
            offsetY: 0,
            scaleX: 100,
            scaleY: 100,
            rotation: 0,
            svgText: svgText
          };
          setTimeout(() => setSelectedObjectIds([newObj.id]), 0);
          return [...prev, newObj];
        });
        setFileType("svg");
        setProgress(null);
        setSlicingStats(null); // Force re-slice
        setActiveTab("prepare");
        setStatusMsg("Imported SVG object from Inkscape");
      } catch (err: any) {
        console.error("Failed to parse imported SVG:", err);
        setStatusMsg(`Import Error: ${err.message}`);
      }
    }).then((fn) => {
      if (!active) fn();
      else unlistenInkscape = fn;
    });

    return () => {
      active = false;
      if (unlistenProgress) unlistenProgress();
      if (unlistenFinished) unlistenFinished();
      if (unlistenInkscape) unlistenInkscape();
      if (unlistenLog) unlistenLog();
    };
  }, []);

  useEffect(() => {
    renderCanvas();
  }, [
    objects, progress, scaleWidth, scaleHeight, margin, selectedObjectIds, activeTab,
    simulatedPointsCount, originCorner, currentPos, invertX, invertY, zoom, connected,
    templateImage, templateOpacity, templateScale, templateOffsetX, templateOffsetY, templateRotation, isTemplateLocked,
    enablePrimingLine, primingStartX, primingStartY, primingLength, primingDirection, slicedPaths
  ]);

  // Re-parse SVGs when hatch spacing, style, angle, cross-hatch, or enableSvgHatching changes
  useEffect(() => {
    let active = true;

    const recomputeHatching = async () => {
      setIsCalculatingHatch(true);
      // Wait for React to render loading overlay
      await new Promise((resolve) => setTimeout(resolve, 50));

      if (!active) return;

      try {
        const updated = objectsRef.current.map(obj => {
          if (obj.svgText && !obj.isMonoline) {
            const parsed = parseSVG(
              obj.svgText, 
              scaleWidth, 
              scaleHeight, 
              svgHatchSpacing, 
              enableSvgHatching,
              svgHatchStyle,
              svgHatchAngle,
              svgCrossHatch
            );
            return {
              ...obj,
              rawPaths: parsed
            };
          }
          return obj;
        });

        if (active) {
          setObjects(updated);
          setSlicingStats(null);
          setRawSlicedPaths([]);
        }
      } catch (err) {
        console.error("Failed to re-parse SVG:", err);
      } finally {
        if (active) {
          setIsCalculatingHatch(false);
        }
      }
    };

    recomputeHatching();

    return () => {
      active = false;
    };
  }, [svgHatchSpacing, enableSvgHatching, svgHatchStyle, svgHatchAngle, svgCrossHatch, scaleWidth, scaleHeight]);

  // Redirect to Prepare tab if plotter disconnects while in Monitor tab
  useEffect(() => {
    if (!connected && activeTab === "monitor") {
      setActiveTab("prepare");
      setStatusMsg("Disconnected: Monitor tab closed");
    }
  }, [connected, activeTab]);

  // Instant priming line update effect to prevent UI freeze
  useEffect(() => {
    if (rawSlicedPaths.length === 0) {
      setSlicedPaths([]);
      return;
    }
    if (enablePrimingLine) {
      const endX = primingDirection === "horizontal" ? (primingStartX + primingLength) : primingStartX;
      const endY = primingDirection === "vertical" ? (primingStartY + primingLength) : primingStartY;
      
      const primingPath: Toolpath = {
        points: [
          { x: primingStartX, y: primingStartY },
          { x: endX, y: endY }
        ]
      };
      setSlicedPaths([primingPath, ...rawSlicedPaths]);
    } else {
      setSlicedPaths(rawSlicedPaths);
    }
  }, [rawSlicedPaths, enablePrimingLine, primingStartX, primingStartY, primingLength, primingDirection]);

  // Draw on monitor canvas (live print dashboard visualizer - Fluidd style)
  useEffect(() => {
    const canvas = monitorCanvasRef.current;
    if (!canvas || activeTab !== "monitor") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const mHeight = canvas.height;
    const mWidth = canvas.width;
    
    // Draw background sheet with clean borders
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, mWidth, mHeight);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.1)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, mWidth, mHeight);

    const mScaleX = mWidth / scaleWidth;
    const mScaleY = mHeight / scaleHeight;

    // Draw background template image if loaded
    if (templateImage) {
      ctx.save();
      ctx.globalAlpha = templateOpacity / 100;
      const bounds = getTemplateBounds();
      if (bounds) {
        const cx = bounds.minX + bounds.width / 2;
        const cy = bounds.minY + bounds.height / 2;

        ctx.translate(cx * mScaleX, cy * mScaleY);
        ctx.rotate((templateRotation * Math.PI) / 180);
        ctx.drawImage(
          templateImage, 
          -bounds.width / 2 * mScaleX, 
          -bounds.height / 2 * mScaleY, 
          bounds.width * mScaleX, 
          bounds.height * mScaleY
        );
      }
      ctx.restore();
    }

    const processed = slicedPaths.length > 0 ? slicedPaths : getProcessedToolpaths();

    processed.forEach((path, pathIdx) => {
      if (path.points.length < 2) return;

      const isPathCompleted = progress && pathIdx < progress.path_index;
      const isPathCurrent = progress && pathIdx === progress.path_index;

      if (isPathCompleted) {
        // Draw solid completed path
        ctx.beginPath();
        ctx.moveTo(path.points[0].x * mScaleX, path.points[0].y * mScaleY);
        for (let i = 1; i < path.points.length; i++) {
          ctx.lineTo(path.points[i].x * mScaleX, path.points[i].y * mScaleY);
        }
        ctx.strokeStyle = "rgba(99, 102, 241, 0.95)"; // Solid indigo
        ctx.lineWidth = 1.6;
        ctx.stroke();
      } else if (isPathCurrent) {
        // Draw current path: completed part is solid, future part is light
        const currentPtIdx = Math.min(progress.point_index, path.points.length - 1);
        
        if (currentPtIdx > 0) {
          ctx.beginPath();
          ctx.moveTo(path.points[0].x * mScaleX, path.points[0].y * mScaleY);
          for (let i = 1; i <= currentPtIdx; i++) {
            ctx.lineTo(path.points[i].x * mScaleX, path.points[i].y * mScaleY);
          }
          ctx.strokeStyle = "rgba(99, 102, 241, 0.95)";
          ctx.lineWidth = 1.8;
          ctx.stroke();
        }

        if (showFuturePath && currentPtIdx < path.points.length - 1) {
          ctx.beginPath();
          ctx.moveTo(path.points[currentPtIdx].x * mScaleX, path.points[currentPtIdx].y * mScaleY);
          for (let i = currentPtIdx + 1; i < path.points.length; i++) {
            ctx.lineTo(path.points[i].x * mScaleX, path.points[i].y * mScaleY);
          }
          ctx.strokeStyle = "rgba(99, 102, 241, 0.18)"; // Light opacity
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      } else {
        // Future path - show ONLY the immediate next path to be drawn
        const isNextPath = progress 
          ? (pathIdx === progress.path_index + 1)
          : (pathIdx === 0);

        if (showFuturePath && isNextPath) {
          ctx.beginPath();
          ctx.moveTo(path.points[0].x * mScaleX, path.points[0].y * mScaleY);
          for (let i = 1; i < path.points.length; i++) {
            ctx.lineTo(path.points[i].x * mScaleX, path.points[i].y * mScaleY);
          }
          ctx.strokeStyle = "rgba(99, 102, 241, 0.45)"; // slightly higher opacity for clarity since it's just one path
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
    });

    // Draw current pen tip position
    const renderX = invertX ? (scaleWidth - currentPos.x) : currentPos.x;
    const renderY = invertY ? (scaleHeight - currentPos.y) : currentPos.y;

    ctx.beginPath();
    ctx.arc(renderX * mScaleX, renderY * mScaleY, 5, 0, 2 * Math.PI);
    ctx.fillStyle = "#ef4444";
    ctx.shadowColor = "#ef4444";
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(renderX * mScaleX, renderY * mScaleY, 1.5, 0, 2 * Math.PI);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    // Crosshairs
    ctx.beginPath();
    ctx.moveTo((renderX - 8) * mScaleX, renderY * mScaleY);
    ctx.lineTo((renderX + 8) * mScaleX, renderY * mScaleY);
    ctx.moveTo(renderX * mScaleX, (renderY - 8) * mScaleY);
    ctx.lineTo(renderX * mScaleX, (renderY + 8) * mScaleY);
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1.0;
    ctx.stroke();
  }, [progress, currentPos, scaleWidth, scaleHeight, activeTab, objects, showFuturePath, invertX, invertY, slicedPaths, monitorZoom, connected, templateImage, templateOpacity, templateScale, templateOffsetX, templateOffsetY, templateRotation]);

  // Update pen heights on EBB dynamically when connected
  useEffect(() => {
    if (connected) {
      invoke("configure_pen_heights", { upHeight: penUpHeight, downHeight: penDownHeight })
        .catch((err) => console.error("Failed to configure pen heights:", err));
    }
  }, [connected, penUpHeight, penDownHeight]);

  const scanPorts = async () => {
    try {
      const availablePorts: SerialPortDetails[] = await invoke("list_serial_ports");
      setPorts(availablePorts);
      
      const axidraw = availablePorts.find(p => p.is_axidraw);
      if (axidraw) {
        setSelectedPort(axidraw.port_name);
        setStatusMsg(`Detected AxiDraw on ${axidraw.port_name}! Ready to Connect.`);
      } else if (availablePorts.length > 0 && !selectedPort) {
        setSelectedPort(availablePorts[0].port_name);
      }
    } catch (err) {
      console.error("Failed to list serial ports:", err);
    }
  };

  // Submit manual EBB Command from Console
  const handleSendManualCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCommandText.trim()) return;
    try {
      await invoke("send_manual_ebb_command", { cmd: manualCommandText.trim() });
      setManualCommandText("");
    } catch (err: any) {
      setConsoleLogs(prev => [...prev, `Error: ${err}`]);
    }
  };

  // Draw on canvas
  const renderCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const dpiScale = 2 * zoom;
    const scaledPadding = CANVAS_PADDING * dpiScale;

    // Apply visual margins inside the canvas to prevent cursor clipping at edges
    const scaleX = (canvas.width - scaledPadding * 2) / scaleWidth;
    const scaleY = (canvas.height - scaledPadding * 2) / scaleHeight;

    // Draw sheet background shadow
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    ctx.fillRect(scaledPadding + 4 * dpiScale, scaledPadding + 4 * dpiScale, canvas.width - scaledPadding * 2, canvas.height - scaledPadding * 2);

    // Draw white sheet background representing the bed
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(scaledPadding, scaledPadding, canvas.width - scaledPadding * 2, canvas.height - scaledPadding * 2);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
    ctx.lineWidth = 1 * dpiScale;
    ctx.strokeRect(scaledPadding, scaledPadding, canvas.width - scaledPadding * 2, canvas.height - scaledPadding * 2);

    // Draw background template image if loaded
    if (templateImage) {
      ctx.save();
      ctx.globalAlpha = templateOpacity / 100;
      const bounds = getTemplateBounds();
      if (bounds) {
        const cx = bounds.minX + bounds.width / 2;
        const cy = bounds.minY + bounds.height / 2;

        ctx.translate(scaledPadding + cx * scaleX, scaledPadding + cy * scaleY);
        ctx.rotate((templateRotation * Math.PI) / 180);
        ctx.drawImage(
          templateImage, 
          -bounds.width / 2 * scaleX, 
          -bounds.height / 2 * scaleY, 
          bounds.width * scaleX, 
          bounds.height * scaleY
        );
      }
      ctx.restore();
    }

    // --- DRAW PHYSICAL RULERS (Réglette millimétrée) ---
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    ctx.font = `${6.5 * dpiScale}px monospace`;
    ctx.lineWidth = 1 * dpiScale;

    // 1. Horizontal top ruler (at Y = scaledPadding - 2 * dpiScale)
    const rulerY = scaledPadding - 2 * dpiScale;
    ctx.beginPath();
    ctx.moveTo(scaledPadding, rulerY);
    ctx.lineTo(canvas.width - scaledPadding, rulerY);
    ctx.stroke();

    // Horizontal ticks and text
    for (let gx = 0; gx <= scaleWidth; gx += 10) {
      const x = scaledPadding + gx * scaleX;
      ctx.beginPath();
      if (gx % 50 === 0) {
        // Major tick
        ctx.moveTo(x, rulerY);
        ctx.lineTo(x, rulerY - 6 * dpiScale);
        ctx.stroke();
        
        // Text label
        ctx.textAlign = "center";
        ctx.fillText(`${gx}`, x, rulerY - 8 * dpiScale);
      } else {
        // Minor tick
        ctx.moveTo(x, rulerY);
        ctx.lineTo(x, rulerY - 3 * dpiScale);
        ctx.stroke();
      }
    }

    // 2. Vertical left ruler (at X = scaledPadding - 2 * dpiScale)
    const rulerX = scaledPadding - 2 * dpiScale;
    ctx.beginPath();
    ctx.moveTo(rulerX, scaledPadding);
    ctx.lineTo(rulerX, canvas.height - scaledPadding);
    ctx.stroke();

    // Vertical ticks and text
    for (let gy = 0; gy <= scaleHeight; gy += 10) {
      const y = scaledPadding + gy * scaleY;
      ctx.beginPath();
      if (gy % 50 === 0) {
        // Major tick
        ctx.moveTo(rulerX, y);
        ctx.lineTo(rulerX - 6 * dpiScale, y);
        ctx.stroke();
        
        // Text label
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(`${gy}`, rulerX - 8 * dpiScale, y);
      } else {
        // Minor tick
        ctx.moveTo(rulerX, y);
        ctx.lineTo(rulerX - 3 * dpiScale, y);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Draw grid marks inside the bed boundaries
    // 10mm grid lines (ultra faint)
    ctx.strokeStyle = "rgba(0, 0, 0, 0.015)";
    ctx.lineWidth = 0.5 * dpiScale;
    for (let gx = 10; gx < scaleWidth; gx += 10) {
      if (gx % 50 === 0) continue; // Skip major gridlines
      ctx.beginPath();
      ctx.moveTo(scaledPadding + gx * scaleX, scaledPadding);
      ctx.lineTo(scaledPadding + gx * scaleX, canvas.height - scaledPadding);
      ctx.stroke();
    }
    for (let gy = 10; gy < scaleHeight; gy += 10) {
      if (gy % 50 === 0) continue; // Skip major gridlines
      ctx.beginPath();
      ctx.moveTo(scaledPadding, scaledPadding + gy * scaleY);
      ctx.lineTo(canvas.width - scaledPadding, scaledPadding + gy * scaleY);
      ctx.stroke();
    }

    // 50mm grid lines (faint)
    ctx.strokeStyle = "rgba(0, 0, 0, 0.05)";
    ctx.lineWidth = 1 * dpiScale;
    for (let gx = 50; gx < scaleWidth; gx += 50) {
      ctx.beginPath();
      ctx.moveTo(scaledPadding + gx * scaleX, scaledPadding);
      ctx.lineTo(scaledPadding + gx * scaleX, canvas.height - scaledPadding);
      ctx.stroke();
    }
    for (let gy = 50; gy < scaleHeight; gy += 50) {
      ctx.beginPath();
      ctx.moveTo(scaledPadding, scaledPadding + gy * scaleY);
      ctx.lineTo(canvas.width - scaledPadding, scaledPadding + gy * scaleY);
      ctx.stroke();
    }

    // Draw Priming Line guide if enabled
    if (enablePrimingLine) {
      const endX = primingDirection === "horizontal" ? (primingStartX + primingLength) : primingStartX;
      const endY = primingDirection === "vertical" ? (primingStartY + primingLength) : primingStartY;
      
      ctx.beginPath();
      ctx.moveTo(scaledPadding + primingStartX * scaleX, scaledPadding + primingStartY * scaleY);
      ctx.lineTo(scaledPadding + endX * scaleX, scaledPadding + endY * scaleY);
      ctx.strokeStyle = "rgba(16, 185, 129, 0.65)"; // Greenish color
      ctx.lineWidth = 2 * dpiScale;
      ctx.setLineDash([4 * dpiScale, 3 * dpiScale]);
      ctx.stroke();
      ctx.setLineDash([]);
      
      // Small label next to it
      ctx.fillStyle = "rgba(16, 185, 129, 0.9)";
      ctx.font = `bold ${8 * dpiScale}px sans-serif`;
      ctx.fillText(
        "PRIMING LINE", 
        scaledPadding + (Math.max(primingStartX, endX) + 4) * scaleX, 
        scaledPadding + (Math.min(primingStartY, endY) + 6) * scaleY
      );
    }

    // Safety margin box inside bed boundaries
    if (margin > 0) {
      ctx.strokeStyle = "rgba(255, 0, 0, 0.15)";
      ctx.lineWidth = 1 * dpiScale;
      ctx.strokeRect(
        scaledPadding + margin * scaleX,
        scaledPadding + margin * scaleY,
        (scaleWidth - margin * 2) * scaleX,
        (scaleHeight - margin * 2) * scaleY
      );
    }

    // Draw toolpaths (using sliced NN-optimized paths in Preview Tab, processed in Prepare)
    const processed = activeTab === "preview" && slicedPaths.length > 0 ? slicedPaths : getProcessedToolpaths();
    
    // Smooth point-by-point filtering based on simulatedPointsCount
    let pathsToDraw: Toolpath[] = [];
    let remainingPoints = simulatedPointsCount !== null ? simulatedPointsCount : Infinity;

    if (activeTab === "preview" && simulatedPointsCount !== null) {
      for (const path of processed) {
        if (remainingPoints <= 0) break;
        if (path.points.length <= remainingPoints) {
          pathsToDraw.push(path);
          remainingPoints -= path.points.length;
        } else {
          // Slice the current path
          const slicedPoints = path.points.slice(0, remainingPoints);
          pathsToDraw.push({ points: slicedPoints });
          remainingPoints = 0;
        }
      }
    } else {
      pathsToDraw = processed;
    }

    pathsToDraw.forEach((path, pathIdx) => {
      if (path.points.length < 2) return;

      // Draw dashed yellow travel lines in Preview Tab
      if (activeTab === "preview" && pathIdx > 0) {
        const prevPath = pathsToDraw[pathIdx - 1];
        if (prevPath.points.length > 0 && path.points.length > 0) {
          ctx.beginPath();
          ctx.moveTo(scaledPadding + prevPath.points[prevPath.points.length - 1].x * scaleX, scaledPadding + prevPath.points[prevPath.points.length - 1].y * scaleY);
          ctx.lineTo(scaledPadding + path.points[0].x * scaleX, scaledPadding + path.points[0].y * scaleY);
          
          ctx.strokeStyle = "rgba(234, 179, 8, 0.45)"; // yellow for travel
          ctx.setLineDash([4 * 2, 4 * 2]);
          ctx.lineWidth = 1 * 2;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      ctx.beginPath();
      ctx.moveTo(scaledPadding + path.points[0].x * scaleX, scaledPadding + path.points[0].y * scaleY);
      
      for (let i = 1; i < path.points.length; i++) {
        ctx.lineTo(scaledPadding + path.points[i].x * scaleX, scaledPadding + path.points[i].y * scaleY);
      }

      if (simulatePenWidth) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        
        if (progress && pathIdx < progress.path_index) {
          ctx.strokeStyle = "rgba(99, 102, 241, 0.85)"; // Drawn segments (Indigo)
          ctx.lineWidth = svgHatchSpacing * scaleX;
        } else if (progress && pathIdx === progress.path_index) {
          ctx.strokeStyle = "rgba(99, 102, 241, 0.85)";
          ctx.lineWidth = svgHatchSpacing * scaleX;
          ctx.stroke();
          
          ctx.beginPath();
          const startIdx = Math.min(progress.point_index, path.points.length - 1);
          ctx.moveTo(scaledPadding + path.points[startIdx].x * scaleX, scaledPadding + path.points[startIdx].y * scaleY);
          for (let i = startIdx + 1; i < path.points.length; i++) {
            ctx.lineTo(scaledPadding + path.points[i].x * scaleX, scaledPadding + path.points[i].y * scaleY);
          }
          ctx.strokeStyle = "rgba(0, 0, 0, 0.3)"; // Remaining/undrawn paths of current segment
          ctx.lineWidth = svgHatchSpacing * scaleX;
        } else {
          const isSelected = path.objectId ? selectedObjectIds.includes(path.objectId) : false;
          if (isSelected) {
            ctx.strokeStyle = "rgba(99, 102, 241, 0.95)";
          } else {
            ctx.strokeStyle = activeTab === "preview" ? "rgba(99, 102, 241, 0.65)" : "rgba(0, 0, 0, 0.65)";
          }
          ctx.lineWidth = svgHatchSpacing * scaleX;
        }
      } else {
        ctx.lineCap = "butt";
        ctx.lineJoin = "miter";
        
        const isSelected = path.objectId ? selectedObjectIds.includes(path.objectId) : false;

        if (progress && pathIdx < progress.path_index) {
          ctx.strokeStyle = "rgba(99, 102, 241, 0.8)"; // Indigo drawn
          ctx.lineWidth = 1.5 * 2;
        } else if (progress && pathIdx === progress.path_index) {
          ctx.strokeStyle = "rgba(99, 102, 241, 0.8)";
          ctx.lineWidth = 1.8 * 2;
          ctx.stroke();
          
          ctx.beginPath();
          const startIdx = Math.min(progress.point_index, path.points.length - 1);
          ctx.moveTo(scaledPadding + path.points[startIdx].x * scaleX, scaledPadding + path.points[startIdx].y * scaleY);
          for (let i = startIdx + 1; i < path.points.length; i++) {
            ctx.lineTo(scaledPadding + path.points[i].x * scaleX, scaledPadding + path.points[i].y * scaleY);
          }
          ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
          ctx.lineWidth = 1.0 * 2;
        } else {
          if (isSelected) {
            ctx.strokeStyle = "var(--accent-color)";
            ctx.lineWidth = 2.0 * dpiScale;
          } else {
            ctx.strokeStyle = activeTab === "preview" ? "rgba(99, 102, 241, 0.7)" : "rgba(0, 0, 0, 0.65)";
            ctx.lineWidth = activeTab === "preview" ? 1.4 * 2 : 1.0 * 2;
          }
        }
      }
      ctx.stroke();
    });

    // Draw simulation cursor in Preview Tab
    if (activeTab === "preview" && pathsToDraw.length > 0) {
      const lastPath = pathsToDraw[pathsToDraw.length - 1];
      if (lastPath.points && lastPath.points.length > 0) {
        const simPt = lastPath.points[lastPath.points.length - 1];
        
        ctx.beginPath();
        ctx.arc(scaledPadding + simPt.x * scaleX, scaledPadding + simPt.y * scaleY, 7 * dpiScale, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(12, 15, 18, 0.9)";
        ctx.strokeStyle = "rgba(99, 102, 241, 0.95)";
        ctx.lineWidth = 1.5 * dpiScale;
        ctx.fill();
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(scaledPadding + simPt.x * scaleX, scaledPadding + simPt.y * scaleY, 2 * dpiScale, 0, 2 * Math.PI);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
      }
    }

    // Draw active tracing boundary box
    if (tracingBoundary) {
      ctx.strokeStyle = "rgba(239, 68, 68, 0.85)";
      ctx.lineWidth = 2 * dpiScale;
      ctx.setLineDash([8 * dpiScale, 4 * dpiScale]);
      ctx.strokeRect(
        scaledPadding + tracingBoundary.minX * scaleX,
        scaledPadding + tracingBoundary.minY * scaleY,
        (tracingBoundary.maxX - tracingBoundary.minX) * scaleX,
        (tracingBoundary.maxY - tracingBoundary.minY) * scaleY
      );
      ctx.setLineDash([]);
      
      ctx.fillStyle = "rgba(239, 68, 68, 0.85)";
      ctx.font = `bold ${10 * dpiScale}px sans-serif`;
      ctx.fillText(
        "TRACING AREA", 
        scaledPadding + tracingBoundary.minX * scaleX + 5, 
        scaledPadding + tracingBoundary.minY * scaleY - 5
      );
    }

    // Draw selection borders & Drag/Scale/Rotate handles
    if ((activeTab === "prepare" || activeTab === "preview") && selectedObjectId) {
      const activeObj = objects.find(o => o.id === selectedObjectId);
      if (activeObj) {
        const bounds = getObjectBounds(activeObj);
        if (bounds) {
          // Bounding Box (Uses constant screen size, 2px canvas width = 1px screen width)
          ctx.strokeStyle = "var(--accent-color)";
          ctx.lineWidth = 2; 
          ctx.setLineDash([10, 6]);
          ctx.strokeRect(
            scaledPadding + bounds.minX * scaleX,
            scaledPadding + bounds.minY * scaleY,
            (bounds.maxX - bounds.minX) * scaleX,
            (bounds.maxY - bounds.minY) * scaleY
          );
          ctx.setLineDash([]);

          // Handles only in prepare tab
          if (activeTab === "prepare") {
            // Corner Scale Handle (bottom right) - 10px screen size
            ctx.fillStyle = "#ffffff";
            ctx.strokeStyle = "var(--accent-color)";
            ctx.lineWidth = 3;
            ctx.fillRect(scaledPadding + bounds.maxX * scaleX - 6, scaledPadding + bounds.maxY * scaleY - 6, 12, 12);
            ctx.strokeRect(scaledPadding + bounds.maxX * scaleX - 6, scaledPadding + bounds.maxY * scaleY - 6, 12, 12);

            // Rotate Handle (top middle extended)
            const rotX = (bounds.minX + bounds.maxX) / 2;
            const rotY = bounds.minY - 15;
            ctx.beginPath();
            ctx.moveTo(scaledPadding + rotX * scaleX, scaledPadding + bounds.minY * scaleY);
            ctx.lineTo(scaledPadding + rotX * scaleX, scaledPadding + rotY * scaleY);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(scaledPadding + rotX * scaleX, scaledPadding + rotY * scaleY, 8, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
          }
        }
      }
    }

    // Draw selection outline and handles for template image when selected and not locked
    if ((activeTab === "prepare" || activeTab === "preview") && selectedObjectId === "template-object" && !isTemplateLocked) {
      const bounds = getTemplateBounds();
      if (bounds) {
        ctx.strokeStyle = "var(--accent-color)";
        ctx.lineWidth = 2; 
        ctx.setLineDash([10, 6]);
        
        ctx.save();
        const cx = bounds.minX + bounds.width / 2;
        const cy = bounds.minY + bounds.height / 2;
        ctx.translate(scaledPadding + cx * scaleX, scaledPadding + cy * scaleY);
        ctx.rotate((templateRotation * Math.PI) / 180);
        
        // Draw rectangle boundary
        ctx.strokeRect(-bounds.width / 2 * scaleX, -bounds.height / 2 * scaleY, bounds.width * scaleX, bounds.height * scaleY);
        ctx.setLineDash([]);
        
        if (activeTab === "prepare") {
          // Corner Scale Handle (bottom right)
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "var(--accent-color)";
          ctx.lineWidth = 3;
          ctx.fillRect(bounds.width / 2 * scaleX - 6, bounds.height / 2 * scaleY - 6, 12, 12);
          ctx.strokeRect(bounds.width / 2 * scaleX - 6, bounds.height / 2 * scaleY - 6, 12, 12);

          // Rotate Handle (top middle extended)
          const rotY = -bounds.height / 2 - 15 / scaleY;
          ctx.beginPath();
          ctx.moveTo(0, -bounds.height / 2 * scaleY);
          ctx.lineTo(0, rotY * scaleY);
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(0, rotY * scaleY, 8, 0, 2 * Math.PI);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // Draw Home Origin Target Indicator (permanent CAD-style crosshair visual aid)
    if (activeTab === "prepare") {
      const homeX = invertX ? scaleWidth : 0;
      const homeY = invertY ? scaleHeight : 0;
      
      // Outer hollow ring
      ctx.beginPath();
      ctx.arc(scaledPadding + homeX * scaleX, scaledPadding + homeY * scaleY, 18, 0, 2 * Math.PI);
      ctx.strokeStyle = "var(--accent-color)";
      ctx.lineWidth = 2.0;
      ctx.stroke();

      // Inner hollow ring
      ctx.beginPath();
      ctx.arc(scaledPadding + homeX * scaleX, scaledPadding + homeY * scaleY, 6, 0, 2 * Math.PI);
      ctx.strokeStyle = "var(--accent-color)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Crosshair lines extending across the target
      ctx.beginPath();
      ctx.moveTo(scaledPadding + (homeX - 26) * scaleX, scaledPadding + homeY * scaleY);
      ctx.lineTo(scaledPadding + (homeX + 26) * scaleX, scaledPadding + homeY * scaleY);
      ctx.moveTo(scaledPadding + homeX * scaleX, scaledPadding + (homeY - 26) * scaleY);
      ctx.lineTo(scaledPadding + homeX * scaleX, scaledPadding + (homeY + 26) * scaleY);
      ctx.strokeStyle = "var(--accent-color)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }



    // Draw current physical pen head position (Highly visible pulsing red dot with crosshair & label) only if connected
    if (connected) {
      const renderX = invertX ? (scaleWidth - currentPos.x) : currentPos.x;
      const renderY = invertY ? (scaleHeight - currentPos.y) : currentPos.y;

      ctx.beginPath();
      ctx.arc(scaledPadding + renderX * scaleX, scaledPadding + renderY * scaleY, 12, 0, 2 * Math.PI);
      ctx.fillStyle = "#ef4444";
      ctx.shadowColor = "#ef4444";
      ctx.shadowBlur = 24;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.beginPath();
      ctx.arc(scaledPadding + renderX * scaleX, scaledPadding + renderY * scaleY, 4, 0, 2 * Math.PI);
      ctx.fillStyle = "#ffffff";
      ctx.fill();

      // Crosshairs
      ctx.beginPath();
      ctx.moveTo(scaledPadding + (renderX - 12) * scaleX, scaledPadding + renderY * scaleY);
      ctx.lineTo(scaledPadding + (renderX + 12) * scaleX, scaledPadding + renderY * scaleY);
      ctx.moveTo(scaledPadding + renderX * scaleX, scaledPadding + (renderY - 12) * scaleY);
      ctx.lineTo(scaledPadding + renderX * scaleX, scaledPadding + (renderY + 12) * scaleY);
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2.4;
      ctx.stroke();

      // Text Label "Pen Tip"
      ctx.fillStyle = "#ef4444";
      ctx.font = `bold 18px sans-serif`;
      ctx.fillText("PEN TIP", scaledPadding + renderX * scaleX + 30, scaledPadding + renderY * scaleY + 6);
    }
  };

  // Mouse drag handles / translate logic
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTab === "monitor") return; // Freeze entirely in Monitor

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    // Shift coordinates by CANVAS_PADDING to map directly to millimeters
    const mmX = ((clientX - CANVAS_PADDING) / (rect.width - CANVAS_PADDING * 2)) * scaleWidth;
    const mmY = ((clientY - CANVAS_PADDING) / (rect.height - CANVAS_PADDING * 2)) * scaleHeight;

    if (activeTab === "preview") {
      // Click selection only, no drag/scale/rotate
      let clickedObjId: string | null = null;
      for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects[i];
        const bounds = getObjectBounds(obj);
        if (!bounds) continue;
        const padding = 5;
        if (mmX >= bounds.minX - padding && mmX <= bounds.maxX + padding && mmY >= bounds.minY - padding && mmY <= bounds.maxY + padding) {
          clickedObjId = obj.id;
          break;
        }
      }
      if (clickedObjId) {
        if (!selectedObjectIds.includes(clickedObjId)) {
          setSelectedObjectIds([clickedObjId]);
        }
      } else {
        setSelectedObjectIds([]);
      }
      return;
    }

    // Check handles of selected object first
    if (selectedObjectId) {
      const obj = objects.find(o => o.id === selectedObjectId);
      if (obj) {
        const bounds = getObjectBounds(obj);
        if (bounds) {
          const canvasScaleX = (canvas.width - CANVAS_PADDING * 2) / 2 / scaleWidth;
          const canvasScaleY = (canvas.height - CANVAS_PADDING * 2) / 2 / scaleHeight;
          const handleSizeMm = 8 / ((canvasScaleX + canvasScaleY) / 2);
          
          // Corner Scale Handle click
          const distToScale = Math.hypot(mmX - bounds.maxX, mmY - bounds.maxY);
          if (distToScale <= handleSizeMm * 1.5) {
            setDragMode("scale");
            setIsDragging(true);
            setDragStart({ x: mmX, y: mmY, initOffsetX: obj.scaleX, initOffsetY: 0 });
            return;
          }

          // Rotate Handle click
          const rotX = (bounds.minX + bounds.maxX) / 2;
          const rotY = bounds.minY - 15;
          const distToRotate = Math.hypot(mmX - rotX, mmY - rotY);
          if (distToRotate <= handleSizeMm * 1.5) {
            setDragMode("rotate");
            setIsDragging(true);
            setDragStart({ x: mmX, y: mmY, initOffsetX: obj.rotation, initOffsetY: 0 });
            return;
          }
        }
      }
    }

    // Check handles of template image if selected and not locked
    if (selectedObjectId === "template-object" && !isTemplateLocked) {
      const bounds = getTemplateBounds();
      if (bounds) {
        const cx = bounds.minX + bounds.width / 2;
        const cy = bounds.minY + bounds.height / 2;
        const rad = (templateRotation * Math.PI) / 180;
        
        const dx = mmX - cx;
        const dy = mmY - cy;
        const localX = dx * Math.cos(-rad) - dy * Math.sin(-rad);
        const localY = dx * Math.sin(-rad) + dy * Math.cos(-rad);

        const canvasScaleX = (canvas.width - CANVAS_PADDING * 2) / 2 / scaleWidth;
        const canvasScaleY = (canvas.height - CANVAS_PADDING * 2) / 2 / scaleHeight;
        const handleSizeMm = 8 / ((canvasScaleX + canvasScaleY) / 2);

        // Scale handle (bottom right)
        const distToScale = Math.hypot(localX - bounds.width / 2, localY - bounds.height / 2);
        if (distToScale <= handleSizeMm * 1.5) {
          setDragMode("scale");
          setIsDragging(true);
          setDragStart({ x: mmX, y: mmY, initOffsetX: templateScale, initOffsetY: 0 });
          return;
        }

        // Rotate handle (top middle)
        const distToRotate = Math.hypot(localX, localY - (-bounds.height / 2 - 15));
        if (distToRotate <= handleSizeMm * 1.5) {
          setDragMode("rotate");
          setIsDragging(true);
          setDragStart({ x: mmX, y: mmY, initOffsetX: templateRotation, initOffsetY: 0 });
          return;
        }
      }
    }

    // Default translation click (supports clicking any item in the selection group)
    let clickedObjId: string | null = null;
    let clickedStart = { x: 0, y: 0, initOffsetX: 0, initOffsetY: 0 };

    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      const bounds = getObjectBounds(obj);
      if (!bounds) continue;

      const padding = 5;
      if (mmX >= bounds.minX - padding && mmX <= bounds.maxX + padding && mmY >= bounds.minY - padding && mmY <= bounds.maxY + padding) {
        clickedObjId = obj.id;
        clickedStart = { x: mmX, y: mmY, initOffsetX: obj.offsetX, initOffsetY: obj.offsetY };
        break;
      }
    }

    if (!clickedObjId && templateImage && !isTemplateLocked) {
      const bounds = getTemplateBounds();
      if (bounds) {
        const cx = bounds.minX + bounds.width / 2;
        const cy = bounds.minY + bounds.height / 2;
        const rad = (templateRotation * Math.PI) / 180;
        
        const dx = mmX - cx;
        const dy = mmY - cy;
        const localX = dx * Math.cos(-rad) - dy * Math.sin(-rad);
        const localY = dx * Math.sin(-rad) + dy * Math.cos(-rad);

        if (localX >= -bounds.width / 2 && localX <= bounds.width / 2 && localY >= -bounds.height / 2 && localY <= bounds.height / 2) {
          clickedObjId = "template-object";
          clickedStart = { x: mmX, y: mmY, initOffsetX: templateOffsetX, initOffsetY: templateOffsetY };
        }
      }
    }

    if (clickedObjId) {
      if (clickedObjId === "template-object") {
        setSelectedObjectIds(["template-object"]);
        setDragMode("translate");
        setIsDragging(true);
        setDragStart(clickedStart);
      } else {
        // If clicked item is not already in the selection, make it the single selection.
        // But if it is already in the selection, preserve the selection group!
        if (!selectedObjectIds.includes(clickedObjId)) {
          setSelectedObjectIds([clickedObjId]);
        }
        
        setDragMode("translate");
        setIsDragging(true);
        setDragStart(clickedStart);

        // Record start offsets for all selected objects for smooth translation grouping
        const startOffsets: { [id: string]: { x: number, y: number } } = {};
        objects.forEach(o => {
          if (selectedObjectIds.includes(o.id) || o.id === clickedObjId) {
            startOffsets[o.id] = { x: o.offsetX, y: o.offsetY };
          }
        });
        setDragStartOffsets(startOffsets);
      }
    } else {
      setSelectedObjectIds([]);
      setDragMode(null);
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTab === "preview" || activeTab === "monitor") return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const mmX = ((clientX - CANVAS_PADDING) / (rect.width - CANVAS_PADDING * 2)) * scaleWidth;
    const mmY = ((clientY - CANVAS_PADDING) / (rect.height - CANVAS_PADDING * 2)) * scaleHeight;

    if (isDragging && selectedObjectId) {
      if (selectedObjectId === "template-object") {
        const bounds = getTemplateBounds();
        if (bounds) {
          if (dragMode === "translate") {
            const dx = mmX - dragStart.x;
            const dy = mmY - dragStart.y;
            setTemplateOffsetX(dragStart.initOffsetX + dx);
            setTemplateOffsetY(dragStart.initOffsetY + dy);
          } else if (dragMode === "scale") {
            const cx = bounds.minX + bounds.width / 2;
            const cy = bounds.minY + bounds.height / 2;
            const currentDist = Math.hypot(mmX - cx, mmY - cy);
            
            const imgW = templateImage!.naturalWidth;
            const imgH = templateImage!.naturalHeight;
            const aspect = imgH / imgW;
            const diag100 = Math.hypot(scaleWidth / 2, (scaleWidth * aspect) / 2);
            
            let newScale = Math.round((currentDist / diag100) * 100);
            newScale = Math.max(10, Math.min(300, newScale));
            setTemplateScale(newScale);
          } else if (dragMode === "rotate") {
            const cx = bounds.minX + bounds.width / 2;
            const cy = bounds.minY + bounds.height / 2;

            const rad = Math.atan2(mmX - cx, cy - mmY);
            let deg = Math.round((rad * 180) / Math.PI);
            if (deg < 0) deg += 360;
            setTemplateRotation(deg);
          }
        }
        return;
      }

      const obj = objects.find(o => o.id === selectedObjectId);
      if (!obj) return;

      if (dragMode === "translate") {
        const dx = mmX - dragStart.x;
        const dy = mmY - dragStart.y;
        
        // Translate all selected objects in the group together
        setObjects(prev => prev.map(o => {
          if (selectedObjectIds.includes(o.id)) {
            const start = dragStartOffsets[o.id] || { x: o.offsetX, y: o.offsetY };
            return {
              ...o,
              offsetX: start.x + dx,
              offsetY: start.y + dy
            };
          }
          return o;
        }));
      } else if (dragMode === "scale") {
        // Calculate resize ratio based on original unscaled diagonal to avoid jumps
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        obj.rawPaths.forEach(path => {
          path.points.forEach(pt => {
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
          });
        });

        if (minX !== Infinity) {
          const bedCenterX = scaleWidth / 2;
          const bedCenterY = scaleHeight / 2;
          const objCenterX = bedCenterX + obj.offsetX;
          const objCenterY = bedCenterY + obj.offsetY;

          const rawW = maxX - minX;
          const rawH = maxY - minY;
          
          const currentDist = Math.hypot(mmX - objCenterX, mmY - objCenterY);
          const diag100 = Math.hypot(rawW / 2, rawH / 2);
          
          let newScale = Math.round((currentDist / diag100) * 100);
          newScale = Math.max(10, Math.min(400, newScale));
          
          // Apply scale change to all selected items together
          setObjects(prev => prev.map(o => selectedObjectIds.includes(o.id) ? { ...o, scaleX: newScale, scaleY: newScale } : o));
        }
      } else if (dragMode === "rotate") {
        const bedCenterX = scaleWidth / 2;
        const bedCenterY = scaleHeight / 2;
        const objCenterX = bedCenterX + obj.offsetX;
        const objCenterY = bedCenterY + obj.offsetY;

        const rad = Math.atan2(mmX - objCenterX, objCenterY - mmY);
        let deg = Math.round((rad * 180) / Math.PI);
        if (deg < 0) deg += 360;
        
        // Apply rotation change to all selected items together
        setObjects(prev => prev.map(o => selectedObjectIds.includes(o.id) ? { ...o, rotation: deg } : o));
      }
      setSlicingStats(null); // Force re-slice
    } else {
      let hoveredMode: "translate" | "scale" | "rotate" | null = null;
      
      if (selectedObjectId === "template-object" && !isTemplateLocked) {
        const bounds = getTemplateBounds();
        if (bounds) {
          const cx = bounds.minX + bounds.width / 2;
          const cy = bounds.minY + bounds.height / 2;
          const rad = (templateRotation * Math.PI) / 180;
          
          const dx = mmX - cx;
          const dy = mmY - cy;
          const localX = dx * Math.cos(-rad) - dy * Math.sin(-rad);
          const localY = dx * Math.sin(-rad) + dy * Math.cos(-rad);

          const canvasScaleX = (canvas.width - CANVAS_PADDING * 2) / 2 / scaleWidth;
          const canvasScaleY = (canvas.height - CANVAS_PADDING * 2) / 2 / scaleHeight;
          const handleSizeMm = 8 / ((canvasScaleX + canvasScaleY) / 2);

          if (Math.hypot(localX - bounds.width / 2, localY - bounds.height / 2) <= handleSizeMm * 1.5) {
            hoveredMode = "scale";
          } else if (Math.hypot(localX, localY - (-bounds.height / 2 - 15)) <= handleSizeMm * 1.5) {
            hoveredMode = "rotate";
          } else if (localX >= -bounds.width / 2 && localX <= bounds.width / 2 && localY >= -bounds.height / 2 && localY <= bounds.height / 2) {
            hoveredMode = "translate";
          }
        }
      } else if (selectedObjectId) {
        const obj = objects.find(o => o.id === selectedObjectId);
        if (obj) {
          const bounds = getObjectBounds(obj);
          if (bounds) {
            const canvasScaleX = (canvas.width - CANVAS_PADDING * 2) / 2 / scaleWidth;
            const canvasScaleY = (canvas.height - CANVAS_PADDING * 2) / 2 / scaleHeight;
            const handleSizeMm = 8 / ((canvasScaleX + canvasScaleY) / 2);
            
            if (Math.hypot(mmX - bounds.maxX, mmY - bounds.maxY) <= handleSizeMm * 1.5) {
              hoveredMode = "scale";
            } else if (Math.hypot(mmX - (bounds.minX + bounds.maxX)/2, mmY - (bounds.minY - 15)) <= handleSizeMm * 1.5) {
              hoveredMode = "rotate";
            }
          }
        }
      }

      if (!hoveredMode) {
        for (const obj of objects) {
          const bounds = getObjectBounds(obj);
          if (!bounds) continue;
          const padding = 5;
          if (mmX >= bounds.minX - padding && mmX <= bounds.maxX + padding && mmY >= bounds.minY - padding && mmY <= bounds.maxY + padding) {
            hoveredMode = "translate";
            break;
          }
        }

        if (!hoveredMode && templateImage && !isTemplateLocked) {
          const bounds = getTemplateBounds();
          if (bounds) {
            const cx = bounds.minX + bounds.width / 2;
            const cy = bounds.minY + bounds.height / 2;
            const rad = (templateRotation * Math.PI) / 180;
            
            const dx = mmX - cx;
            const dy = mmY - cy;
            const localX = dx * Math.cos(-rad) - dy * Math.sin(-rad);
            const localY = dx * Math.sin(-rad) + dy * Math.cos(-rad);

            if (localX >= -bounds.width / 2 && localX <= bounds.width / 2 && localY >= -bounds.height / 2 && localY <= bounds.height / 2) {
              hoveredMode = "translate";
            }
          }
        }
      }

      if (hoveredMode === "scale") {
        canvas.style.cursor = "nwse-resize";
      } else if (hoveredMode === "rotate") {
        canvas.style.cursor = "crosshair";
      } else if (hoveredMode === "translate") {
        canvas.style.cursor = "move";
      } else {
        canvas.style.cursor = "default";
      }
    }
  };

  const handleCanvasMouseUp = () => {
    setIsDragging(false);
    setDragMode(null);
  };

  const handleDiscardRecovery = () => {
    localStorage.removeItem("axidraw_recovery_session");
    setRecoverySession(null);
    setStatusMsg("Interrupted session discarded");
  };

  const handleResumeFromRecovery = async () => {
    if (!recoverySession) return;

    // 1. Restore states
    setObjects(recoverySession.objects);
    setSlicedPaths(recoverySession.slicedPaths);
    setSlicingStats(recoverySession.slicingStats);

    const savedProgress = recoverySession.progress;
    const finalPaths = recoverySession.slicedPaths;

    // 2. Filter paths to start from savedProgress.global_point_index
    let remainingPaths: Toolpath[] = [];
    let currentGlobalIndex = 0;
    let resumeStartPoint: Point | null = null;

    for (let pathIdx = 0; pathIdx < finalPaths.length; pathIdx++) {
      const path = finalPaths[pathIdx];
      const startGlobalOfPath = currentGlobalIndex;
      const endGlobalOfPath = currentGlobalIndex + path.points.length;

      if (savedProgress.global_point_index >= endGlobalOfPath) {
        currentGlobalIndex = endGlobalOfPath;
        continue;
      }

      if (savedProgress.global_point_index >= startGlobalOfPath && savedProgress.global_point_index < endGlobalOfPath) {
        const pointOffset = savedProgress.global_point_index - startGlobalOfPath;
        const remainingPoints = path.points.slice(pointOffset);
        
        if (remainingPoints.length > 0) {
          remainingPaths.push({
            points: remainingPoints,
            isFill: path.isFill
          });
          resumeStartPoint = remainingPoints[0];
        }
        currentGlobalIndex = endGlobalOfPath;
      } else {
        remainingPaths.push(path);
        currentGlobalIndex = endGlobalOfPath;
      }
    }

    if (remainingPaths.length === 0) {
      setStatusMsg("No remaining points to plot!");
      localStorage.removeItem("axidraw_recovery_session");
      setRecoverySession(null);
      return;
    }

    // 3. Clear recovery state from storage so it doesn't loop
    localStorage.removeItem("axidraw_recovery_session");
    setRecoverySession(null);

    // 4. Mirror remaining paths according to settings
    const mirroredPaths = remainingPaths.map(path => ({
      points: path.points.map(pt => {
        let xVal = invertX ? scaleWidth - pt.x : pt.x;
        let yVal = invertY ? scaleHeight - pt.y : pt.y;
        return { x: xVal, y: yVal };
      })
    }));

    // Apply speed multipliers
    const activeEbbSpeed = ebbSpeed * (speedMultiplier / 100);
    const activeAirSpeed = airSpeed * (speedMultiplier / 100);

    try {
      setStatusMsg("Resuming interrupted plot job...");
      setIsPlotting(true);
      setIsPaused(false);
      
      setJobStartTime(Date.now() - (recoverySession.jobStats?.elapsedTime || 0) * 1000);
      initialDrawnMetersOfRunRef.current = recoverySession.jobStats?.distanceDrawn || 0;
      lastDistanceDrawnRef.current = recoverySession.jobStats?.distanceDrawn || 0;
      
      setJobStats({
        status: "printing",
        pointsCompleted: savedProgress.global_point_index,
        totalPoints: savedProgress.total_points,
        pathsCompleted: savedProgress.path_index,
        totalPaths: finalPaths.length,
        distanceDrawn: recoverySession.jobStats?.distanceDrawn || 0,
        distanceTraveled: recoverySession.jobStats?.distanceTraveled || 0,
        elapsedTime: recoverySession.jobStats?.elapsedTime || 0,
        estimatedRemaining: recoverySession.jobStats?.estimatedRemaining || 0,
        airTravelTime: recoverySession.jobStats?.airTravelTime || 0
      });

      setActiveTab("monitor");

      // Jog pen to the first point of the resumed job
      if (resumeStartPoint && connected) {
        const firstPtX = invertX ? scaleWidth - resumeStartPoint.x : resumeStartPoint.x;
        const firstPtY = invertY ? scaleHeight - resumeStartPoint.y : resumeStartPoint.y;
        
        await invoke("jog_plotter", {
          dx: firstPtX,
          dy: firstPtY,
          speed: activeAirSpeed,
          bedWidth: scaleWidth,
          bedHeight: scaleHeight
        });
      }

      await invoke("start_plot", {
        paths: mirroredPaths,
        speed: activeEbbSpeed,
        airSpeed: activeAirSpeed,
        penUpDuration: penDelay,
        penDownDuration: penDelay,
      });
    } catch (err: any) {
      setStatusMsg(`Resume failed: ${err}`);
      setIsPlotting(false);
      setJobStartTime(null);
    }
  };

  // Plotting queue commands
  const handleStartPlot = async () => {
    if (!connected) {
      setStatusMsg("Please connect to AxiDraw first");
      return;
    }
    
    const pathsToPlot = slicedPaths.length > 0 ? slicedPaths : getProcessedToolpaths();
    if (pathsToPlot.length === 0) {
      setStatusMsg("Nothing to plot! Load SVG or image.");
      return;
    }

    // Apply mirroring based on axis inversion settings
    const finalPaths = pathsToPlot.map(path => ({
      points: path.points.map(pt => {
        let xVal = invertX ? scaleWidth - pt.x : pt.x;
        let yVal = invertY ? scaleHeight - pt.y : pt.y;
        return { x: xVal, y: yVal };
      })
    }));

    // Apply speed multiplier override factor
    const activeEbbSpeed = ebbSpeed * (speedMultiplier / 100);
    const activeAirSpeed = airSpeed * (speedMultiplier / 100);

    try {
      setStatusMsg("Plotting started...");
      setIsPlotting(true);
      setIsPaused(false);
      setJobStartTime(Date.now());
      initialDrawnMetersOfRunRef.current = 0;
      lastDistanceDrawnRef.current = 0;
      setJobStats({
        status: "printing",
        pointsCompleted: 0,
        totalPoints: finalPaths.reduce((acc, p) => acc + p.points.length, 0),
        pathsCompleted: 0,
        totalPaths: finalPaths.length,
        distanceDrawn: 0.0,
        distanceTraveled: 0.0,
        elapsedTime: 0,
        estimatedRemaining: slicingStats ? Math.round(slicingStats.timeEst) : 0,
        airTravelTime: 0
      });
      setActiveTab("monitor"); // Auto-switch to monitor dashboard
      await invoke("start_plot", {
        paths: finalPaths,
        speed: activeEbbSpeed,
        airSpeed: activeAirSpeed,
        penUpDuration: penDelay,
        penDownDuration: penDelay,
      });
    } catch (err: any) {
      setStatusMsg(`Plot failed: ${err}`);
      setIsPlotting(false);
      setJobStartTime(null);
    }
  };

  // Physical laser-engraving style frame trace around page margins, starting near home
  const handleTraceFrame = async () => {
    if (!connected) {
      setStatusMsg("Please connect to AxiDraw first");
      return;
    }

    // Trace safety margin boundary box instead of design bounding box
    const minX = margin;
    const maxX = scaleWidth - margin;
    const minY = margin;
    const maxY = scaleHeight - margin;

    setTracingBoundary({ minX, maxX, minY, maxY });

    // Corner ordering depending on origin corner (starts closest to home corner)
    let corners = [];
    if (originCorner === "top-right") {
      // Home is top-right (scaleWidth, 0) -> closest margin corner is (maxX, minY)
      corners = [
        { x: maxX, y: minY },
        { x: minX, y: minY },
        { x: minX, y: maxY },
        { x: maxX, y: maxY },
        { x: maxX, y: minY }
      ];
    } else {
      // Home is top-left (0,0) -> closest margin corner is (minX, minY)
      corners = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
        { x: minX, y: minY }
      ];
    }

    // Convert coordinates to hardware motor mapping space, respecting invertX/invertY
    const mirroredCorners = corners.map((pt) => ({
      x: invertX ? scaleWidth - pt.x : pt.x,
      y: invertY ? scaleHeight - pt.y : pt.y,
    }));

    // Apply speed multiplier override factor
    const activeJogSpeed = jogSpeed * (speedMultiplier / 100);

    try {
      setStatusMsg("Tracing safety margin boundaries...");
      setIsPlotting(true);
      await invoke("run_frame_preview", { points: mirroredCorners, speed: activeJogSpeed });
    } catch (err: any) {
      setStatusMsg(`Frame trace failed: ${err}`);
      setIsPlotting(false);
      setTracingBoundary(null);
    }
  };

  const handleTraceDesignBoundary = async () => {
    if (!connected) {
      setStatusMsg("Please connect to AxiDraw first");
      return;
    }

    const targetIds = selectedObjectIds.length > 0 
      ? selectedObjectIds 
      : objects.map(o => o.id);

    if (targetIds.length === 0) {
      setStatusMsg("No designs to trace!");
      return;
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    targetIds.forEach(id => {
      const obj = objects.find(o => o.id === id);
      if (obj) {
        const bounds = getObjectBounds(obj);
        if (bounds) {
          if (bounds.minX < minX) minX = bounds.minX;
          if (bounds.maxX > maxX) maxX = bounds.maxX;
          if (bounds.minY < minY) minY = bounds.minY;
          if (bounds.maxY > maxY) maxY = bounds.maxY;
        }
      }
    });

    if (minX === Infinity || minY === Infinity) {
      setStatusMsg("Cannot compute bounds of selected designs");
      return;
    }

    setTracingBoundary({ minX, maxX, minY, maxY });

    // Corner ordering depending on origin corner (starts closest to home corner)
    let corners = [];
    if (originCorner === "top-right") {
      // Home is top-right (scaleWidth, 0) -> closest margin corner is (maxX, minY)
      corners = [
        { x: maxX, y: minY },
        { x: minX, y: minY },
        { x: minX, y: maxY },
        { x: maxX, y: maxY },
        { x: maxX, y: minY }
      ];
    } else {
      // Home is top-left (0,0) -> closest margin corner is (minX, minY)
      corners = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
        { x: minX, y: minY }
      ];
    }

    // Convert coordinates to hardware motor mapping space, respecting invertX/invertY
    const mirroredCorners = corners.map((pt) => ({
      x: invertX ? scaleWidth - pt.x : pt.x,
      y: invertY ? scaleHeight - pt.y : pt.y,
    }));

    // Apply speed multiplier override factor
    const activeJogSpeed = jogSpeed * (speedMultiplier / 100);

    try {
      setStatusMsg("Tracing design boundaries...");
      setIsPlotting(true);
      await invoke("run_frame_preview", { points: mirroredCorners, speed: activeJogSpeed });
    } catch (err: any) {
      setStatusMsg(`Design trace failed: ${err}`);
      setIsPlotting(false);
      setTracingBoundary(null);
    }
  };

  const handlePausePlot = async () => {
    try {
      await invoke("pause_plot");
      setIsPaused(true);
      setJobStats(prev => ({ ...prev, status: "paused" }));
      setStatusMsg("Plot Paused");
    } catch (err) {
      console.error(err);
    }
  };

  const handleResumePlot = async () => {
    try {
      await invoke("resume_plot");
      setIsPaused(false);
      setJobStats(prev => ({ ...prev, status: "printing" }));
      setStatusMsg("Plot Resumed");
    } catch (err) {
      console.error(err);
    }
  };

  function addToJobHistory(aborted: boolean) {
    const jobName = objects.length > 0 
      ? objects.map(o => o.name).join(", ") 
      : "Custom Plot Job";
    
    const newJob: PastJob = {
      id: `job-${Date.now()}`,
      name: jobName,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      paths: slicedPaths.length > 0 ? [...slicedPaths] : getProcessedToolpaths(),
      stats: slicingStats,
      status: aborted ? "aborted" : "completed"
    };
    
    setJobHistory(prev => [newJob, ...prev.slice(0, 9)]);
  }

  const handleRelaunchJob = async (job: PastJob) => {
    if (!connected) {
      setStatusMsg("Please connect to AxiDraw first");
      return;
    }
    
    // Load job paths & stats
    setSlicedPaths(job.paths);
    setSlicingStats(job.stats);

    // Apply mirroring
    const finalPaths = job.paths.map(path => ({
      points: path.points.map(pt => {
        let xVal = invertX ? scaleWidth - pt.x : pt.x;
        let yVal = invertY ? scaleHeight - pt.y : pt.y;
        return { x: xVal, y: yVal };
      })
    }));

    const activeEbbSpeed = ebbSpeed * (speedMultiplier / 100);
    const activeAirSpeed = airSpeed * (speedMultiplier / 100);

    try {
      setStatusMsg(`Relaunching job: ${job.name}...`);
      setIsPlotting(true);
      setIsPaused(false);
      setJobStartTime(Date.now());
      initialDrawnMetersOfRunRef.current = 0;
      lastDistanceDrawnRef.current = 0;
      setJobStats({
        status: "printing",
        pointsCompleted: 0,
        totalPoints: finalPaths.reduce((acc, p) => acc + p.points.length, 0),
        pathsCompleted: 0,
        totalPaths: finalPaths.length,
        distanceDrawn: 0.0,
        distanceTraveled: 0.0,
        elapsedTime: 0,
        estimatedRemaining: job.stats ? Math.round(job.stats.timeEst) : 0,
        airTravelTime: 0
      });
      setActiveTab("monitor");
      await invoke("start_plot", {
        paths: finalPaths,
        speed: activeEbbSpeed,
        airSpeed: activeAirSpeed,
        penUpDuration: penDelay,
        penDownDuration: penDelay,
      });
    } catch (err: any) {
      setStatusMsg(`Relaunch failed: ${err}`);
      setIsPlotting(false);
      setJobStartTime(null);
    }
  };

  // Stop plotting: halts steppers, raises pen, releases motors, and homes pen back to origin
  const handleStopPlot = async () => {
    setStatusMsg("Stop registered. Completing current stroke before returning home...");
    setTracingBoundary(null);
    try {
      await invoke("stop_plot"); // halts active moves instantly
      setIsPlotting(false);
      setIsPaused(false);
      setIsPenDown(false);
      setJobStartTime(null);
      setJobStats(prev => ({ ...prev, status: "aborted" }));
    } catch (err: any) {
      console.error(err);
      setStatusMsg(`Stop failed: ${err}`);
    }
  };

  // Manual Stepper/Pen Controls
  const handleJog = async (direction: string) => {
    if (!connected) return;
    let dx = 0;
    let dy = 0;

    const multX = invertX ? -1 : 1;
    const multY = invertY ? -1 : 1;

    switch (direction) {
      case "up":
        dy = -jogStep * multY; // Up decreases physical Y coordinate (retracts carriage)
        break;
      case "down":
        dy = jogStep * multY;  // Down increases physical Y coordinate (extends carriage)
        break;
      case "left":
        dx = -jogStep * multX;
        break;
      case "right":
        dx = jogStep * multX;
        break;
      case "center":
        setStatusMsg("Homing plotter to origin...");
        try {
          // Raise pen first to prevent dragging across the sheet
          await invoke("toggle_pen", { down: false, durationMs: penDelay });
          setIsPenDown(false);
          const activeJogSpeed = jogSpeed * (speedMultiplier / 100);
          await invoke("home_plotter", { speed: activeJogSpeed });
          setCurrentPos({ x: 0, y: 0 });
          updateHomeTimestamp();
          setStatusMsg("Plotter at origin (0,0).");
        } catch (err: any) {
          setStatusMsg(`Homing failed: ${err}`);
        }
        return;
    }
    
    if (dx !== 0 || dy !== 0) {
      try {
        const activeJogSpeed = jogSpeed * (speedMultiplier / 100);
        await invoke("jog_plotter", { dx, dy, speed: activeJogSpeed, bedWidth: scaleWidth, bedHeight: scaleHeight });
      } catch (err: any) {
        setStatusMsg(`Jog failed: ${err}`);
      }
    }
  };

  const handleZeroPlotter = async () => {
    if (!connected) return;
    try {
      await invoke("zero_plotter_coordinates");
      setCurrentPos({ x: 0, y: 0 });
      setIsPenDown(false); // Reset pen state tracker to UP
      updateHomeTimestamp();
      setStatusMsg("Coordinates zeroed.");
    } catch (err: any) {
      setStatusMsg(`Zero failed: ${err}`);
    }
  };

  // Toggle pen position (UP / DOWN) using a single switch
  const handleTogglePenState = async () => {
    if (!connected) return;
    const targetState = !isPenDown;
    try {
      await invoke("toggle_pen", { down: targetState, durationMs: penDelay });
      setIsPenDown(targetState);
    } catch (err: any) {
      setStatusMsg(`Pen toggle failed: ${err}`);
    }
  };

  // Toggle motors (ENABLED / RELEASED) using a single switch
  const handleToggleMotorsState = async () => {
    if (!connected) return;
    const targetState = !areMotorsEnabled;
    try {
      await invoke("enable_motors", { enable: targetState });
      setAreMotorsEnabled(targetState);
      setStatusMsg(targetState ? "Motors enabled" : "Motors released");
    } catch (err: any) {
      setStatusMsg(`Motors toggle failed: ${err}`);
    }
  };

  const handleBedPresetChange = (preset: string) => {
    if (activeTab === "preview" || activeTab === "monitor") return;
    if (!preset) return; // Custom
    let w = 210, h = 297;
    switch (preset) {
      case "A4": w = 210; h = 297; break;
      case "A3": w = 297; h = 420; break;
      case "A2": w = 420; h = 594; break;
      case "A1": w = 594; h = 841; break;
      case "A5": w = 148; h = 210; break;
      case "A6": w = 105; h = 148; break;
      case "A7": w = 74; h = 105; break;
    }
    
    if (orientation === "landscape") {
      setScaleWidth(h);
      setScaleHeight(w);
    } else {
      setScaleWidth(w);
      setScaleHeight(h);
    }
    setSlicingStats(null);
    setSlicedPaths([]);
    setActiveTab("prepare");
  };

  const handleOrientationToggle = (newOrientation: "landscape" | "portrait") => {
    if (activeTab === "preview" || activeTab === "monitor") return;
    setOrientation(newOrientation);
    const temp = scaleWidth;
    setScaleWidth(scaleHeight);
    setScaleHeight(temp);
    setSlicingStats(null);
    setSlicedPaths([]);
  };

  // Jog direction limits guard calculations
  const step = jogStep;
  const nextXLeft = currentPos.x - step * (invertX ? -1 : 1);
  const nextXRight = currentPos.x + step * (invertX ? -1 : 1);
  const nextYUp = currentPos.y - step * (invertY ? -1 : 1);
  const nextYDown = currentPos.y + step * (invertY ? -1 : 1);

  const canJogLeft = nextXLeft >= 0 && nextXLeft <= scaleWidth;
  const canJogRight = nextXRight >= 0 && nextXRight <= scaleWidth;
  const canJogUp = nextYUp >= 0 && nextYUp <= scaleHeight;
  const canJogDown = nextYDown >= 0 && nextYDown <= scaleHeight;

  // Active Pen Profile details
  const activeProfile = penProfiles.find(p => p.id === activeProfileId);
  const penCapacityMeters = activeProfile ? activeProfile.capacityMeters : 1500;

  // Selected object transform properties (Prepare tab bindings)
  const selectedObject = selectedObjectId === "template-object"
    ? ({ id: "template-object", name: "Gabarit d'Arrière-Plan", scale: templateScale, rotation: templateRotation, offsetX: templateOffsetX, offsetY: templateOffsetY } as any)
    : objects.find(o => o.id === selectedObjectId);

  const canvasHeight = 550;
  const canvasWidth = Math.round(canvasHeight * (scaleWidth / scaleHeight));

  const totalCanvasWidth = canvasWidth + CANVAS_PADDING * 2;
  const totalCanvasHeight = canvasHeight + CANVAS_PADDING * 2;

  const showBlockingLoader = isCalculatingHatch || isGenerating || loadingText !== null;
  const currentLoadingText = loadingText || (isGenerating ? "Vectorizing Image..." : (isCalculatingHatch ? "Calculating SVG Fill & Hatching..." : "Processing..."));

  return (
    <div className="app-container">
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>

      {showBlockingLoader && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0, 0, 0, 0.75)",
          backdropFilter: "blur(5px)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          color: "#ffffff"
        }}>
          <div style={{
            width: "50px",
            height: "50px",
            border: "4px solid rgba(255, 255, 255, 0.1)",
            borderTop: "4px solid var(--accent-color, #4361ee)",
            borderRadius: "50%",
            animation: "spin 1s linear infinite",
            marginBottom: "15px"
          }} />
          <div style={{ fontSize: "1.1rem", fontWeight: "bold" }}>{currentLoadingText}</div>
          <div style={{ fontSize: "0.8rem", color: "rgba(255, 255, 255, 0.6)", marginTop: "6px" }}>Please wait...</div>
        </div>
      )}

      <header className="app-header">
        <div className="brand-section">
          <img src="/logo.png" className="brand-logo" alt="logo" style={{ borderRadius: "4px", objectFit: "contain" }} />
          <span className="brand-title" style={{ textTransform: "lowercase", letterSpacing: "1px" }}>axidrawslicer</span>
        </div>
        <div className="connection-status">
          <div className="status-indicator">
            <div className={`status-dot ${isPlotting ? "plotting" : connected ? "connected" : ""}`} />
            {isPlotting ? "Plotting" : connected ? "Connected" : "Disconnected"}
          </div>
        </div>
      </header>

      <div className="workspace">
        {/* LEFT COLUMN: Sidebar Navigation */}
        <aside className="sidebar">
          <div className="tab-navigation">
            <button className={`tab-btn ${activeTab === "prepare" ? "active" : ""}`} onClick={() => setActiveTab("prepare")}>
              Prepare
            </button>
            <button className={`tab-btn ${activeTab === "preview" ? "active" : ""}`} onClick={() => setActiveTab("preview")} disabled={slicingStats === null}>
              Preview
            </button>
            <button 
              className={`tab-btn ${activeTab === "monitor" ? "active" : ""}`} 
              onClick={() => setActiveTab("monitor")}
              disabled={!connected}
              title={!connected ? "Connect plotter to access live monitoring" : ""}
            >
              Monitor
            </button>
          </div>

          {/* PREPARE TAB */}
          {activeTab === "prepare" && (
            <>
              {/* File Import */}
              <div className="card-section">
                <h3 className="card-title">File Import</h3>
                <div 
                  className="file-dropzone" 
                  onClick={() => document.getElementById("file-input")?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleFileDrop}
                >
                  <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
                  </svg>
                  <p>Drag SVG/Image or click to Browse</p>
                  <input id="file-input" type="file" accept=".svg,.png,.jpg,.jpeg" onChange={handleFileChange} style={{ display: "none" }} />
                </div>
                {fileType === "image" && imagePreviewUrl && (
                  <div style={{ textAlign: "center", marginTop: "10px" }}>
                    <img src={imagePreviewUrl} alt="Preview" style={{ maxWidth: "100%", maxHeight: "90px", borderRadius: "6px", border: "1px solid var(--border-color)" }} />
                  </div>
                )}

                {objects.length > 0 && (
                  <div style={{ marginTop: "15px" }}>
                    <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)", fontWeight: "bold" }}>Loaded Objects</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" }}>
                      {objects.map(obj => (
                        <div 
                          key={obj.id} 
                          style={{ 
                            display: "flex", 
                            alignItems: "center", 
                            justifyContent: "space-between", 
                            padding: "6px 10px", 
                            borderRadius: "4px", 
                            fontSize: "0.8rem", 
                            backgroundColor: selectedObjectIds.includes(obj.id) ? "rgba(99, 102, 241, 0.15)" : "var(--bg-primary)",
                            border: `1px solid ${selectedObjectIds.includes(obj.id) ? "var(--accent-color)" : "var(--border-color)"}`,
                            cursor: "pointer"
                          }}
                          onClick={() => setSelectedObjectIds([obj.id])}
                        >
                          <div style={{ display: "flex", alignItems: "center" }}>
                            <input 
                              type="checkbox" 
                              checked={selectedObjectIds.includes(obj.id)} 
                              onChange={(e) => {
                                e.stopPropagation();
                                if (e.target.checked) {
                                  setSelectedObjectIds(prev => [...prev, obj.id]);
                                } else {
                                  setSelectedObjectIds(prev => prev.filter(id => id !== obj.id));
                                }
                              }} 
                              style={{ marginRight: "8px", cursor: "pointer" }}
                            />
                            <span style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", maxWidth: "150px" }}>{obj.name}</span>
                          </div>
                          <button 
                            style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: "1.1rem", padding: "0 4px" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setObjects(prev => prev.filter(o => o.id !== obj.id));
                              setSelectedObjectIds(prev => prev.filter(id => id !== obj.id));
                              setSlicingStats(null);
                              setRawSlicedPaths([]);
                            }}
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                      <button className="btn btn-secondary" style={{ padding: "4px 8px", fontSize: "0.75rem", flex: 1 }} onClick={() => setSelectedObjectIds(objects.map(o => o.id))}>
                        Select all
                      </button>
                      <button className="btn btn-secondary" style={{ padding: "4px 8px", fontSize: "0.75rem", flex: 1 }} onClick={() => setSelectedObjectIds([])}>
                        Deselect all
                      </button>
                    </div>
                    {selectedObject && selectedObject.id !== "template-object" && (
                      <div style={{ marginTop: "12px", padding: "10px", backgroundColor: "var(--bg-tertiary)", borderRadius: "6px", border: "1px solid var(--border-color)", display: "flex", flexDirection: "column", gap: "8px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontWeight: "bold" }}>Monoline Merge Gap</span>
                          <span style={{ fontSize: "0.75rem", color: "var(--accent-color)", fontWeight: "bold" }}>{monolineMergeWidth.toFixed(2)} mm</span>
                        </div>
                        <input 
                          type="range" 
                          min="0.0" 
                          max="3.0" 
                          step="0.05" 
                          value={monolineMergeWidth} 
                          onChange={(e) => setMonolineMergeWidth(parseFloat(e.target.value))} 
                          style={{ width: "100%", margin: 0, padding: 0 }}
                          title="Gaps wider than this size won't be merged into single strokes"
                        />
                        <span style={{ fontSize: "0.62rem", color: "var(--text-muted)", lineHeight: "1.2" }}>
                          Adjust to merge parallel outlines (expanded strokes) into a single path. Set to 0 to keep all lines thin and separate.
                        </span>
                        <button 
                          className="btn btn-secondary" 
                          onClick={() => handleConvertToMonoline(selectedObject.id)}
                          style={{ width: "100%", border: "1px solid var(--accent-color)", padding: "6px", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", marginTop: "2px" }}
                          title="Convert this vector object into single centerline paths"
                        >
                          ⚡ Convert to Monoline
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* SVG Hatch Fill Settings */}
              {objects.some(o => o.svgText !== undefined) && (
                <div className="card-section">
                  <h3 className="card-title">SVG Fill & Hatching</h3>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem", fontWeight: "bold", cursor: "pointer", userSelect: "none", marginBottom: "10px" }}>
                    <input 
                      type="checkbox" 
                      checked={enableSvgHatching} 
                      onChange={(e) => setEnableSvgHatching(e.target.checked)} 
                    />
                    Enable Hatch Fill (Color Shapes)
                  </label>

                  {enableSvgHatching && (
                    <div style={{ borderTop: "1px solid var(--border-color)", paddingTop: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
                      <div className="form-group">
                        <label>Fill Style</label>
                        <select value={svgHatchStyle} onChange={(e) => setSvgHatchStyle(e.target.value as "hatch" | "concentric")}>
                          <option value="hatch">Hatch (Lines)</option>
                          <option value="concentric">Concentric (Offset)</option>
                        </select>
                      </div>

                      <div className="form-group" style={{ marginBottom: "12px" }}>
                        <label>Pen Thickness / Spacing</label>
                        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
                          <select 
                            value={[0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 1.0].includes(svgHatchSpacing) ? svgHatchSpacing.toString() : "custom"} 
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val !== "custom") {
                                const numVal = parseFloat(val);
                                setSvgHatchSpacing(numVal);
                                setLocalHatchSpacing(numVal);
                              }
                            }}
                            style={{ flex: 1, minWidth: "0", fontSize: "0.8rem", padding: "5px", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                          >
                            <option value="0.2">0.20 mm</option>
                            <option value="0.25">0.25 mm</option>
                            <option value="0.3">0.30 mm</option>
                            <option value="0.35">0.35 mm</option>
                            <option value="0.4">0.40 mm (Default)</option>
                            <option value="0.45">0.45 mm</option>
                            <option value="0.5">0.50 mm</option>
                            <option value="0.6">0.60 mm</option>
                            <option value="0.7">0.70 mm</option>
                            <option value="0.8">0.80 mm</option>
                            <option value="1.0">1.00 mm</option>
                            <option value="custom">Custom...</option>
                          </select>
                          <input 
                            type="number" 
                            step="0.01"
                            min="0.05"
                            max="10"
                            value={localHatchSpacing} 
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 0.4;
                              setLocalHatchSpacing(val);
                            }}
                            onBlur={() => setSvgHatchSpacing(localHatchSpacing)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                setSvgHatchSpacing(localHatchSpacing);
                              }
                            }}
                            style={{ width: "70px", fontSize: "0.8rem", padding: "5px", textAlign: "right", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                          />
                          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>mm</span>
                        </div>
                        <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", display: "block", marginTop: "4px" }}>
                          Choose a preset or enter the exact pen tip size textually.
                        </span>
                      </div>

                      {svgHatchStyle === "hatch" && (
                        <>
                          <div className="slider-group">
                            <div className="slider-header">
                              <label>Hatch Angle (degrees)</label>
                              <span className="slider-val">{localHatchAngle}°</span>
                            </div>
                            <input 
                              type="range" 
                              min="0" 
                              max="180" 
                              step="5" 
                              value={localHatchAngle} 
                              onChange={(e) => setLocalHatchAngle(parseInt(e.target.value) || 0)}
                              onMouseUp={() => setSvgHatchAngle(localHatchAngle)}
                              onTouchEnd={() => setSvgHatchAngle(localHatchAngle)}
                              onKeyUp={(e) => {
                                if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
                                  setSvgHatchAngle(localHatchAngle);
                                }
                              }}
                            />
                          </div>

                          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.8rem", cursor: "pointer", userSelect: "none" }}>
                            <input 
                              type="checkbox" 
                              checked={svgCrossHatch} 
                              onChange={(e) => setSvgCrossHatch(e.target.checked)} 
                            />
                            Cross-Hatch (Double density grid)
                          </label>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Raster settings if image */}
              {fileType === "image" && (
                <div className="card-section">
                  <h3 className="card-title">Vectorizer Settings</h3>
                  
                  <div className="form-group">
                    <label>Algorithm</label>
                    <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value)}>
                      <option value="sketch">Sketch (Squiggle)</option>
                      <option value="hatch">Hatching (Waves)</option>
                      <option value="tsp">TSP (Continuous Line)</option>
                      <option value="outline">Outline (Line Art)</option>
                      <option value="crosshatch">Cross-Hatching (Waves)</option>
                    </select>
                  </div>

                  {(algorithm === "sketch" || algorithm === "tsp") && (
                    <div className="slider-group">
                      <div className="slider-header">
                        <label>{algorithm === "tsp" ? "Stipple points" : "Density/Max lines"}</label>
                        <span className="slider-val">{maxLines}</span>
                      </div>
                      <input type="range" min="100" max="4000" step="50" value={maxLines} onChange={(e) => setMaxLines(parseInt(e.target.value))} />
                    </div>
                  )}

                  {(algorithm === "hatch" || algorithm === "crosshatch") && (
                    <div className="slider-group">
                      <div className="slider-header">
                        <label>Line frequency</label>
                        <span className="slider-val">{lineDensity}</span>
                      </div>
                      <input type="range" min="1.0" max="10.0" step="0.5" value={lineDensity} onChange={(e) => setLineDensity(parseFloat(e.target.value))} />
                    </div>
                  )}

                  <div className="slider-group">
                    <div className="slider-header">
                      <label>Computing resolution</label>
                      <span className="slider-val">{resolution}px</span>
                    </div>
                    <input type="range" min="200" max="1000" step="50" value={resolution} onChange={(e) => setResolution(parseInt(e.target.value))} />
                  </div>

                  <button className="btn btn-primary" onClick={handleGenerateToolpath} disabled={isGenerating}>
                    {isGenerating ? "Processing..." : "Generate toolpath"}
                  </button>

                  {selectedObject && selectedObject.name.startsWith("Vectorizer:") && selectedObject.scaleX !== 100 && (
                    <button 
                      className="btn btn-secondary" 
                      onClick={handleOptimizeVectorizerScale} 
                      disabled={isGenerating}
                      style={{ marginTop: "10px", width: "100%", border: "1px solid var(--accent-color)" }}
                      title="Regenerate vector paths at current scale to optimize path density"
                    >
                      Optimize Density to Scale ({Math.round(selectedObject.scaleX)}%)
                    </button>
                  )}
                </div>
              )}

              {/* Bed Size Settings */}
              <div className="card-section">
                <h3 className="card-title">Bed Layout</h3>
                
                <div className="form-row">
                  <div className="form-group">
                    <label>Preset Page Size</label>
                    <select value={bedPreset} onChange={(e) => { handleBedPresetChange(e.target.value); setBedPreset(e.target.value); }}>
                      <option value="">Custom Dimensions</option>
                      <option value="A4">A4 (210 x 297 mm)</option>
                      <option value="A3">A3 (297 x 420 mm)</option>
                      <option value="A2">A2 (420 x 594 mm)</option>
                      <option value="A1">A1 (594 x 841 mm)</option>
                      <option value="A5">A5 (148 x 210 mm)</option>
                      <option value="A6">A6 (105 x 148 mm)</option>
                      <option value="A7">A7 (74 x 105 mm)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Orientation</label>
                    <select value={orientation} onChange={(e) => handleOrientationToggle(e.target.value as "landscape" | "portrait")}>
                      <option value="landscape">Landscape</option>
                      <option value="portrait">Portrait</option>
                    </select>
                  </div>
                </div>

                <div 
                  className="form-row" 
                  onMouseEnter={() => setShowBedWarning(true)}
                  onMouseLeave={() => setShowBedWarning(false)}
                  style={{ position: "relative" }}
                >
                  <div className="form-group">
                    <label>Width (mm)</label>
                    <input type="number" value={scaleWidth} onChange={(e) => { setScaleWidth(parseFloat(e.target.value) || 210); setSlicingStats(null); setSlicedPaths([]); setBedPreset(""); }} />
                  </div>
                  <div className="form-group">
                    <label>Height (mm)</label>
                    <input type="number" value={scaleHeight} onChange={(e) => { setScaleHeight(parseFloat(e.target.value) || 297); setSlicingStats(null); setSlicedPaths([]); setBedPreset(""); }} />
                  </div>

                  {showBedWarning && (
                    <div style={{ position: "absolute", bottom: "100%", left: "0", right: "0", backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--warning)", padding: "10px", borderRadius: "6px", fontSize: "0.75rem", color: "var(--text-secondary)", zIndex: 10, boxShadow: "0 4px 12px rgba(0,0,0,0.5)" }}>
                      Ensure width/height matches your physical travel limits (e.g. height 210 mm) to prevent motor grinding.
                    </div>
                  )}
                </div>

                <div className="form-group" style={{ marginTop: "10px" }}>
                  <label>Safety Margins (mm)</label>
                  <input type="number" value={margin} onChange={(e) => { setMargin(parseFloat(e.target.value) || 0); setSlicingStats(null); setSlicedPaths([]); }} />
                </div>
              </div>

              {/* Background Visual Template */}
              <div className="card-section">
                <h3 className="card-title">Background Visual Template</h3>
                {!templateImage ? (
                  <div 
                    className="file-dropzone" 
                    onClick={() => document.getElementById("template-input")?.click()} 
                    style={{ padding: "12px", minHeight: "60px" }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleTemplateDrop}
                  >
                    <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "24px", height: "24px", marginBottom: "4px" }}>
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                      <circle cx="8.5" cy="8.5" r="1.5"/>
                      <polyline points="21 15 16 10 5 21"/>
                    </svg>
                    <p style={{ fontSize: "0.75rem", margin: 0 }}>Click to Load PNG/JPG Template</p>
                    <input id="template-input" type="file" accept=".png,.jpg,.jpeg" onChange={handleTemplateUpload} style={{ display: "none" }} />
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: "0.8rem", color: "var(--success)", fontWeight: "bold" }}>Template Loaded</span>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button 
                          className="btn btn-secondary" 
                          onClick={() => {
                            setIsTemplateLocked(!isTemplateLocked);
                            if (!isTemplateLocked) {
                              if (selectedObjectIds.includes("template-object")) {
                                setSelectedObjectIds(prev => prev.filter(id => id !== "template-object"));
                              }
                            }
                          }}
                          style={{ padding: "4px 8px", fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "4px", width: "auto" }}
                          title={isTemplateLocked ? "Unlock template to move/rotate/scale it" : "Lock template to prevent accidental dragging"}
                        >
                          {isTemplateLocked ? "🔒 Locked" : "🔓 Unlock"}
                        </button>
                        <button className="btn btn-danger" onClick={() => { setTemplateImage(null); setStatusMsg("Template removed"); }} style={{ padding: "4px 8px", fontSize: "0.75rem", width: "auto" }}>
                          Remove
                        </button>
                      </div>
                    </div>

                    <div className="slider-group">
                      <div className="slider-header">
                        <label>Opacity</label>
                        <span className="slider-val">{templateOpacity}%</span>
                      </div>
                      <input type="range" min="10" max="100" step="5" value={templateOpacity} onChange={(e) => setTemplateOpacity(parseInt(e.target.value))} />
                    </div>

                    <div className="slider-group">
                      <div className="slider-header">
                        <label>Scale</label>
                        <span className="slider-val">{templateScale}%</span>
                      </div>
                      <input type="range" min="10" max="300" step="5" value={templateScale} onChange={(e) => setTemplateScale(parseInt(e.target.value))} />
                    </div>

                    <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                      {!isTemplateLocked ? "💡 Tip: Click and drag, rotate, or scale the template on the canvas directly!" : "🔒 Template locked. Unlock to drag/scale/rotate."}
                    </span>
                  </div>
                )}
              </div>

              {/* Pen Profile Presets & Life Tracker */}
              <div className="card-section">
                <h3 className="card-title">Pen Profile Presets</h3>
                <div className="form-group">
                  <label>Active Pen Profile</label>
                  <select value={activeProfileId} onChange={(e) => setActiveProfileId(e.target.value)}>
                    <option value="">-- No Active Pen Profile --</option>
                    {penProfiles.map(p => (
                      <option key={p.id} value={p.id}>{p.name} ({p.capacityMeters}m)</option>
                    ))}
                  </select>
                </div>
                
                {activeProfile && (
                  <div style={{ marginTop: "10px", fontSize: "0.85rem", display: "flex", flexDirection: "column", gap: "6px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Accumulated draw:</span>
                      <strong>{activeProfile.accumulatedDistanceMeters.toFixed(1)} m / {activeProfile.capacityMeters} m</strong>
                    </div>
                    {(() => {
                      const pct = (activeProfile.accumulatedDistanceMeters / activeProfile.capacityMeters) * 100;
                      return (
                        <>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span>Pen lifespan used:</span>
                            <span style={{ color: pct > 80 ? "var(--danger)" : pct > 50 ? "var(--warning)" : "var(--success)", fontWeight: "bold" }}>
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                          <div style={{ width: "100%", height: "6px", backgroundColor: "var(--bg-tertiary)", borderRadius: "3px", overflow: "hidden", marginTop: "2px" }}>
                            <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", backgroundColor: pct > 80 ? "var(--danger)" : pct > 50 ? "var(--warning)" : "var(--success)" }} />
                          </div>
                        </>
                      );
                    })()}
                    <button className="btn btn-secondary" style={{ marginTop: "8px", padding: "4px 8px", fontSize: "0.75rem", width: "100%" }} onClick={() => {
                      setPenProfiles(prev => prev.map(p => p.id === activeProfileId ? { ...p, accumulatedDistanceMeters: 0 } : p));
                      setStatusMsg("Active pen usage tracking reset.");
                    }}>
                      Reset pen refill
                    </button>
                  </div>
                )}

                {/* Add Custom Profile Form */}
                <div style={{ borderTop: "1px solid var(--border-color)", marginTop: "15px", paddingTop: "15px" }}>
                  <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)", fontWeight: "bold", display: "block", marginBottom: "8px" }}>Add custom pen</label>
                  <div className="form-group" style={{ marginBottom: "8px" }}>
                    <input type="text" placeholder="Pen name (e.g. Gelly Roll)" value={newPenName} onChange={(e) => setNewPenName(e.target.value)} style={{ fontSize: "0.8rem" }} />
                  </div>
                  <div className="form-row" style={{ alignItems: "center", gap: "6px" }}>
                    <div className="form-group" style={{ margin: 0, flex: 1.2 }}>
                      <input 
                        type="number" 
                        placeholder="Cap. (m)" 
                        value={newPenCapacity} 
                        onChange={(e) => setNewPenCapacity(parseInt(e.target.value) || 1000)} 
                        style={{ fontSize: "0.8rem", width: "100%", boxSizing: "border-box" }} 
                        title="Pen ink capacity in meters"
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0, flex: 2 }}>
                      <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                        <select 
                          value={[0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 1.0].includes(newPenTipSize) ? newPenTipSize.toString() : "custom"} 
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val !== "custom") {
                              setNewPenTipSize(parseFloat(val));
                            }
                          }}
                          style={{ flex: 1, fontSize: "0.75rem", padding: "4px", minWidth: "0", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                        >
                          <option value="0.2">0.20</option>
                          <option value="0.25">0.25</option>
                          <option value="0.3">0.30</option>
                          <option value="0.35">0.35</option>
                          <option value="0.4">0.40</option>
                          <option value="0.45">0.45</option>
                          <option value="0.5">0.50</option>
                          <option value="0.6">0.60</option>
                          <option value="0.7">0.70</option>
                          <option value="0.8">0.80</option>
                          <option value="1.0">1.00</option>
                          <option value="custom">Cust.</option>
                        </select>
                        <input 
                          type="number" 
                          step="0.01"
                          min="0.05"
                          placeholder="Tip" 
                          value={newPenTipSize} 
                          onChange={(e) => setNewPenTipSize(parseFloat(e.target.value) || 0.4)} 
                          style={{ fontSize: "0.75rem", width: "48px", boxSizing: "border-box", padding: "4px", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)", textAlign: "right" }} 
                          title="Pen tip size in millimeters"
                        />
                      </div>
                    </div>
                    <button className="btn btn-secondary" onClick={handleAddPenProfile} style={{ padding: "5px 8px", fontSize: "0.8rem", width: "auto", flexShrink: 0 }}>
                      Add
                    </button>
                  </div>
                </div>
              </div>

              {objects.length > 0 && (
                <button className="btn btn-success" onClick={handleSlice} style={{ marginTop: "10px" }}>
                  Slice & preview toolpath
                </button>
              )}
            </>
          )}

          {/* PREVIEW TAB */}
          {activeTab === "preview" && slicingStats && (
            <>
              {/* Statistics Card */}
              <div className="card-section">
                <h3 className="card-title">Slicing Estimates</h3>
                <div className="stats-list">
                  <div className="stats-row">
                    <span>Estimated time (total):</span>
                    <span className="stats-val" style={{ color: "var(--success)" }}>{formatTime(slicingStats.timeEst)}</span>
                  </div>
                  <div className="stats-row">
                    <span>Draw distance:</span>
                    <span className="stats-val">{((slicingStats.drawDist) / 1000).toFixed(2)} m</span>
                  </div>
                  <div className="stats-row">
                    <span>Air travel:</span>
                    <span className="stats-val" style={{ color: "var(--warning)" }}>{((slicingStats.airDist) / 1000).toFixed(2)} m ({formatTime(slicingStats.airTimeEst)})</span>
                  </div>
                  <div className="stats-row">
                    <span>Pen lifts:</span>
                    <span className="stats-val">{slicingStats.numLifts}</span>
                  </div>
                  <div className="stats-row" style={{ borderTop: "1px solid var(--border-color)", paddingTop: "8px", marginTop: "4px" }}>
                    <span>Estimated ink used:</span>
                    <span className="stats-val" style={{ color: "var(--accent-color)" }}>
                      {((slicingStats.drawDist / 1000) / penCapacityMeters * 100).toFixed(2)}% of pen
                    </span>
                  </div>
                </div>

                <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginTop: "10px", fontStyle: "italic", borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: "8px" }}>
                  * Estimated time includes total drawing time, air travel time, and pen delay overhead.
                </div>

                {/* Simulated drawing sequence slider */}
                {simulatedPointsCount !== null && (
                  <div className="slider-group" style={{ marginTop: "15px", borderTop: "1px solid var(--border-color)", paddingTop: "15px" }}>
                    <div className="slider-header" style={{ display: "flex", justifyContent: "space-between" }}>
                      <label style={{ fontWeight: "bold" }}>Drawing simulation preview</label>
                      <span className="slider-val">{simulatedPointsCount} / {slicedPaths.reduce((sum, p) => sum + p.points.length, 0)}</span>
                    </div>
                    <input 
                      type="range" 
                      min="0" 
                      max={slicedPaths.reduce((sum, p) => sum + p.points.length, 0)} 
                      value={simulatedPointsCount} 
                      onChange={(e) => setSimulatedPointsCount(parseInt(e.target.value))} 
                    />
                    <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", display: "block", marginTop: "2px" }}>
                      Drag to simulate the drawing sequence smoothly point-by-point.
                    </span>
                  </div>
                )}

                <div style={{ marginTop: "15px", borderTop: "1px solid var(--border-color)", paddingTop: "15px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "0.82rem", fontWeight: "bold" }}>
                    <input 
                      type="checkbox" 
                      checked={simulatePenWidth} 
                      onChange={(e) => setSimulatePenWidth(e.target.checked)} 
                    />
                    Simulate Pen Width (WYSIWYG)
                  </label>
                  <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", display: "block", marginTop: "4px", paddingLeft: "20px" }}>
                    Render paths matching the physical thickness of your selected pen to preview detail readability.
                  </span>
                </div>

                <button className="btn btn-secondary" onClick={() => setActiveTab("prepare")} style={{ marginTop: "15px", width: "100%" }}>
                  Modify parameters
                </button>
              </div>

              {/* Printing speeds */}
              <div className="card-section">
                <h3 className="card-title">Slicing Speed Settings</h3>
                <div className="form-row">
                  <div className="form-group">
                    <label>Plot Speed (mm/s)</label>
                    <input 
                      type="number" 
                      value={ebbSpeed === 0 || isNaN(ebbSpeed) ? "" : ebbSpeed} 
                      onChange={(e) => { const v = e.target.value; setEbbSpeed(v === "" ? "" as any : parseFloat(v)); }} 
                      onBlur={() => { if (isNaN(ebbSpeed) || !ebbSpeed) setEbbSpeed(25); }}
                    />
                    <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>Range: 15-40 (Max: 100)</span>
                  </div>
                  <div className="form-group">
                    <label>Air Speed (mm/s)</label>
                    <input 
                      type="number" 
                      value={airSpeed === 0 || isNaN(airSpeed) ? "" : airSpeed} 
                      onChange={(e) => { const v = e.target.value; setAirSpeed(v === "" ? "" as any : parseFloat(v)); }} 
                      onBlur={() => { if (isNaN(airSpeed) || !airSpeed) setAirSpeed(60); }}
                    />
                    <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>Range: 40-100 (Max: 150)</span>
                  </div>
                </div>
                <div className="form-group" style={{ marginTop: "5px" }}>
                  <label>Pen delay (ms)</label>
                  <input 
                    type="number" 
                    value={penDelay === 0 || isNaN(penDelay) ? "" : penDelay} 
                    onChange={(e) => { const v = e.target.value; setPenDelay(v === "" ? "" as any : parseInt(v)); }} 
                    onBlur={() => { if (isNaN(penDelay) || !penDelay) setPenDelay(300); }}
                  />
                  <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>Range: 150 - 500 ms</span>
                </div>
              </div>

              {/* Priming Line Settings */}
              <div className="card-section">
                <h3 className="card-title">Priming Line Settings</h3>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem", fontWeight: "bold", cursor: "pointer", userSelect: "none", marginBottom: "10px" }}>
                  <input 
                    type="checkbox" 
                    checked={enablePrimingLine} 
                    onChange={(e) => {
                      setEnablePrimingLine(e.target.checked);
                      if (e.target.checked) {
                        setTimeout(() => handleAutoPositionPriming(), 0);
                      }
                    }} 
                  />
                  Enable Priming Line
                </label>

                {enablePrimingLine && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--border-color)", paddingTop: "10px" }}>
                    <div className="form-row">
                      <div className="form-group">
                        <label>Start X (mm)</label>
                        <input 
                          type="number" 
                          value={primingStartX === 0 || isNaN(primingStartX) ? "" : primingStartX} 
                          onChange={(e) => {
                            const val = e.target.value;
                            setPrimingStartX(val === "" ? 0 : parseFloat(val));
                          }} 
                        />
                      </div>
                      <div className="form-group">
                        <label>Start Y (mm)</label>
                        <input 
                          type="number" 
                          value={primingStartY === 0 || isNaN(primingStartY) ? "" : primingStartY} 
                          onChange={(e) => {
                            const val = e.target.value;
                            setPrimingStartY(val === "" ? 0 : parseFloat(val));
                          }} 
                        />
                      </div>
                    </div>

                    <div className="form-row" style={{ alignItems: "center" }}>
                      <div className="form-group">
                        <label>Length (mm)</label>
                        <input 
                          type="number" 
                          value={primingLength === 0 || isNaN(primingLength) ? "" : primingLength} 
                          onChange={(e) => {
                            const val = e.target.value;
                            setPrimingLength(val === "" ? 0 : parseFloat(val));
                          }} 
                        />
                      </div>
                      <div className="form-group">
                        <label>Direction</label>
                        <select 
                          value={primingDirection} 
                          onChange={(e) => {
                            setPrimingDirection(e.target.value as "horizontal" | "vertical");
                          }}
                        >
                          <option value="horizontal">Horizontal</option>
                          <option value="vertical">Vertical</option>
                        </select>
                      </div>
                    </div>

                    <button 
                      className="btn btn-secondary" 
                      onClick={handleAutoPositionPriming}
                      style={{ padding: "6px 12px", fontSize: "0.75rem", width: "100%", marginTop: "4px", border: "1px solid var(--accent-color)" }}
                      title="Automatically place priming line adjacent to design boundaries to prevent drawing overlapping lines"
                    >
                      ⚡ Auto-position near design
                    </button>
                  </div>
                )}
              </div>

              {/* Execution panel */}
              {connected && (
                <div className="card-section">
                  <h3 className="card-title">Job Execution</h3>
                  
                  <div className="form-row" style={{ gap: "8px", marginBottom: "10px" }}>
                    <button className="btn btn-secondary" onClick={handleTraceFrame} disabled={isPlotting} style={{ flex: 1, padding: "6px 4px", fontSize: "0.75rem" }}>
                      Trace page margins
                    </button>
                    <button className="btn btn-secondary" onClick={handleTraceDesignBoundary} disabled={isPlotting || objects.length === 0} style={{ flex: 1, padding: "6px 4px", fontSize: "0.75rem" }}>
                      Trace designs boundary
                    </button>
                  </div>

                  {!isPlotting ? (
                    <button className="btn btn-success" onClick={handleStartPlot}>
                      Start plot job
                    </button>
                  ) : (
                    <div className="form-row">
                      {isPaused ? (
                        <button className="btn btn-success" onClick={handleResumePlot}>Resume</button>
                      ) : (
                        <button className="btn btn-secondary" onClick={handlePausePlot}>Pause</button>
                      )}
                      <button className="btn btn-danger" onClick={handleStopPlot}>Stop</button>
                    </div>
                  )}

                  {progress && (
                    <div style={{ marginTop: "10px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "4px" }}>
                        <span>Progress</span>
                        <span>{Math.round((progress.global_point_index / progress.total_points) * 100)}%</span>
                      </div>
                      <div style={{ width: "100%", height: "6px", backgroundColor: "var(--bg-primary)", borderRadius: "3px", overflow: "hidden" }}>
                        <div style={{ width: `${(progress.global_point_index / progress.total_points) * 100}%`, height: "100%", backgroundColor: "var(--accent-color)" }} />
                      </div>
                      
                      {progress.total_loops > 1 ? (
                        <div style={{ fontSize: "0.8rem", color: "var(--warning)", marginTop: "6px", textAlign: "center", fontWeight: "bold" }}>
                          Tracing boundary loop: {progress.loop_index + 1} / {progress.total_loops}
                        </div>
                      ) : (
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "6px", textAlign: "center" }}>
                          X: {currentPos.x.toFixed(1)}mm | Y: {currentPos.y.toFixed(1)}mm
                        </div>
                      )}
                    </div>
                  )}
                  {statusMsg && (
                    <div style={{ 
                      marginTop: "12px", 
                      padding: "8px 12px", 
                      borderRadius: "6px", 
                      fontSize: "0.75rem", 
                      fontFamily: "monospace",
                      backgroundColor: "var(--bg-primary)", 
                      borderLeft: "3px solid var(--accent-color)", 
                      color: "var(--text-secondary)" 
                    }}>
                      Status: {statusMsg}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* MONITOR TAB SIDEBAR */}
          {activeTab === "monitor" && (
            <>
              {/* Manual Override card */}
              <div className="card-section">
                <h3 className="card-title">Telemetry & Overrides</h3>
                
                {/* Speed Factor override */}
                <div className="slider-group">
                  <div className="slider-header" style={{ display: "flex", justifyContent: "space-between" }}>
                    <label style={{ fontWeight: "bold" }}>Speed factor override</label>
                    <span className="slider-val" style={{ color: "var(--accent-color)", fontWeight: "bold" }}>{speedMultiplier}%</span>
                  </div>
                  <input 
                    type="range" 
                    min="50" 
                    max="150" 
                    step="5" 
                    value={speedMultiplier} 
                    onChange={(e) => setSpeedMultiplier(parseInt(e.target.value))} 
                  />
                  <span style={{ fontSize: "0.68rem", color: "var(--text-secondary)", display: "block", marginTop: "4px" }}>
                    Multiplies plot/travel rates dynamically.
                    <br />
                    Draw: {(ebbSpeed * speedMultiplier / 100).toFixed(1)} mm/s | Air: {(airSpeed * speedMultiplier / 100).toFixed(1)} mm/s
                  </span>
                </div>

                <div style={{ borderTop: "1px solid var(--border-color)", paddingTop: "12px", marginTop: "4px", display: "flex", flexDirection: "column", gap: "8px", fontSize: "0.82rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Hardware motors:</span>
                    <strong style={{ color: areMotorsEnabled ? "var(--success)" : "var(--warning)" }}>
                      {areMotorsEnabled ? "enabled" : "released"}
                    </strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Hardware pen state:</span>
                    <strong style={{ color: isPenDown ? "var(--danger)" : "var(--success)" }}>
                      {isPenDown ? "down (drawing)" : "up (travel)"}
                    </strong>
                  </div>
                </div>
              </div>

              {/* Status information */}
              <div className="card-section">
                <h3 className="card-title">Hardware Telemetry</h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", fontSize: "0.8rem" }}>
                  <div style={{ flex: "1 1 45%", backgroundColor: "var(--bg-primary)", padding: "8px", borderRadius: "6px", border: "1px solid var(--border-color)", textAlign: "center" }}>
                    <div style={{ color: "var(--text-muted)", fontSize: "0.65rem" }}>CARRIAGE X</div>
                    <strong style={{ fontSize: "1.1rem", color: "var(--accent-color)" }}>{currentPos.x.toFixed(1)} <span style={{ fontSize: "0.75rem" }}>mm</span></strong>
                  </div>
                  <div style={{ flex: "1 1 45%", backgroundColor: "var(--bg-primary)", padding: "8px", borderRadius: "6px", border: "1px solid var(--border-color)", textAlign: "center" }}>
                    <div style={{ color: "var(--text-muted)", fontSize: "0.65rem" }}>CARRIAGE Y</div>
                    <strong style={{ fontSize: "1.1rem", color: "var(--accent-color)" }}>{currentPos.y.toFixed(1)} <span style={{ fontSize: "0.75rem" }}>mm</span></strong>
                  </div>
                </div>
              </div>

              {/* Dashboard Layout controls */}
              <div className="card-section">
                <h3 className="card-title">Dashboard Layout</h3>
                <button 
                  className="btn btn-secondary" 
                  style={{ width: "100%", padding: "6px 12px", fontSize: "0.8rem" }}
                  onClick={() => {
                    setConsoleHeight(450);
                    setMonitorZoom(1.0);
                  }}
                >
                  Reset Widget Layout
                </button>
              </div>
            </>
          )}

          {/* Credits footer */}
          <div style={{ marginTop: "auto", paddingTop: "15px", borderTop: "1px solid var(--border-color)", display: "flex", flexDirection: "column", gap: "2px", alignItems: "center", fontSize: "0.72rem", color: "var(--text-muted)" }}>
            <span style={{ fontWeight: 600, letterSpacing: "0.5px" }}>axidrawslicer v0.1.0</span>
            <span>Developed by <strong style={{ color: "var(--accent-color)" }}>aent0n</strong></span>
          </div>
        </aside>

        {/* CENTER VIEWPORT */}
        {activeTab !== "monitor" ? (
          <div style={{ flex: 1, minWidth: 0, position: "relative", display: "flex", flexDirection: "column", height: "100%", width: "100%", overflow: "hidden" }}>
            
            {/* Scrollable Canvas area */}
            <main 
              ref={prepareScrollContainerCallback}
              className="canvas-container" 
              onMouseDown={handlePrepareMouseDown}
              onMouseMove={handlePrepareMouseMove}
              onMouseUp={handlePrepareMouseUp}
              onMouseLeave={handlePrepareMouseUp}
              onContextMenu={(e) => {
                if (isPanningPrepare) e.preventDefault();
              }}
              style={{ display: "flex", flexDirection: "column", gap: "15px", overflow: "auto", alignItems: "center", width: "100%", height: "100%", padding: "20px 10px", boxSizing: "border-box" }}
            >
              {recoverySession && (
                <div 
                  style={{
                    backgroundColor: "rgba(245, 158, 11, 0.08)",
                    border: "1px solid rgba(245, 158, 11, 0.3)",
                    borderRadius: "8px",
                    padding: "14px 20px",
                    width: "100%",
                    maxWidth: `${totalCanvasWidth * zoom}px`,
                    boxSizing: "border-box",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    backdropFilter: "blur(5px)",
                    flexShrink: 0
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ fontSize: "1.2rem" }}>⚠️</span>
                    <div style={{ flex: 1 }}>
                      <h4 style={{ margin: 0, fontSize: "0.85rem", color: "var(--warning)", fontWeight: "600" }}>
                        Interrupted Plotting Session Detected
                      </h4>
                      <p style={{ margin: "4px 0 0 0", fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                        A previous job for <strong>{recoverySession.objects.map((o: any) => o.name).join(", ")}</strong> was interrupted at point <strong>{recoverySession.progress?.global_point_index}</strong> of <strong>{recoverySession.progress?.total_points}</strong> ({Math.round(((recoverySession.progress?.global_point_index || 0) / (recoverySession.progress?.total_points || 1)) * 100)}%).
                      </p>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                    <button 
                      className="btn btn-success" 
                      onClick={handleResumeFromRecovery}
                      disabled={!connected}
                      style={{ fontSize: "0.75rem", padding: "6px 12px", width: "auto" }}
                      title={!connected ? "Connect AxiDraw first to resume job" : ""}
                    >
                      Resume Job from Interruption
                    </button>
                    <button 
                      className="btn btn-danger" 
                      onClick={handleDiscardRecovery}
                      style={{ fontSize: "0.75rem", padding: "6px 12px", width: "auto", backgroundColor: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", border: "1px solid rgba(239, 68, 68, 0.3)" }}
                    >
                      Discard Session
                    </button>
                    {!connected && (
                      <span style={{ fontSize: "0.7rem", color: "var(--warning)", alignSelf: "center" }}>
                        (Please connect AxiDraw to enable resume)
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Horizontal Slicing Toolbar - aligned at bed level, matching bed width */}
              <div 
                style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "center", 
                  backgroundColor: "var(--bg-secondary)", 
                  border: "1px solid var(--border-color)", 
                  borderRadius: "8px", 
                  padding: "10px 16px",
                  width: "fit-content",
                  minWidth: `${totalCanvasWidth * zoom}px`,
                  boxSizing: "border-box",
                  flexWrap: "nowrap",
                  gap: "15px",
                  flexShrink: 0
                }}
              >
                {/* Clipboard actions */}
                <div style={{ display: "flex", gap: "4px", flexShrink: 0, flexWrap: "nowrap" }}>
                  <button className="btn btn-secondary" onClick={handleCopy} disabled={activeTab === "preview" || !selectedObjectId} style={{ padding: "4px 8px", fontSize: "0.75rem" }}>
                    Copy
                  </button>
                  <button className="btn btn-secondary" onClick={handleCut} disabled={activeTab === "preview" || !selectedObjectId} style={{ padding: "4px 8px", fontSize: "0.75rem" }}>
                    Cut
                  </button>
                  <button className="btn btn-secondary" onClick={handlePaste} disabled={activeTab === "preview" || !clipboard} style={{ padding: "4px 8px", fontSize: "0.75rem" }}>
                    Paste
                  </button>
                  <button 
                    className="btn btn-danger" 
                    onClick={() => {
                      if (selectedObjectIds.includes("template-object")) {
                        setTemplateImage(null);
                        setSelectedObjectIds([]);
                        setStatusMsg("Template removed");
                      } else if (selectedObjectIds.length > 0) {
                        setObjects(prev => prev.filter(o => !selectedObjectIds.includes(o.id)));
                        setSelectedObjectIds([]);
                        setSlicingStats(null);
                        setRawSlicedPaths([]);
                      }
                    }} 
                    disabled={activeTab === "preview" || selectedObjectIds.length === 0} 
                    style={{ padding: "4px 8px", fontSize: "0.75rem", backgroundColor: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", border: "1px solid rgba(239, 68, 68, 0.3)" }}
                  >
                    Delete
                  </button>
                </div>

                {/* Vertical Divider */}
                <div style={{ width: "1px", height: "24px", backgroundColor: "var(--border-color)", flexShrink: 0 }} />

                {/* Arrange group */}
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0, flexWrap: "nowrap" }}>
                  <button className="btn btn-secondary" onClick={handleArrangeAll} disabled={activeTab === "preview" || objects.length === 0} style={{ padding: "4px 10px", fontSize: "0.75rem" }}>
                    Auto-Arrange
                  </button>
                  <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.72rem", fontWeight: "normal", cursor: "pointer", userSelect: "none", color: "var(--text-secondary)", whiteSpace: "nowrap" }} title="Allow resizing objects to fit cells during layout optimization">
                    <input type="checkbox" checked={allowArrangeResize} onChange={(e) => setAllowArrangeResize(e.target.checked)} disabled={activeTab === "preview"} />
                    Auto-Scale
                  </label>
                </div>

                {/* Vertical Divider */}
                <div style={{ width: "1px", height: "24px", backgroundColor: "var(--border-color)", flexShrink: 0 }} />

                {/* Scale / Rotate / Flip actions */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0, flexWrap: "nowrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "nowrap" }}>
                    <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>Scale:</span>
                    <input 
                      type="number" 
                      value={inputScaleText} 
                      disabled={activeTab === "preview" || !selectedObject}
                      onChange={(e) => {
                        const txt = e.target.value;
                        setInputScaleText(txt);
                        const val = parseInt(txt);
                        if (!isNaN(val) && val > 0) {
                          if (selectedObjectId === "template-object") {
                            setTemplateScale(val);
                          } else {
                            setObjects(prev => prev.map(o => selectedObjectIds.includes(o.id) ? { ...o, scaleX: val, scaleY: val } : o));
                            setSlicingStats(null);
                            setRawSlicedPaths([]);
                          }
                        }
                      }}
                      style={{ width: "45px", padding: "4px 6px", fontSize: "0.75rem", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                    />
                    <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>%</span>
                  </div>

                  {selectedObject && selectedObjectId !== "template-object" && (
                    <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "nowrap" }}>
                      <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>Size:</span>
                      <input 
                        type="number" 
                        value={inputWidthText} 
                        disabled={activeTab === "preview"}
                        onChange={(e) => handleWidthChange(e.target.value)}
                        style={{ width: "50px", padding: "4px 6px", fontSize: "0.75rem", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                        placeholder="W"
                        title="Width in mm"
                      />
                      <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>×</span>
                      <input 
                        type="number" 
                        value={inputHeightText} 
                        disabled={activeTab === "preview"}
                        onChange={(e) => handleHeightChange(e.target.value)}
                        style={{ width: "50px", padding: "4px 6px", fontSize: "0.75rem", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                        placeholder="H"
                        title="Height in mm"
                      />
                      <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginRight: "6px" }}>mm</span>
                    </div>
                  )}

                  <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "nowrap" }}>
                    <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>Rot/Flip:</span>
                    <button className="btn btn-secondary" style={{ padding: "2px 6px", fontSize: "0.7rem" }} disabled={activeTab === "preview" || !selectedObject} onClick={() => rotate90("left")} title="Rotate 90° CCW">-90°</button>
                    <button className="btn btn-secondary" style={{ padding: "2px 6px", fontSize: "0.7rem" }} disabled={activeTab === "preview" || !selectedObject} onClick={() => rotate90("right")} title="Rotate 90° CW">+90°</button>
                    <button className="btn btn-secondary" style={{ padding: "2px 6px", fontSize: "0.7rem" }} disabled={activeTab === "preview" || !selectedObject || selectedObjectId === "template-object"} onClick={() => flipObject("horizontal")} title="Flip horizontally">Flip H</button>
                    <button className="btn btn-secondary" style={{ padding: "2px 6px", fontSize: "0.7rem" }} disabled={activeTab === "preview" || !selectedObject || selectedObjectId === "template-object"} onClick={() => flipObject("vertical")} title="Flip vertically">Flip V</button>
                    <input 
                      type="number" 
                      value={inputRotationText} 
                      disabled={activeTab === "preview" || !selectedObject}
                      onChange={(e) => {
                        const txt = e.target.value;
                        setInputRotationText(txt);
                        const val = parseInt(txt);
                        if (!isNaN(val)) {
                          if (selectedObjectId === "template-object") {
                            setTemplateRotation(val);
                          } else {
                            setObjects(prev => prev.map(o => selectedObjectIds.includes(o.id) ? { ...o, rotation: val } : o));
                            setSlicingStats(null);
                            setRawSlicedPaths([]);
                          }
                        }
                      }}
                      style={{ width: "40px", padding: "4px 6px", fontSize: "0.75rem", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                    />
                    <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>°</span>
                  </div>
                </div>

                {/* Vertical Divider */}
                <div style={{ width: "1px", height: "24px", backgroundColor: "var(--border-color)", flexShrink: 0 }} />

                {/* Dynamic Zoom Section */}
                <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0, flexWrap: "nowrap" }}>
                  <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>Zoom:</span>
                  <button className="btn btn-secondary" style={{ padding: "2px 8px", fontSize: "0.75rem" }} onClick={() => setZoom(prev => Math.max(1.0, prev - 0.25))}>-</button>
                  <span style={{ fontSize: "0.75rem", minWidth: "35px", textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
                  <button className="btn btn-secondary" style={{ padding: "2px 8px", fontSize: "0.75rem" }} onClick={() => setZoom(prev => Math.min(5.0, prev + 0.25))}>+</button>
                  <button 
                    className="btn btn-secondary" 
                    style={{ padding: "2px 8px", fontSize: "0.75rem", marginLeft: "4px" }} 
                    onClick={() => {
                      if (prepareScrollContainerRef.current) {
                        const container = prepareScrollContainerRef.current;
                        const containerPadding = 40;
                        const availableWidth = container.clientWidth - containerPadding;
                        const availableHeight = container.clientHeight - containerPadding - 80;
                        
                        const zoomX = availableWidth / totalCanvasWidth;
                        const zoomY = availableHeight / totalCanvasHeight;
                        
                        let idealZoom = Math.min(zoomX, zoomY);
                        idealZoom = Math.max(0.5, Math.min(5.0, idealZoom));
                        idealZoom = Math.round(idealZoom * 20) / 20;
                        
                        setZoom(idealZoom);
                        
                        setTimeout(() => {
                          container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2;
                          container.scrollTop = (container.scrollHeight - container.clientHeight) / 2;
                        }, 50);
                      }
                    }}
                  >
                    Fit
                  </button>
                </div>
              </div>

              {/* White Paper Sheet Zooms with controls, while Container handles scrolling */}
              <div 
                ref={canvasWrapperRef}
                className="canvas-wrapper" 
                style={{ 
                  width: `${totalCanvasWidth * zoom}px`, 
                  height: `${totalCanvasHeight * zoom}px`, 
                  transition: "width 0.1s ease, height 0.1s ease",
                  backgroundColor: "transparent", 
                  position: "relative",
                  overflow: "hidden",
                  flexShrink: 0
                }}
              >
                <canvas
                  ref={canvasRef}
                  className="plotter-canvas"
                  width={totalCanvasWidth * 2 * zoom}
                  height={totalCanvasHeight * 2 * zoom}
                  style={{ width: "100%", height: "100%" }}
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onMouseLeave={handleCanvasMouseUp}
                />
              </div>
            </main>
            <div className="canvas-scale-indicator" style={{ position: "absolute", bottom: "20px", right: "20px", zIndex: 20 }}>
              Bed: {scaleWidth}mm x {scaleHeight}mm
            </div>
          </div>
        ) : (
          /* MONITOR TAB CENTER VIEWPORT: Dedicated Fluidd Dashboard */
          <main style={{ flex: 1, minWidth: 0, padding: "20px", display: "flex", flexDirection: "column", gap: "20px", overflowY: "auto" }}>
            {recoverySession && (
              <div 
                style={{
                  backgroundColor: "rgba(245, 158, 11, 0.08)",
                  border: "1px solid rgba(245, 158, 11, 0.3)",
                  borderRadius: "8px",
                  padding: "14px 20px",
                  width: "100%",
                  boxSizing: "border-box",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  backdropFilter: "blur(5px)",
                  flexShrink: 0
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ fontSize: "1.2rem" }}>⚠️</span>
                  <div style={{ flex: 1 }}>
                    <h4 style={{ margin: 0, fontSize: "0.85rem", color: "var(--warning)", fontWeight: "600" }}>
                      Interrupted Plotting Session Detected
                    </h4>
                    <p style={{ margin: "4px 0 0 0", fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                      A previous job for <strong>{recoverySession.objects.map((o: any) => o.name).join(", ")}</strong> was interrupted at point <strong>{recoverySession.progress?.global_point_index}</strong> of <strong>{recoverySession.progress?.total_points}</strong> ({Math.round(((recoverySession.progress?.global_point_index || 0) / (recoverySession.progress?.total_points || 1)) * 100)}%).
                    </p>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                  <button 
                    className="btn btn-success" 
                    onClick={handleResumeFromRecovery}
                    disabled={!connected}
                    style={{ fontSize: "0.75rem", padding: "6px 12px", width: "auto" }}
                    title={!connected ? "Connect AxiDraw first to resume job" : ""}
                  >
                    Resume Job from Interruption
                  </button>
                  <button 
                    className="btn btn-danger" 
                    onClick={handleDiscardRecovery}
                    style={{ fontSize: "0.75rem", padding: "6px 12px", width: "auto", backgroundColor: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", border: "1px solid rgba(239, 68, 68, 0.3)" }}
                  >
                    Discard Session
                  </button>
                  {!connected && (
                    <span style={{ fontSize: "0.7rem", color: "var(--warning)", alignSelf: "center" }}>
                      (Please connect AxiDraw to enable resume)
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Top part: Two Columns side-by-side */}
            <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: "20px", alignItems: "stretch", width: "100%" }}>
              
              {/* Column Left: Serial Terminal & Job History */}
              <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                
                {/* Console log output panel (Resizable with drag handle divider) */}
                <div 
                  ref={consoleCardRef}
                  className="telemetry-card" 
                  style={{ height: `${consoleHeight}px`, position: "relative", display: "flex", flexDirection: "column", gap: "10px", transition: isResizingConsole ? "none" : "height 0.1s ease" }}
                >
                  <h3 className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: 0 }}>
                    <span>EBB serial terminal logs</span>
                    <button className="btn btn-secondary" style={{ padding: "2px 8px", fontSize: "0.7rem", width: "auto" }} onClick={() => setConsoleLogs([])}>
                      Clear logs
                    </button>
                  </h3>
                  
                  <div ref={consoleContainerRef} className="monitor-console-container" style={{ flex: 1, minHeight: 0 }}>
                    {consoleLogs.map((log, idx) => {
                      let className = "console-log-row info";
                      if (log.startsWith("Sent:")) className = "console-log-row sent";
                      else if (log.startsWith("Received:")) className = "console-log-row recv";
                      
                      const cleanLog = log
                        .replace(/\(Ensure Pen UP to start\)/i, "(ensure pen up to start)")
                        .replace(/\(Lower Pen\)/i, "(lower pen)")
                        .replace(/\(Raise Pen\)/i, "(raise pen)")
                        .replace(/\(Return Home\)/i, "(return home)")
                        .replace(/\(Release motors\)/i, "(release motors)")
                        .replace(/\(Boundary Trace\)/i, "(boundary trace)")
                        .replace(/\(Homing carriage back to home\)/i, "(homing carriage back to home)")
                        .replace(/\(Pen at home origin\)/i, "(pen at home origin)")
                        .replace(/\(Jogging pen carriage\)/i, "(jogging pen carriage)");

                      return (
                        <div key={idx} className={className}>
                          {cleanLog}
                        </div>
                      );
                    })}
                    {consoleLogs.length === 0 && (
                      <div style={{ color: "var(--text-muted)", fontStyle: "italic", textAlign: "center", marginTop: "80px" }}>
                        Terminal listening... Send commands or start job to see EBB serial transactions.
                      </div>
                    )}
                  </div>

                  {/* EBB command manual input entry form */}
                  {connected && (
                    <form onSubmit={handleSendManualCommand} style={{ display: "flex", gap: "8px", width: "100%", flexShrink: 0, padding: "0 5px 5px 5px" }}>
                      <input 
                        type="text" 
                        placeholder="Enter manual EBB command (e.g. SP,0)..." 
                        value={manualCommandText}
                        onChange={(e) => setManualCommandText(e.target.value)}
                        style={{ flex: 1, padding: "6px 12px", fontSize: "0.8rem", fontFamily: "monospace", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "#34d399", minWidth: "0" }}
                      />
                      <button type="submit" className="btn btn-secondary" style={{ padding: "6px 12px", fontSize: "0.8rem", width: "auto", flexShrink: 0 }}>Send</button>
                    </form>
                  )}

                  {/* Drag Resize Handle Divider */}
                  <div 
                    onMouseDown={handleConsoleResizeMouseDown}
                    style={{ 
                      position: "absolute", 
                      bottom: 0, 
                      left: 0, 
                      right: 0, 
                      height: "6px", 
                      cursor: "ns-resize", 
                      backgroundColor: isResizingConsole ? "var(--accent-color)" : "transparent",
                      borderBottomLeftRadius: "12px",
                      borderBottomRightRadius: "12px",
                      transition: "background-color 0.15s",
                      zIndex: 10
                    }} 
                    title="Drag to resize console widget"
                  />
                </div>

                {/* Job History & Quick Relaunch Panel */}
                <div className="telemetry-card" style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "15px 20px" }}>
                  <h3 className="card-title" style={{ margin: 0 }}>Job History & Quick Relaunch</h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "250px", overflowY: "auto" }}>
                    {jobHistory.length > 0 ? (
                      jobHistory.map((job) => (
                        <div 
                          key={job.id} 
                          style={{ 
                            display: "flex", 
                            justifyContent: "space-between", 
                            alignItems: "center", 
                            padding: "10px 14px", 
                            backgroundColor: "var(--bg-primary)", 
                            border: "1px solid var(--border-color)", 
                            borderRadius: "6px" 
                          }}
                        >
                          <div style={{ display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: 0, marginRight: "12px" }}>
                            <span style={{ fontSize: "0.85rem", fontWeight: "bold", color: "var(--text-primary)", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                              {job.name}
                            </span>
                            <span style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>
                              Time: {job.timestamp} | Status:{" "}
                              <span style={{ color: job.status === "completed" ? "var(--success)" : "var(--danger)", fontWeight: "bold" }}>
                                {job.status === "completed" ? "Completed" : "Aborted"}
                              </span>
                              {job.stats && ` | Distance: ${(job.stats.drawDist / 1000).toFixed(2)}m`}
                            </span>
                          </div>
                          <button 
                            className="btn btn-success" 
                            onClick={() => handleRelaunchJob(job)} 
                            disabled={!connected || isPlotting}
                            style={{ padding: "4px 10px", fontSize: "0.75rem", width: "auto" }}
                          >
                            Relaunch
                          </button>
                        </div>
                      ))
                    ) : (
                      <div style={{ textAlign: "center", color: "var(--text-muted)", fontStyle: "italic", padding: "15px" }}>
                        No past jobs recorded. Start a print job to populate history.
                      </div>
                    )}
                  </div>
                </div>

              </div>

              {/* Column Right: Live Visualizer Preview */}
              <div style={{ display: "flex" }}>
                <div 
                  className="telemetry-card" 
                  style={{ flex: 1, display: "flex", flexDirection: "column", gap: "10px", padding: "20px", boxSizing: "border-box" }}
                >
                  <h3 className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: 0, borderBottom: "1px solid var(--border-color)", paddingBottom: "10px" }}>
                    <span>Live visualizer preview</span>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                        <span style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>Zoom:</span>
                        <button className="btn btn-secondary" style={{ padding: "1px 6px", fontSize: "0.65rem" }} onClick={() => setMonitorZoom(prev => Math.max(1.0, prev - 0.25))}>-</button>
                        <span style={{ fontSize: "0.75rem", minWidth: "30px", textAlign: "center" }}>{Math.round(monitorZoom * 100)}%</span>
                        <button className="btn btn-secondary" style={{ padding: "1px 6px", fontSize: "0.65rem" }} onClick={() => setMonitorZoom(prev => Math.min(5.0, prev + 0.25))}>+</button>
                        <button className="btn btn-secondary" style={{ padding: "1px 6px", fontSize: "0.65rem", marginLeft: "4px" }} onClick={handleCenterMonitorView}>Center</button>
                      </div>
                      <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.75rem", fontWeight: "normal", cursor: "pointer", userSelect: "none" }}>
                        <input type="checkbox" checked={showFuturePath} onChange={(e) => setShowFuturePath(e.target.checked)} />
                        Show next path
                      </label>
                    </div>
                  </h3>
                  
                  {/* Visualizer canvas representing real-time print tracking */}
                  <div 
                    ref={monitorCanvasContainerCallback}
                    onMouseDown={handleMonitorMouseDown}
                    onMouseMove={handleMonitorMouseMove}
                    onMouseUp={handleMonitorMouseUp}
                    onMouseLeave={handleMonitorMouseUp}
                    onContextMenu={(e) => {
                      if (isPanningMonitor) e.preventDefault();
                    }}
                    style={{ display: "flex", justifyContent: "center", alignItems: "center", flex: 1, minHeight: 0, width: "100%", backgroundColor: "var(--bg-primary)", borderRadius: "8px", border: "1px solid var(--border-color)", padding: "10px", position: "relative", overflow: "hidden", cursor: isPanningMonitor ? "grabbing" : "grab" }}
                  >
                    <canvas 
                      ref={monitorCanvasRef} 
                      width={320 * monitorZoom} 
                      height={230 * monitorZoom} 
                      style={{ width: `${320 * monitorZoom}px`, height: `${230 * monitorZoom}px`, borderRadius: "4px", flexShrink: 0, margin: "auto" }}
                    />

                    {progress && (
                      <div style={{ position: "absolute", bottom: "15px", right: "15px", backgroundColor: "rgba(0,0,0,0.85)", border: "1px solid var(--border-color)", padding: "4px 10px", borderRadius: "6px", fontSize: "0.75rem", fontFamily: "monospace", color: "var(--success)", zIndex: 10 }}>
                        Progress: {Math.round((progress.global_point_index / progress.total_points) * 100)}%
                      </div>
                    )}
                  </div>

                  {/* Tactile manual overrides */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "5px" }}>
                    {connected ? (
                      <div className="form-row">
                        {!isPlotting ? (
                          <button className="btn btn-success" onClick={handleStartPlot} disabled={slicingStats === null}>
                            Start plot job
                          </button>
                        ) : (
                          <>
                            {isPaused ? (
                              <button className="btn btn-success" onClick={handleResumePlot}>Resume</button>
                            ) : (
                              <button className="btn btn-secondary" onClick={handlePausePlot}>Pause</button>
                            )}
                            <button className="btn btn-danger" onClick={handleStopPlot}>Stop plot</button>
                          </>
                        )}
                      </div>
                    ) : (
                      <div style={{ textAlign: "center", padding: "10px", color: "var(--warning)", border: "1px solid var(--warning)", borderRadius: "6px", fontSize: "0.85rem", backgroundColor: "rgba(234, 179, 8, 0.05)" }}>
                        Disconnected from AxiDraw plotter.
                      </div>
                    )}
                  </div>
                </div>
              </div>

            </div>

            {/* Bottom part: Real-time Job Statistics Tracker Card (full width) */}
            <div className="telemetry-card" style={{ width: "100%", marginTop: "10px" }}>
              <h3 className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Job statistics tracker</span>
                <span className={`status-badge ${jobStats.status}`} style={{
                  fontSize: "0.75rem",
                  padding: "2px 8px",
                  borderRadius: "12px",
                  textTransform: "uppercase",
                  fontWeight: "bold",
                  backgroundColor: jobStats.status === "printing" ? "rgba(234, 179, 8, 0.15)" :
                                   jobStats.status === "paused" ? "rgba(96, 165, 250, 0.15)" :
                                   jobStats.status === "completed" ? "rgba(52, 211, 153, 0.15)" :
                                   jobStats.status === "aborted" ? "rgba(239, 68, 68, 0.15)" : "rgba(156, 163, 175, 0.1)",
                  color: jobStats.status === "printing" ? "var(--warning)" :
                         jobStats.status === "paused" ? "var(--info)" :
                         jobStats.status === "completed" ? "var(--success)" :
                         jobStats.status === "aborted" ? "var(--danger)" : "var(--text-muted)",
                  border: `1px solid ${
                    jobStats.status === "printing" ? "rgba(234, 179, 8, 0.3)" :
                    jobStats.status === "paused" ? "rgba(96, 165, 250, 0.3)" :
                    jobStats.status === "completed" ? "rgba(52, 211, 153, 0.3)" :
                    jobStats.status === "aborted" ? "rgba(239, 68, 68, 0.3)" : "rgba(156, 163, 175, 0.2)"
                  }`
                }}>
                  {jobStats.status}
                </span>
              </h3>
              
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "15px", padding: "5px" }}>
                <div style={{ backgroundColor: "var(--bg-primary)", padding: "10px 14px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Distance Drawn</div>
                  <strong style={{ fontSize: "1.2rem", color: "var(--accent-color)" }}>{jobStats.distanceDrawn.toFixed(2)} <span style={{ fontSize: "0.8rem", fontWeight: "normal", color: "var(--text-muted)" }}>meters</span></strong>
                </div>
                
                <div style={{ backgroundColor: "var(--bg-primary)", padding: "10px 14px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Air Travel Distance</div>
                  <strong style={{ fontSize: "1.2rem", color: "var(--warning)" }}>{jobStats.distanceTraveled.toFixed(2)} <span style={{ fontSize: "0.8rem", fontWeight: "normal", color: "var(--text-muted)" }}>m ({formatTime(jobStats.airTravelTime)})</span></strong>
                </div>

                <div style={{ backgroundColor: "var(--bg-primary)", padding: "10px 14px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Points Completed</div>
                  <strong style={{ fontSize: "1.2rem" }}>{jobStats.pointsCompleted} / {jobStats.totalPoints}</strong>
                </div>

                <div style={{ backgroundColor: "var(--bg-primary)", padding: "10px 14px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Paths Completed</div>
                  <strong style={{ fontSize: "1.2rem" }}>{jobStats.pathsCompleted} / {jobStats.totalPaths}</strong>
                </div>

                <div style={{ backgroundColor: "var(--bg-primary)", padding: "10px 14px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Time Elapsed (total)</div>
                  <strong style={{ fontSize: "1.2rem" }}>{formatTime(jobStats.elapsedTime)}</strong>
                </div>

                <div style={{ backgroundColor: "var(--bg-primary)", padding: "10px 14px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Est. Remaining (total)</div>
                  <strong style={{ fontSize: "1.2rem", color: jobStats.status === "printing" ? "var(--success)" : "var(--text-muted)" }}>
                    {jobStats.status === "printing" ? formatTime(jobStats.estimatedRemaining) : "0m 0s"}
                  </strong>
                </div>
              </div>
              
              <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginTop: "10px", fontStyle: "italic", padding: "0 5px" }}>
                * Estimated Remaining and Time Elapsed represent total job durations, including both drawing and air travel phases.
              </div>
            </div>

          </main>
        )}

        {/* RIGHT COLUMN: Connection & Plotter Controller */}
        <aside className="sidebar right">
          <h2 className="sidebar-title">Controller Panel</h2>

          {/* Connection Card */}
          <div className="card-section">
            <h3 className="card-title">Connection</h3>
            <div className="form-group">
              <label>Serial port</label>
              <div className="form-row">
                <select value={selectedPort} onChange={(e) => setSelectedPort(e.target.value)}>
                  {ports.map((p) => (
                    <option key={p.port_name} value={p.port_name}>
                      {p.display_name}
                    </option>
                  ))}
                  {ports.length === 0 && <option value="">No ports found</option>}
                </select>
                <button className="btn btn-secondary" onClick={scanPorts} style={{ padding: "8px" }}>Scan</button>
              </div>
            </div>

            <div className="form-group">
              <label>Bed origin corner</label>
              <select value={originCorner} onChange={(e) => setOriginCorner(e.target.value as "top-left" | "top-right")}>
                <option value="top-left">Top-left (standard)</option>
                <option value="top-right">Top-right (mirrored setup)</option>
              </select>
              <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", display: "block", marginTop: "2px" }}>
                Select top-right if your mechanical zero is physically at the top-right of your page.
              </span>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Pen UP (PWM)</label>
                <input type="number" value={penUpHeight} onChange={(e) => setPenUpHeight(parseInt(e.target.value) || 12000)} />
              </div>
              <div className="form-group">
                <label>Pen DOWN (PWM)</label>
                <input type="number" value={penDownHeight} onChange={(e) => setPenDownHeight(parseInt(e.target.value) || 16000)} />
              </div>
            </div>

            <button className={`btn ${connected ? "btn-danger" : "btn-primary"}`} onClick={handleConnect}>
              {connected ? "Disconnect" : "Connect plotter"}
            </button>
            <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", textAlign: "center" }}>
              {statusMsg}
            </div>
          </div>

          {/* Live Position Feedback Widget */}
          <div className="card-section">
            <h3 className="card-title">Live Position Feedback</h3>
            
            <div style={{ backgroundColor: "rgba(234, 179, 8, 0.08)", borderLeft: "3px solid var(--warning)", padding: "8px", borderRadius: "4px", fontSize: "0.72rem", color: "var(--text-secondary)", marginBottom: "8px" }}>
              Before clicking zero position, manually slide your carriage to its home corner (fully retract the Y-axis).
            </div>

            <div style={{ display: "flex", justifyContent: "space-around", backgroundColor: "var(--bg-tertiary)", padding: "10px", borderRadius: "6px", border: "1px solid var(--border-color)", fontFamily: "monospace", fontSize: "1.05rem", marginBottom: "8px" }}>
              <div>X: <span style={{ color: "var(--accent-color)", fontWeight: "bold" }}>{currentPos.x.toFixed(1)}</span> mm</div>
              <div>Y: <span style={{ color: "var(--accent-color)", fontWeight: "bold" }}>{currentPos.y.toFixed(1)}</span> mm</div>
            </div>

            <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: "8px", textAlign: "center" }}>
              Home status: {homeSetTimestamp ? <strong style={{ color: "var(--success)" }}>Set at {homeSetTimestamp}</strong> : <span style={{ color: "var(--text-muted)" }}>Not set yet</span>}
            </div>

            {connected && (
              <button className="btn btn-secondary" onClick={handleZeroPlotter} style={{ width: "100%" }}>
                Zero position (set home)
              </button>
            )}
          </div>

          {/* Stepper Manual Jog Controls */}
          {connected && (
            <div className="card-section">
              <h3 className="card-title">Manual Control</h3>
              
              <div className="jog-grid">
                <button className="jog-btn" style={{ gridArea: "1 / 2" }} onClick={() => handleJog("up")} disabled={!canJogUp}>Up</button>
                <button className="jog-btn" style={{ gridArea: "2 / 1" }} onClick={() => handleJog("left")} disabled={!canJogLeft}>Left</button>
                <button className="jog-btn" style={{ gridArea: "2 / 2" }} onClick={() => handleJog("center")}>Home</button>
                <button className="jog-btn" style={{ gridArea: "2 / 3" }} onClick={() => handleJog("right")} disabled={!canJogRight}>Right</button>
                <button className="jog-btn" style={{ gridArea: "3 / 2" }} onClick={() => handleJog("down")} disabled={!canJogDown}>Down</button>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Jog distance (mm)</label>
                  <input type="number" value={jogStep} onChange={(e) => setJogStep(parseFloat(e.target.value))} />
                </div>
                <div className="form-group">
                  <label>Jog speed (mm/s)</label>
                  <input type="number" value={jogSpeed} onChange={(e) => setJogSpeed(parseFloat(e.target.value))} />
                </div>
              </div>

              <div className="form-row" style={{ marginTop: "4px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "0.8rem" }}>
                  <input type="checkbox" checked={invertX} onChange={(e) => setInvertX(e.target.checked)} />
                  Invert X axis (plot & jog)
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "0.8rem" }}>
                  <input type="checkbox" checked={invertY} onChange={(e) => setInvertY(e.target.checked)} />
                  Invert Y axis (plot & jog)
                </label>
              </div>

              {/* Single Pen Switch */}
              <div style={{ marginTop: "10px" }}>
                <button 
                  className={`btn ${isPenDown ? "btn-danger" : "btn-primary"}`} 
                  onClick={handleTogglePenState}
                  style={{ width: "100%" }}
                >
                  Pen position: {isPenDown ? "DOWN" : "UP"}
                </button>
              </div>

              {/* Condensed Motors Toggle Switch */}
              <div style={{ marginTop: "8px" }}>
                <button 
                  className={`btn ${areMotorsEnabled ? "btn-success" : "btn-warning"}`} 
                  onClick={handleToggleMotorsState}
                  style={{ width: "100%" }}
                >
                  Motors: {areMotorsEnabled ? "ENABLED" : "RELEASED"}
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* JOB COMPLETED NOTIFICATION MODAL: Premium Dark Telemetry View */}
      {showFinishedModal && (
        <div 
          style={{ 
            position: "fixed", 
            top: 0, 
            left: 0, 
            width: "100vw", 
            height: "100vh", 
            backgroundColor: "rgba(0,0,0,0.85)", 
            display: "flex", 
            alignItems: "center", 
            justifyContent: "center", 
            zIndex: 1000 
          }}
        >
          <div 
            style={{ 
              backgroundColor: "var(--bg-secondary)", 
              border: "1px solid var(--success)", 
              borderRadius: "12px", 
              width: "480px", 
              padding: "30px", 
              boxShadow: "0 10px 40px rgba(0,0,0,0.8)",
              display: "flex",
              flexDirection: "column",
              gap: "20px"
            }}
          >
            <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "10px" }}>
              <span style={{ fontSize: "0.75rem", color: "var(--success)", fontWeight: "bold", textTransform: "uppercase", letterSpacing: "1px" }}>Plot completed successfully</span>
              <h2 style={{ fontSize: "1.4rem", fontWeight: "600", color: "var(--text-primary)", marginTop: "4px" }}>AxiDraw job execution report</h2>
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <span>Actual time taken:</span>
                <strong style={{ color: "var(--success)" }}>{formatTime(actualElapsedSeconds)}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderTop: "1px solid var(--border-color)" }}>
                <span>Estimated time (total):</span>
                <strong>{slicingStats ? formatTime(slicingStats.timeEst) : "0m 0s"}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <span>Draw distance:</span>
                <strong>{slicingStats ? (slicingStats.drawDist / 1000).toFixed(2) : "0.00"} m</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <span>Air travel:</span>
                <strong>
                  {slicingStats ? (slicingStats.airDist / 1000).toFixed(2) : "0.00"} m 
                  {slicingStats && slicingStats.airTimeEst !== undefined ? ` (${formatTime(slicingStats.airTimeEst)})` : ""}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <span>Pen lifts:</span>
                <strong>{slicingStats ? slicingStats.numLifts : 0}</strong>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "10px" }}>
              <button 
                className="btn btn-success" 
                onClick={() => setShowFinishedModal(false)}
                style={{ width: "100px", padding: "6px 12px" }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LOADING OVERLAY */}
      {loadingText && (
        <div 
          style={{ 
            position: "fixed", 
            top: 0, 
            left: 0, 
            width: "100vw", 
            height: "100vh", 
            backgroundColor: "rgba(12, 15, 18, 0.75)", 
            backdropFilter: "blur(4px)",
            display: "flex", 
            flexDirection: "column",
            alignItems: "center", 
            justifyContent: "center", 
            zIndex: 2000,
            gap: "15px"
          }}
        >
          {/* Spinning Loader */}
          <div style={{
            width: "45px",
            height: "45px",
            border: "3px solid var(--border-color)",
            borderTop: "3px solid var(--accent-color)",
            borderRadius: "50%",
            animation: "spin 1s linear infinite"
          }} />
          <div style={{ 
            color: "var(--text-primary)", 
            fontSize: "0.95rem", 
            fontWeight: "500",
            letterSpacing: "0.5px"
          }}>
            {loadingText}
          </div>
          
          <style>{`
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          `}</style>
        </div>
      )}
    </div>
  );
}

export default App;
