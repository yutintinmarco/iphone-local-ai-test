const $ = (id) => document.getElementById(id);

const secureStatus = $("secureStatus");
const webgpuStatus = $("webgpuStatus");
const adapterStatus = $("adapterStatus");
const modelStatus = $("modelStatus");
const overallBadge = $("overallBadge");
const checkButton = $("checkButton");
const loadButton = $("loadButton");
const loadHint = $("loadHint");
const progressWrap = $("progressWrap");
const progressLabel = $("progressLabel");
const progressValue = $("progressValue");
const progressBar = $("progressBar");
const photoInput = $("photoInput");
const previewWrap = $("previewWrap");
const previewImage = $("previewImage");
const imageInfo = $("imageInfo");
const promptInput = $("promptInput");
const analyzeButton = $("analyzeButton");
const resultOutput = $("resultOutput");
const timeBadge = $("timeBadge");
const logOutput = $("logOutput");
const clearLogButton = $("clearLogButton");

const BUILD_ID = "2026-08-26d";
let worker = null;
let modelReady = false;
let modelLoading = false;
let analyzing = false;
let selectedImageData = null;
let loadStartedAt = null;
const fileProgress = new Map();

function stamp() {
  return new Intl.DateTimeFormat("en-HK", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
}

function log(message) {
  const line = `[${stamp()}] ${message}`;
  logOutput.textContent += `${line}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
  console.log(line);
}

function setBadge(text, mode = "neutral") {
  overallBadge.textContent = text;
  overallBadge.className = `badge ${mode}`;
}

function setTimeBadge(text, mode = "neutral") {
  timeBadge.textContent = text;
  timeBadge.className = `badge ${mode}`;
}

function updateActions() {
  loadButton.disabled = !navigator.gpu || modelReady || modelLoading;
  analyzeButton.disabled = !modelReady || !selectedImageData || analyzing;
}

async function localWebGPUCheck() {
  secureStatus.textContent = window.isSecureContext ? "Yes" : "No";
  if (!window.isSecureContext) {
    webgpuStatus.textContent = "Needs HTTPS";
    adapterStatus.textContent = "Unavailable";
    setBadge("HTTPS required", "bad");
    updateActions();
    return;
  }
  if (!navigator.gpu) {
    webgpuStatus.textContent = "Not available";
    adapterStatus.textContent = "No WebGPU API";
    setBadge("WebGPU unavailable", "bad");
    updateActions();
    return;
  }

  webgpuStatus.textContent = "Available";
  adapterStatus.textContent = "Checking…";
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No GPU adapter returned");
    const fp16 = adapter.features.has("shader-f16");
    adapterStatus.textContent = fp16 ? "Ready · shader f16" : "Ready · no shader f16";
    setBadge(fp16 ? "Ready for GLM-OCR" : "WebGPU only", fp16 ? "good" : "bad");
    loadHint.textContent = fp16
      ? "Safe boot passed. The GLM-OCR worker will start only after you press Load GLM-OCR."
      : "This GLM-OCR q4f16 build requires shader-f16.";
    log(`Main page WebGPU check passed. shader-f16: ${fp16 ? "yes" : "no"}`);
    if (!fp16) loadButton.disabled = true;
  } catch (error) {
    adapterStatus.textContent = "Adapter failed";
    setBadge("Adapter failed", "bad");
    log(`Adapter error: ${error.message || error}`);
  }
  updateActions();
}

function handleProgressEvent(event) {
  if (!event) return;
  const key = event.file || event.name || event.status || "model";
  if (event.status === "done") {
    const existing = fileProgress.get(key) || {};
    fileProgress.set(key, { ...existing, progress: 100 });
  } else if (event.status === "progress" || Number.isFinite(event.progress)) {
    fileProgress.set(key, { progress: Number.isFinite(event.progress) ? event.progress : 0 });
  } else if (event.status === "initiate" && !fileProgress.has(key)) {
    fileProgress.set(key, { progress: 0 });
  }
  const values = [...fileProgress.values()].filter((x) => Number.isFinite(x.progress));
  const pct = values.length ? values.reduce((s, x) => s + x.progress, 0) / values.length : 0;
  progressBar.value = Math.max(0, Math.min(100, pct));
  progressValue.textContent = `${Math.round(progressBar.value)}%`;
  progressLabel.textContent = event.file ? `Loading ${String(event.file).split("/").at(-1)}` : "Loading model files…";
}

function createWorkerOnlyOnDemand() {
  if (worker) return worker;
  log("Starting GLM-OCR worker on demand. No worker was created during page boot.");
  worker = new Worker(`./worker.js?build=${BUILD_ID}`, { type: "module" });

  worker.addEventListener("message", (event) => {
    const data = event.data || {};
    switch (data.status) {
      case "checked":
        log(`Worker WebGPU ready. dtype selected: ${data.dtype}`);
        break;
      case "loading":
        modelLoading = true;
        modelStatus.textContent = "Loading…";
        setBadge("Loading GLM-OCR", "busy");
        progressWrap.hidden = false;
        progressLabel.textContent = data.message || "Loading GLM-OCR…";
        updateActions();
        break;
      case "progress_event":
        handleProgressEvent(data.event);
        break;
      case "ready": {
        modelReady = true;
        modelLoading = false;
        modelStatus.textContent = `Ready · ${data.dtype}`;
        setBadge("GLM-OCR ready", "good");
        progressBar.value = 100;
        progressValue.textContent = "100%";
        const seconds = loadStartedAt ? (performance.now() - loadStartedAt) / 1000 : null;
        progressLabel.textContent = seconds ? `Model ready in ${seconds.toFixed(1)} sec` : "Model ready";
        log(`Model ready: ${data.modelId}, dtype ${data.dtype}${seconds ? `, load ${seconds.toFixed(1)} sec` : ""}`);
        updateActions();
        break;
      }
      case "generation_start":
        analyzing = true;
        resultOutput.textContent = "Analyzing on this device…";
        setTimeBadge("Running locally", "busy");
        log("Local OCR inference started.");
        updateActions();
        break;
      case "generation_update":
        resultOutput.textContent = data.output || "Generating…";
        break;
      case "generation_complete": {
        analyzing = false;
        resultOutput.textContent = data.output || "Model returned an empty response.";
        const sec = Number.isFinite(data.elapsedMs) ? data.elapsedMs / 1000 : null;
        setTimeBadge(sec ? `${sec.toFixed(1)} sec` : "Complete", "good");
        log(`Inference complete${sec ? ` in ${sec.toFixed(1)} sec` : ""}. Tokens: ${data.tokenCount ?? "n/a"}`);
        updateActions();
        break;
      }
      case "error":
        modelLoading = false;
        analyzing = false;
        modelStatus.textContent = modelReady ? "Ready" : "Error";
        setBadge("Error", "bad");
        setTimeBadge("Error", "bad");
        resultOutput.textContent = `Error: ${data.message || "Unknown worker error"}`;
        log(`Worker error: ${data.message || "Unknown error"}`);
        updateActions();
        break;
    }
  });

  worker.addEventListener("error", (event) => {
    modelLoading = false;
    analyzing = false;
    setBadge("Worker error", "bad");
    resultOutput.textContent = `Worker error: ${event.message || "Unknown error"}`;
    log(`Worker script error: ${event.message || "Unknown error"}`);
    updateActions();
  });

  return worker;
}

async function resizeImage(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = objectUrl;
    await image.decode();
    const originalWidth = image.naturalWidth;
    const originalHeight = image.naturalHeight;
    const maxDimension = 1280;
    const scale = Math.min(1, maxDimension / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas could not be created");
    context.drawImage(image, 0, 0, width, height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.86), originalWidth, originalHeight, width, height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

checkButton.addEventListener("click", localWebGPUCheck);

loadButton.addEventListener("click", () => {
  fileProgress.clear();
  progressWrap.hidden = false;
  progressBar.value = 0;
  progressValue.textContent = "0%";
  loadStartedAt = performance.now();
  modelLoading = true;
  setBadge("Starting GLM-OCR", "busy");
  updateActions();
  log("User requested GLM-OCR load. This may download about 635 MB of public model files.");
  createWorkerOnlyOnDemand().postMessage({ type: "load" });
});

photoInput.addEventListener("change", async () => {
  const [file] = photoInput.files || [];
  if (!file) return;
  try {
    imageInfo.textContent = "Preparing photo…";
    previewWrap.hidden = false;
    const processed = await resizeImage(file);
    selectedImageData = processed.dataUrl;
    previewImage.src = processed.dataUrl;
    imageInfo.textContent = `${processed.originalWidth} × ${processed.originalHeight} → ${processed.width} × ${processed.height} for local OCR`;
    log(`Photo prepared locally: ${processed.originalWidth}x${processed.originalHeight} -> ${processed.width}x${processed.height}`);
  } catch (error) {
    selectedImageData = null;
    resultOutput.textContent = `Could not read this image: ${error.message || error}`;
    log(`Image preparation error: ${error.message || error}`);
  }
  updateActions();
});

analyzeButton.addEventListener("click", () => {
  if (!modelReady || !selectedImageData || analyzing) return;
  const prompt = promptInput.value.trim() || "Text Recognition:";
  analyzing = true;
  updateActions();
  createWorkerOnlyOnDemand().postMessage({ type: "generate", data: { image: selectedImageData, prompt } });
});

clearLogButton.addEventListener("click", () => { logOutput.textContent = ""; });
window.addEventListener("unhandledrejection", (event) => log(`Unhandled promise rejection: ${event.reason?.message || event.reason || "unknown"}`));

log(`Page loaded in SAFE BOOT mode. Build ${BUILD_ID}.`);
log("No GLM-OCR worker or model is started until Load GLM-OCR is pressed.");
log(`Browser: ${navigator.userAgent}`);
await localWebGPUCheck();
updateActions();
