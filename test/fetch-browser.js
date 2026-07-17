// Downloads Chrome for Testing (the automation build that still honors --load-extension)
// into test/.browsers and prints the executable path.
const path = require("path");
const { install, resolveBuildId, detectBrowserPlatform, computeExecutablePath } = require("@puppeteer/browsers");

(async () => {
  const cacheDir = path.join(__dirname, ".browsers");
  const platform = detectBrowserPlatform();
  const buildId = await resolveBuildId("chrome", platform, "stable");
  console.log("platform:", platform, "buildId:", buildId);
  let lastPct = -10;
  await install({
    browser: "chrome", buildId, cacheDir,
    downloadProgressCallback: (dl, total) => {
      const pct = Math.floor((dl / total) * 100);
      if (pct >= lastPct + 10) { lastPct = pct; console.log(`download ${pct}%`); }
    },
  });
  console.log("EXE:", computeExecutablePath({ browser: "chrome", buildId, cacheDir }));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
