const BUILD_ID = "2026-08-26g";
const $ = (id) => document.getElementById(id);

const statusBadge = $("statusBadge");
const loadButton = $("loadButton");
const loadHint = $("loadHint");
const photoInput = $("photoInput");
const previewWrap = $("previewWrap");
const previewImage = $("previewImage");
const imageInfo = $("imageInfo");
const ocrButton = $("ocrButton");
const resultOutput = $("resultOutput");
const timeBadge = $("timeBadge");
const logOutput = $("logOutput");
const clearLogButton = $("clearLogButton");

let PaddleOCR = null;
let ocr = null;
let selectedBlob = null;
let loading = false;
let running = false;

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
  console.log(line);
}

function setBadge(text, mode = "neutral") {
  statusBadge.textContent = text;
  statusBadge.className = `badge ${mode}`;
}

function setTime(text, mode = "neutral") {
  timeBadge.textContent = text;
  timeBadge.className = `badge ${mode}`;
}

function updateActions() {
  loadButton.disabled = loading || !!ocr;
  ocrButton.disabled = !ocr || !selectedBlob || running;
}

async function resizeToBlob(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();

    const originalWidth = img.naturalWidth;
    const originalHeight = img.naturalHeight;
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("JPEG conversion failed")), "image/jpeg", 0.9);
    });

    return { blob, width, height, originalWidth, originalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function importPaddleOCR() {
  if (PaddleOCR) return PaddleOCR;
  log("Loading official PaddleOCR browser SDK from jsDelivr…");
  const mod = await import("https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm");
  if (!mod.PaddleOCR) throw new Error("PaddleOCR export not found in browser package");
  PaddleOCR = mod.PaddleOCR;
  log("PaddleOCR browser SDK loaded.");
  return PaddleOCR;
}

async function loadOcr() {
  if (ocr || loading) return;
  loading = true;
  setBadge("Loading", "busy");
  loadHint.textContent = "Loading browser OCR library and Chinese PP OCR v5 mobile models…";
  updateActions();
  const started = performance.now();

  try {
    const OCR = await importPaddleOCR();
    log("Creating PP OCR v5 Chinese pipeline with WASM backend…");
    ocr = await OCR.create({
      lang: "ch",
      ocrVersion: "PP-OCRv5",
      ortOptions: {
        backend: "wasm",
        wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",
        numThreads: 1,
        simd: true,
      },
    });

    const seconds = (performance.now() - started) / 1000;
    setBadge("Ready", "good");
    loadHint.textContent = `Local OCR ready in ${seconds.toFixed(1)} sec.`;
    log(`PP OCR v5 ready in ${seconds.toFixed(1)} sec.`);
  } catch (error) {
    ocr = null;
    setBadge("Error", "bad");
    loadHint.textContent = "Load failed. Send the Technical log back for adjustment.";
    resultOutput.textContent = `Load error: ${error?.message || String(error)}`;
    log(`Load error: ${error?.message || String(error)}`);
    if (error?.stack) log(error.stack);
  } finally {
    loading = false;
    updateActions();
  }
}

async function runOcr() {
  if (!ocr || !selectedBlob || running) return;
  running = true;
  setTime("Running locally", "busy");
  resultOutput.textContent = "Recognizing text on this iPhone…";
  updateActions();
  const started = performance.now();

  try {
    const [result] = await ocr.predict(selectedBlob);
    const items = result?.items || [];
    const lines = items.map((item, index) => {
      const score = Number.isFinite(item.score) ? ` (${(item.score * 100).toFixed(1)}%)` : "";
      return `${index + 1}. ${item.text || ""}${score}`;
    });
    const seconds = (performance.now() - started) / 1000;
    resultOutput.textContent = lines.length ? lines.join("\n") : "No text recognized.";
    setTime(`${seconds.toFixed(1)} sec`, "good");
    log(`OCR complete in ${seconds.toFixed(1)} sec. Recognized lines: ${items.length}.`);
    if (result?.metrics) {
      log(`Metrics: det ${result.metrics.detMs ?? "n/a"} ms · rec ${result.metrics.recMs ?? "n/a"} ms · total ${result.metrics.totalMs ?? "n/a"} ms.`);
    }
  } catch (error) {
    setTime("Error", "bad");
    resultOutput.textContent = `OCR error: ${error?.message || String(error)}`;
    log(`OCR error: ${error?.message || String(error)}`);
    if (error?.stack) log(error.stack);
  } finally {
    running = false;
    updateActions();
  }
}

loadButton.addEventListener("click", loadOcr);

photoInput.addEventListener("change", async () => {
  const [file] = photoInput.files || [];
  if (!file) return;
  selectedBlob = null;
  ocrButton.disabled = true;
  previewWrap.hidden = false;
  imageInfo.textContent = "Preparing image locally…";
  try {
    const processed = await resizeToBlob(file);
    selectedBlob = processed.blob;
    const previewUrl = URL.createObjectURL(processed.blob);
    previewImage.onload = () => URL.revokeObjectURL(previewUrl);
    previewImage.src = previewUrl;
    imageInfo.textContent = `${processed.originalWidth} × ${processed.originalHeight} → ${processed.width} × ${processed.height} for local OCR`;
    log(`Photo prepared locally: ${processed.originalWidth}x${processed.originalHeight} -> ${processed.width}x${processed.height}.`);
  } catch (error) {
    previewWrap.hidden = true;
    resultOutput.textContent = `Image error: ${error?.message || String(error)}`;
    log(`Image error: ${error?.message || String(error)}`);
  }
  updateActions();
});

ocrButton.addEventListener("click", runOcr);
clearLogButton.addEventListener("click", () => { logOutput.textContent = ""; });
window.addEventListener("unhandledrejection", (event) => log(`Unhandled rejection: ${event.reason?.message || event.reason || "unknown"}`));

log(`PP OCR v5 test page loaded. Build ${BUILD_ID}.`);
log("No AI API, Firebase or WebGPU model has been started.");
log(`Browser: ${navigator.userAgent}`);
updateActions();
