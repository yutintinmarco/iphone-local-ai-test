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

let worker = null;
let modelReady = false;
let modelLoading = false;
let analyzing = false;
let selectedImageData = null;
let loadStartedAt = null;
const fileProgress = new Map();

function stamp() {
  return new Intl.DateTimeFormat("en-HK", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function log(message) {
  const line = `[${stamp()}] ${message}`;
  logOutput.textContent += `${line}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
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

async function checkWebGPU() {
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
    log("WebGPU API is not exposed by this browser.");
    updateActions();
    return;
  }

  webgpuStatus.textContent = "Available";
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No GPU adapter returned");
    const fp16 = adapter.features.has("shader-f16");
    adapterStatus.textContent = fp16 ? "Ready · shader f16" : "Ready · standard";
    setBadge("Safe boot ready", "good");
    loadHint.textContent = "Safe boot passed. No AI worker has started yet. Press Load GLM-OCR only when ready.";
    log(`Safe boot WebGPU check passed. shader-f16: ${fp16 ? "yes" : "no"}`);
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
    fileProgress.set(key, { progress: 100 });
  } else if (event.status === "progress" || Number.isFinite(event.progress)) {
    fileProgress.set(key, { progress: Number.isFinite(event.progress) ? event.progress : 0 });
  } else if (event.status === "initiate" && !fileProgress.has(key)) {
    fileProgress.set(key, { progress: 0 });
  }

  const values = [...fileProgress.values()].filter((item) => Number.isFinite(item.progress));
  const percent = values.length ? values.reduce((sum, item) => sum + item.progress, 0) / values.length : 0;
  progressBar.value = Math.max(0, Math.min(100, percent));
  progressValue.textContent = `${Math.round(progressBar.value)}%`;
  if (event.file) progressLabel.textContent = `Loading ${String(event.file).split("/").at(-1)}`;
}

function createWorkerOnDemand() {
  if (worker) return worker;

  log("Creating GLM-OCR worker now. This is the first point where Transformers.js is loaded.");
  worker = new Worker("./worker.js?build=2026-08-26e", { type: "module" });

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
        progressLabel.textContent = data.message || "Loading model…";
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
        log("Local image inference started.");
        updateActions();
        break;
      case "generation_update":
        resultOutput.textContent = data.output || "Generating…";
        break;
      case "generation_complete": {
        analyzing = false;
        resultOutput.textContent = data.output || "Model returned an empty response.";
        const sec = Number.isFinite(data.elapsedMs) ? data.elapsedMs / 1000 : null;
        const tps = Number.isFinite(data.tokensPerSecond) ? data.tokensPerSecond : null;
        setTimeBadge(sec ? `${sec.toFixed(1)} sec${tps ? ` · ${tps.toFixed(1)} tok/s` : ""}` : "Complete", "good");
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
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas could not be created");
    ctx.drawImage(image, 0, 0, width, height);
    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.88),
      originalWidth: image.naturalWidth,
      originalHeight: image.naturalHeight,
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

checkButton.addEventListener("click", checkWebGPU);

loadButton.addEventListener("click", () => {
  fileProgress.clear();
  progressBar.value = 0;
  progressValue.textContent = "0%";
  progressWrap.hidden = false;
  loadStartedAt = performance.now();
  modelLoading = true;
  setBadge("Starting GLM-OCR", "busy");
  loadButton.disabled = true;
  log("User pressed Load GLM-OCR. Heavy model loading starts now.");
  createWorkerOnDemand().postMessage({ type: "load" });
});

photoInput.addEventListener("change", async () => {
  const [file] = photoInput.files || [];
  if (!file) return;
  try {
    const processed = await resizeImage(file);
    selectedImageData = processed.dataUrl;
    previewImage.src = processed.dataUrl;
    previewWrap.hidden = false;
    imageInfo.textContent = `${processed.originalWidth} × ${processed.originalHeight} → ${processed.width} × ${processed.height} for local AI`;
    log(`Photo prepared locally: ${processed.originalWidth}x${processed.originalHeight} -> ${processed.width}x${processed.height}`);
  } catch (error) {
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
  createWorkerOnDemand().postMessage({ type: "generate", data: { image: selectedImageData, prompt } });
});

clearLogButton.addEventListener("click", () => {
  logOutput.textContent = "";
});

log("Page loaded in TRUE SAFE BOOT mode. Build 2026-08-26e.");
log("No AI worker, Transformers.js library, or GLM-OCR model has started yet.");
await checkWebGPU();
updateActions();
