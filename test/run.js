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
  // Second origin (different port = different origin) serving the tone WITHOUT CORS headers:
  // an "ad CDN" whose media the extension can never hook in-page (cross-origin-no-cors).
  const adServer = http.createServer((req, res) => {
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

// Trusted click on a fixture video via CDP input (real user activation). Scrolls it into view
// first: in a growing feed the target is otherwise below the fold and the click lands on nothing.
async function clickVideo(page, id) {
  const pos = await page.evaluate((i) => {
    const v = document.getElementById(i);
    if (!v) return null;
    v.scrollIntoView({ block: "center" });
    const r = v.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
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
      await swClearLog(ctx.sw);
      const ad = await page.evaluate((m) => window.feed.adStart(m, {}), main);
      const sw1 = await waitEngage(ctx.sw, (r) => r.ok && r.signal === true, 4000);
      if (!sw1.hit) return `hook never switched to the ad within 4s`;
      ctx.note(`switched to ad after ${sw1.elapsed}ms`);
      await swClearLog(ctx.sw);
      await page.evaluate((a, m) => window.feed.adEnd(a, m), ad, main);
      const back = await waitEngage(ctx.sw, (r) => r.ok && r.signal === true, 5000);
      if (!back.hit) return `boost never returned to the content video after the ad`;
      ctx.note(`recovered ${back.elapsed}ms after ad end`);
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

  // Clicking through a feed: EVERY click must stay fast. Before gesture-attributed urgency the
  // 3-per-10s token budget ran dry and click 4+ fell back to the ~2s churn wait - the reported
  // "my ears get blasted for 1-2s" on a ducked tab.
  async s11_repeat_click_latency(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const first = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05); // ducked: the case that actually hurts
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), first);
      const times = [];
      for (let i = 0; i < 6; i++) {
        const id = await page.evaluate(() => window.feed.add()); // muted autoplay, like the feed
        await sleep(1000);                                       // user cadence between clicks
        await swClearLog(ctx.sw);
        await clickVideo(page, id);                              // trusted CDP click = real gesture
        const { hit, elapsed } = await waitEngage(ctx.sw, (r) => r.ok && r.signal === true, 5000);
        if (!hit) return `click ${i + 1}: boost never confirmed`;
        times.push(elapsed);
        await page.evaluate((x) => window.feed.pause(x), id);
      }
      ctx.note(`${times.join("/")}ms`);
      const worst = Math.max(...times);
      if (worst > 700) return `latency degrades on repeat clicks: ${times.join("/")}ms (budget 700ms each)`;
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

  // A burst of urgent signals that COALESCES into one send must not spend the whole urgency
  // budget: the next genuine, gesture-less urgency (a site unmuting by itself after an ad) has
  // to stay fast. Pre-fix the budget was charged before the coalescing check, so three folded
  // events emptied it and the next real one fell back to the ~2s churn wait.
  async s14_nongesture_urgency_survives_burst(ctx) {
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
      await swClearLog(ctx.sw);
      // the genuine event, still gesture-less: the page unmutes its next video by itself
      await page.evaluate((m, s, t) => {
        window.feed.pause(m);
        window.feed.pause(s);
        const v = document.getElementById(t);
        v.muted = false; v.volume = 1;
      }, main, spam, target);
      const { hit, elapsed } = await waitEngage(ctx.sw, (x) => x.ok && x.signal === true, 5000);
      if (!hit) return `boost never confirmed after a gesture-less unmute`;
      ctx.note(`${elapsed}ms`);
      if (elapsed > 700) return `gesture-less urgency degraded to ${elapsed}ms after a coalesced burst`;
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
