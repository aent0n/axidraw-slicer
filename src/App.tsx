import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseSVG } from "./utils/svgParser";

interface Point {
  x: number;
  y: number;
}

interface Toolpath {
  points: Point[];
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
  scale: number;
  rotation: number;
}

const formatTime = (secs: number): string => {
  const mins = Math.floor(secs / 60);
  const remainingSecs = Math.round(secs % 60);
  return `${mins}m ${remainingSecs}s`;
};

const CANVAS_PADDING = 20;

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

  // Slicer Multi-Object State & Selection Grouping
  const [objects, setObjects] = useState<SlicerObject[]>([]);
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const selectedObjectId = selectedObjectIds[selectedObjectIds.length - 1] || null;

  // Input text buffer states (to prevent snapping/resetting while typing)
  const [inputScaleText, setInputScaleText] = useState("");
  const [inputRotationText, setInputRotationText] = useState("");

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

  // Pen Profiles Manager
  const [penProfiles, setPenProfiles] = useState<PenProfile[]>([
    { id: "generic", name: "Generic standard pen", capacityMeters: 2000, accumulatedDistanceMeters: 0 },
    { id: "pilot-g2", name: "Pilot G2 gel pen", capacityMeters: 1500, accumulatedDistanceMeters: 0 },
    { id: "micron", name: "Sakura Micron fine-liner", capacityMeters: 800, accumulatedDistanceMeters: 0 },
    { id: "bic", name: "Bic Cristal ballpoint", capacityMeters: 2500, accumulatedDistanceMeters: 0 },
  ]);
  const [activeProfileId, setActiveProfileId] = useState("generic"); // default is generic
  
  // Custom Profile Add
  const [newPenName, setNewPenName] = useState("");
  const [newPenCapacity, setNewPenCapacity] = useState(1000);

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
  const consoleEndRef = useRef<HTMLDivElement | null>(null);
  const monitorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const consoleCardRef = useRef<HTMLDivElement | null>(null);
  const monitorCanvasContainerRef = useRef<HTMLDivElement | null>(null);
  const prepareScrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Refs to avoid stale closures in event listeners
  const slicingStatsRef = useRef(slicingStats);
  useEffect(() => { slicingStatsRef.current = slicingStats; }, [slicingStats]);

  const jobStartTimeRef = useRef(jobStartTime);
  useEffect(() => { jobStartTimeRef.current = jobStartTime; }, [jobStartTime]);

  const isPausedRef = useRef(isPaused);
  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);

  const slicedPathsRef = useRef(slicedPaths);
  useEffect(() => { slicedPathsRef.current = slicedPaths; }, [slicedPaths]);

  // Click-and-drag panning states
  const [isPanningPrepare, setIsPanningPrepare] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });
  const [isPanningMonitor, setIsPanningMonitor] = useState(false);
  const [panStartMonitor, setPanStartMonitor] = useState({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  // Slicer Clipboard
  const [clipboard, setClipboard] = useState<SlicerObject | null>(null);
  const [allowArrangeResize, setAllowArrangeResize] = useState<boolean>(false);
  const [jobHistory, setJobHistory] = useState<PastJob[]>([]);

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
    const scaleFactor = obj.scale / 100;
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
        x *= scaleFactor;
        y *= scaleFactor;
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

      const scaleFactor = obj.scale / 100;
      const rad = (obj.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      const bedCenterX = scaleWidth / 2;
      const bedCenterY = scaleHeight / 2;

      const processedObjPaths = obj.rawPaths.map((path) => {
        const points = path.points.map((pt) => {
          let x = pt.x - cx;
          let y = pt.y - cy;

          x *= scaleFactor;
          y *= scaleFactor;

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
        return { points };
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    if (file.name.endsWith(".svg")) {
      setFileType("svg");
      reader.onload = (event) => {
        const svgText = event.target?.result as string;
        try {
          const parsed = parseSVG(svgText, scaleWidth, scaleHeight);
          
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
            scale: 100,
            rotation: 0
          };
          setObjects(prev => [...prev, newObj]);
          setSelectedObjectIds([newObj.id]);
          setSlicingStats(null);
          setSlicedPaths([]);
          setStatusMsg(`Loaded SVG object: ${finalName}`);
        } catch (err: any) {
          setStatusMsg(`SVG Error: ${err.message}`);
        }
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
      };
      reader.readAsArrayBuffer(file);
    }
    
    // Clear input value to allow selecting same file again
    e.target.value = "";
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
        scale: 100,
        rotation: 0
      };

      setObjects(prev => [...prev, newObj]);
      setSelectedObjectIds([newObj.id]);
      setSlicingStats(null);
      setSlicedPaths([]);
      setStatusMsg("Generated vectorized object from image");
    } catch (err: any) {
      setStatusMsg(`Vectorizer failed: ${err}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddPenProfile = () => {
    if (!newPenName.trim()) return;
    const newId = `custom-${Date.now()}`;
    const newProfile: PenProfile = {
      id: newId,
      name: newPenName,
      capacityMeters: newPenCapacity,
      accumulatedDistanceMeters: 0
    };
    setPenProfiles(prev => [...prev, newProfile]);
    setActiveProfileId(newId);
    setNewPenName("");
    setStatusMsg(`Added custom pen profile: ${newPenName}`);
  };

  const rotate90 = (direction: "left" | "right") => {
    if (activeTab === "preview") return;
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
    setSlicedPaths([]);
  };

  const handleArrangeAll = () => {
    if (activeTab === "preview") return;
    const N = objects.length;
    if (N === 0) return;

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

      let newScale = obj.scale;
      let objW = rawW * (newScale / 100);
      let objH = rawH * (newScale / 100);

      if (allowArrangeResize) {
        // If auto-scale is allowed, fit inside a default cell width/height
        const cols = Math.ceil(Math.sqrt(N));
        const rows = Math.ceil(N / cols);
        const cellW = (scaleWidth - margin * 2) / cols;
        const cellH = (scaleHeight - margin * 2) / rows;
        const maxFitW = cellW * 0.9;
        const maxFitH = cellH * 0.9;
        const scaleRatio = Math.min(maxFitW / rawW, maxFitH / rawH);
        newScale = Math.max(10, Math.min(400, Math.floor(scaleRatio * 100)));
        objW = rawW * (newScale / 100);
        objH = rawH * (newScale / 100);
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
        scale: newScale,
        offsetX: newOffsetX,
        offsetY: newOffsetY
      };
    });

    setObjects(arranged);
    setSlicingStats(null);
    setSlicedPaths([]);
    setStatusMsg(`Arranged ${N} designs compactly near home with ${spacing}mm safety spacing.`);
  };

  const handleSlice = () => {
    const combinedPaths = getProcessedToolpaths();
    if (combinedPaths.length === 0) return;

    setStatusMsg("Slicing and optimizing toolpath...");
    
    const unvisited = [...combinedPaths];
    const optimizedPaths: Toolpath[] = [];
    
    let currPos: Point = { x: 0, y: 0 };

    while (unvisited.length > 0) {
      let minDistance = Infinity;
      let bestIdx = 0;
      let shouldReverse = false;

      for (let i = 0; i < unvisited.length; i++) {
        const path = unvisited[i];
        if (path.points.length === 0) continue;
        
        const startPt = path.points[0];
        const endPt = path.points[path.points.length - 1];

        const dStart = Math.hypot(startPt.x - currPos.x, startPt.y - currPos.y);
        const dEnd = Math.hypot(endPt.x - currPos.x, endPt.y - currPos.y);

        if (dStart < minDistance) {
          minDistance = dStart;
          bestIdx = i;
          shouldReverse = false;
        }
        if (dEnd < minDistance) {
          minDistance = dEnd;
          bestIdx = i;
          shouldReverse = true;
        }
      }

      const nextPath = unvisited.splice(bestIdx, 1)[0];
      if (shouldReverse) {
        nextPath.points.reverse();
      }
      
      currPos = nextPath.points[nextPath.points.length - 1];
      optimizedPaths.push(nextPath);
    }

    setSlicedPaths(optimizedPaths);
    setActiveTab("preview");
    setStatusMsg("Toolpath sliced and optimized successfully!");
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
    const selected = objects.find(o => o.id === selectedObjectId);
    if (selected) {
      setInputScaleText(selected.scale.toString());
      setInputRotationText(selected.rotation.toString());
    } else {
      setInputScaleText("");
      setInputRotationText("");
    }
  }, [selectedObjectId, objects]);

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
          setObjects(prev => prev.filter(o => !selectedObjectIds.includes(o.id)));
          setSelectedObjectIds([]);
          setSlicingStats(null);
          setStatusMsg("Deleted selected objects");
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [objects, selectedObjectIds, clipboard, activeTab]);

  // Scroll wheel zoom on bed wrapper
  useEffect(() => {
    const wrapper = canvasWrapperRef.current;
    if (!wrapper) return;
    
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // Only zoom if Ctrl key is held!
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 0.15 : -0.15;
      setZoom(prev => Math.max(1.0, Math.min(5.0, prev + zoomFactor)));
    };
    
    wrapper.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      wrapper.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // Scroll wheel zoom on live visualizer preview wrapper
  useEffect(() => {
    const container = monitorCanvasContainerRef.current;
    if (!container) return;
    
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // Only zoom if Ctrl key is held!
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 0.25 : -0.25;
      setMonitorZoom(prev => Math.max(1.0, Math.min(5.0, prev + zoomFactor)));
    };
    
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [activeTab]);

  // Autoscroll monitor console
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: "smooth" });
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
    let unlistenProgress: (() => void) | null = null;
    let unlistenFinished: (() => void) | null = null;
    let unlistenInkscape: (() => void) | null = null;
    let unlistenLog: (() => void) | null = null;

    listen<ProgressPayload>("plot-progress", (event) => {
      setProgress(event.payload);
      setCurrentPos({ x: event.payload.x, y: event.payload.y });

      const payload = event.payload;
      const elapsed = jobStartTimeRef.current ? Math.round((Date.now() - jobStartTimeRef.current) / 1000) : 0;
      const totalPoints = payload.total_points > 0 ? payload.total_points : 1;
      const ratio = payload.global_point_index / totalPoints;
      
      const drawM = slicingStatsRef.current ? (slicingStatsRef.current.drawDist * ratio) / 1000.0 : 0.0;
      const travelM = slicingStatsRef.current ? (slicingStatsRef.current.airDist * ratio) / 1000.0 : 0.0;
      const remaining = slicingStatsRef.current ? Math.max(0, Math.round(slicingStatsRef.current.timeEst - elapsed)) : 0;
      const airTravelSecs = slicingStatsRef.current ? slicingStatsRef.current.airTimeEst * ratio : 0.0;

      setJobStats({
        status: isPausedRef.current ? "paused" : "printing",
        pointsCompleted: payload.global_point_index,
        totalPoints: payload.total_points,
        pathsCompleted: payload.path_index,
        totalPaths: slicedPathsRef.current.length,
        distanceDrawn: parseFloat(drawM.toFixed(2)),
        distanceTraveled: parseFloat(travelM.toFixed(2)),
        elapsedTime: elapsed,
        estimatedRemaining: remaining,
        airTravelTime: Math.round(airTravelSecs)
      });
    }).then((fn) => {
      unlistenProgress = fn;
    });

    listen<string>("ebb-log", (event) => {
      setConsoleLogs(prev => [...prev.slice(-99), event.payload]);
    }).then((fn) => {
      unlistenLog = fn;
    });

    listen<boolean>("plot-finished", (event) => {
      const aborted = event.payload;
      setIsPlotting(false);
      setIsPaused(false);
      setProgress(null);
      setCurrentPos({ x: 0, y: 0 });
      setIsPenDown(false);
      setStatusMsg(aborted ? "Job Aborted" : "Job Finished");

      setJobStats((prev) => {
        return {
          ...prev,
          status: aborted ? "aborted" : "completed"
        };
      });
      
      // Calculate elapsed time and open completion screen only if not aborted
      if (!aborted && jobStartTime) {
        const elapsed = Math.round((Date.now() - jobStartTime) / 1000);
        setActualElapsedSeconds(elapsed);
        setShowFinishedModal(true);
        setJobStartTime(null);
      } else {
        setJobStartTime(null);
      }

      // Add to job history list
      addToJobHistory(aborted);

      // Update pen profiles distance tracker upon job completion
      if (slicingStats) {
        setPenProfiles(prev => prev.map(p => {
          if (p.id === activeProfileId) {
            return {
              ...p,
              accumulatedDistanceMeters: p.accumulatedDistanceMeters + (slicingStats.drawDist / 1000)
            };
          }
          return p;
        }));
      }
    }).then((fn) => {
      unlistenFinished = fn;
    });

    listen<string>("inkscape-import", (event) => {
      const svgText = event.payload;
      try {
        const parsed = parseSVG(svgText, scaleWidth, scaleHeight);
        setObjects((prev) => {
          const newObj: SlicerObject = {
            id: `obj-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            name: `Inkscape Import ${prev.length + 1}`,
            rawPaths: parsed,
            offsetX: 0,
            offsetY: 0,
            scale: 100,
            rotation: 0
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
      unlistenInkscape = fn;
    });

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenFinished) unlistenFinished();
      if (unlistenInkscape) unlistenInkscape();
      if (unlistenLog) unlistenLog();
    };
  }, [scaleWidth, scaleHeight, originCorner, slicingStats, activeProfileId, jobStartTime]);

  useEffect(() => {
    renderCanvas();
  }, [objects, progress, scaleWidth, scaleHeight, margin, selectedObjectIds, activeTab, simulatedPointsCount, originCorner, currentPos, invertX, invertY, zoom, connected]);

  // Redirect to Prepare tab if plotter disconnects while in Monitor tab
  useEffect(() => {
    if (!connected && activeTab === "monitor") {
      setActiveTab("prepare");
      setStatusMsg("Disconnected: Monitor tab closed");
    }
  }, [connected, activeTab]);

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
  }, [progress, currentPos, scaleWidth, scaleHeight, activeTab, objects, showFuturePath, invertX, invertY, slicedPaths, monitorZoom, connected]);

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

    // Draw grid marks (every 50mm) inside the bed boundaries
    ctx.strokeStyle = "rgba(0, 0, 0, 0.04)";
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
        ctx.strokeStyle = activeTab === "preview" ? "rgba(99, 102, 241, 0.7)" : "rgba(0, 0, 0, 0.65)";
        ctx.lineWidth = activeTab === "preview" ? 1.4 * 2 : 1.0 * 2;
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

    // Draw selection borders & Drag/Scale/Rotate handles
    if (activeTab === "prepare" && selectedObjectId) {
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

    // Draw Home Origin Target Indicator (permanent CAD-style crosshair visual aid)
    if (activeTab === "prepare") {
      const homeX = originCorner === "top-right" ? scaleWidth : 0;
      const homeY = 0;
      
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
    if (activeTab === "preview" || activeTab === "monitor") return; // Freeze dragging in Preview/Monitor

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    // Shift coordinates by CANVAS_PADDING to map directly to millimeters
    const mmX = ((clientX - CANVAS_PADDING) / (rect.width - CANVAS_PADDING * 2)) * scaleWidth;
    const mmY = ((clientY - CANVAS_PADDING) / (rect.height - CANVAS_PADDING * 2)) * scaleHeight;

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
            setDragStart({ x: mmX, y: mmY, initOffsetX: obj.scale, initOffsetY: 0 });
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

    if (clickedObjId) {
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
          setObjects(prev => prev.map(o => selectedObjectIds.includes(o.id) ? { ...o, scale: newScale } : o));
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
      
      if (selectedObjectId) {
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

  const addToJobHistory = (aborted: boolean) => {
    const jobName = objects.length > 0 
      ? objects.map(o => o.name).join(", ") 
      : "Custom Plot Job";
    
    const newJob: PastJob = {
      id: `job-${Date.now()}`,
      name: jobName.length > 40 ? jobName.substring(0, 37) + "..." : jobName,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      paths: slicedPaths.length > 0 ? [...slicedPaths] : getProcessedToolpaths(),
      stats: slicingStats,
      status: aborted ? "aborted" : "completed"
    };
    
    setJobHistory(prev => [newJob, ...prev.slice(0, 9)]);
  };

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
    setStatusMsg("Stopping plot... Raising pen and returning home...");
    try {
      await invoke("stop_plot"); // halts active moves instantly
      setIsPlotting(false);
      setIsPaused(false);
      setIsPenDown(false);
      setJobStartTime(null);
      setJobStats(prev => ({ ...prev, status: "aborted" }));
      setStatusMsg("Plot Stopped. Returning home...");
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
          const activeJogSpeed = jogSpeed * (speedMultiplier / 100);
          await invoke("home_plotter", { speed: activeJogSpeed });
          setCurrentPos({ x: 0, y: 0 });
          setIsPenDown(false); // Pen UP on home
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
  const selectedObject = objects.find(o => o.id === selectedObjectId);

  const canvasHeight = 550;
  const canvasWidth = Math.round(canvasHeight * (scaleWidth / scaleHeight));

  const totalCanvasWidth = canvasWidth + CANVAS_PADDING * 2;
  const totalCanvasHeight = canvasHeight + CANVAS_PADDING * 2;

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="brand-section">
          <svg className="brand-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 19l7-7 3 3-10 10L2 15l3-3z"/>
            <path d="M19 12V5a2 2 0 00-2-2H7a2 2 0 00-2 2v7"/>
          </svg>
          <span className="brand-title">AXIDRAW SLICER & CONTROL</span>
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
                <div className="file-dropzone" onClick={() => document.getElementById("file-input")?.click()}>
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
                              setSlicedPaths([]);
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
                  </div>
                )}
              </div>

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

              {/* Pen Profile Presets & Life Tracker */}
              <div className="card-section">
                <h3 className="card-title">Pen Profile Presets</h3>
                <div className="form-group">
                  <label>Active Pen Profile</label>
                  <select value={activeProfileId} onChange={(e) => setActiveProfileId(e.target.value)}>
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
                  <div className="form-row" style={{ alignItems: "center" }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <input type="number" placeholder="Cap. (m)" value={newPenCapacity} onChange={(e) => setNewPenCapacity(parseInt(e.target.value) || 1000)} style={{ fontSize: "0.8rem", width: "80px" }} />
                    </div>
                    <button className="btn btn-secondary" onClick={handleAddPenProfile} style={{ flex: 1, padding: "5px 10px", fontSize: "0.8rem" }}>
                      Add pen
                    </button>
                  </div>
                </div>
              </div>

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
                    </select>
                  </div>

                  <div className="slider-group">
                    <div className="slider-header">
                      <label>{algorithm === "tsp" ? "Stipple points" : "Density/Max lines"}</label>
                      <span className="slider-val">{maxLines}</span>
                    </div>
                    <input type="range" min="100" max="4000" step="50" value={maxLines} onChange={(e) => setMaxLines(parseInt(e.target.value))} />
                  </div>

                  {algorithm === "hatch" && (
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
                </div>
              )}

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
                    <span>Estimated time:</span>
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

                <button className="btn btn-secondary" onClick={() => setActiveTab("prepare")} style={{ marginTop: "10px", width: "100%" }}>
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

              {/* Execution panel */}
              {connected && (
                <div className="card-section">
                  <h3 className="card-title">Job Execution</h3>
                  
                  <div className="form-row" style={{ marginBottom: "10px" }}>
                    <button className="btn btn-secondary" onClick={handleTraceFrame} disabled={isPlotting}>
                      Trace frame boundary
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
        </aside>

        {/* CENTER VIEWPORT */}
        {activeTab !== "monitor" ? (
          <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", height: "100%", width: "100%", overflow: "hidden" }}>
            <main 
              ref={prepareScrollContainerRef}
              className="canvas-container" 
              onMouseDown={handlePrepareMouseDown}
              onMouseMove={handlePrepareMouseMove}
              onMouseUp={handlePrepareMouseUp}
              onMouseLeave={handlePrepareMouseUp}
              onContextMenu={(e) => {
                if (isPanningPrepare) e.preventDefault();
              }}
              style={{ display: "flex", flexDirection: "column", gap: "10px", overflow: "auto", alignItems: "center", width: "100%", height: "100%" }}
            >
              
              <div style={{ width: `${Math.max(1260, totalCanvasWidth * zoom)}px`, display: "flex", flexDirection: "column", gap: "10px", alignItems: "center" }}>
              {/* Horizontal Slicing Toolbar */}
              <div 
                style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "space-evenly", 
                  backgroundColor: "var(--bg-secondary)", 
                  border: "1px solid var(--border-color)", 
                  borderRadius: "8px", 
                  padding: "10px 16px",
                  width: "100%",
                  boxSizing: "border-box",
                  flexWrap: "nowrap",
                  position: "sticky",
                  top: "10px",
                  zIndex: 10
                }}
              >
                {/* Clipboard group (Locked in Preview Tab, Grised if no selection) */}
                <div style={{ display: "flex", gap: "6px" }}>
                  <button className="btn btn-secondary" onClick={handleCopy} disabled={activeTab === "preview" || !selectedObjectId} style={{ padding: "4px 10px", fontSize: "0.8rem" }}>
                    Copy
                  </button>
                  <button className="btn btn-secondary" onClick={handleCut} disabled={activeTab === "preview" || !selectedObjectId} style={{ padding: "4px 10px", fontSize: "0.8rem" }}>
                    Cut
                  </button>
                  <button className="btn btn-secondary" onClick={handlePaste} disabled={activeTab === "preview" || !clipboard} style={{ padding: "4px 10px", fontSize: "0.8rem" }}>
                    Paste
                  </button>
                  <button 
                    className="btn btn-danger" 
                    onClick={() => {
                      if (selectedObjectIds.length > 0) {
                        setObjects(prev => prev.filter(o => !selectedObjectIds.includes(o.id)));
                        setSelectedObjectIds([]);
                        setSlicingStats(null);
                        setSlicedPaths([]);
                      }
                    }} 
                    disabled={activeTab === "preview" || selectedObjectIds.length === 0} 
                    style={{ padding: "4px 10px", fontSize: "0.8rem", backgroundColor: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", border: "1px solid rgba(239, 68, 68, 0.3)" }}
                  >
                    Delete
                  </button>
                </div>

                {/* Vertical Divider */}
                <div style={{ width: "1px", height: "24px", backgroundColor: "var(--border-color)", flexShrink: 0 }} />

                {/* Arrange group */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <button className="btn btn-secondary" onClick={handleArrangeAll} disabled={activeTab === "preview" || objects.length === 0} style={{ padding: "4px 12px", fontSize: "0.8rem" }}>
                    Auto-Arrange Designs
                  </button>
                  <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.72rem", fontWeight: "normal", cursor: "pointer", userSelect: "none", color: "var(--text-secondary)" }} title="Allow resizing objects to fit cells during layout optimization">
                    <input type="checkbox" checked={allowArrangeResize} onChange={(e) => setAllowArrangeResize(e.target.checked)} disabled={activeTab === "preview"} />
                    Auto-Scale
                  </label>
                </div>

                {/* Vertical Divider */}
                <div style={{ width: "1px", height: "24px", backgroundColor: "var(--border-color)", flexShrink: 0 }} />

                {/* Scale / Rotate Numeric Inputs group (with typeable buffer state to prevent auto-snapping) */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>Scale:</span>
                    <input 
                      type="number" 
                      value={inputScaleText} 
                      disabled={activeTab === "preview" || !selectedObject}
                      onChange={(e) => {
                        const txt = e.target.value;
                        setInputScaleText(txt);
                        const val = parseInt(txt);
                        if (!isNaN(val) && val > 0) {
                          setObjects(prev => prev.map(o => selectedObjectIds.includes(o.id) ? { ...o, scale: val } : o));
                          setSlicingStats(null);
                          setSlicedPaths([]);
                        }
                      }}
                      style={{ width: "65px", padding: "4px 8px", fontSize: "0.8rem", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                    />
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>%</span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>Rot:</span>
                    <button className="btn btn-secondary" style={{ padding: "2px 6px", fontSize: "0.7rem" }} disabled={activeTab === "preview" || !selectedObject} onClick={() => rotate90("left")}>-90</button>
                    <button className="btn btn-secondary" style={{ padding: "2px 6px", fontSize: "0.7rem" }} disabled={activeTab === "preview" || !selectedObject} onClick={() => rotate90("right")}>+90</button>
                    <input 
                      type="number" 
                      value={inputRotationText} 
                      disabled={activeTab === "preview" || !selectedObject}
                      onChange={(e) => {
                        const txt = e.target.value;
                        setInputRotationText(txt);
                        const val = parseInt(txt);
                        if (!isNaN(val)) {
                          setObjects(prev => prev.map(o => selectedObjectIds.includes(o.id) ? { ...o, rotation: val } : o));
                          setSlicingStats(null);
                          setSlicedPaths([]);
                        }
                      }}
                      style={{ width: "55px", padding: "4px 8px", fontSize: "0.8rem", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                    />
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>°</span>
                  </div>
                </div>

                {/* Vertical Divider */}
                <div style={{ width: "1px", height: "24px", backgroundColor: "var(--border-color)", flexShrink: 0 }} />

                {/* Bed Setup Group */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>Bed:</span>
                    <select 
                      value={bedPreset}
                      onChange={(e) => { handleBedPresetChange(e.target.value); setBedPreset(e.target.value); }}
                      disabled={activeTab === "preview"}
                      style={{ padding: "4px 8px", fontSize: "0.8rem", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                    >
                      <option value="">Custom</option>
                      <option value="A4">A4</option>
                      <option value="A3">A3</option>
                      <option value="A2">A2</option>
                      <option value="A1">A1</option>
                      <option value="A5">A5</option>
                      <option value="A6">A6</option>
                      <option value="A7">A7</option>
                    </select>
                  </div>

                  <select 
                    value={orientation} 
                    disabled={activeTab === "preview"}
                    onChange={(e) => handleOrientationToggle(e.target.value as "landscape" | "portrait")}
                    style={{ padding: "4px 8px", fontSize: "0.8rem", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", color: "var(--text-primary)" }}
                  >
                    <option value="landscape">Landscape</option>
                    <option value="portrait">Portrait</option>
                  </select>
                </div>

                {/* Vertical Divider */}
                <div style={{ width: "1px", height: "24px", backgroundColor: "var(--border-color)", flexShrink: 0 }} />

                {/* Dynamic Zoom Section */}
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>Zoom:</span>
                  <button className="btn btn-secondary" style={{ padding: "2px 8px", fontSize: "0.8rem" }} onClick={() => setZoom(prev => Math.max(1.0, prev - 0.25))}>-</button>
                  <span style={{ fontSize: "0.8rem", minWidth: "40px", textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
                  <button className="btn btn-secondary" style={{ padding: "2px 8px", fontSize: "0.8rem" }} onClick={() => setZoom(prev => Math.min(5.0, prev + 0.25))}>+</button>
                  <button 
                    className="btn btn-secondary" 
                    style={{ padding: "2px 8px", fontSize: "0.8rem", marginLeft: "4px" }} 
                    onClick={() => {
                      if (prepareScrollContainerRef.current) {
                        const container = prepareScrollContainerRef.current;
                        const containerPadding = 40;
                        const availableWidth = container.clientWidth - containerPadding;
                        const availableHeight = container.clientHeight - containerPadding - 80; // accounts for horizontal toolbar height
                        
                        const zoomX = availableWidth / totalCanvasWidth;
                        const zoomY = availableHeight / totalCanvasHeight;
                        
                        let idealZoom = Math.min(zoomX, zoomY);
                        idealZoom = Math.max(0.5, Math.min(5.0, idealZoom));
                        
                        // Round to nearest 0.05
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
                  overflow: "hidden"
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
            </div>
          </main>
          <div className="canvas-scale-indicator" style={{ position: "absolute", bottom: "20px", right: "20px", zIndex: 20 }}>
            Bed: {scaleWidth}mm x {scaleHeight}mm
          </div>
        </div>
        ) : (
          /* MONITOR TAB CENTER VIEWPORT: Dedicated Fluidd Dashboard */
          <main style={{ flex: 1, padding: "20px", display: "flex", flexDirection: "column", gap: "20px", overflowY: "auto" }}>
            
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
                  
                  <div className="monitor-console-container" style={{ flex: 1, minHeight: 0 }}>
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
                    <div ref={consoleEndRef} />
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
                          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <span style={{ fontSize: "0.85rem", fontWeight: "bold", color: "var(--text-primary)" }}>
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
                    ref={monitorCanvasContainerRef}
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
                  <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Time Elapsed</div>
                  <strong style={{ fontSize: "1.2rem" }}>{formatTime(jobStats.elapsedTime)}</strong>
                </div>

                <div style={{ backgroundColor: "var(--bg-primary)", padding: "10px 14px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Est. Remaining</div>
                  <strong style={{ fontSize: "1.2rem", color: jobStats.status === "printing" ? "var(--success)" : "var(--text-muted)" }}>
                    {jobStats.status === "printing" ? formatTime(jobStats.estimatedRemaining) : "0m 0s"}
                  </strong>
                </div>
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
      {showFinishedModal && slicingStats && (
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
                <span>Estimated time:</span>
                <strong>{formatTime(slicingStats.timeEst)}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <span>Draw distance:</span>
                <strong>{((slicingStats.drawDist) / 1000).toFixed(2)} m</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <span>Air travel:</span>
                <strong>{((slicingStats.airDist) / 1000).toFixed(2)} m</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <span>Pen lifts:</span>
                <strong>{slicingStats.numLifts}</strong>
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
    </div>
  );
}

export default App;
