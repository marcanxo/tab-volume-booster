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
    // Newest build first: an older cached build must never win by directory order.
    const dirs = fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) {
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
  // Second origin (different port = different origin) serving the tone WITHOUT CORS headers:
  // an "ad CDN" whose media the extension can never hook in-page (cross-origin-no-cors).
  const adServer = http.createServer((req, res) => {
    // The ad origin doubles as a genuinely cross-origin host for the iframe fixture: same
    // process boundary a real embedded player sits behind.
    const p = req.url.split("?")[0];
    if (p.endsWith(".html")) {
      const file = path.join(__dirname, "fixtures", path.basename(p));
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(fs.readFileSync(file));
      }
    }
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
    res.end(wav);
  });
  const adReady = new Promise((r) => adServer.listen(0, "127.0.0.1", () => r(adServer.address().port)));
  // Per-path request counter: lets a scenario assert how many times the redirect-safety probe
  // actually hits the origin (the fetch-storm guard is invisible otherwise).
  // bytes=0-0 is the redirect probe's signature; media elements request open-ended ranges, so
  // counting only this keeps a looping <video> re-fetch from being charged to the extension.
  const counts = {};
  const server = http.createServer(async (req, res) => {
    const p = req.url.split("?")[0];
    if (req.headers.range === "bytes=0-0") counts[p] = (counts[p] || 0) + 1;
    if (req.url === "/tone.wav" || p === "/media.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
      return res.end(wav);
    }
    // Same-origin URL that HTTP-redirects to another origin: plays natively, but its media data
    // is CORS-tainted, so hooking it would silence the tab. This is what sameOriginChainOk exists
    // to detect, and nothing in the blob-based fixtures ever exercised it.
    if (p === "/redir.wav") {
      const adPort = await adReady;
      res.writeHead(302, { Location: `http://127.0.0.1:${adPort}/ad-tone.wav` });
      return res.end();
    }
    // Host page for the iframe scenarios: the player origin is only known once the ad server has
    // a port, so it is substituted here rather than hardcoded in the file.
    if (p === "/frame-host.html") {
      const adPort = await adReady;
      const html = fs.readFileSync(path.join(__dirname, "fixtures", "frame-host.html"), "utf8")
        .replace("__INNER__", `http://127.0.0.1:${adPort}/x-feed.html`);
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(html);
    }
    if (req.url === "/adsrc") {
      const adPort = await adReady;
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(`http://127.0.0.1:${adPort}/ad-tone.wav`);
    }
    const file = path.join(__dirname, "fixtures", req.url === "/" ? "x-feed.html" : req.url);
    if (!file.startsWith(path.join(__dirname, "fixtures")) || !fs.existsSync(file)) {
      res.writeHead(404); return res.end("nope");
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => r({ server, adServer, counts, port: server.address().port }))
  );
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
  await sw.evaluate(async () => {
    if (globalThis.__spy) { globalThis.__spy.log.length = 0; return; }
    // The worker target can be attachable before its chrome.* namespaces are wired up, so the
    // very first evaluate can find chrome.runtime/chrome.tabs still undefined. Wait them out.
    for (let i = 0; i < 100; i++) {
      if (globalThis.chrome && chrome.tabs && chrome.tabs.sendMessage && chrome.runtime && chrome.runtime.onMessage) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const log = [];
    globalThis.__spy = { log, pings: 0 };
    // Count inbound 'navigated' pings so a scenario can assert the anti-flood ceiling: the
    // gesture fast-path trades some of that ceiling away and nothing else would catch it.
    chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "navigated") globalThis.__spy.pings++; });
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
const swClearSpy = (sw) => sw.evaluate(() => { globalThis.__spy.log.length = 0; globalThis.__spy.pings = 0; });
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

// Trusted click on a fixture video via CDP input (real user activation). The fixture scrolls the
// target into view first: in a growing feed it is otherwise below the fold and the click lands on
// nothing. It also knows where shadow-DOM players are, which a selector here could not reach.
async function clickVideo(page, id) {
  const pos = await page.evaluate((i) => window.feed.point(i), id);
  if (!pos) throw new Error(`no video ${id}`);
  await page.mouse.click(pos.x, pos.y);
}

// Same, for a player inside an iframe: the point comes back in the INNER frame's coordinates, so
// it has to be offset by where that frame sits in the top-level viewport.
async function clickInFrame(page, frame, id) {
  const pos = await frame.evaluate((i) => window.feed.point(i), id);
  if (!pos) throw new Error(`no video ${id} in frame`);
  const box = await page.evaluate(() => {
    const r = document.getElementById("inner").getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.click(box.x + pos.x, box.y + pos.y);
}

// The ground truth for both in-page paths (the click pre-hook and the unmute auto-hook): the
// level is applied where the signal happens, so NOTHING should leave the page - no ping, no
// engage - and the page can prove the element was taken, because a second
// createMediaElementSource on it throws. Call swClearSpy right before the trigger. Destructive
// on `id`: it must be the scenario's last word about that element.
async function assertHookedInPage(ctx, page, id, label) {
  await sleep(1200); // a worker roundtrip would long since have shown up
  const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
  const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
  if (!(await page.evaluate((i) => window.feed.isHooked(i), id)))
    return `${label}: the video was never hooked`;
  if (pings || engages) return `${label}: the boost needed the worker (${pings} pings, ${engages} engages)`;
  return true;
}

async function newFeedPage(browser, port) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.feedReady === true, { timeout: 5000 });
  return page;
}

// A page whose only player sits in a cross-origin iframe.
async function newFramedPage(browser, port) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/frame-host.html`, { waitUntil: "load" });
  for (let i = 0; i < 60; i++) {
    const inner = page.frames().find((f) => f !== page.mainFrame() && f.url().includes("x-feed.html"));
    if (inner) {
      try {
        await inner.waitForFunction(() => window.feedReady === true, { timeout: 1000 });
        return { page, inner };
      } catch (_) { /* frame still booting */ }
    }
    await sleep(100);
  }
  await page.close();
  throw new Error("the inner player frame never became ready");
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

  // The X flow: boosted video A PAUSES (X pauses off-screen posts - no DOM change), muted
  // successor B appears, the user clicks B to unmute it. The click has to carry the boost itself.
  async s3_pause_swap_click(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a); // silent pause, no ping
      const b = await page.evaluate(() => window.feed.add());
      await sleep(2600); // let the churn pass fully drain (worst-case cooldown)
      await swClearSpy(ctx.sw);
      await clickVideo(page, b);
      return await assertHookedInPage(ctx, page, b, "pause-swap click");
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

  // The old "sometimes no boost at all" shape: B is added while A is STILL PLAYING, then A
  // pauses (no DOM change, no ping), then the user clicks B. The unmute is a property write, so
  // nothing in the page is observable - the gesture itself is the only signal there is.
  async s7_unarmed_unmute(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const b = await page.evaluate(() => window.feed.add()); // churn while A still plays
      await sleep(2600);                                      // churn pass drains
      await page.evaluate((i) => window.feed.pause(i), a);    // A pauses silently - NO ping
      await sleep(400);
      await swClearSpy(ctx.sw);
      await clickVideo(page, b);                              // unmute: property write only
      return await assertHookedInPage(ctx, page, b, "unarmed unmute");
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
      await swClearSpy(ctx.sw);
      await clickVideo(page, id);
      return await assertHookedInPage(ctx, page, id, "click after rapid churn");
    } finally { await page.close(); }
  },

  // Ad break, same-origin ad element (IMA style): content pauses, audible ad appears.
  // Expected: the hook SWITCHES to the ad (audible playing beats paused - by design, so the
  // user's level applies consistently), and returns to the content video after the break.
  async s9a_ad_switch_and_recover(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const ad = await page.evaluate((m) => window.feed.adStart(m, {}), main);
      // Since the play listener, the switch may happen IN-PAGE (zero worker traffic) or via the
      // worker - either way the ground truth is the same: the LIVE graph must carry audible
      // signal, which only the ad produces now (the content is paused). A hook stuck on the
      // paused content would measure silence.
      await sleep(1500);
      const m1 = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
      if (!m1 || !m1.ok || !m1.signal) return `hook never moved to the ad (live graph silent: ${JSON.stringify(m1)})`;
      await page.evaluate((a, m) => window.feed.adEnd(a, m), ad, main);
      await sleep(2000);
      const m2 = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
      if (!m2 || !m2.ok || !m2.signal) return `boost never returned to the content video after the ad (live graph silent: ${JSON.stringify(m2)})`;
      return true;
    } finally { await page.close(); }
  },

  // Ad plays WHILE the content keeps playing (ducked backing track + ad case): the no-steal
  // gate must keep the hook on the content; the ad plays at native volume (documented tradeoff).
  async s9b_ad_no_steal_while_playing(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05); // ducked, Chordify-style
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await swClearLog(ctx.sw);
      // audible ad appears but the content is NOT paused
      await page.evaluate(() => window.feed.add() && undefined);
      const adv = await page.evaluate(() => { const v = document.querySelectorAll("video"); const last = v[v.length-1]; last.muted = false; last.volume = 1; return last.id; });
      await sleep(3000); // give churn ping + restore pass time to run
      const log = await swSpyLog(ctx.sw);
      const stolen = log.find((e) => e.cmd === "engage" && e.res && e.res.signal === true);
      if (stolen) return `hook was stolen by the ad although the content was still playing`;
      const mode = await swGetMode(ctx.sw, tabId);
      if (!mode || mode.mode !== "element") return `mode drifted: ${JSON.stringify(mode)}`;
      return true;
    } finally { await page.close(); }
  },

  // CROSS-ORIGIN ad while the content is paused: the switch gate opens (audible playing ad,
  // idle content), but the ad can never be hooked. The content's hook must NOT be sacrificed:
  // the boost survives the break and no capture flip happens.
  async s9c_cross_origin_ad_keeps_hook(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await swClearLog(ctx.sw);
      const ad = await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true }), main);
      await sleep(3500); // churn ping + restore pass window
      const log = await swSpyLog(ctx.sw);
      const sacrificed = log.find((e) => e.cmd === "engage" && e.res && e.res.ok === false && e.res.reason === "cross-origin-no-cors");
      if (sacrificed) return `BUG: hook was retired for an unhookable cross-origin ad (reason cross-origin-no-cors refusal seen) - content plays unboosted during the break`;
      const mode = await swGetMode(ctx.sw, tabId);
      if (mode && mode.mode === "capture") return `BUG: tab flipped to capture mode because of the ad (fullscreen lost)`;
      await swClearLog(ctx.sw);
      await page.evaluate((a, m) => window.feed.adEnd(a, m), ad, main);
      await sleep(2500);
      const mode2 = await swGetMode(ctx.sw, tabId);
      const gain = await swGetGain(ctx.sw, tabId);
      if (gain !== 3) return `stored gain drifted: ${gain}`;
      if (mode2 && mode2.mode === "capture") return `capture flip after ad end`;
      return true;
    } finally { await page.close(); }
  },

  // User drags the slider WHILE a cross-origin ad plays (content paused): the engage must
  // not sacrifice the content's hook to an ad it can never hook, and must not flip to capture.
  async s9d_slider_during_cross_origin_ad(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const ad = await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true }), main);
      await sleep(600);
      await swClearLog(ctx.sw);
      const r2 = await swSetGain(ctx.sw, tabId, 4); // the slider move mid-ad
      if (r2.mode !== "element") return `BUG: slider move mid-ad left element mode (got ${JSON.stringify(r2)}) - real users with the popup open flip to capture here`;
      const log = await swSpyLog(ctx.sw);
      const sacrificed = log.find((e) => e.cmd === "engage" && e.res && e.res.ok === false && e.res.reason === "cross-origin-no-cors");
      if (sacrificed) return `BUG: content hook was retired for the unhookable ad (cross-origin-no-cors refusal)`;
      const stopped = log.find((e) => e.cmd === "stop");
      if (stopped) return `BUG: stop was broadcast mid-ad - the content hook was shut down under the stored level`;
      await page.evaluate((a, m) => window.feed.adEnd(a, m), ad, main);
      await sleep(2500);
      const gain = await swGetGain(ctx.sw, tabId);
      const mode = await swGetMode(ctx.sw, tabId);
      if (gain !== 4) return `stored gain drifted: ${gain}`;
      if (!mode || mode.mode !== "element") return `mode after ad end: ${JSON.stringify(mode)} (expected element)`;
      return true;
    } finally { await page.close(); }
  },

  // DRM page holding a harmless safe element (decoy): the probe substitutes the decoy for
  // mode prediction, but a churn ping must NOT grind the 8-iteration restore loop on endless
  // 'drm' refusals - one refusal, terminal resolve, done.
  async s10_drm_decoy_no_grind(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      const drmOk = await page.evaluate((m) => window.feed.makeDrm(m), main);
      if (!drmOk) return `fixture could not attach MediaKeys`;
      await page.evaluate(() => window.feed.add()); // safe muted decoy
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode === "element") return `element mode claimed on a DRM top pick: ${JSON.stringify(r1)}`;
      await sleep(2500); // let any setGain-path restore noise drain
      await swClearLog(ctx.sw);
      await page.evaluate(() => window.feed.add()); // churn ping -> kickRestore
      await sleep(6000); // long enough that a pre-fix 8x(350+400) grind would be visible
      const log = await swSpyLog(ctx.sw);
      const drmRefusals = log.filter((e) => e.cmd === "engage" && e.res && e.res.reason === "drm").length;
      const probes = log.filter((e) => e.cmd === "probe").length;
      if (drmRefusals > 2) return `restore loop ground ${drmRefusals} drm refusals (expected <=2, terminal resolve)`;
      if (probes > 4) return `restore loop ran ${probes} probes (expected <=4)`;
      ctx.note(`${drmRefusals} drm refusal(s), ${probes} probe(s)`);
      return true;
    } finally { await page.close(); }
  },

  // Clicking through a feed: EVERY click has to carry its own boost, not just the first. This is
  // where the old anti-flood budget used to run dry and clicks 4+ fell back to a ~2s wait - the
  // reported "my ears get blasted for one to two seconds" on a ducked tab.
  async s11_repeat_click_latency(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const first = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05); // ducked: the case that actually hurts
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), first);
      for (let i = 0; i < 6; i++) {
        const id = await page.evaluate(() => window.feed.add()); // muted autoplay, like the feed
        await sleep(1000);                                       // user cadence between clicks
        await swClearSpy(ctx.sw);
        await clickVideo(page, id);                              // trusted CDP click = real gesture
        const verdict = await assertHookedInPage(ctx, page, id, `click ${i + 1}`);
        if (verdict !== true) return verdict;
        await page.evaluate((x) => window.feed.pause(x), id);
      }
      ctx.note("6 clicks, no worker traffic");
      return true;
    } finally { await page.close(); }
  },

  // The anti-flood ceiling the gesture fast-path trades against. ONE real click must not licence
  // a page to drive the worker: a non-hooked element spamming volumechange gets at most the
  // per-gesture allowance, then falls back to the budget and the churn wait.
  async s12_ping_flood_ceiling(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r = await swSetGain(ctx.sw, tabId, 3);
      if (r.mode !== "element" || !r.confirmed) return `setup failed: ${JSON.stringify(r)}`;
      const spam = await page.evaluate(() => window.feed.addAudible()); // 2nd audible video, never hooked
      await sleep(2600);                                               // let the churn settle
      await ctx.sw.evaluate(() => { globalThis.__spy.pings = 0; });
      await clickVideo(page, main);   // ONE trusted gesture (on the hooked element: no ping itself)
      await page.evaluate((id) => {   // page spams volumechange on the OTHER element
        const v = document.getElementById(id);
        let n = 0;
        window.__spamTimer = setInterval(() => { v.volume = (n++ % 2) ? 0.5 : 0.6; }, 5);
      }, spam);
      await sleep(1500);
      await page.evaluate(() => clearInterval(window.__spamTimer));
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      ctx.note(`${pings} pings`);
      if (pings > 8) return `ping flood: ${pings} navigated messages in 1.5s after a single click (ceiling 8)`;
      return true;
    } finally { await page.close(); }
  },

  // Redirect safety, and the request cost of warming it. A same-origin URL that 302s to another
  // origin must never be hooked (it would silence the tab), and repeated probes must not re-fetch
  // that failing URL every time.
  async s13_same_origin_redirect_guard(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      // (a) a plain same-origin file is hookable
      await page.evaluate(() => window.feed.addSrc("/media.wav"));
      await sleep(500);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const good = await swSetGain(ctx.sw, tabId, 3);
      if (good.mode !== "element" || !good.confirmed) return `same-origin media not hooked: ${JSON.stringify(good)}`;
      await swSetGain(ctx.sw, tabId, 1); // release before the second half
      await sleep(300);
    } finally { await page.close(); }

    const page2 = await newFeedPage(ctx.browser, ctx.port);
    try {
      // (b) a same-origin URL that redirects cross-origin must be refused, not hooked
      await page2.evaluate(() => window.feed.addSrc("/redir.wav"));
      await sleep(600);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      await swClearLog(ctx.sw);
      ctx.counts["/redir.wav"] = ctx.counts["/redir.wav"] || 0;
      const res = await swSetGain(ctx.sw, tabId, 3);
      if (res.mode === "element") return `BUG: hooked a same-origin URL that redirects cross-origin (would silence the tab)`;
      const log = await swSpyLog(ctx.sw);
      const refused = log.find((e) => e.cmd === "engage" && e.res && e.res.reason === "cross-origin-redirect");
      if (!refused) return `expected a cross-origin-redirect refusal, got ${JSON.stringify(log.filter((e) => e.cmd === "engage").map((e) => e.res))}`;
      // (c) repeated probes must not re-request the failing URL every time (negative TTL)
      const before = ctx.counts["/redir.wav"];
      for (let i = 0; i < 6; i++) {
        await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "probe" }).catch(() => {}), tabId);
        await sleep(200);
      }
      const added = (ctx.counts["/redir.wav"] || 0) - before;
      ctx.note(`refused; ${added} extra probe requests over 6 probes`);
      if (added > 0) return `probe warming re-fetches the failing src: ${added} requests over 6 probes`;
      return true;
    } finally { await page2.close(); }
  },

  // A burst of volumechange from the page must not spend the auto-hook allowance: the next
  // genuine unmute has to still be taken in-page. The burst lands on an element the auto-hook
  // refuses anyway (an audible one, while the hooked video is still playing), and a refusal has
  // to cost nothing - otherwise a page could empty the budget at will and push every real unmute
  // back onto the slow path.
  async s14_burst_does_not_drain_autohook(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r = await swSetGain(ctx.sw, tabId, 0.05); // ducked: the case where a delay hurts
      if (r.mode !== "element" || !r.confirmed) return `setup failed: ${JSON.stringify(r)}`;
      const spam = await page.evaluate(() => window.feed.addAudible()); // audible, never hooked
      const target = await page.evaluate(() => window.feed.add());      // muted autoplay
      await sleep(2600);
      // burst of urgent-but-coalescing volumechange, with NO user gesture anywhere
      await page.evaluate((id) => {
        const v = document.getElementById(id);
        for (let i = 0; i < 12; i++) v.volume = 0.5 + (i % 2) * 0.1;
      }, spam);
      await sleep(400);
      await swClearSpy(ctx.sw);
      // the genuine event, still gesture-less: the page unmutes its next video by itself
      await page.evaluate((m, s, t) => {
        window.feed.pause(m);
        window.feed.pause(s);
        window.feed.unmute(t);
      }, main, spam, target);
      return await assertHookedInPage(ctx, page, target, "unmute after a volumechange burst");
    } finally { await page.close(); }
  },

  // The pre-hook. Clicking a muted video in a boosted tab must apply the level inside the
  // gesture itself - no ping, no worker roundtrip, no engage. Ground truth on both sides: the
  // spy sees NOTHING leave the page, and the page can prove the element was taken (a second
  // createMediaElementSource on it throws).
  async s15_prehook_no_roundtrip(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05); // ducked: the case where the delay hurts
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const b = await page.evaluate(() => window.feed.add()); // muted autoplay, not hooked
      await sleep(2600);                                      // let the churn pass drain fully
      await swClearLog(ctx.sw);
      await ctx.sw.evaluate(() => { globalThis.__spy.pings = 0; });
      await clickVideo(page, b);
      await sleep(1200); // a worker roundtrip would long since have happened
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
      const hooked = await page.evaluate((i) => window.feed.isHooked(i), b);
      ctx.note(`${pings} pings, ${engages} engages`);
      if (!hooked) return `the clicked video was never hooked - the pre-hook did not fire`;
      if (pings || engages) return `boost went through the worker (${pings} pings, ${engages} engages) instead of landing inside the gesture`;
      return true;
    } finally { await page.close(); }
  },

  // Same, but the click lands on a transparent cover over the video (how real players are built):
  // the event target is a <div>, so only hit-testing the point finds the media element.
  async s16_prehook_overlay_click(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const b = await page.evaluate(() => window.feed.addOverlay());
      await sleep(2600);
      await swClearLog(ctx.sw);
      await ctx.sw.evaluate(() => { globalThis.__spy.pings = 0; });
      await clickVideo(page, b); // centre of the video = centre of the cover on top of it
      await sleep(1200);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const hooked = await page.evaluate((i) => window.feed.isHooked(i), b);
      ctx.note(`${pings} pings`);
      if (!hooked) return `covered video not pre-hooked - the element lookup missed it behind the overlay`;
      if (pings) return `boost still went through the worker (${pings} pings)`;
      return true;
    } finally { await page.close(); }
  },

  // The pre-hook has no time to check anything asynchronously, so its safety gates must refuse
  // on their own. A cross-origin element would be SILENCED by the hook, permanently.
  async s17_prehook_refuses_unhookable(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const ad = await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true }), main);
      await sleep(2600); // the ordinary path settles (s9c covers what it does)
      await clickVideo(page, ad);
      await sleep(800);
      const hooked = await page.evaluate((i) => window.feed.isHooked(i), ad);
      if (hooked) return `BUG: the pre-hook took a cross-origin element - it is now silent for good`;
      const mode = await swGetMode(ctx.sw, tabId);
      if (mode && mode.mode === "capture") return `tab flipped to capture over the ad click`;
      return true;
    } finally { await page.close(); }
  },

  // The redirect gate, synchronously. A same-origin URL is only hookable once the probe has
  // cleared it: cleared ones must be pre-hooked, and one that 302s to another origin must not be
  // (hooking it would silence the tab) even though its URL looks perfectly same-origin.
  async s18_prehook_sync_chain_gate(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addSrc("/media.wav"));
      await sleep(500);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const b = await page.evaluate(() => window.feed.addSrc("/media.wav", { muted: true }));
      await sleep(2600); // probe warming clears the src while the churn drains
      await ctx.sw.evaluate(() => { globalThis.__spy.pings = 0; });
      await clickVideo(page, b);
      await sleep(1200);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      if (!(await page.evaluate((i) => window.feed.isHooked(i), b)))
        return `a cleared same-origin src was not pre-hooked`;
      ctx.note(`cleared src: ${pings} pings`);
      if (pings) return `cleared same-origin src still needed the worker (${pings} pings)`;
    } finally { await page.close(); }

    const page2 = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page2.evaluate(() => window.feed.addSrc("/media.wav"));
      await sleep(500);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed (b): ${JSON.stringify(r1)}`;
      await page2.evaluate((i) => window.feed.pause(i), a);
      const bad = await page2.evaluate(() => window.feed.addSrc("/redir.wav", { muted: true }));
      await sleep(2600);
      await clickVideo(page2, bad);
      await sleep(800);
      if (await page2.evaluate((i) => window.feed.isHooked(i), bad))
        return `BUG: pre-hooked a same-origin URL that redirects cross-origin - the element is now silent`;
      return true;
    } finally { await page2.close(); }
  },

  // Every hook in a frame shares ONE AudioContext now - that sharing is what lets the pre-hook
  // work synchronously. Parked graphs are still reclaimed once their element leaves the DOM, and
  // closing the context there would silence every OTHER element on it, forever. Then the second
  // half: an element whose parked graph WAS reclaimed comes back. Its one-shot hook is spent, but
  // that is our own doing and must never be reported as another app holding the user's player.
  async s19_shared_ctx_reclaim(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const first = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), first);
      // Click through four more videos. Each one parks the previous graph on the shared context,
      // and they all stay in the DOM, so none of them is reclaimable yet.
      const ids = [];
      for (let i = 0; i < 4; i++) {
        const id = await page.evaluate(() => window.feed.add());
        ids.push(id);
        await sleep(900);
        await clickVideo(page, id);
        await sleep(400);
        await page.evaluate((x) => window.feed.pause(x), id);
      }
      // Now make two of them collectable and park one more graph, which triggers the reclaim.
      await page.evaluate((x, y) => { window.feed.detach(x); window.feed.detach(y); }, first, ids[0]);
      const last = await page.evaluate(() => window.feed.add());
      await sleep(900);
      await clickVideo(page, last);
      await sleep(600);
      // ids[1] never left the DOM and its graph is parked on that same context. Bring it back:
      // if reclaiming the detached graphs closed the context, it is silent for good.
      await page.evaluate((keep, drop) => {
        drop.forEach((x) => window.feed.pause(x));
        const v = document.getElementById(keep);
        v.muted = false; v.volume = 1; v.play().catch(() => {});
      }, ids[1], [ids[2], ids[3], last]);
      await sleep(500);
      // Since the play/volumechange listeners, the returning element is re-adopted IN-PAGE, so
      // an engage would fast-path without measuring. The read-only measure is the ground truth:
      // if reclaiming the detached graphs closed the shared ctx, the live graph is silent.
      const back = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
      if (!back || !back.ok || !back.signal)
        return `BUG: a parked graph lost its audio when a detached one was reclaimed: ${JSON.stringify(back)}`;
      // The reclaimed element returns. Its hook is spent - refuse, but honestly.
      await page.evaluate((x, y) => { window.feed.pause(y); window.feed.reattach(x); }, first, ids[1]);
      await sleep(400);
      const again = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "engage", gain: 3, useLimiter: true }), tabId);
      ctx.note(`returning element: ${JSON.stringify(again)}`);
      if (again && again.reason === "already-hooked")
        return `BUG: our own spent hook was reported as a foreign app's conflict`;
      return true;
    } finally { await page.close(); }
  },

  // A player that keeps its video inside a shadow root, with its click catcher in there as well.
  // Neither the composed path nor a plain document hit-test reaches the video; only descending
  // into the root does.
  async s20_prehook_shadow_dom(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const b = await page.evaluate(() => window.feed.addShadow());
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await clickVideo(page, b);
      return await assertHookedInPage(ctx, page, b, "shadow-DOM player");
    } finally { await page.close(); }
  },

  // The player in a CROSS-ORIGIN iframe: its own frame, its own content script. The pre-hook has
  // to work there too, which also means the worker's element mode really pointed at that frame.
  async s21_prehook_in_iframe(ctx) {
    const { page, inner } = await newFramedPage(ctx.browser, ctx.port);
    try {
      const a = await inner.evaluate(() => window.feed.addAudible());
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `iframe player not hooked: ${JSON.stringify(r1)}`;
      await inner.evaluate((i) => window.feed.pause(i), a);
      const b = await inner.evaluate(() => window.feed.add());
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await clickInFrame(page, inner, b);
      await sleep(1200);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const hooked = await inner.evaluate((i) => window.feed.isHooked(i), b);
      ctx.note(`${pings} pings`);
      if (!hooked) return `the click inside the iframe did not pre-hook`;
      if (pings) return `iframe click still needed the worker (${pings} pings)`;
      return true;
    } finally { await page.close(); }
  },

  // The safety half of the same mechanism. Once the worker has routed the tab away from this
  // frame (capture, a conflict, a frame retarget - they all broadcast a stop first), the frame
  // must stop hooking on its own: an element hook underneath the capture gain is double volume.
  // Tell: an armed frame swallows the unmute silently, a disarmed one falls back to the ping.
  async s22_capture_disarms_frame(ctx) {
    const { page, inner } = await newFramedPage(ctx.browser, ctx.port);
    try {
      const a = await inner.evaluate(() => window.feed.addAudible());
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await inner.evaluate((i) => window.feed.pause(i), a);
      const b = await inner.evaluate(() => window.feed.add());
      await sleep(2600);
      // The worker decides this tab has to be captured instead. Whether the capture itself
      // succeeds in the test browser is beside the point - the disarm is what is under test.
      await ctx.sw.evaluate((t) => applyCaptureOrPause(t, 3, true, false), tabId);
      await sleep(400);
      await ctx.sw.evaluate(() => { globalThis.__spy.pings = 0; });
      await clickInFrame(page, inner, b);
      await sleep(1200);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      ctx.note(`${pings} pings after disarm`);
      if (!pings) return `BUG: the frame kept pre-hooking after the tab moved to capture - element gain would stack under the capture gain`;
      return true;
    } finally { await page.close(); }
  },

  // The reels pattern, and the case the click pre-hook can never cover: a brand new element
  // starts muted and the site unmutes it itself as you scroll. There is no gesture, so the
  // unmute is the only signal there is - and it has to be enough.
  async s23_autohook_on_self_unmute(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05); // ducked: where the delay is audible
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a); // the previous clip pauses first
      await sleep(2600);                                   // let earlier churn drain
      await swClearSpy(ctx.sw);
      const b = await page.evaluate(() => window.feed.addReel()); // muted, unmutes itself at +30ms
      // Deliberately NOT the zero-traffic assertion the other in-page scenarios use: inserting a
      // player into the DOM legitimately nudges the worker (that is the swap detection, and it
      // has nothing to do with the unmute). The sharp question is whether the element is already
      // boosted BEFORE any engage could possibly have arrived.
      await sleep(200);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
      const hooked = await page.evaluate((i) => window.feed.isHooked(i), b);
      if (!hooked) return `the self-unmuting reel was not taken in-page`;
      if (engages) return `an engage landed within 200ms, so this proves nothing about the auto-hook`;
      return true;
    } finally { await page.close(); }
  },

  // The ceiling on that. Unlike a gesture, an unmute is a property write a page can produce as
  // often as it likes, and every hook it triggers is one-shot. Past the allowance the signal has
  // to fall back to the ping it was before, which is what the pings here prove.
  async s24_autohook_budget_ceiling(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      // Build the elements FIRST and let all the DOM churn drain, so that during the burst below
      // the unmutes are the only thing that could possibly reach the worker. Otherwise the
      // insertions ping on their own and the ceiling would look enforced when it is not.
      const ids = await page.evaluate(() => {
        const made = [];
        for (let i = 0; i < 20; i++) made.push(window.feed.add());
        return made;
      });
      await sleep(3000);
      await swClearSpy(ctx.sw);
      // 20 self-unmutes inside one allowance window, each with the previous element paused so
      // the idle gate never refuses them for free.
      await page.evaluate(async (list) => {
        for (let i = 0; i < list.length; i++) {
          if (i) window.feed.pause(list[i - 1]);
          window.feed.unmute(list[i]);
          await new Promise((r) => setTimeout(r, 100));
        }
      }, ids);
      await sleep(1200);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      ctx.note(`20 self-unmutes, ${pings} pings`);
      if (!pings) return `no ceiling: every one of 20 self-unmutes was taken in-page, so a page can mint one-shot hooks at will`;
      return true;
    } finally { await page.close(); }
  },

  // The in-page paths finally measured, not just proven-to-have-hooked: after a pre-hook click
  // on a DUCKED tab, the read-only measure command reports the rms coming out of the gesture-
  // built graph. signal proves audio flows through that wiring; the rms magnitude proves the
  // ARMED level was applied (tone at 0.5 amplitude: 0.05x -> rms ~0.02, a wrongly-applied 1.0
  // or 3.0 -> rms 0.35+). engage cannot provide this ground truth - it re-sets the gain before
  // measuring, overwriting the very value under test.
  async s25_prehook_applies_level(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const b = await page.evaluate(() => window.feed.add());
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await clickVideo(page, b); // preHook adopts at 0.05; the click handler unmutes
      await sleep(600);          // let audio flow through the fresh graph
      const m = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
      ctx.note(`rms ${m && m.rms && m.rms.toFixed(4)}, ${engages} engages`);
      if (!m || !m.ok) return `no live graph to measure: ${JSON.stringify(m)}`;
      if (engages) return `an engage interfered - this run proves nothing about the in-page path`;
      if (!m.signal) return `BUG: no audio flows through the gesture-built graph (wiring broken)`;
      if (m.rms > 0.1) return `BUG: ducked tab plays at rms ${m.rms.toFixed(3)} - the armed 0.05x level was not applied by the pre-hook`;
      return true;
    } finally { await page.close(); }
  },

  // The disarm on the restore loop's give-up exits. When the loop exhausts (or hits 'suspended')
  // it drops the mode record - and with it the frameId, so it is the worker's LAST chance to
  // disarm a frame an earlier engage armed. Without the disarm that frame keeps self-hooking new
  // elements at its stale level, invisibly, while the worker tracks a different frame.
  async s26_restore_exhaust_disarms(ctx) {
    const { page, inner } = await newFramedPage(ctx.browser, ctx.port);
    try {
      const a = await inner.evaluate(() => window.feed.addAudible());
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3); // arms the INNER frame
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      // The hooked element vanishes and nothing replaces it: elementLost kicks the restore
      // loop, which probes ~6s, finds no media anywhere, and exits by clearing the mode.
      await inner.evaluate((i) => window.feed.remove(i), a);
      await sleep(8000);
      // The worker then tracks a DIFFERENT frame: a big muted video appears in the TOP frame
      // and the churn-ping restore engages it (element mode, frameId 0).
      await page.evaluate(() => new Promise((res) => {
        const v = document.createElement("video");
        v.src = "/tone.wav"; v.loop = true; v.muted = true; v.playsInline = true;
        v.style.cssText = "width:640px;height:360px;display:block";
        document.body.appendChild(v);
        v.play().finally(res);
      }));
      await sleep(5000); // queued restore passes settle on the top video; churn drains
      // A muted video appears in the INNER frame (it loses pickBest to the bigger top video,
      // so the worker never engages it there) ...
      const b = await inner.evaluate(() => window.feed.add());
      await sleep(2600);
      await ctx.sw.evaluate(() => { globalThis.__spy.pings = 0; });
      // ... and unmutes, gesture-less. A disarmed inner frame falls back to the ping; a
      // stale-armed one silently self-hooks at 3x - the untracked-frame hazard under test.
      await inner.evaluate((i) => window.feed.unmute(i), b);
      await sleep(1200);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const hooked = await inner.evaluate((i) => window.feed.isHooked(i), b);
      ctx.note(`${pings} pings after exhaust`);
      if (!pings && hooked) return `BUG: the inner frame stayed armed across the restore give-up exit and silently self-hooked at a level the worker no longer tracks`;
      if (!pings) return `no ping after the unmute - nothing reacted at all`;
      return true;
    } finally { await page.close(); }
  },

  // The ceiling on in-page hook minting (PARK_MAX). A feed that keeps every clicked video in
  // the DOM grows one unreclaimable parked graph per in-page hook; past the ceiling the
  // synchronous paths must refuse and the click must still get boosted - via the worker, at
  // worker pace. The user-visible contract: boosting never stops working, growth just returns
  // to worker-rate-limited.
  async s27_park_cap_falls_back(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), main);
      // 16 clicked videos, all kept in the DOM: each in-page hook parks one more graph, filling
      // the ceiling exactly. Each video is paused after its click so the NEXT one is the frame's
      // top pick.
      for (let i = 0; i < 16; i++) {
        const id = await page.evaluate(() => window.feed.add());
        await sleep(250);
        await clickVideo(page, id);
        await sleep(350);
        await page.evaluate((x) => window.feed.pause(x), id);
      }
      const last = await page.evaluate(() => window.feed.add());
      await sleep(2600); // drain churn so the next click's traffic is unambiguous
      await swClearSpy(ctx.sw);
      await clickVideo(page, last); // in-page refused at the ceiling -> gesture ping -> worker
      const { hit, elapsed } = await waitEngage(ctx.sw, (r) => r.ok && r.signal === true, 3000);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      ctx.note(`click 17: worker boost after ${elapsed}ms, ${pings} ping(s)`);
      if (!hit) return `past the park ceiling the click was neither hooked in-page nor boosted by the worker`;
      if (!pings) return `worker boost without a ping - the ceiling did not refuse, something else engaged`;
      return true;
    } finally { await page.close(); }
  },

  // Failed adopts must cost nothing. The budget bounds MINTED one-shot hooks; an element the
  // page itself routed through its own AudioContext makes every adopt throw, and a player that
  // fades el.volume fires dozens of such attempts. If they charged, the allowance would be gone
  // before the genuine unmute arrives. The assertion window closes before the worker could
  // possibly react, so the in-page budget is the only thing being measured.
  async s28_failed_adopts_cost_nothing(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const foreign = await page.evaluate(() => window.feed.add()); // muted for now
      const reel = await page.evaluate(() => window.feed.add());    // muted for now
      await sleep(2800); // churn fully drained while main still plays
      await page.evaluate((f) => window.feed.hookSelf(f), foreign);
      await page.evaluate((m) => window.feed.pause(m), main); // idle gate open: adopts will be attempted
      await sleep(300);
      await swClearSpy(ctx.sw);
      // One synchronous burst: 15 volume writes on the foreign-hooked element (every adopt
      // throws), then the genuine unmute. The queued volumechange tasks run in write order.
      await page.evaluate((f, r) => {
        const v = document.getElementById(f);
        window.feed.unmute(f);
        for (let i = 0; i < 14; i++) v.volume = 0.5 + ((i % 5) + 1) / 10;
        window.feed.unmute(r);
      }, foreign, reel);
      await sleep(150); // long before any worker roundtrip (>=600ms) could land
      const hooked = await page.evaluate((i) => window.feed.isHooked(i), reel);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
      ctx.note(`reel hooked in-page: ${hooked}, ${engages} engages in the window`);
      if (engages) return `an engage landed within 150ms - the measurement window is broken`;
      if (!hooked) return `BUG: 15 throwing adopts drained the budget, the genuine unmute fell off the fast path`;
      return true;
    } finally { await page.close(); }
  },

  // The worker-side urgency budget after a coalesced burst - the protection the old s14 held
  // before the auto-hook took its trigger in-page. It still matters: once the auto-hook
  // allowance is legitimately spent, every further unmute rides exactly this ping path, and a
  // regression of the charge-after-coalesce fix would push it onto the ~2s churn wait.
  async s29_worker_urgency_survives_burst(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const target = await page.evaluate(() => window.feed.add()); // muted autoplay, ranks below any audible element
      await sleep(2600);
      // Close the in-page path DETERMINISTICALLY: 17 self-unmuting elements, each becoming the
      // live hook (in-page or, when a timing collision leaks one, via the worker - both park
      // the predecessor), drive the parked count past PARK_MAX and spend the auto-hook budget
      // on the way. After this, a further unmute CANNOT be taken in-page - only the ping path
      // remains, which is exactly the path under test. The audible spam element is added ONLY
      // AFTERWARDS: audible and early in the DOM it would win every candidate pick, the worker
      // would move the hook onto it, and the loop's unmutes would all bounce off the no-steal
      // gate for free - park count and budget untouched, scenario meaningless.
      await page.evaluate((m) => window.feed.pause(m), main);
      // VERIFIED, not assumed: timing collisions (a churn engage holding the command queue)
      // make some unmutes skip both paths entirely, so a fixed element count cannot guarantee
      // the ceiling. Add self-unmuting elements until the frame REPORTS parked >= cap.
      // The ceiling (16) sits above one auto-hook window's allowance (12), so a single batch
      // cannot reach it in-page and the remainder would depend on worker-engage timing (flaky).
      // Instead: fill a window, wait for the rolling 10s allowance to refill, fill again.
      let prev = null;
      let parked = 0;
      for (let round = 0; round < 3 && parked < 16; round++) {
        for (let i = 0; i < 12 && parked < 16; i++) {
          prev = await page.evaluate((p) => {
            if (p) window.feed.pause(p);
            const el = window.feed.add();
            setTimeout(() => window.feed.unmute(el), 20);
            return el;
          }, prev);
          await sleep(150);
          if (i % 3 === 2) {
            const st = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
            parked = (st && st.parked) || 0;
          }
        }
        const st = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
        parked = (st && st.parked) || 0;
        if (parked < 16) await sleep(10500); // allowance refills; the ceiling is still short
      }
      if (parked < 16) return `could not drive the park count to the ceiling (${parked})`;
      const spam = await page.evaluate(() => window.feed.addAudible()); // audible, never hooked
      // Let the churn drain AND the worker's rolling 10s urgency window lapse: the loop's own
      // cap-refused tail unmutes ping urgently and legitimately spend tokens - the burst below
      // must be the only urgency consumer in the window, or the scenario measures the loop, not
      // the coalescing. (The auto-hook allowance refills too, but the park ceiling is what keeps
      // the in-page path closed, and that is timing-independent.)
      await sleep(11000);
      // The coalescing burst, gesture-less: volumechange spam on the unhooked audible element.
      await page.evaluate((id) => {
        const v = document.getElementById(id);
        for (let i = 0; i < 12; i++) v.volume = 0.5 + (i % 2) * 0.1;
      }, spam);
      await sleep(400);
      await swClearSpy(ctx.sw);
      // The genuine event: auto-hook budget is empty, so this MUST take the worker ping path,
      // and the worker's urgency budget must have survived the coalesced burst.
      await page.evaluate((m, s, p, t) => {
        window.feed.pause(m); window.feed.pause(s); window.feed.pause(p);
        window.feed.unmute(t);
      }, main, spam, prev, target);
      const { hit, elapsed } = await waitEngage(ctx.sw, (x) => x.ok && x.signal === true, 5000);
      if (!hit) {
        const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
        const hooked = await page.evaluate((i) => window.feed.isHooked(i), target);
        const log = (await swSpyLog(ctx.sw)).map((e) => `${e.cmd}@${e.t % 100000}${e.res ? ":" + JSON.stringify(e.res) : ""}`);
        const st = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
        return `boost never confirmed after the budget-exhausted unmute (pings=${pings} hooked=${hooked} parked=${st && st.parked} log=${JSON.stringify(log)})`;
      }
      ctx.note(`${elapsed}ms`);
      if (elapsed > 700) return `worker urgency degraded to ${elapsed}ms after a coalesced burst`;
      return true;
    } finally { await page.close(); }
  },

  // A STALE capture entry must heal on the next slider move. The active list survives reloads
  // (only closing the tab clears it), so if the trackEnded message from the offscreen engine is
  // ever lost, the worker keeps sending 'update' to a graph that no longer exists - the slider
  // goes dead for the tab's whole life, F5 does not help, and only a new tab works. Field bug:
  // boost active, in-tab navigation to the next episode killed the capture, slider dead from
  // then on, same after F5, fine in a fresh tab.
  async s30_stale_capture_entry_heals(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      // no video added: the probe finds nothing hookable, so setGain routes to the capture path
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      // simulate the lost trackEnded: the offscreen doc EXISTS but holds no graph for this tab,
      // while the active list claims it does (ensureOffscreen first, or createdFresh wipes it)
      await ctx.sw.evaluate(async (t) => { await ensureOffscreen(); await markActive(t); }, tabId);
      const res = await swSetGain(ctx.sw, tabId, 3);
      // ground truth from the engine itself: does a graph (or in-flight start) exist now?
      const ack = await ctx.sw.evaluate((t) =>
        chrome.runtime.sendMessage({ target: "offscreen", cmd: "update", tabId: t, gain: 3, useLimiter: true }).catch(() => null), tabId);
      const active = await ctx.sw.evaluate(() => sget("active"));
      const stillListed = Array.isArray(active) && active.includes(tabId);
      ctx.note(`mode=${res && res.mode}, graph=${!!(ack && ack.ok)}, listed=${stillListed}`);
      if (res && res.mode === "capture" && !(ack && ack.ok))
        return `BUG: mode says capture but the engine has no graph - the slider is dead and the popup lies`;
      if (stillListed && !(ack && ack.ok))
        return `BUG: the stale active entry survived the slider move - every future update goes into the void`;
      return true;
    } finally { await page.close(); }
  },

  // The muted-holder hostage, in-page half. A silent hero loop got the hook (it was the only
  // element when the level was set); the real clip then unmutes ITSELF. The old no-steal gate
  // refused because the loop "is playing" - but a muted holder contributes nothing audible, so
  // the steal is silent by definition and refusing means the audible media never gets the level.
  async s31_muted_holder_autohook_steal(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const loop = await page.evaluate(() => window.feed.add()); // muted autoplay loop
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05); // hooks the muted loop (only element)
      if (r1.mode !== "element") return `setup failed: ${JSON.stringify(r1)}`;
      const clip = await page.evaluate(() => window.feed.add());
      await sleep(2600); // churn drains; the loop keeps "playing" muted the whole time
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.unmute(i), clip); // gesture-less self-unmute
      return await assertHookedInPage(ctx, page, clip, "clip unmuting next to a muted holder");
    } finally { await page.close(); }
  },

  // Same hostage, worker half: the audible successor arrives via DOM churn and the WORKER'S
  // engage switch gate must hand off from the muted holder (old curIdle never included muted).
  async s32_muted_holder_engage_switch(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const loop = await page.evaluate(() => window.feed.add());
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element") return `setup failed: ${JSON.stringify(r1)}`;
      await swClearSpy(ctx.sw);
      // An audibly-playing clip appears with a same-origin src whose redirect verdict is COLD:
      // the in-page paths must refuse it (sync gate), so the signal falls through to the worker
      // and the ENGAGE switch gate is what hands off - the gate under test. A blob clip would be
      // adopted in-page by the play listener and never reach the worker.
      await page.evaluate(() => window.feed.addSrc("/media.wav"));
      const { hit, elapsed } = await waitEngage(ctx.sw, (r) => r.ok && r.signal === true, 5000);
      if (!hit) return `BUG: the muted loop held the hook - the audible clip never got the level`;
      ctx.note(`handoff after ${elapsed}ms`);
      return true;
    } finally { await page.close(); }
  },

  // Orphaned world after an extension update/reload. chrome.runtime.id reads undefined in an
  // invalidated context; the first event afterwards must unwind every graph to unity and stand
  // down - otherwise the old world keeps applying a level nobody can ever change again, and
  // capture gain from the NEW world would stack on top. Simulated by overriding chrome.runtime
  // in the extension's isolated world (executeScript reaches the same world as the content
  // script); the pre-override runtime references keep the measure channel alive for asserting.
  async s33_orphaned_world_stands_down(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05); // ducked: unity vs 0.05 is unmistakable in rms
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const m1 = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
      if (!m1 || !m1.ok || m1.rms > 0.1) return `precondition failed: ducked rms ${m1 && m1.rms}`;
      // simulate invalidation: chrome.runtime disappears from the isolated world
      await ctx.sw.evaluate((t) => chrome.scripting.executeScript({
        target: { tabId: t },
        func: () => { Object.defineProperty(chrome, "runtime", { get: () => undefined, configurable: true }); },
      }), tabId);
      // Deliberately NO user event: the dangerous stacking window (popup re-boost over a stale
      // orphan graph) involves none, so the standdown must come from the continuous trigger -
      // timeupdate on the playing video - all by itself.
      await sleep(900);
      const m2 = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
      ctx.note(`rms ducked ${m1.rms.toFixed(3)} -> after orphan ${m2 && m2.ok && m2.rms.toFixed(3)}`);
      if (!m2 || !m2.ok) return `measure channel died: ${JSON.stringify(m2)}`;
      if (m2.rms < 0.2) return `BUG: the orphaned world keeps applying the stale 0.05x level (rms ${m2.rms.toFixed(3)})`;
      // and it must be DISARMED: a fresh self-unmuting element must not be hooked by the corpse
      const b = await page.evaluate(() => window.feed.addReel());
      await sleep(600);
      if (await page.evaluate((i) => window.feed.isHooked(i), b))
        return `BUG: the orphaned world still mints hooks`;
      return true;
    } finally { await page.close(); }
  },

  // The capture-start ack: a start whose getUserMedia fails must answer ok:false, so the worker
  // reports an honest failure instead of recording mode 'capture' for a boost that never went
  // live (amber pill lying over silence).
  async s34_capture_start_acked(ctx) {
    const ack = await ctx.sw.evaluate(async () => {
      await ensureOffscreen();
      return chrome.runtime
        .sendMessage({ target: "offscreen", cmd: "start", tabId: 999999, streamId: "bogus-stream-id", gain: 3, useLimiter: true })
        .catch((e) => ({ err: String(e) }));
    });
    ctx.note(JSON.stringify(ack));
    if (!ack || ack.ok !== false) return `start with a dead streamId did not ack ok:false: ${JSON.stringify(ack)}`;
    return true;
  },

  // The play-event blind spot: a second video that is unmuted from the start and merely PAUSED.
  // Pressing play changes neither volume nor the DOM - before the play listener existed there
  // was no signal at all and the boost never arrived.
  async s35_play_on_unmuted_paused(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const b = await page.evaluate(() => window.feed.addPaused()); // unmuted, paused, never played
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), b); // no gesture, no volumechange, no churn
      return await assertHookedInPage(ctx, page, b, "play on an unmuted paused video");
    } finally { await page.close(); }
  },

  // Back/forward cache: a page frozen with a live graph returns after the user RELEASED the
  // boost - the release's stop could never reach it. The pageshow resync must shut the
  // resurrected boost down. (BFCache participation depends on the browser build; the scenario
  // verifies honestly and reports when the cache was not used.)
  async s36_bfcache_release_resync(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.goto(`http://127.0.0.1:${ctx.port}/x-feed.html?other`, { waitUntil: "load" });
      await swSetGain(ctx.sw, tabId, 1); // release while the boosted page sits in the freezer
      await sleep(300);
      await page.goBack({ waitUntil: "load" }).catch(() => {});
      await sleep(800); // pageshow resync roundtrip + stop ramp
      const persisted = await page.evaluate(() =>
        performance.getEntriesByType("navigation").some((n) => n.deliveryType === "back-forward" || n.type === "back_forward"));
      if (!persisted) { ctx.note("bfcache not used in this environment - resync path not exercised"); return true; }
      await page.evaluate((i) => { const v = document.getElementById(i); if (v) { v.muted = false; v.volume = 1; v.play(); } }, a);
      await sleep(400);
      const m = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
      ctx.note(`persisted, rms ${m && m.ok && m.rms && m.rms.toFixed(3)}`);
      if (m && m.ok && m.rms > 0.45) return `BUG: the resurrected page still boosts at 3x after the release (rms ${m.rms.toFixed(3)})`;
      return true;
    } finally { await page.close(); }
  },

  // Protection direction of the relaxed gates: an audible interloper firing 'play' while the
  // hooked content plays AUDIBLY must still be refused - the muted-holder relaxation must not
  // have opened the ad-steal door the no-steal gate exists for.
  async s37_play_no_steal_while_audible(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await sleep(2600);
      await swClearSpy(ctx.sw);
      // audible ad appears (fires 'play') while the content is STILL PLAYING audibly
      const ad = await page.evaluate(() => window.feed.addAudible());
      await sleep(1500);
      const hooked = await page.evaluate((i) => window.feed.isHooked(i), ad);
      const mode = await swGetMode(ctx.sw, tabId);
      if (hooked) return `BUG: the play path stole the hook from audibly-playing content`;
      if (mode && mode.mode !== "element") return `mode drifted: ${JSON.stringify(mode)}`;
      return true;
    } finally { await page.close(); }
  },

  // The resync handler itself, without needing BFCache (which CDP-attached pages never enter):
  // a frame holding a HOT graph while the worker has no active gain any more - exactly what a
  // BFCache restore after a release produces - must be shut down by one resync message.
  async s38_resync_releases_stale(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      // simulate the post-BFCache state: the stored level is GONE (released while frozen), the
      // frame's graph is still hot - deleted directly, bypassing release's stop broadcast
      await ctx.sw.evaluate(async (t) => { await sdel(`tabgain:${t}`); await sdel(`tabmode:${t}`); }, tabId);
      const m1 = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
      if (!m1 || !m1.ok || m1.rms > 0.1) return `precondition failed: graph not hot/ducked (${JSON.stringify(m1)})`;
      // the frame reports back from the freezer
      await ctx.sw.evaluate((t) => chrome.scripting.executeScript({
        target: { tabId: t },
        func: () => { try { chrome.runtime.sendMessage({ type: "resync" }); } catch (_) {} },
      }), tabId);
      await sleep(600); // handler roundtrip + stop ramp
      const m2 = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
      ctx.note(`rms ${m1.rms.toFixed(3)} -> ${m2 && m2.ok && m2.rms.toFixed(3)}`);
      if (!m2 || !m2.ok) return `measure failed after resync: ${JSON.stringify(m2)}`;
      if (m2.rms < 0.2) return `BUG: the stale graph still applies the released level after resync (rms ${m2.rms.toFixed(3)})`;
      return true;
    } finally { await page.close(); }
  },

  // The sacrifice guard on the switch gate: an audible interloper whose same-origin src 302s
  // cross-origin must NOT cost a muted holder its live hook (assess alone would open the gate;
  // the awaited redirect verdict must close it BEFORE anything is retired). Pre-fix this
  // flipped the tab to capture for the interloper's lifetime.
  async s39_redirect_interloper_no_sacrifice(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const loop = await page.evaluate(() => window.feed.add()); // muted holder
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element") return `setup failed: ${JSON.stringify(r1)}`;
      await sleep(2600);
      await swClearSpy(ctx.sw);
      const bad = await page.evaluate(() => window.feed.addSrc("/redir.wav")); // audible, same-origin -> 302 cross-origin
      await sleep(3500); // play ping + restore + awaited verdict all settle
      const mode = await swGetMode(ctx.sw, tabId);
      const hookedBad = await page.evaluate((i) => window.feed.isHooked(i), bad);
      ctx.note(`mode=${mode && mode.mode}`);
      if (hookedBad) return `BUG: the redirecting interloper was hooked (would be silenced)`;
      // The positive claim, not just "no capture": the holder's ELEMENT mode must survive. In
      // the harness a sacrificed hook shows up as mode undefined (capture start has no grant
      // here), in the field as mode 'capture' - both are the sacrifice.
      if (!mode || mode.mode !== "element") return `BUG: the muted holder's hook was sacrificed for an unhookable interloper (mode=${mode && mode.mode})`;
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
  const { server, adServer, counts, port } = await serveFixtures();
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
      const ctx = { browser, port, sw, counts, note: (s) => notes.push(s) };
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
    adServer.close();
  }
  process.exit(failed ? 1 : 0);
})();
