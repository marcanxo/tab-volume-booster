// End-to-end harness: loads the UNPACKED extension in real Chrome, serves an X-like fixture
// feed, drives it with trusted input via CDP, and spies on the service worker's frame
// messages to assert that boosts actually engage (signal:true = the analyser saw audio
// flowing through the boosted graph - real end-to-end ground truth).
//
//   node run.js            -> all scenarios
//   node run.js s3 s7      -> just those
const http = require("http");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const REPO = path.dirname(__dirname);
// Chrome for Testing, NOT the installed branded Chrome: since Chrome 137 the branded build
// silently ignores --load-extension. Fetch via `node fetch-browser.js` (or see the glob below).
const CHROME = (() => {
  const root = path.join(__dirname, ".browsers", "chrome");
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      const exe = path.join(root, d, "chrome-win64", "chrome.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error("Chrome for Testing not found - run: node fetch-browser.js");
})();

// ---- tone.wav: 2s 440Hz sine, mono 16-bit 44.1k, generated in memory ----
function toneWav() {
  const rate = 44100, secs = 2, n = rate * secs;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function serveFixtures() {
  const wav = toneWav();
  const server = http.createServer((req, res) => {
    if (req.url === "/tone.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
      return res.end(wav);
    }
    const file = path.join(__dirname, "fixtures", req.url === "/" ? "x-feed.html" : req.url);
    if (!file.startsWith(path.join(__dirname, "fixtures")) || !fs.existsSync(file)) {
      res.writeHead(404); return res.end("nope");
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWorker(browser) {
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
    { timeout: 15000 }
  );
  return target.worker();
}

// Spy: wraps chrome.tabs.sendMessage inside the SW so every engage/stop/probe and its
// RESPONSE is recorded. Also exposes helpers to run the worker's own entry points.
async function installSpy(sw) {
  await sw.evaluate(() => {
    if (globalThis.__spy) { globalThis.__spy.log.length = 0; return; }
    const log = [];
    globalThis.__spy = { log };
    const orig = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = (tabId, msg, opts) => {
      const entry = { t: Date.now(), tabId, frameId: opts && opts.frameId, cmd: msg && msg.cmd };
      const p = opts === undefined ? orig(tabId, msg) : orig(tabId, msg, opts);
      if (msg && (msg.cmd === "engage" || msg.cmd === "stop")) {
        return p.then(
          (res) => { entry.res = res; log.push(entry); return res; },
          (e) => { entry.err = String(e); log.push(entry); throw e; }
        );
      }
      log.push(entry);
      return p;
    };
  });
}

const swSpyLog = (sw) => sw.evaluate(() => globalThis.__spy.log);
const swClearLog = (sw) => sw.evaluate(() => { globalThis.__spy.log.length = 0; });
const swSetGain = (sw, tabId, gain) =>
  sw.evaluate((t, g) => serialized(t, () => setGain(t, g, true)), tabId, gain);
const swGetMode = (sw, tabId) => sw.evaluate((t) => sget(`tabmode:${t}`), tabId);
const swGetGain = (sw, tabId) => sw.evaluate((t) => sget(`tabgain:${t}`), tabId);

async function tabIdOf(sw, port) {
  return sw.evaluate(async (p) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url && t.url.includes(`127.0.0.1:${p}`));
    return tab ? tab.id : null;
  }, port);
}

// Wait until the spy log contains an engage response matching pred, or time out.
async function waitEngage(sw, pred, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const log = await swSpyLog(sw);
    const hit = log.find((e) => e.cmd === "engage" && e.res && pred(e.res));
    if (hit) return { hit, elapsed: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { hit: null, elapsed: Date.now() - t0 };
    await sleep(100);
  }
}

// Trusted click on a fixture video via CDP input (real user activation).
async function clickVideo(page, id) {
  const pos = await page.evaluate((i) => window.feed.rect(i), id);
  if (!pos) throw new Error(`no video ${id}`);
  await page.mouse.click(pos.x, pos.y);
}

async function newFeedPage(browser, port) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.feedReady === true, { timeout: 5000 });
  return page;
}

// ---- scenarios ----------------------------------------------------------
const scenarios = {
  // Baseline: audible playing video, set a boost -> element mode, audio confirmed flowing.
  async s1_basic_boost(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const res = await swSetGain(ctx.sw, tabId, 3);
      if (res.mode !== "element") return `expected element mode, got ${JSON.stringify(res)}`;
      if (!res.confirmed) return `hook engaged but no audio signal confirmed: ${JSON.stringify(res)}`;
      return true;
    } finally { await page.close(); }
  },

  // The v1.1.2 X flow: boosted video A PAUSES (X pauses off-screen posts - no DOM change),
  // muted successor B appears (DOM churn arms the volumechange one-shot), click unmutes B
  // -> urgent ping -> hook switches to B, fast, with audio confirmed end-to-end.
  async s3_pause_swap_click(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a); // silent pause, no ping
      const b = await page.evaluate(() => window.feed.add()); // churn -> ping -> engage arms one-shot on B
      await sleep(2600); // let the churn pass fully drain (worst-case cooldown)
      await swClearLog(ctx.sw);
      await clickVideo(page, b);
      const { hit, elapsed } = await waitEngage(ctx.sw, (r) => r.ok && r.signal === true, 4000);
      if (!hit) return `boost never confirmed on the new video within 4s`;
      if (elapsed > 2500) return `boost took ${elapsed}ms (budget 2500ms)`;
      ctx.note(`boost confirmed ${elapsed}ms after click`);
      return true;
    } finally { await page.close(); }
  },

  // Scroll-OUT variant: A is REMOVED from the DOM (elementLost path) -> the restore loop
  // pre-hooks muted B silently; the click then just lets audio flow through the live hook.
  async s5_removal_prehook(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await swClearLog(ctx.sw);
      await page.evaluate((old) => { window.feed.remove(old); return window.feed.add(); }, a);
      // elementLost -> kickRestore -> fresh engage on muted B must succeed (signal false is fine)
      const { hit, elapsed } = await waitEngage(ctx.sw, (r) => r.ok && r.engaged, 4000);
      if (!hit) return `no engage on the successor after removal within 4s`;
      // the restore loop clears + re-sets the mode per pass - poll until it settles on element
      let mode = null;
      for (let i = 0; i < 30; i++) {
        mode = await swGetMode(ctx.sw, tabId);
        if (mode && mode.mode === "element") break;
        await sleep(100);
      }
      if (!mode || mode.mode !== "element") return `mode not element after prehook: ${JSON.stringify(mode)}`;
      ctx.note(`prehooked ${elapsed}ms after swap`);
      return true;
    } finally { await page.close(); }
  },

  // Hypothesis for "sometimes no boost at all": B is added while A is STILL PLAYING (the
  // churn engage sees curIdle=false and arms nothing), then A pauses (no DOM change, no
  // ping), then the user clicks B. The unmute is invisible: no volumechange listener was
  // armed on B, and property writes never wake a MutationObserver.
  async s7_unarmed_unmute(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const b = await page.evaluate(() => window.feed.add()); // churn while A still plays
      await sleep(2600);                                      // churn pass drains; nothing armed on B
      await page.evaluate((i) => window.feed.pause(i), a);    // A pauses silently - NO ping
      await sleep(400);
      await swClearLog(ctx.sw);
      await clickVideo(page, b);                              // unmute: property write only
      const { hit, elapsed } = await waitEngage(ctx.sw, (r) => r.ok && r.signal === true, 5000);
      if (!hit) return `BUG REPRODUCED: click-unmute produced no boost within 5s (nothing was listening)`;
      ctx.note(`boost confirmed ${elapsed}ms after click`);
      return true;
    } finally { await page.close(); }
  },

  // Rapid churn then click: posts flip in and out quickly (A stays paused in the DOM, like
  // X's keep-a-window virtualization), then the user clicks the one that stayed.
  async s4_rapid_churn(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      let id = null;
      for (let i = 0; i < 4; i++) {
        id = await page.evaluate((old) => {
          if (old) window.feed.remove(old);
          return window.feed.add();
        }, id);
        await sleep(350);
      }
      await sleep(2600);
      await swClearLog(ctx.sw);
      await clickVideo(page, id);
      const { hit, elapsed } = await waitEngage(ctx.sw, (r) => r.ok && r.signal === true, 5000);
      if (!hit) return `boost never confirmed after rapid churn`;
      ctx.note(`boost confirmed ${elapsed}ms after click`);
      return true;
    } finally { await page.close(); }
  },

  // Release must reach the swapped-in hook: boost, swap, click (boost lands), then 1.0x.
  async s8_release_after_swap(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      await swSetGain(ctx.sw, tabId, 3);
      const b = await page.evaluate((old) => { window.feed.remove(old); return window.feed.add(); }, a);
      await sleep(2600);
      await clickVideo(page, b);
      await waitEngage(ctx.sw, (r) => r.ok, 5000);
      const rel = await swSetGain(ctx.sw, tabId, 1);
      if (rel.mode !== "none") return `release returned ${JSON.stringify(rel)}`;
      const gain = await swGetGain(ctx.sw, tabId);
      const mode = await swGetMode(ctx.sw, tabId);
      if (gain !== undefined || mode !== undefined) return `state not cleared: gain=${gain} mode=${JSON.stringify(mode)}`;
      return true;
    } finally { await page.close(); }
  },
};

// ---- main ---------------------------------------------------------------
(async () => {
  const { server, port } = await serveFixtures();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false, // extension + media playback: headed is the reliable path; window is small and brief
    args: [
      `--disable-extensions-except=${REPO}`,
      `--load-extension=${REPO}`,
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio", // audio still flows through WebAudio graphs; just don't blast the speakers
      "--window-size=800,600",
      "--no-first-run", "--no-default-browser-check",
    ],
  });

  let failed = 0;
  try {
    const sw = await getWorker(browser);
    await installSpy(sw);
    const wanted = process.argv.slice(2).map((s) => s.toLowerCase());
    for (const [name, fn] of Object.entries(scenarios)) {
      if (wanted.length && !wanted.some((w) => name.startsWith(w))) continue;
      const notes = [];
      const ctx = { browser, port, sw, note: (s) => notes.push(s) };
      let outcome;
      try { outcome = await fn(ctx); }
      catch (e) { outcome = `threw: ${e.message}`; }
      const ok = outcome === true;
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${notes.length ? "  (" + notes.join("; ") + ")" : ""}${ok ? "" : "\n      " + outcome}`);
      await swClearLog(sw);
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  process.exit(failed ? 1 : 0);
})();
