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
let selectedImageMeta = null;
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
  logOutput.textContent = `${logOutput.textContent}${line}\n`;
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index >= 2 ? 1 : 0)} ${units[index]}`;
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
    loadHint.textContent = "GitHub Pages should provide HTTPS automatically.";
    updateActions();
    return;
  }

  if (!navigator.gpu) {
    webgpuStatus.textContent = "Not available";
    adapterStatus.textContent = "No WebGPU API";
    setBadge("WebGPU unavailable", "bad");
    loadHint.textContent = "This browser does not expose WebGPU. Use a current Safari version on iPhone.";
    log(`WebGPU missing. User agent: ${navigator.userAgent}`);
    updateActions();
    return;
  }

  webgpuStatus.textContent = "Available";
  adapterStatus.textContent = "Requesting adapter…";
  setBadge("WebGPU found", "good");
  loadHint.textContent = "WebGPU is available. You can load the local model.";

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No GPU adapter returned");
    const fp16 = adapter.features.has("shader-f16");
    adapterStatus.textContent = fp16 ? "Ready · shader f16" : "Ready · standard";
    log(`Main page WebGPU check passed. shader-f16: ${fp16 ? "yes" : "no"}`);
  } catch (error) {
    adapterStatus.textContent = "Adapter failed";
    setBadge("Adapter failed", "bad");
    log(`Adapter error: ${error.message || error}`);
  }

  updateActions();
}

function createWorker() {
  if (worker) return worker;

  worker = new Worker("./worker.js", { type: "module" });

  worker.addEventListener("message", (event) => {
    const data = event.data || {};

    switch (data.status) {
      case "checked":
        adapterStatus.textContent = `${data.adapterInfo} · ${data.dtype}`;
        log(`Worker WebGPU ready. dtype selected: ${data.dtype}`);
        break;

      case "loading":
        modelLoading = true;
        modelStatus.textContent = "Loading…";
        setBadge("Loading AI", "busy");
        progressWrap.hidden = false;
        progressLabel.textContent = data.message || "Loading model…";
        loadHint.textContent = "First load downloads public model files. Keep Safari open until it finishes.";
        updateActions();
        break;

      case "progress_event":
        handleProgressEvent(data.event);
        break;

      case "ready": {
        modelReady = true;
        modelLoading = false;
        modelStatus.textContent = `Ready · ${data.dtype}`;
        setBadge("Local AI ready", "good");
        progressBar.value = 100;
        progressValue.textContent = "100%";
        const seconds = loadStartedAt ? (performance.now() - loadStartedAt) / 1000 : null;
        progressLabel.textContent = seconds ? `Model ready in ${seconds.toFixed(1)} sec` : "Model ready";
        loadHint.textContent = "The model is ready. Choose or take a price tag photo.";
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
        const label = sec
          ? `${sec.toFixed(1)} sec${tps ? ` · ${tps.toFixed(1)} tok/s` : ""}`
          : "Complete";
        setTimeBadge(label, "good");
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
        loadHint.textContent = "Take a screenshot of this page and send it back so the test can be adjusted.";
        log(`Worker error: ${data.message || "Unknown error"}`);
        if (data.stack) log(data.stack);
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

  worker.postMessage({ type: "check" });
  return worker;
}

function handleProgressEvent(event) {
  if (!event) return;

  const key = event.file || event.name || event.status || "model";

  if (event.status === "done") {
    const existing = fileProgress.get(key) || {};
    fileProgress.set(key, { ...existing, progress: 100, done: true });
  } else if (event.status === "progress" || Number.isFinite(event.progress)) {
    fileProgress.set(key, {
      progress: Number.isFinite(event.progress) ? event.progress : 0,
      loaded: event.loaded,
      total: event.total,
      done: false,
    });
  } else if (event.status === "initiate") {
    if (!fileProgress.has(key)) fileProgress.set(key, { progress: 0, done: false });
  }

  const tracked = [...fileProgress.values()];
  const usable = tracked.filter((item) => Number.isFinite(item.progress));
  const percent = usable.length
    ? usable.reduce((sum, item) => sum + item.progress, 0) / usable.length
    : 0;

  progressBar.value = Math.max(0, Math.min(100, percent));
  progressValue.textContent = `${Math.round(progressBar.value)}%`;

  const shortName = String(key).split("/").at(-1);
  if (event.status === "progress") {
    const size = event.loaded ? formatBytes(event.loaded) : "";
    progressLabel.textContent = `Downloading ${shortName}${size ? ` · ${size}` : ""}`;
  } else if (event.status === "initiate") {
    progressLabel.textContent = `Preparing ${shortName}`;
  }
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
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas could not be created");

    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);

    return {
      dataUrl,
      originalWidth,
      originalHeight,
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function choosePhoto(file) {
  if (!file) return;

  selectedImageData = null;
  selectedImageMeta = null;
  analyzeButton.disabled = true;
  imageInfo.textContent = "Preparing photo…";
  previewWrap.hidden = false;

  try {
    const processed = await resizeImage(file);
    selectedImageData = processed.dataUrl;
    selectedImageMeta = processed;
    previewImage.src = processed.dataUrl;
    imageInfo.textContent = `${processed.originalWidth} × ${processed.originalHeight} → ${processed.width} × ${processed.height} for local AI`;
    log(`Photo prepared locally: ${processed.originalWidth}x${processed.originalHeight} -> ${processed.width}x${processed.height}`);
  } catch (error) {
    previewWrap.hidden = true;
    resultOutput.textContent = `Could not read this image: ${error.message || error}`;
    log(`Image preparation error: ${error.message || error}`);
  }

  updateActions();
}

checkButton.addEventListener("click", async () => {
  await localWebGPUCheck();
  if (navigator.gpu) createWorker().postMessage({ type: "check" });
});

loadButton.addEventListener("click", () => {
  fileProgress.clear();
  progressBar.value = 0;
  progressValue.textContent = "0%";
  progressWrap.hidden = false;
  loadStartedAt = performance.now();
  modelLoading = true;
  setBadge("Starting", "busy");
  loadButton.disabled = true;
  log("User requested local model load. Network download is expected only for library and model files.");
  createWorker().postMessage({ type: "load" });
});

photoInput.addEventListener("change", async () => {
  const [file] = photoInput.files || [];
  await choosePhoto(file);
});

analyzeButton.addEventListener("click", () => {
  if (!modelReady || !selectedImageData || analyzing) return;

  const prompt = promptInput.value.trim();
  if (!prompt) {
    resultOutput.textContent = "Please enter a test instruction.";
    return;
  }

  analyzing = true;
  setTimeBadge("Starting", "busy");
  updateActions();

  createWorker().postMessage({
    type: "generate",
    data: {
      image: selectedImageData,
      prompt,
      imageMeta: selectedImageMeta,
    },
  });
});

clearLogButton.addEventListener("click", () => {
  logOutput.textContent = "";
});

window.addEventListener("unhandledrejection", (event) => {
  log(`Unhandled promise rejection: ${event.reason?.message || event.reason || "unknown"}`);
});

log("Page loaded. No OpenAI or Firebase code is present in this test.");
log(`Browser: ${navigator.userAgent}`);
await localWebGPUCheck();
if (navigator.gpu) createWorker();
updateActions();
