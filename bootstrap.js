const BUILD_ID = "2026-08-26c";
const NativeWorker = window.Worker;

window.Worker = class VersionedWorker extends NativeWorker {
  constructor(url, options) {
    let versionedUrl = url;
    if (typeof url === "string" && url.includes("worker.js")) {
      const separator = url.includes("?") ? "&" : "?";
      versionedUrl = `${url}${separator}build=${encodeURIComponent(BUILD_ID)}`;
    }
    super(versionedUrl, options);
  }
};

await import(`./app.js?build=${encodeURIComponent(BUILD_ID)}`);

const logOutput = document.getElementById("logOutput");
if (logOutput) {
  logOutput.textContent += `[build] ${BUILD_ID} · GLM-OCR test · cache-bust enabled\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}
