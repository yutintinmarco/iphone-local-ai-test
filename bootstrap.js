const BUILD_ID = "2026-08-26e";
await import(`./app-safe.js?build=${encodeURIComponent(BUILD_ID)}`);

const logOutput = document.getElementById("logOutput");
if (logOutput) {
  logOutput.textContent += `[build] ${BUILD_ID} · TRUE SAFE BOOT · cache-bust enabled\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}
