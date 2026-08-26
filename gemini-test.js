const BUILD_ID = "2026-08-27a";
const $ = (id) => document.getElementById(id);

const guardBadge = $("guardBadge");
const endpointInput = $("endpointInput");
const tokenInput = $("tokenInput");
const saveConfigButton = $("saveConfigButton");
const photoInput = $("photoInput");
const previewWrap = $("previewWrap");
const previewImage = $("previewImage");
const imageInfo = $("imageInfo");
const runButton = $("runButton");
const requestBadge = $("requestBadge");
const localCounter = $("localCounter");
const jsonGrid = $("jsonGrid");
const resultOutput = $("resultOutput");
const timeBadge = $("timeBadge");
const logOutput = $("logOutput");
const clearLogButton = $("clearLogButton");

const DEFAULT_ENDPOINT = "https://asia-east2-price-tracker-app-8.cloudfunctions.net/geminiPriceTagTest";
const CONFIG_KEY = "geminiPriceTagTestConfigV1";
let selectedPayload = null;
let running = false;

function stamp() {
  return new Intl.DateTimeFormat("en-HK", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
}

function log(message) {
  const line = `[${stamp()}] ${message}`;
  logOutput.textContent += `${line}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
  console.log(line);
}

function setBadge(el, text, mode = "neutral") {
  el.textContent = text;
  el.className = `badge ${mode}`;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function getLocalCount() {
  return Number(localStorage.getItem(`gemini-test-count:${todayKey()}`) || 0);
}

function incrementLocalCount() {
  const key = `gemini-test-count:${todayKey()}`;
  localStorage.setItem(key, String(getLocalCount() + 1));
}

function refreshLocalCounter() {
  localCounter.textContent = `This device has sent ${getLocalCount()} test request${getLocalCount() === 1 ? "" : "s"} today.`;
}

function loadConfig() {
  endpointInput.value = DEFAULT_ENDPOINT;
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    if (saved?.endpoint) endpointInput.value = saved.endpoint;
    if (saved?.token) tokenInput.value = saved.token;
  } catch {}
  refreshConfigState();
}

function refreshConfigState() {
  const ok = endpointInput.value.trim().startsWith("https://") && tokenInput.value.trim().length >= 12;
  setBadge(guardBadge, ok ? "Configured" : "Not configured", ok ? "good" : "neutral");
  runButton.disabled = running || !ok || !selectedPayload;
}

saveConfigButton.addEventListener("click", () => {
  const endpoint = endpointInput.value.trim();
  const token = tokenInput.value.trim();
  if (!endpoint.startsWith("https://") || token.length < 12) {
    setBadge(guardBadge, "Check config", "bad");
    return;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ endpoint, token }));
  setBadge(guardBadge, "Saved locally", "good");
  log("Endpoint and test token saved only in this browser localStorage.");
  refreshConfigState();
});

endpointInput.addEventListener("input", refreshConfigState);
tokenInput.addEventListener("input", refreshConfigState);

async function resizeImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const ow = img.naturalWidth;
    const oh = img.naturalHeight;
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(ow, oh));
    const width = Math.max(1, Math.round(ow * scale));
    const height = Math.max(1, Math.round(oh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.84);
    const base64 = dataUrl.split(",")[1];
    if (!base64) throw new Error("JPEG encoding failed");
    return { dataUrl, base64, mimeType: "image/jpeg", width, height, originalWidth: ow, originalHeight: oh };
  } finally {
    URL.revokeObjectURL(url);
  }
}

photoInput.addEventListener("change", async () => {
  const [file] = photoInput.files || [];
  if (!file) return;
  selectedPayload = null;
  previewWrap.hidden = false;
  imageInfo.textContent = "Preparing image locally…";
  try {
    const p = await resizeImage(file);
    selectedPayload = p;
    previewImage.src = p.dataUrl;
    imageInfo.textContent = `${p.originalWidth} × ${p.originalHeight} → ${p.width} × ${p.height}; image is sent only when Run is pressed.`;
    log(`Photo prepared locally: ${p.originalWidth}x${p.originalHeight} -> ${p.width}x${p.height}. No Gemini request yet.`);
  } catch (error) {
    previewWrap.hidden = true;
    resultOutput.textContent = `Image error: ${error?.message || String(error)}`;
    log(`Image error: ${error?.message || String(error)}`);
  }
  refreshConfigState();
});

function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function renderJson(data) {
  jsonGrid.textContent = "";
  const keys = ["product_name","brand","pack_size","current_price","original_price","member_price","multi_buy","promotion","confidence","notes"];
  for (const key of keys) {
    const div = document.createElement("div");
    div.className = "kv";
    const b = document.createElement("b");
    b.textContent = key;
    const span = document.createElement("span");
    const value = data?.[key];
    span.textContent = value === null || value === undefined ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value);
    div.append(b, span);
    jsonGrid.appendChild(div);
  }
  jsonGrid.hidden = false;
}

runButton.addEventListener("click", async () => {
  if (running || !selectedPayload) return;
  const endpoint = endpointInput.value.trim();
  const token = tokenInput.value.trim();
  if (!endpoint.startsWith("https://") || token.length < 12) return;

  running = true;
  refreshConfigState();
  setBadge(requestBadge, "Running once", "busy");
  setBadge(timeBadge, "Waiting", "busy");
  resultOutput.textContent = "One Gemini Vision request is in progress…";
  jsonGrid.hidden = true;
  const requestId = newRequestId();
  const started = performance.now();
  log(`Manual request started. requestId=${requestId}. No automatic retry is implemented.`);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Price-Tracker-Test-Token": token,
      },
      body: JSON.stringify({
        requestId,
        image: { mimeType: selectedPayload.mimeType, base64: selectedPayload.base64 },
      }),
    });

    const body = await response.json().catch(() => ({}));
    const seconds = (performance.now() - started) / 1000;

    if (!response.ok) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }

    incrementLocalCount();
    refreshLocalCounter();
    setBadge(requestBadge, "1 request complete", "good");
    setBadge(timeBadge, `${seconds.toFixed(1)} sec`, "good");
    renderJson(body.result || {});
    resultOutput.textContent = JSON.stringify(body, null, 2);
    log(`Request complete in ${seconds.toFixed(1)} sec. Server daily count: ${body.usage?.count ?? "n/a"}/${body.usage?.limit ?? "n/a"}. Model: ${body.model || "n/a"}.`);
  } catch (error) {
    const seconds = (performance.now() - started) / 1000;
    setBadge(requestBadge, "Stopped on error", "bad");
    setBadge(timeBadge, "Error", "bad");
    resultOutput.textContent = `Error: ${error?.message || String(error)}`;
    log(`Request stopped after ${seconds.toFixed(1)} sec: ${error?.message || String(error)}. No client retry was attempted.`);
  } finally {
    running = false;
    refreshConfigState();
  }
});

clearLogButton.addEventListener("click", () => { logOutput.textContent = ""; });

log(`Gemini Vision guarded test loaded. Build ${BUILD_ID}.`);
log("This browser page contains no Gemini API key and cannot call Gemini without the Firebase Function endpoint plus private test token.");
loadConfig();
refreshLocalCounter();
