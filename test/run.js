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
    // The same redirect, with a check that answers late: the media element's own request gets
    // the 302 at once, the redirect probe's (bytes=0-0) only after 800 ms. An engage that runs
    // meanwhile finds the verdict still open and has to wait for it. no-store: the probe fetches
    // with cache "force-cache", and a stored copy of the element's 302 would answer it at once.
    if (p === "/redir-slow.wav") {
      const adPort = await adReady;
      if (req.headers.range === "bytes=0-0") await sleep(800);
      res.writeHead(302, { Location: `http://127.0.0.1:${adPort}/ad-tone.wav`, "Cache-Control": "no-store" });
      return res.end();
    }
    // A same-origin file whose redirect check answers late: the media element gets the file at
    // once, the redirect probe (bytes=0-0) only after 1.5 s. An engage that picks it waits on the
    // check. no-store for the same reason as above.
    if (p === "/slow.wav") {
      if (req.headers.range === "bytes=0-0") await sleep(1500);
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Cache-Control": "no-store" });
      return res.end(wav);
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
    if (p === "/decoy-host.html") {
      const adPort = await adReady;
      const html = fs.readFileSync(path.join(__dirname, "fixtures", "decoy-host.html"), "utf8")
        .replace(/__AD__/g, `http://127.0.0.1:${adPort}`);
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(html);
    }
    if (req.url === "/adsrc") {
      const adPort = await adReady;
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(`http://127.0.0.1:${adPort}/ad-tone.wav`);
    }
    const file = path.join(__dirname, "fixtures", p === "/" ? "x-feed.html" : p); // path only: fixtures take ?flags
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
  // The worker target can be attachable before its realm is fully set up (even setTimeout can be
  // missing for a moment, seen once as an uncaught ReferenceError that ended a whole run): retry
  // the install until it takes.
  for (let attempt = 0; ; attempt++) {
    try { await installSpyOnce(sw); return; }
    catch (e) { if (attempt >= 30) throw e; await sleep(100); }
  }
}
async function installSpyOnce(sw) {
  await sw.evaluate(async () => {
    if (globalThis.__spy) { globalThis.__spy.log.length = 0; return; }
    // The worker target can be attachable before its chrome.* namespaces are wired up, so the
    // very first evaluate can find chrome.runtime/chrome.tabs still undefined. Wait them out.
    for (let i = 0; i < 100; i++) {
      if (globalThis.chrome && chrome.tabs && chrome.tabs.sendMessage && chrome.runtime && chrome.runtime.onMessage) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const log = [];
    globalThis.__spy = { log, pings: 0, hooked: 0 };
    // Count inbound 'navigated' pings so a scenario can assert the anti-flood ceiling: the
    // gesture fast-path trades some of that ceiling away and nothing else would catch it.
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.type === "navigated") globalThis.__spy.pings++;
      if (m && m.type === "hooked") globalThis.__spy.hooked++;
    });
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
const swClearSpy = (sw) => sw.evaluate(() => { globalThis.__spy.log.length = 0; globalThis.__spy.pings = 0; globalThis.__spy.hooked = 0; });
// Runs `func` in a tab's ISOLATED world: the voice of our content script, which is what a page
// that has broken into its renderer could use. Returns what func returns.
// The function travels as source into the worker's DevTools evaluation (no eval in any extension
// context), and chrome.scripting serializes it into the tab. frameIds: run it in those frames
// only (the top frame by default).
async function asContentScript(sw, tabId, func, args, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId };
  return sw.evaluate(`chrome.scripting.executeScript({ target: ${JSON.stringify(target)}, world: "ISOLATED", func: ${func.toString()}, args: ${JSON.stringify(args || [])} }).then((r) => r && r[0] && r[0].result)`);
}
// The worker's frameId of the frame whose address contains `fragment`, or null.
const frameIdOf = (sw, tabId, fragment) => sw.evaluate(async (t, f) => {
  const r = await chrome.scripting.executeScript({ target: { tabId: t, allFrames: true }, func: () => location.href });
  const hit = r.find((x) => typeof x.result === "string" && x.result.includes(f));
  return hit ? hit.frameId : null;
}, tabId, fragment);
// A tab by a fragment of its URL (several tabs on one origin: tabIdOf would find the first).
async function tabIdByUrl(sw, fragment) {
  return sw.evaluate(async (f) => {
    const t = (await chrome.tabs.query({})).find((x) => (x.url || "").includes(f));
    return t ? t.id : null;
  }, fragment);
}
const swSetGain = (sw, tabId, gain) =>
  sw.evaluate((t, g) => serialized(t, () => setGain(t, g, true)), tabId, gain);
const swGetMode = (sw, tabId) => sw.evaluate((t) => sget(`tabmode:${t}`), tabId);
const swGetGain = (sw, tabId) => sw.evaluate((t) => sget(`tabgain:${t}`), tabId);
// Saved site levels live in storage.local under the worker's own key scheme.
const swSaveSite = (sw, host, level) => sw.evaluate((h, g) => lset(SITE(h), g), host, level);
const swForgetSite = (sw, host) => sw.evaluate((h) => ldel(SITE(h)), host);
const swSavedLevel = (sw, host) => sw.evaluate((h) => lget(SITE(h)), host);

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

// The top frame's live graph as content.js measures it: null when no script runs there (nothing
// was ever injected, or the document is new), {ok:false} when nothing is engaged, {ok, rms} else.
const measureTop = (sw, tabId) =>
  sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }, { frameId: 0 }).catch(() => null), tabId);
// Poll until pred(measure) holds. The spy log cannot tell which DOCUMENT an engage landed in (a
// restore pass still running against the old page logs the same entry), so scenarios that navigate
// assert on what the CURRENT document actually plays instead.
async function waitMeasure(sw, tabId, pred, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const m = await measureTop(sw, tabId);
    if (pred(m)) return { m, elapsed: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { m: null, last: m, elapsed: Date.now() - t0 };
    await sleep(250);
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
  const reports = await ctx.sw.evaluate(() => globalThis.__spy.hooked);
  const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
  if (!(await page.evaluate((i) => window.feed.isHooked(i), id)))
    return `${label}: the video was never hooked`;
  if (pings || engages) return `${label}: the boost needed the worker (${pings} pings, ${engages} engages)`;
  if (reports) return `${label}: the in-page hook woke the worker (${reports} 'hooked' reports) although it tracks the frame already`;
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

// The decoy page (fixtures/decoy-host.html), ready once its content player plays (or has loaded,
// for ?content=blobpaused) and its ad frame has built its video. The page is closed on every
// failure, so no tab of it stays behind for a later scenario's tabIdOf to find. The ad frame is
// polled on a timer: a cross-origin frame far off screen gets no animation frames to poll on.
async function newDecoyPage(browser, port, query) {
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/decoy-host.html?${query}`, { waitUntil: "load" });
    let inner = null;
    for (let i = 0; i < 60 && !inner; i++) {
      inner = page.frames().find((f) => f !== page.mainFrame() && f.url().includes("decoy.html")) || null;
      if (!inner) await sleep(100);
    }
    if (!inner) throw new Error("the decoy frame never appeared");
    await inner.waitForFunction(() => window.decoyReady === true, { timeout: 5000, polling: 100 });
    await page.waitForFunction(() => {
      const v = document.getElementById("content");
      return !!v && v.readyState >= 2 && (window.contentPaused === true || !v.paused);
    }, { timeout: 5000 });
    await sleep(300);
    return { page, inner };
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
}
// Counts the capture starts the worker attempts. The harness has no capture grant, so each one
// fails: what a scenario checks is that it is made.
const captureSpyOn = (sw) => sw.evaluate(() => {
  if (globalThis.__capSpy) { globalThis.__capSpy.calls = 0; return; }
  const orig = chrome.tabCapture.getMediaStreamId.bind(chrome.tabCapture);
  globalThis.__capSpy = { orig, calls: 0 };
  chrome.tabCapture.getMediaStreamId = (...a) => { globalThis.__capSpy.calls++; return orig(...a); };
});
const captureSpyOff = (sw) => sw.evaluate(() => {
  if (!globalThis.__capSpy) return;
  chrome.tabCapture.getMediaStreamId = globalThis.__capSpy.orig;
  delete globalThis.__capSpy;
});
const captureCalls = (sw) => sw.evaluate(() => (globalThis.__capSpy ? globalThis.__capSpy.calls : 0));
// A capture that is live by the worker's own records. The harness has no capture grant, so the
// engine's update ack for the tab is stubbed (as in s44, s65 and s66), and the stop commands the
// engine gets for it are counted. recordCapture records the capture with a level.
const stubCapture = (sw, tabId) => sw.evaluate(async (t) => {
  await ensureOffscreen();
  if (globalThis.__stubCap) chrome.runtime.sendMessage = globalThis.__stubCap.origSend;
  const st = globalThis.__stubCap = { origSend: chrome.runtime.sendMessage.bind(chrome.runtime), stops: 0 };
  chrome.runtime.sendMessage = (m, ...rest) => {
    if (m && m.target === "offscreen" && m.tabId === t) {
      if (m.cmd === "update") return Promise.resolve({ ok: true });
      if (m.cmd === "stop") st.stops++;
    }
    return st.origSend(m, ...rest);
  };
}, tabId);
const unstubCapture = (sw) => sw.evaluate(() => {
  const st = globalThis.__stubCap;
  if (!st) return;
  chrome.runtime.sendMessage = st.origSend;
  delete globalThis.__stubCap;
});
const recordCapture = (sw, tabId, gain, conflict) => sw.evaluate(async (t, g, c) => {
  await sset(TABGAIN(t), g);
  await setMode(t, { mode: "capture", conflict: c });
  await markActive(t);
}, tabId, gain, !!conflict);
// A post playing a clip from the ad origin (no CORS) audibly, paused again once it has played:
// a clip the page has sounded. The frame must run its script by then to hear it.
async function soundedClip(sw, page, tabId) {
  await sw.evaluate((t) => ensureContentScript(t), tabId);
  const id = await page.evaluate((s) => window.feed.addSrc(s), await adSrc(page));
  await page.waitForFunction((i) => { const v = document.getElementById(i); return !!v && !v.paused && v.readyState >= 2; }, { timeout: 5000 }, id);
  await sleep(300);
  await page.evaluate((i) => window.feed.pause(i), id);
  return id;
}
// Until no restore pass has run for the tab for quietMs in a row (a pass can queue one more), or
// the timeout. Returns whether it got quiet.
async function waitIdle(sw, tabId, timeoutMs, quietMs) {
  const quiet = quietMs || 600;
  const t0 = Date.now();
  let idleSince = null;
  while (Date.now() - t0 < timeoutMs) {
    const running = await sw.evaluate((t) => restoring.has(t), tabId);
    if (running) idleSince = null; else if (idleSince == null) idleSince = Date.now();
    if (idleSince != null && Date.now() - idleSince >= quiet) return true;
    await sleep(100);
  }
  return false;
}
// Until the spy log holds a probe, or the timeout: proof that a pass looked at the page.
async function waitProbe(sw, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await swSpyLog(sw)).some((e) => e.cmd === "probe")) return true;
    await sleep(100);
  }
  return false;
}
// The URL the ad origin serves its tone at (cross-origin, no CORS headers).
const adSrc = (page) => page.evaluate(async () => (await (await fetch("/adsrc")).text()).trim());

// ---- shadow-feed.html: players inside open shadow roots ----
// A page whose players keep their media in shadow roots (see the fixture's header). The query
// also tells pages apart for tabIdByUrl.
async function newShadowPage(browser, port, query) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/shadow-feed.html${query || ""}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.feedReady === true, { timeout: 5000 });
  return page;
}
// Until the clip really plays: rendered into its root, source attached, frames decoded.
async function waitClipPlaying(page, id) {
  await page.waitForFunction((i) => {
    const s = window.feed.state(i);
    return !!s && s.connected && !s.paused && s.ready >= 2;
  }, { timeout: 5000 }, id);
}
// One audible shadow clip, boosted through the popup path. Returns { a, tabId }, or the failure.
async function shadowSetup(ctx, page, gain) {
  const a = await page.evaluate(() => window.feed.addAudible());
  await waitClipPlaying(page, a);
  await sleep(300);
  const tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
  const r1 = await swSetGain(ctx.sw, tabId, gain);
  if (r1.mode !== "element" || !r1.confirmed) return `setup failed, the shadow player was not hooked: ${JSON.stringify(r1)}`;
  return { a, tabId };
}
// The tone at volume 0.25, Reddit's unmute level, reads about rms 0.09 at unity and about 0.005
// at 0.05x. The x-feed bound of 0.1 would let native level pass as ducked there.
const SHADOW_DUCKED = 0.03;
const SHADOW_UNITY = 0.06;
// A clip the frame took on its own, before any engage of the worker could: the live graph reads
// the level, and every engage since the spy was cleared found the clip held (that update answers
// without a `signal` of its own). The insertion of a clip may ping, so pings are not counted.
// Destructive on `id` (isHooked): the scenario's last word about that element.
async function assertTakenInPage(ctx, page, id, tabId, label) {
  await sleep(1500);
  const m = await measureTop(ctx.sw, tabId);
  const byWorker = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.ok && "signal" in e.res);
  ctx.note(`${label}: measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}, worker hook ${byWorker ? JSON.stringify(byWorker.res) : "none"}`);
  if (!m || !m.ok || !m.signal) return `${label}: the clip is not on the live graph (measure ${JSON.stringify(m)})`;
  if (m.rms > 0.1) return `${label}: the clip plays at rms ${m.rms.toFixed(3)}, not at the 0.05x level`;
  if (byWorker) return `${label}: the worker's engage hooked the clip, so it played at native level until then`;
  if (!(await page.evaluate((i) => window.feed.isHooked(i), id))) return `${label}: the clip was never hooked`;
  return true;
}
const fmtMeasure = (m) => (m && m.ok ? `${m.rms.toFixed(3)}${m.signal ? "" : " without signal"}` : JSON.stringify(m));
// A light-DOM clip on shadow-feed.html, boosted through setGain and paused again: the frame is
// armed at 0.05x, and on a ?shell=0 page it has met no shadow root. Returns { tabId }, or the
// failure.
async function armWithLightClip(ctx, page) {
  await page.evaluate(async () => {
    const v = document.createElement("video");
    v.id = "light";
    v.loop = true;
    v.style.cssText = "width:320px;height:180px;display:block";
    v.src = URL.createObjectURL(await (await fetch("/tone.wav")).blob());
    document.body.appendChild(v);
    v.play().catch(() => {});
  });
  await page.waitForFunction(() => { const v = document.getElementById("light"); return !!v && !v.paused && v.readyState >= 2; }, { timeout: 5000 });
  await sleep(300);
  const tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
  const r1 = await swSetGain(ctx.sw, tabId, 0.05);
  if (r1.mode !== "element" || !r1.confirmed) return `setup failed, the light clip was not hooked: ${JSON.stringify(r1)}`;
  await page.evaluate(() => document.getElementById("light").pause());
  return { tabId };
}
// A muted light clip that loops at the top of a ?shell=0 page, playing (a hero background) or
// paused, and no level on the tab. The script arrives, and 300 ms later a defined player inside a
// light wrapper starts audibly, unseen by the frame's observer. Slider moves at 2.6 s and 11 s
// after the injection must find the player and put the level on it.
async function mutedHeroCase(ctx, tag, heroPlays) {
  const page = await newShadowPage(ctx.browser, ctx.port, `?shell=0&${tag}`);
  let tabId = null;
  try {
    await page.evaluate(async (plays) => {
      const v = document.createElement("video");
      v.id = "hero"; v.loop = true; v.muted = true;
      v.style.cssText = "width:160px;height:90px;display:block";
      v.src = URL.createObjectURL(await (await fetch("/tone.wav")).blob());
      document.body.insertBefore(v, document.body.firstChild);
      if (plays) v.play().catch(() => {});
    }, heroPlays);
    await page.waitForFunction((plays) => { const v = document.getElementById("hero"); return v.readyState >= 2 && (!plays || !v.paused); }, { timeout: 5000 }, heroPlays);
    tabId = await tabIdByUrl(ctx.sw, tag);
    await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
    const injectedAt = Date.now();
    await sleep(300);
    const id = await page.evaluate(() => window.feed.add({ muted: false }));
    await waitClipPlaying(page, id);
    await sleep(Math.max(1000, injectedAt + 2600 - Date.now()));
    const r = await swSetGain(ctx.sw, tabId, 0.05);
    const m = await measureTop(ctx.sw, tabId);
    await sleep(Math.max(0, injectedAt + 11000 - Date.now()));
    const r2 = await swSetGain(ctx.sw, tabId, 0.06);
    const m2 = await measureTop(ctx.sw, tabId);
    const hero = await page.evaluate(() => { const v = document.getElementById("hero"); return { paused: v.paused, muted: v.muted }; });
    const hooked = await page.evaluate((i) => window.feed.isHooked(i), id);
    ctx.note(`hero ${JSON.stringify(hero)}, setGain at 2.6 s ${JSON.stringify(r)} measure ${fmtMeasure(m)}, at 11 s ${JSON.stringify(r2)} measure ${fmtMeasure(m2)}, player hooked ${hooked}`);
    if (hero.paused === heroPlays) return `setup failed: the hero is ${hero.paused ? "paused" : "playing"}`;
    if (!hooked) return "BUG: neither slider move found the audible player in its wrapper";
    if (!m2 || !m2.ok || !m2.signal || m2.rms > 0.1) return `BUG: the level is not on the player (${fmtMeasure(m2)})`;
    return true;
  } finally {
    if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
    await page.close();
  }
}
// From a trace of a page's renderer: the task that evaluates content.js for the first time (the
// injection), and its duration in ms. null when the trace holds no such task.
function injectionTask(buf) {
  const data = JSON.parse(Buffer.from(buf).toString("utf8"));
  const evs = Array.isArray(data) ? data : data.traceEvents;
  const evals = evs.filter((e) => e.ph === "X" && e.name === "EvaluateScript" && e.args && e.args.data &&
    /^chrome-extension:\/\/[^/]+\/content\.js$/.test(e.args.data.url || "")).sort((a, b) => a.ts - b.ts);
  if (!evals.length) return null;
  const ev = evals[0];
  const task = evs.filter((e) => e.ph === "X" && e.pid === ev.pid && e.tid === ev.tid &&
    (e.name === "ThreadControllerImpl::RunTask" || e.name === "RunTask") &&
    e.ts <= ev.ts && e.ts + e.dur >= ev.ts + ev.dur).sort((a, b) => b.dur - a.dur)[0];
  return task ? { task: task.dur / 1000, script: ev.dur / 1000 } : null;
}
// The page removes (how "remove") or moves to its end (how "move") a block of 90,000 light
// elements in a task of its own between the first and the second slice of the walk at
// injection, with the walk stopped inside that block. The frame's timers are watched from its own
// world, set up before the script arrives: the first slice is scheduled at the injection, the
// second at the end of the first. An audible player sits in a root after the block, and the page
// has no other root. The first probe has to report it.
async function bootWalkRace(ctx, how) {
  const tag = `bootrace-${how}`;
  const page = await newShadowPage(ctx.browser, ctx.port, `?shell=0&${tag}`);
  try {
    const block = await page.evaluate(() => window.feed.bulk(90000, "before"));
    const a = await page.evaluate(() => window.feed.addAudible());
    await waitClipPlaying(page, a);
    const tabId = await tabIdByUrl(ctx.sw, tag);
    await asContentScript(ctx.sw, tabId, (id, how) => {
      const set = window.setTimeout;
      const st = window.__bootRace = { slices: 0, done: false };
      window.setTimeout = function (fn, ms, ...rest) {
        if (typeof fn === "function" && fn.name === "walkSlice" && ++st.slices === 2) {
          set.call(window, () => {
            const b = document.getElementById(id);
            if (!b) return;
            if (how === "move") document.body.appendChild(b); else b.remove();
            st.done = true;
          }, 0);
        }
        return set.call(window, fn, ms, ...rest);
      };
      return true;
    }, [block, how]);
    await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
    await sleep(200);
    const st = await asContentScript(ctx.sw, tabId, () => window.__bootRace);
    const p1 = await ctx.sw.evaluate((t) => predictMode(t), tabId);
    ctx.note(`${st && st.slices} slices scheduled, block ${how === "move" ? "moved" : "removed"} ${st && st.done}, first probe ${JSON.stringify(p1)}`);
    if (!st || !st.done) return `setup failed: the page task did not run between two slices (${JSON.stringify(st)})`;
    if (p1.mode !== "element") return `BUG: the first probe missed the player after the walk's block was ${how === "move" ? "moved" : "removed"} (${JSON.stringify(p1)})`;
    return true;
  } finally { await page.close(); }
}

// The ceiling on parked graphs as content.js has it, so the scenarios that fill it follow its value.
const PARK_MAX = (() => {
  const m = /const PARK_MAX = (\d+);/.exec(fs.readFileSync(path.join(REPO, "content.js"), "utf8"));
  if (!m) throw new Error("PARK_MAX not found in content.js");
  return +m[1];
})();

// A recorder in a frame's isolated world, the world content.js runs in, installed before the hooks
// it should see. It notes each element's source node and when it was made (by element id), and
// the connections every audio node makes, so a scenario can read what reaches an element's gain
// node, what leaves it and where it goes, for a parked or a dormant graph as well, which the
// measure command does not see. It counts the disconnects from everything (cuts) as well.
const tapInstall = (sw, tabId) => asContentScript(sw, tabId, () => {
  if (window.__tap) return true;
  const tap = window.__tap = { nodes: new Map(), at: new Map(), outs: new WeakMap(), cuts: new WeakMap() };
  const make = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (el) {
    const n = make.call(this, el);
    tap.nodes.set(el.id, n);
    tap.at.set(el.id, performance.now());
    return n;
  };
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dst, ...rest) {
    const r = connect.call(this, dst, ...rest);
    if (dst instanceof AudioNode) {
      if (!tap.outs.has(this)) tap.outs.set(this, []);
      tap.outs.get(this).push(dst);
    }
    return r;
  };
  const disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function (...a) {
    const r = disconnect.apply(this, a);
    const outs = tap.outs.get(this) || [];
    tap.outs.set(this, a.length && a[0] instanceof AudioNode ? outs.filter((x) => x !== a[0]) : []);
    if (!a.length) tap.cuts.set(this, (tap.cuts.get(this) || 0) + 1);
    return r;
  };
  return true;
});
// What the recorder sees of the element with this id: the source node's chain by node type, the
// gain node's value, and over `ms` the peak rms before (pre) and after (post) that gain node, and
// their ratio. A source that goes straight to the destination has no post and no ratio. null when
// the element never got a source node.
const tapLevels = (sw, tabId, id, ms) => asContentScript(sw, tabId, async (id, ms) => {
  const tap = window.__tap;
  const n = tap && tap.nodes.get(id);
  if (!n) return null;
  const names = (node) => (tap.outs.get(node) || []).map((x) => x.constructor.name);
  const next = (tap.outs.get(n) || [])[0] || null;
  const chain = { source: names(n), gain: next ? names(next) : null };
  const ctx = n.context;
  const pre = ctx.createAnalyser(), post = ctx.createAnalyser();
  pre.fftSize = post.fftSize = 2048;
  n.connect(pre);
  const tail = !!next && next.numberOfOutputs > 0;
  if (tail) next.connect(post);
  const buf = new Float32Array(2048);
  const rms = (an) => { an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };
  let p = 0, q = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { p = Math.max(p, rms(pre)); q = Math.max(q, rms(post)); await new Promise((r) => setTimeout(r, 50)); }
  try { n.disconnect(pre); } catch (_) {}
  try { if (tail) next.disconnect(post); } catch (_) {}
  return { pre: +p.toFixed(4), post: +q.toFixed(4), ratio: tail && p > 0.001 ? +(q / p).toFixed(3) : null, gain: next && next.gain ? +next.gain.value.toFixed(4) : null, chain };
}, [id, ms]);
// The node types the source node of the element with this id sends to, as the recorder saw its
// connects and disconnects: [] for a dormant graph. null when the element never got a source node.
const tapOuts = (sw, tabId, id) => asContentScript(sw, tabId, (id) => {
  const tap = window.__tap;
  const n = tap && tap.nodes.get(id);
  return n ? (tap.outs.get(n) || []).map((x) => x.constructor.name) : null;
}, [id]);
// How often the source node of the element with this id was disconnected from everything.
const tapCuts = (sw, tabId, id) => asContentScript(sw, tabId, (id) => {
  const tap = window.__tap;
  const n = tap && tap.nodes.get(id);
  return n ? tap.cuts.get(n) || 0 : null;
}, [id]);
// The limiter of the element with this id, the compressor its gain node sends to: its ratio and
// threshold as the audio thread last computed them. null when the element never got a source
// node or its source sends nowhere.
const tapLimiter = (sw, tabId, id) => asContentScript(sw, tabId, (id) => {
  const tap = window.__tap;
  const n = tap && tap.nodes.get(id);
  const gain = n && (tap.outs.get(n) || [])[0];
  const lim = gain && (tap.outs.get(gain) || []).find((x) => x.constructor.name === "DynamicsCompressorNode");
  return lim ? { ratio: +lim.ratio.value.toFixed(2), threshold: +lim.threshold.value.toFixed(2) } : null;
}, [id]);
// The renderer CPU of the whole browser per window of `ms`, from Chrome's process list (CDP
// SystemInfo.getProcessInfo): the median of `n` windows, and all of them, in ms.
async function rendererCpu(browser, n, ms) {
  const cdp = await browser.target().createCDPSession();
  try {
    const read = async () => {
      const m = new Map();
      for (const pr of (await cdp.send("SystemInfo.getProcessInfo")).processInfo) if (pr.type === "renderer") m.set(pr.id, pr.cpuTime);
      return m;
    };
    const all = [];
    for (let i = 0; i < n; i++) {
      const a = await read();
      const t0 = Date.now();
      await sleep(ms);
      const b = await read();
      let sum = 0;
      for (const [pid, t] of b) if (a.has(pid)) sum += t - a.get(pid);
      all.push(Math.round((sum * 1000 * ms) / (Date.now() - t0)));
    }
    return { med: all.slice().sort((x, y) => x - y)[Math.floor(n / 2)], all };
  } finally { await cdp.detach().catch(() => {}); }
}
// The element's own playback, read twice `ms` apart from the page: whether it plays and advances.
const playback = (page, id, ms) => page.evaluate(async (id, ms) => {
  const find = (root) => {
    const v = root.getElementById ? root.getElementById(id) : null;
    if (v) return v;
    for (const e of root.querySelectorAll("*")) if (e.shadowRoot) { const r = find(e.shadowRoot); if (r) return r; }
    return null;
  };
  const v = find(document);
  if (!v) return null;
  const t1 = v.currentTime;
  await new Promise((r) => setTimeout(r, ms));
  let d = v.currentTime - t1;
  if (d < 0 && v.loop) d += v.duration; // looped around meanwhile
  return { paused: v.paused, connected: v.isConnected, advanced: +d.toFixed(3) };
}, id, ms);
// Clip A gets the level (0.05x through a slider move), its node leaves the DOM and is kept, the
// way a virtualized feed keeps it, and four more clips are hooked in-page after it. Then A's same
// node comes back and plays. The worker's passes are held back throughout, so only the page's own
// paths can take A back. Returns the parked count before A came back, where A's source node sent
// to then (asleep), A's playback (play), what reaches and leaves A's gain node (tap) and the live
// graph (m), or a setup failure.
async function parkedReturn(ctx, page, tabId) {
  const restore = await dropPasses(ctx.sw, tabId);
  try {
    await tapInstall(ctx.sw, tabId);
    const a = await page.evaluate(() => window.feed.addAudible());
    await sleep(300);
    const r1 = await swSetGain(ctx.sw, tabId, 0.05);
    if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
    await page.evaluate((i) => window.feed.detach(i), a);
    await sleep(600); // the frame's watcher parks A
    let prev = null;
    for (let i = 0; i < 4; i++) {
      const id = await page.evaluate((p) => { if (p) window.feed.pause(p); return window.feed.add(); }, prev);
      await sleep(400);
      await page.evaluate((x) => window.feed.unmute(x), id);
      await sleep(400);
      prev = id;
    }
    await page.evaluate((p) => window.feed.pause(p), prev);
    const before = await measureTop(ctx.sw, tabId);
    const asleep = await tapOuts(ctx.sw, tabId, a);
    await sleep(300);
    await page.evaluate((i) => window.feed.reattach(i), a);
    await sleep(1000);
    const play = await playback(page, a, 500); // read before the tap below pulls on the source
    const tap = await tapLevels(ctx.sw, tabId, a, 600);
    const m = await measureTop(ctx.sw, tabId);
    return { parked: before && before.parked, asleep, play, tap, m };
  } finally { await restore(); }
}
// Drops the worker's restore passes for the tab until the function it resolves with runs: only
// the frame's own paths can take a clip then, never the arm of a pass (content.js takeSounding)
// or its engage.
async function dropPasses(sw, tabId) {
  await sw.evaluate((t) => {
    globalThis.__dropPasses = { origKick: kickRestore };
    kickRestore = (id, d) => (id === t ? Promise.resolve() : globalThis.__dropPasses.origKick(id, d));
  }, tabId);
  return () => sw.evaluate((t) => {
    if (!globalThis.__dropPasses) return;
    kickRestore = globalThis.__dropPasses.origKick;
    pendingRekick.delete(t);
    delete globalThis.__dropPasses;
  }, tabId);
}
// Opens the extension's real popup on the page's tab, the way a click on its toolbar icon does,
// which also grants the tab capture (activeTab). Needs a browser from launchChrome({ actionDebug:
// true }). Resolves with the popup's page.
async function openPopup(browser, page) {
  const cdp = await browser.target().createCDPSession();
  try {
    const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
    const extId = new URL(sw.url()).host;
    const all = await cdp.send("Target.getTargets", { filter: [{}] });
    const tab = all.targetInfos.find((t) => t.type === "tab" && t.url === page.url());
    if (!tab) throw new Error(`no tab target for ${page.url()}`);
    await cdp.send("Extensions.triggerAction", { id: extId, targetId: tab.targetId });
    const pt = await browser.waitForTarget((t) => t.url().endsWith("/popup.html"), { timeout: 10000 });
    return (await pt.page()) || (await pt.asPage());
  } finally { await cdp.detach().catch(() => {}); }
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

  // User drags the slider WHILE a cross-origin ad plays over the paused content. The content
  // player stands in for the ad, but a level on it changes nothing the user hears now: a user
  // action never settles on a stand-in and tries capture, which reaches the ad. The harness has
  // no capture grant, so the attempt fails. The content's hook is never sacrificed to the ad, and
  // once the break is over the content's play signal brings it back to element mode at the
  // slider's level (ducked to 0.05x, moved to 0.5x: the measure reads about 0.22, at unity 0.44).
  async s9d_slider_during_cross_origin_ad(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const ad = await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true }), main);
      await sleep(600);
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      const r2 = await swSetGain(ctx.sw, tabId, 0.5); // the slider move mid-ad
      const calls = await captureCalls(ctx.sw);
      const log = await swSpyLog(ctx.sw);
      ctx.note(`slider mid-ad ${JSON.stringify(r2)}, ${calls} capture attempt(s)`);
      if (r2.mode === "element") return `BUG: the slider move mid-ad settled on the content standing in for the ad (${JSON.stringify(r2)}): the ad plays on at native level`;
      if (calls < 1) return "BUG: the slider move mid-ad did not try the capture that reaches the ad";
      const sacrificed = log.find((e) => e.cmd === "engage" && e.res && e.res.ok === false && e.res.reason === "cross-origin-no-cors");
      if (sacrificed) return `BUG: content hook was retired for the unhookable ad (cross-origin-no-cors refusal)`;
      await page.evaluate((a, m) => window.feed.adEnd(a, m), ad, main);
      const w = await waitMeasure(ctx.sw, tabId, (m) => !!(m && m.ok && m.signal && m.rms > 0.1 && m.rms < 0.33), 5000);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const gain = await swGetGain(ctx.sw, tabId);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`after the ad: ${w.m ? "rms " + w.m.rms.toFixed(3) + " after " + w.elapsed + "ms" : JSON.stringify(w.last)}, mode ${JSON.stringify(mode)}`);
      if (gain !== 0.5) return `stored gain drifted: ${gain}`;
      if (!w.m) return `BUG: the content does not play at the slider's 0.5x after the ad (last measure ${JSON.stringify(w.last)})`;
      if (!mode || mode.mode !== "element") return `mode after ad end: ${JSON.stringify(mode)} (expected element)`;
      return true;
    } finally { await captureSpyOff(ctx.sw); await page.close(); }
  },

  // DRM page holding a harmless safe element (decoy): a churn ping must not grind the
  // 8-iteration restore loop on endless 'drm' refusals. The DRM player sounds and the decoy is
  // muted, so the probe calls the tab capture at once and the pass resolves terminally.
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
      ctx.note(`refused, ${added} extra probe requests over 6 probes`);
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
      await swClearSpy(ctx.sw);
      await clickVideo(page, b);
      await sleep(1200); // a worker roundtrip would long since have happened
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const reports = await ctx.sw.evaluate(() => globalThis.__spy.hooked);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
      const hooked = await page.evaluate((i) => window.feed.isHooked(i), b);
      ctx.note(`${pings} pings, ${engages} engages, ${reports} hooked reports`);
      if (!hooked) return `the clicked video was never hooked - the pre-hook did not fire`;
      if (pings || engages) return `boost went through the worker (${pings} pings, ${engages} engages) instead of landing inside the gesture`;
      if (reports) return `the pre-hook woke the worker (${reports} hooked reports) although it tracks the frame already`;
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

  // Every hook in a frame shares ONE AudioContext (that sharing is what lets the pre-hook work
  // synchronously), and the graphs on it go dormant and wake again all the time. None of that may
  // close the context: every OTHER element on it would be silent for good. Clips are
  // clicked one after the other and paused, two of them leave the DOM, and a clip that stayed in
  // the DOM plays again: the live graph has signal. Then one of the clips that left comes back.
  // Its graph is still there, and the engage takes it back: our own hook must never be reported
  // as lost, or as another app holding the user's player.
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
      // where it goes dormant, paused.
      const ids = [];
      for (let i = 0; i < 4; i++) {
        const id = await page.evaluate(() => window.feed.add());
        ids.push(id);
        await sleep(900);
        await clickVideo(page, id);
        await sleep(400);
        await page.evaluate((x) => window.feed.pause(x), id);
      }
      // Two of them leave the DOM, and one more clip is hooked.
      await page.evaluate((x, y) => { window.feed.detach(x); window.feed.detach(y); }, first, ids[0]);
      const last = await page.evaluate(() => window.feed.add());
      await sleep(900);
      await clickVideo(page, last);
      await sleep(600);
      // ids[1] never left the DOM and its graph is dormant on that same context. Bring it back:
      // if anything closed the context, it is silent for good.
      await page.evaluate((keep, drop) => {
        drop.forEach((x) => window.feed.pause(x));
        const v = document.getElementById(keep);
        v.muted = false; v.volume = 1; v.play().catch(() => {});
      }, ids[1], [ids[2], ids[3], last]);
      await sleep(500);
      // Since the play/volumechange listeners, the returning element is re-adopted IN-PAGE, so
      // an engage would fast-path without measuring. The read-only measure is the ground truth:
      // if a dormant graph closed the shared ctx, the live graph is silent.
      const back = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "measure" }), tabId);
      ctx.note(`live graph after the dormant ones woke: ${JSON.stringify(back)}`);
      if (!back || !back.ok || !back.signal)
        return `BUG: a dormant graph lost its audio on the shared context: ${JSON.stringify(back)}`;
      // A clip that left the DOM returns. Its graph is still there.
      await page.evaluate((x, y) => { window.feed.pause(y); window.feed.reattach(x); }, first, ids[1]);
      await sleep(400);
      const again = await ctx.sw.evaluate((t) => chrome.tabs.sendMessage(t, { cmd: "engage", gain: 3, useLimiter: true }), tabId);
      ctx.note(`returning element: ${JSON.stringify(again)}`);
      if (again && again.reason === "already-hooked")
        return `BUG: our own hook was reported as a foreign app's conflict`;
      if (!again || !again.ok) return `BUG: the returning element's graph was not taken back (${JSON.stringify(again)})`;
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
      // A muted video appears in the INNER frame (the top video holds the level and keeps it
      // while nothing sounds, so the worker never engages the inner one) ...
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

  // The ceiling on in-page hook minting (PARK_MAX). A page whose clicked videos go on playing
  // muted (looping previews) grows one parked graph per in-page hook that never goes dormant.
  // Past the ceiling the synchronous paths must refuse, and the click must still get boosted, by
  // the worker at worker pace. The user-visible contract: boosting never stops working, growth
  // just returns to worker-rate-limited.
  async s27_park_cap_falls_back(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => { document.getElementById(i).muted = true; }, main);
      // PARK_MAX clicked videos, all kept in the DOM and muted again after the click, so they go
      // on playing: each in-page hook parks one more graph that stays connected, filling the
      // ceiling exactly (the first click parks the main clip's).
      for (let i = 0; i < PARK_MAX; i++) {
        const id = await page.evaluate(() => window.feed.add());
        await sleep(250);
        await clickVideo(page, id);
        await sleep(350);
        await page.evaluate((x) => { document.getElementById(x).muted = true; }, id);
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
      // the predecessor, which the loop mutes so that it plays on and stays connected, never
      // dormant), drive the parked count past PARK_MAX and spend the auto-hook budget
      // on the way. After this, a further unmute CANNOT be taken in-page - only the ping path
      // remains, which is exactly the path under test. The audible spam element is added ONLY
      // AFTERWARDS: audible and early in the DOM it would win every candidate pick, the worker
      // would move the hook onto it, and the loop's unmutes would all bounce off the no-steal
      // gate for free - park count and budget untouched, scenario meaningless.
      await page.evaluate((m) => window.feed.pause(m), main);
      // VERIFIED, not assumed: timing collisions (a churn engage holding the command queue)
      // make some unmutes skip both paths entirely, so a fixed element count cannot guarantee
      // the ceiling. Add self-unmuting elements until the frame REPORTS parked >= cap.
      // The ceiling (PARK_MAX) sits above one auto-hook window's allowance (12), so a single batch
      // cannot reach it in-page and the remainder would depend on worker-engage timing (flaky).
      // Instead: fill a window, wait for the rolling 10s allowance to refill, fill again.
      let prev = null;
      let parked = 0;
      for (let round = 0; round < Math.ceil(PARK_MAX / 12) + 2 && parked < PARK_MAX; round++) {
        for (let i = 0; i < 12 && parked < PARK_MAX; i++) {
          prev = await page.evaluate((p) => {
            if (p) document.getElementById(p).muted = true;
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
        if (parked < PARK_MAX) await sleep(10500); // allowance refills, the ceiling is still short
      }
      if (parked < PARK_MAX) return `could not drive the park count to the ceiling (${parked})`;
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
  // boost, and the release's stop cannot reach a frozen document. The pageshow resync must shut
  // the resurrected boost down. The navigation entry cannot tell a restore apart, its type stays
  // 'navigate'. Three independent signals prove the restore instead: CDP reports the main-frame
  // navigation as BackForwardCacheRestore, pageshow fires with persisted true, and a window
  // marker set before leaving is still there. No restore is a failure. The only exception is a
  // browser whose cache is switched off, which CDP names and the run reports as SKIP.
  async s36_bfcache_release_resync(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    let cdp = null;
    try {
      cdp = await page.createCDPSession();
      await cdp.send("Page.enable");
      const navTypes = [];
      const notUsed = [];
      cdp.on("Page.frameNavigated", (e) => { if (!e.frame.parentId) navTypes.push(e.type); });
      cdp.on("Page.backForwardCacheNotUsed", (e) => {
        for (const x of e.notRestoredExplanations || []) notUsed.push(`${x.reason} (${x.type})`);
      });
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const m0 = await measureTop(ctx.sw, tabId);
      if (!(m0 && m0.ok && m0.signal && m0.rms > 0.45)) return `setup: no audible 3x boost before leaving: ${JSON.stringify(m0)}`;
      const marker = await page.evaluate(() => {
        window.__bfMarker = String(performance.now());
        window.__bfShows = [];
        addEventListener("pageshow", (e) => window.__bfShows.push(e.persisted));
        return window.__bfMarker;
      });
      await page.goto(`http://127.0.0.1:${ctx.port}/x-feed.html?other`, { waitUntil: "load" });
      await swSetGain(ctx.sw, tabId, 1); // release while the boosted page sits in the freezer
      await sleep(300);
      navTypes.length = 0;
      notUsed.length = 0;
      await swClearLog(ctx.sw);
      await page.goBack({ waitUntil: "load" });
      let back = null;
      for (let i = 0; i < 30; i++) {
        back = await page.evaluate(() => ({ marker: window.__bfMarker, shows: window.__bfShows || null }));
        if (navTypes.length && back.shows && back.shows.length) break;
        await sleep(100);
      }
      const signals = {
        cdp: navTypes.includes("BackForwardCacheRestore"),
        pageshow: !!(back && back.shows && back.shows.includes(true)),
        marker: !!back && back.marker === marker,
      };
      if (!signals.cdp || !signals.pageshow || !signals.marker) {
        const why = notUsed.length ? notUsed.join(", ") : "no reason reported";
        // With the cache switched off, Chrome lists further would-be reasons next to it
        // (EmbedderExtensionMessaging, BrowsingInstanceNotSwapped). Those block nothing while the
        // cache is on, so the exact switch reason alone decides.
        if (notUsed.some((r) => r.split(" ")[0] === "BackForwardCacheDisabled"))
          return { skip: `bfcache is switched off in this browser: ${why}` };
        return `no bfcache restore: ${why} (signals ${JSON.stringify(signals)}, navigations ${JSON.stringify(navTypes)})`;
      }
      await page.evaluate((i) => { const v = document.getElementById(i); if (v) { v.muted = false; v.volume = 1; v.play(); } }, a);
      const w = await waitMeasure(ctx.sw, tabId, (m) => !!(m && m.ok && m.signal && m.rms <= 0.45), 4000);
      const stops = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "stop" && e.tabId === tabId && e.res);
      const m = w.m || w.last;
      ctx.note(`restored, rms ${m0.rms.toFixed(3)} before leaving, ${m && m.ok ? m.rms.toFixed(3) : "n/a"} after Back, ${stops.length} stop(s) answered`);
      if (!m || !m.ok || !m.signal) return `the restored page has no live graph to measure: ${JSON.stringify(m)}`;
      if (!w.m) return `BUG: the restored page still boosts at 3x after the release (rms ${m.rms.toFixed(3)}, ${stops.length} stop(s) answered)`;
      return true;
    } finally {
      if (cdp) await cdp.detach().catch(() => {});
      await page.close();
    }
  },

  // Protection direction of the relaxed gates: an audible interloper firing 'play' while the
  // hooked content plays AUDIBLY must still be refused - the muted-holder relaxation must not
  // have opened the ad-steal door the no-steal gate exists for. The interloper is BIGGER than the
  // content, so the ranking alone would pick it: only the rule that a hook on media the user hears
  // stays put (select.js) keeps the content. A slider move afterwards makes sure an engage ran.
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
      const ad = await page.evaluate(() => { const id = window.feed.addAudible(); document.getElementById(id).style.height = "400px"; return id; });
      await sleep(1500);
      const r2 = await swSetGain(ctx.sw, tabId, 0.06);
      if (r2.mode !== "element") return `BUG: the slider move left element mode: ${JSON.stringify(r2)}`;
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

  // A muted holder and a sounding clip whose same-origin src 302s cross-origin. The frame's
  // redirect check refuses the clip, so it is never hooked (that would silence it for good), and
  // the holder is not given up for it either: the redirect verdict counts before anything is torn
  // down, so the holder is still the live graph after the pass and nothing new is parked. A muted
  // holder never stands in for sounding media: boosting it changes nothing the user hears, so the
  // verdict is capture. The harness has no capture grant, so the attempt fails and leaves no record.
  async s39_redirect_interloper_no_sacrifice(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const loop = await page.evaluate(() => window.feed.add()); // muted holder
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element") return `setup failed: ${JSON.stringify(r1)}`;
      await sleep(2600);
      const m0 = await measureTop(ctx.sw, tabId);
      if (!m0 || !m0.ok) return `setup failed: the holder is not the live graph (${JSON.stringify(m0)})`;
      await swClearSpy(ctx.sw);
      await captureSpyOn(ctx.sw);
      const bad = await page.evaluate(() => window.feed.addSrc("/redir.wav")); // audible, same-origin -> 302 cross-origin
      await sleep(1000); // play ping, then its restore pass with the awaited verdict
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const mode = await swGetMode(ctx.sw, tabId);
      const calls = await captureCalls(ctx.sw);
      const m1 = await measureTop(ctx.sw, tabId);
      const hookedBad = await page.evaluate((i) => window.feed.isHooked(i), bad);
      ctx.note(`mode=${mode && mode.mode}, ${calls} capture attempt(s), parked ${m0.parked} -> ${m1 && m1.parked}`);
      if (hookedBad) return `BUG: the redirecting interloper was hooked (would be silenced)`;
      if (!m1 || !m1.ok || m1.parked !== m0.parked) return `BUG: the holder was given up for the redirecting clip (measure ${JSON.stringify(m1)}, parked before ${m0.parked})`;
      if (mode && mode.mode === "element") return `BUG: an element record stays on the muted holder while the redirecting clip sounds (${JSON.stringify(mode)})`;
      if (calls < 1) return "BUG: no capture was tried for the sounding clip no hook can take";
      return true;
    } finally { await captureSpyOff(ctx.sw); await page.close(); }
  },

  // The autoplay-policy hang. On a document Chrome has not unlocked (no activation, no history of
  // audible playback on that origin) AudioContext.resume() stays pending FOR GOOD - measured in
  // Chrome 152: still pending after a later trusted click. An engage awaiting it never answered,
  // wedging the frame's command chain and the worker's op with it: slider dead until the next
  // navigation. This needs its own Chrome: the suite's browser runs with the autoplay policy
  // switched off, and any evaluate() in the target document would hand it activation - so the
  // page is reached through a script hop to a second origin and prepared by a URL flag instead.
  async s41_suspended_engage_answers(ctx) {
    const browser2 = await launchChrome({ autoplayPolicyOff: false });
    let page;
    try {
      const sw2 = await getWorker(browser2);
      await installSpy(sw2);
      page = await browser2.newPage();
      const target = `http://localhost:${ctx.port}/?auto=audible`;
      await page.goto(`http://127.0.0.1:${ctx.port}/hop.html?to=${encodeURIComponent(target)}`, { waitUntil: "load" });
      // Wait for the hop to land - from the worker's side only, no evaluate in the target document.
      let tabId = null;
      for (let i = 0; i < 50 && tabId == null; i++) {
        await sleep(100);
        tabId = await sw2.evaluate(async (p) => {
          const tabs = await chrome.tabs.query({});
          const t = tabs.find((x) => x.url && x.url.startsWith(`http://localhost:${p}/`) && x.status === "complete");
          return t ? t.id : null;
        }, ctx.port);
      }
      if (tabId == null) return "the hop never landed on the second origin";
      await sleep(600); // the fixture adds its audible post on load
      // The engage must ANSWER. Refusing is right (nothing is unlocked yet); hanging is the bug.
      const res = await Promise.race([swSetGain(sw2, tabId, 3), sleep(8000).then(() => "hung")]);
      if (res === "hung") return "BUG: setGain never returned - the engage waits on a resume() that will never settle";
      const refusal = (await swSpyLog(sw2)).find((e) => e.cmd === "engage" && e.res && e.res.reason);
      ctx.note(`first engage answered: ${JSON.stringify(refusal && refusal.res)}`);
      if (!refusal || refusal.res.reason !== "suspended") return `expected a 'suspended' refusal, got ${JSON.stringify(refusal && refusal.res)}`;
      // The first gesture in that frame: the one-shot retry pings, the worker re-engages, and this
      // time the context is allowed to run.
      await swClearLog(sw2);
      const pos = await page.evaluate(() => {
        const v = document.querySelector("video");
        v.scrollIntoView({ block: "center" });
        const r = v.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.click(pos.x, pos.y);
      const { hit, elapsed } = await waitEngage(sw2, (r) => r.ok === true, 8000);
      if (!hit) return "BUG: the boost never landed after the unlocking click";
      ctx.note(`boost ${elapsed}ms after the click`);
      return true;
    } finally {
      if (page) await page.close().catch(() => {});
      await browser2.close().catch(() => {});
    }
  },

  // Cross-frame candidate choice. A landing page keeps a big MUTED loop in the top document and
  // the real, audible player in a smaller same-origin iframe. Ranking by playing-then-area picked
  // the loop: the hook landed on silence, the pill went green, and nothing healed it (the iframe
  // was never armed, and every re-probe chose the loop again).
  async s42_cross_frame_prefers_audible(ctx) {
    const page = await ctx.browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${ctx.port}/hero-host.html`, { waitUntil: "load" });
      await sleep(1200); // the hero autoplays, the inner feed adds its audible post
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const res = await swSetGain(ctx.sw, tabId, 3);
      const engage = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.ok);
      ctx.note(`mode=${res.mode} confirmed=${res.confirmed} frame=${engage && engage.frameId}`);
      if (res.mode !== "element") return `expected element mode, got ${JSON.stringify(res)}`;
      if (!engage || engage.frameId === 0) return "BUG: the muted top-frame loop won the boost over the audible iframe player";
      if (!res.confirmed) return "BUG: the hook landed on an element with no signal";
      return true;
    } finally { await page.close(); }
  },

  // An iframe navigating itself: the player loads the next episode at its own new address. The
  // host's src attribute never changes and the frame id survives, so the recorded hook points at
  // a document that no longer runs the script. A review claimed nothing re-hooks it; in fact the
  // tab's load state covers sub-frame navigations, so the worker's tabs.onUpdated restore does.
  // Coverage, not a bug fix: this pins that platform behavior (it passes on the old code too).
  async s43_iframe_self_navigation_rehooks(ctx) {
    const page = await ctx.browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${ctx.port}/frame-same-origin.html`, { waitUntil: "load" });
      await sleep(1000);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05); // ducked: unity vs 0.05 is unmistakable in rms
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const first = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.ok);
      if (!first || first.frameId === 0) return `setup failed: hook not in the iframe (${JSON.stringify(first)})`;
      await swClearLog(ctx.sw);
      // The frame moves on by itself: a new document, same frame id, no attribute change anywhere.
      const inner = page.frames().find((f) => f !== page.mainFrame());
      await inner.evaluate(() => { setTimeout(() => location.assign("/?auto=audible&episode=2"), 0); });
      const { hit, elapsed } = await waitEngage(ctx.sw, (r) => r.ok === true, 8000);
      if (!hit) return "BUG: nothing re-hooked the player after the iframe navigated itself";
      const m = await ctx.sw.evaluate((t, f) =>
        chrome.tabs.sendMessage(t, { cmd: "measure" }, { frameId: f }).catch(() => null), tabId, hit.frameId);
      ctx.note(`re-hooked ${elapsed}ms after the navigation, rms ${m && m.ok ? m.rms.toFixed(3) : "n/a"}`);
      if (!m || !m.ok || m.rms > 0.1) return `BUG: the new document plays unducked (measure ${JSON.stringify(m)})`;
      return true;
    } finally { await page.close(); }
  },

  // The capture engine is asked before the active list is trusted. A live graph whose list entry
  // was stripped (an unmark for the OLD stream landing after a newer start was marked) used to send
  // the worker straight to getMediaStreamId, which Chrome refuses for a tab it is still capturing -
  // every slider move failed until release. Simulated at the message layer: the engine answers the
  // update, the list says nothing.
  async s44_capture_asks_engine_before_list(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port); // no video: the probe routes to capture
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await ctx.sw.evaluate(async (t) => {
        await ensureOffscreen();
        await unmarkActive(t);
        const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
        const origStream = chrome.tabCapture.getMediaStreamId.bind(chrome.tabCapture);
        globalThis.__s44 = { origSend, origStream, streamCalls: 0 };
        chrome.runtime.sendMessage = (m, ...rest) => {
          if (m && m.target === "offscreen" && m.cmd === "update" && m.tabId === t) return Promise.resolve({ ok: true });
          return origSend(m, ...rest);
        };
        chrome.tabCapture.getMediaStreamId = (...a) => { globalThis.__s44.streamCalls++; return origStream(...a); };
      }, tabId);
      const res = await swSetGain(ctx.sw, tabId, 3);
      const calls = await ctx.sw.evaluate(() => globalThis.__s44.streamCalls);
      const active = await ctx.sw.evaluate(() => sget("active"));
      const listed = Array.isArray(active) && active.includes(tabId);
      ctx.note(`mode=${res.mode} streamIdCalls=${calls} listed=${listed}`);
      if (calls > 0) return "BUG: the worker asked for a new stream id although the engine already held this tab";
      if (res.mode !== "capture") return `expected capture mode through the live graph, got ${JSON.stringify(res)}`;
      if (!listed) return "BUG: the healed entry was not re-marked";
      return true;
    } finally {
      await ctx.sw.evaluate(() => {
        if (!globalThis.__s44) return;
        chrome.runtime.sendMessage = globalThis.__s44.origSend;
        chrome.tabCapture.getMediaStreamId = globalThis.__s44.origStream;
        delete globalThis.__s44;
      });
      await swSetGain(ctx.sw, tabId, 1);
      await page.close();
    }
  },

  // A late captureFailed (an old stream's start losing the race) must not wipe a mode a newer
  // action has recorded - here a working element hook.
  async s45_late_capture_failed_keeps_element(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element") return `setup failed: ${JSON.stringify(r1)}`;
      // the stale failure report, as the worker handles it when the capture engine sends it (a
      // report from anywhere else never gets this far: see s61)
      await ctx.sw.evaluate((t) => onCaptureFailed(t), tabId);
      await sleep(200);
      const mode = await swGetMode(ctx.sw, tabId);
      if (!mode || mode.mode !== "element") return `BUG: a stale captureFailed wiped the live element mode (mode=${JSON.stringify(mode)})`;
      return true;
    } finally { await page.close(); }
  },

  // ---- saved site levels ----

  // A level saved for a site lands in a NEW tab on that site with no popup involved: the arrival
  // seeds the tab and the restore machinery applies it. Ducked to 0.05x so the measure can tell it
  // from native level. Then the non-vacuity half: with the level forgotten, the same new tab gets
  // nothing at all.
  async s46_site_level_applies_on_arrival(ctx) {
    const host = "127.0.0.1";
    let page;
    try {
      await swSaveSite(ctx.sw, host, 0.05);
      page = await ctx.browser.newPage();
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=audible`, { waitUntil: "load" });
      const { hit, elapsed } = await waitEngage(ctx.sw, (r) => r.ok === true, 8000);
      if (!hit) return "BUG: the saved site level never engaged in the new tab";
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const gain = await swGetGain(ctx.sw, tabId);
      const m = await ctx.sw.evaluate((t, f) =>
        chrome.tabs.sendMessage(t, { cmd: "measure" }, { frameId: f }).catch(() => null), tabId, hit.frameId);
      ctx.note(`engaged ${elapsed}ms after load, gain=${gain}, rms ${m && m.ok ? m.rms.toFixed(3) : "n/a"}`);
      if (gain !== 0.05) return `BUG: the tab holds ${gain}, not the saved 0.05`;
      if (!m || !m.ok || m.rms > 0.1) return `BUG: the new tab plays at native level (measure ${JSON.stringify(m)})`;
      await page.close(); page = null;
      await swForgetSite(ctx.sw, host);
      await swClearLog(ctx.sw);
      page = await ctx.browser.newPage();
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=audible`, { waitUntil: "load" });
      await sleep(2500);
      const t2 = await tabIdOf(ctx.sw, ctx.port);
      const g2 = await swGetGain(ctx.sw, t2);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage" && e.tabId === t2).length;
      if (g2 !== undefined || engages) return `sabotage failed: with nothing saved the new tab got gain=${g2}, ${engages} engages`;
      const note = await ctx.sw.evaluate((t) => sget(TABHOST(t)), t2);
      if (note !== undefined) return `BUG: the worker noted the site of a tab on a site with no saved level (${note})`;
      return true;
    } finally {
      await swForgetSite(ctx.sw, host);
      if (page) await page.close().catch(() => {});
    }
  },

  // The saved level belongs to its site, and only the ARRIVAL applies it. One tab throughout:
  // leaving for a site with nothing saved (localhost is a different host) drops a level the tab
  // only got from the saved one; coming back seeds it again; a level the user then sets in the tab
  // survives a reload untouched (no re-seeding on the same site) and travels on to the next site,
  // as a tab's own level always has.
  async s47_site_level_stays_with_its_site(ctx) {
    const host = "127.0.0.1";
    const page = await ctx.browser.newPage();
    const ducked = (m) => !!(m && m.ok && m.rms < 0.1);     // the 0.05x seed: unmistakable in rms
    const notDucked = (m) => !m || !m.ok || m.rms > 0.2;    // no script, nothing engaged, or not the seed
    const boosted = (m) => !!(m && m.ok && m.rms > 0.2);    // the tab's own 1.5x (the limiter caps it, still far above the seed)
    try {
      await swSaveSite(ctx.sw, host, 0.05);
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=audible`, { waitUntil: "load" });
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      let w = await waitMeasure(ctx.sw, tabId, ducked, 8000);
      if (!w.m) return `setup failed: the saved level never took (last measure ${JSON.stringify(w.last)})`;
      // 1. leaving for a site with nothing saved: the seeded level stays behind
      await page.goto(`http://localhost:${ctx.port}/?auto=audible`, { waitUntil: "load" });
      await sleep(2500);
      let gain = await swGetGain(ctx.sw, tabId);
      const m1 = await measureTop(ctx.sw, tabId);
      ctx.note(`after leaving: gain=${gain} measure=${JSON.stringify(m1)}`);
      if (gain !== undefined || !notDucked(m1)) return `BUG: the seeded level followed the tab to another site (gain=${gain}, measure ${JSON.stringify(m1)})`;
      const note = await ctx.sw.evaluate((t) => sget(TABHOST(t)), tabId);
      if (note !== undefined) return `BUG: the note of the saved site outlived the visit (${note})`;
      // 2. back on the site: seeded again
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=audible`, { waitUntil: "load" });
      w = await waitMeasure(ctx.sw, tabId, ducked, 8000);
      gain = await swGetGain(ctx.sw, tabId);
      if (!w.m || gain !== 0.05) return `BUG: coming back to the site did not apply the saved level again (gain=${gain}, measure ${JSON.stringify(w.m || w.last)})`;
      // 3. the user's own level in the tab survives a reload: no re-seeding on the same site
      const r = await swSetGain(ctx.sw, tabId, 1.5);
      if (r.mode !== "element") return `setup failed: ${JSON.stringify(r)}`;
      await page.reload({ waitUntil: "load" });
      w = await waitMeasure(ctx.sw, tabId, boosted, 8000);
      gain = await swGetGain(ctx.sw, tabId);
      ctx.note(`after reload: gain=${gain} measure=${JSON.stringify(w.m || w.last)}`);
      if (gain !== 1.5) return `BUG: the reload re-applied the saved level over the tab's own (gain=${gain}, expected 1.5)`;
      if (!w.m) return `BUG: the tab's own level was not restored after the reload (last measure ${JSON.stringify(w.last)})`;
      // 4. ...and travels with the tab to the next site, as a tab's own level always has
      await page.goto(`http://localhost:${ctx.port}/?auto=audible`, { waitUntil: "load" });
      w = await waitMeasure(ctx.sw, tabId, boosted, 8000);
      gain = await swGetGain(ctx.sw, tabId);
      if (!w.m || gain !== 1.5) return `BUG: the tab's own level did not travel to the next site (gain=${gain}, measure ${JSON.stringify(w.m || w.last)})`;
      return true;
    } finally {
      await swForgetSite(ctx.sw, host);
      await page.close().catch(() => {});
    }
  },

  // The popup's entry points: save keeps the slider's level for the tab's site, saving 1x (off)
  // and forget both leave nothing behind, and a site with nothing saved seeds no new tab.
  async s48_site_level_save_and_forget(ctx) {
    const host = "127.0.0.1";
    let page = await ctx.browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=audible`, { waitUntil: "load" });
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const s = await ctx.sw.evaluate((t) => siteSave(t, 2), tabId);
      if (!s || s.host !== host || s.saved !== 2) return `save answered ${JSON.stringify(s)}`;
      if ((await swSavedLevel(ctx.sw, host)) !== 2) return "the saved level is not in storage";
      const s1 = await ctx.sw.evaluate((t) => siteSave(t, 1), tabId);
      if (s1.saved !== null || (await swSavedLevel(ctx.sw, host)) !== undefined) return "BUG: saving 1x (off) left a level behind";
      await ctx.sw.evaluate((t) => siteSave(t, 2), tabId);
      const f = await ctx.sw.evaluate((t) => siteForget(t), tabId);
      if (f.saved !== null || (await swSavedLevel(ctx.sw, host)) !== undefined) return "BUG: forget left the level behind";
      await page.close(); page = null;
      await swClearLog(ctx.sw);
      page = await ctx.browser.newPage();
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=audible`, { waitUntil: "load" });
      await sleep(2500);
      const t2 = await tabIdOf(ctx.sw, ctx.port);
      const g = await swGetGain(ctx.sw, t2);
      if (g !== undefined) return `BUG: a forgotten site level still seeds new tabs (gain=${g})`;
      return true;
    } finally {
      await swForgetSite(ctx.sw, host);
      if (page) await page.close().catch(() => {});
    }
  },

  // The promise for rarely visited sites: a saved level arriving in a fresh tab that Chrome has
  // not let play sound yet is refused as 'suspended' (nothing hangs, nothing is silenced) and
  // lands with the first click on the page. Real autoplay policy in a fresh profile, script-hopped
  // navigation so the document carries no activation (as s41).
  async s49_site_level_waits_for_first_click(ctx) {
    const browser2 = await launchChrome({ autoplayPolicyOff: false });
    let page;
    try {
      const sw2 = await getWorker(browser2);
      await installSpy(sw2);
      await swSaveSite(sw2, "localhost", 3);
      page = await browser2.newPage();
      const target = `http://localhost:${ctx.port}/?auto=audible`;
      await page.goto(`http://127.0.0.1:${ctx.port}/hop.html?to=${encodeURIComponent(target)}`, { waitUntil: "load" });
      // The arrival seeds the tab and the restore engages: the answer must be a refusal, not a hang.
      const t0 = Date.now();
      let refusal = null;
      while (!refusal && Date.now() - t0 < 10000) {
        await sleep(100);
        refusal = (await swSpyLog(sw2)).find((e) => e.cmd === "engage" && e.res && e.res.reason === "suspended");
      }
      if (!refusal) {
        const seen = (await swSpyLog(sw2)).filter((e) => e.cmd === "engage").map((e) => e.res);
        return `no 'suspended' refusal within 10s (engages seen: ${JSON.stringify(seen)})`;
      }
      const tabId = refusal.tabId;
      if ((await swGetGain(sw2, tabId)) !== 3) return "BUG: the refusal dropped the seeded level";
      ctx.note(`refused ${Date.now() - t0}ms after the hop`);
      await swClearLog(sw2);
      const pos = await page.evaluate(() => {
        const v = document.querySelector("video");
        v.scrollIntoView({ block: "center" });
        const r = v.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.click(pos.x, pos.y);
      const { hit, elapsed } = await waitEngage(sw2, (r) => r.ok === true, 8000);
      if (!hit) return "BUG: the saved level never landed after the unlocking click";
      ctx.note(`boost ${elapsed}ms after the click`);
      return true;
    } finally {
      if (page) await page.close().catch(() => {});
      await browser2.close().catch(() => {});
    }
  },

  // A popup opened while a restore is still running. It used to skip its own apply (a premature
  // probe could commit capture before the player loads) and show a guessed mode, trusting the
  // restore to apply the level - but a restore never starts a capture by itself, so on a page only
  // capture can reach (a saved level arriving on a DRM or cross-origin player) the level never
  // came, under an amber pill. Now the popup shows no guess and the worker answers it when the
  // pass settles: the confirmed mode, or its own apply where the restore could not apply the
  // level. Driven at the worker's entry points (the harness cannot open the real popup): prepare
  // mid-restore, then afterRestore. The harness has no popup grant, so a capture attempt fails
  // here; what is checked is that it is made, and only when a popup is waiting.
  async s50_popup_mid_restore_settles(ctx) {
    const host = "127.0.0.1";
    let page;
    const midRestorePrepare = async (tabId) => {
      for (let i = 0; i < 40; i++) {
        const p = await ctx.sw.evaluate((t) => prepare(t), tabId);
        if (p.restoring) return p;
        await sleep(100);
      }
      return null;
    };
    const waitPopup = (tabId) => Promise.race([
      ctx.sw.evaluate((t) => afterRestore(t), tabId),
      sleep(20000).then(() => "hung"),
    ]);
    const captureCalls = () => ctx.sw.evaluate(() => globalThis.__s50.calls);
    try {
      await ctx.sw.evaluate(() => {
        const orig = chrome.tabCapture.getMediaStreamId.bind(chrome.tabCapture);
        globalThis.__s50 = { orig, calls: 0 };
        chrome.tabCapture.getMediaStreamId = (...a) => { globalThis.__s50.calls++; return orig(...a); };
      });
      await swSaveSite(ctx.sw, host, 3);

      // 1. A player that attaches late: the popup waits, and the restore's own engage is the answer.
      page = await ctx.browser.newPage();
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=late`, { waitUntil: "load" });
      let tabId = await tabIdOf(ctx.sw, ctx.port);
      let prep = await midRestorePrepare(tabId);
      if (!prep) return "setup failed: no restore pass seen on the late-player page";
      if (prep.mode !== undefined) return `BUG: the popup is shown a guessed mode mid-restore (${prep.mode})`;
      let res = await waitPopup(tabId);
      ctx.note(`late player: ${JSON.stringify(res)}`);
      if (res === "hung") return "BUG: the popup's wait never ended (late player)";
      if (res.mode !== "element") return `BUG: the popup's wait on a late player ended with ${JSON.stringify(res)}`;
      if (await captureCalls()) return "BUG: a capture was tried although the restore engaged the player";
      await page.close(); page = null;

      // 2. A page only capture could reach (nothing hookable on it): the popup's own apply follows.
      page = await ctx.browser.newPage();
      await page.goto(`http://127.0.0.1:${ctx.port}/`, { waitUntil: "load" });
      tabId = await tabIdOf(ctx.sw, ctx.port);
      prep = await midRestorePrepare(tabId);
      if (!prep) return "setup failed: no restore pass seen on the capture-only page";
      if (prep.mode !== undefined) return `BUG: the popup is shown a guessed mode mid-restore (${prep.mode})`;
      const t0 = Date.now();
      res = await waitPopup(tabId);
      const calls = await captureCalls();
      ctx.note(`capture-only: answered after ${Date.now() - t0}ms with ${JSON.stringify(res)}, ${calls} capture attempt(s)`);
      if (res === "hung") return "BUG: the popup's wait never ended (capture-only page)";
      if (calls < 1) return "BUG: the restore settled and nothing applied the level for the waiting popup";
      if (res.mode === "capture") return `no grant here, yet the answer claims a capture: ${JSON.stringify(res)}`;

      // 3. Non-vacuity: the same kind of pass with no popup waiting never tries a capture itself.
      await ctx.sw.evaluate(() => { globalThis.__s50.calls = 0; });
      await page.reload({ waitUntil: "load" });
      let seen = false;
      for (let i = 0; i < 30 && !seen; i++) { seen = await ctx.sw.evaluate((t) => restoring.has(t), tabId); if (!seen) await sleep(100); }
      if (!seen) return "setup failed: no restore pass after the reload";
      for (let i = 0; i < 150 && (await ctx.sw.evaluate((t) => restoring.has(t), tabId)); i++) await sleep(100);
      const alone = await captureCalls();
      if (alone) return `sabotage failed: a pass with no popup waiting tried ${alone} capture(s) on its own`;
      return true;
    } finally {
      await ctx.sw.evaluate(() => {
        if (!globalThis.__s50) return;
        chrome.tabCapture.getMediaStreamId = globalThis.__s50.orig;
        delete globalThis.__s50;
      });
      await swForgetSite(ctx.sw, host);
      if (page) await page.close().catch(() => {});
    }
  },

  // A page whose player no in-page hook can ever take (a live stream fed through srcObject, the
  // way live-stream players use a MediaSource handle): the probe says so at once, yet the restore
  // used to keep probing for a hookable element for its full patience - on a heavy page well
  // over ten seconds, and a popup opened meanwhile waited all of it before the level arrived.
  // Now the first probe that sees the playing player ends the pass with one capture attempt
  // (it fails here: no popup grant in the harness).
  async s51_unhookable_player_ends_restore(ctx) {
    const host = "127.0.0.1";
    let page;
    try {
      await ctx.sw.evaluate(() => {
        const orig = chrome.tabCapture.getMediaStreamId.bind(chrome.tabCapture);
        globalThis.__s51 = { orig, calls: 0 };
        chrome.tabCapture.getMediaStreamId = (...a) => { globalThis.__s51.calls++; return orig(...a); };
      });
      await swSaveSite(ctx.sw, host, 3);
      page = await ctx.browser.newPage();
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=stream`, { waitUntil: "load" });
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      // a stream delivers its first frame a beat after play(): wait until the element really plays
      let playing = false;
      for (let i = 0; i < 30 && !playing; i++) {
        playing = await page.evaluate(() => { const v = document.getElementById("stream"); return !!v && !v.paused && v.readyState >= 2; });
        if (!playing) await sleep(100);
      }
      if (!playing) return "setup failed: the stream player never started playing";
      await ctx.sw.evaluate(() => {
        globalThis.__s51.cands = [];
        chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "frameCandidates" && globalThis.__s51) globalThis.__s51.cands.push(...m.cands); });
      });
      const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      if (pm.mode !== "capture" || !pm.certain) {
        const cands = await ctx.sw.evaluate(() => globalThis.__s51.cands);
        return `BUG: the probe does not call the playing srcObject player unhookable for good: ${JSON.stringify(pm)} candidates ${JSON.stringify(cands)}`;
      }
      // time the arrival's pass: it must end right after the player is seen, not after the full patience
      // settled = no pass running for 600ms in a row; queued re-runs (the player's own churn pings)
      // are allowed, a pass that keeps probing is not
      const t0 = Date.now();
      let idleSince = null;
      while (Date.now() - t0 < 3500) {
        const running = await ctx.sw.evaluate((t) => restoring.has(t), tabId);
        if (running) idleSince = null; else if (idleSince == null) idleSince = Date.now();
        if (idleSince != null && Date.now() - idleSince >= 600) break;
        await sleep(100);
      }
      const busy = !(idleSince != null && Date.now() - idleSince >= 600);
      const calls = await ctx.sw.evaluate(() => globalThis.__s51.calls);
      ctx.note(`pass still running ${Date.now() - t0}ms after load: ${busy}, capture attempts ${calls}`);
      if (busy) return "BUG: the restore keeps probing a page whose player can only be captured";
      if (calls < 1) return "BUG: the pass ended without the one capture attempt";
      // and a popup opened now is answered at once, with its own apply
      const t1 = Date.now();
      const res = await Promise.race([ctx.sw.evaluate((t) => afterRestore(t), tabId), sleep(8000).then(() => "hung")]);
      ctx.note(`popup answered in ${Date.now() - t1}ms: ${JSON.stringify(res)}`);
      if (res === "hung" || Date.now() - t1 > 3000) return `BUG: a popup opened after the pass still waited (${JSON.stringify(res)})`;
      return true;
    } finally {
      await ctx.sw.evaluate(() => {
        if (!globalThis.__s51) return;
        chrome.tabCapture.getMediaStreamId = globalThis.__s51.orig;
        delete globalThis.__s51;
      });
      await swForgetSite(ctx.sw, host);
      if (page) await page.close().catch(() => {});
    }
  },

  // A tab that was open across an extension update keeps the PREVIOUS copy's one-shot hook on its
  // player: the old world stands down, the element stays bound. The new world cannot hook it
  // again and used to report 'already-hooked', a foreign conflict - so the popup told the user the
  // page (or another app) handles its audio. Simulated: the page's main world hooks the player,
  // which the extension's world cannot tell from a predecessor's hook, and the worker's install
  // time is set after (an update happened) or before (a fresh document) the document was created.
  async s52_stale_hook_is_not_a_conflict(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const orig = await ctx.sw.evaluate(() => installedAt());
    const setSince = (v) => ctx.sw.evaluate(async (x) => { await lset(INSTALLED_KEY, x); installedAtCache = null; }, v);
    let tabId = null;
    try {
      const id = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      await page.evaluate((i) => {
        const v = document.getElementById(i);
        const ac = new AudioContext();
        ac.createMediaElementSource(v).connect(ac.destination);
        window.__predecessor = ac;
      }, id);
      tabId = await tabIdOf(ctx.sw, ctx.port);
      // 1. installed after this document was created: the hook is our predecessor's leftover
      await setSince(Date.now());
      await swClearLog(ctx.sw);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      const e1 = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.reason);
      ctx.note(`after an update: ${JSON.stringify(e1 && e1.res)} -> ${JSON.stringify(r1)}`);
      if (!e1 || e1.res.reason !== "stale-hook") return `BUG: the leftover is not recognized (${JSON.stringify(e1 && e1.res)})`;
      if (r1.conflict || !r1.stale) return `BUG: the popup would blame the page: ${JSON.stringify(r1)}`;
      // 2. non-vacuity: the same hook on a document newer than the install IS a foreign conflict
      await setSince(1);
      await ctx.sw.evaluate((t) => clearMode(t), tabId);
      await swClearLog(ctx.sw);
      const r2 = await swSetGain(ctx.sw, tabId, 3);
      const e2 = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.reason);
      ctx.note(`fresh document: ${JSON.stringify(e2 && e2.res)} -> ${JSON.stringify(r2)}`);
      if (!e2 || e2.res.reason !== "already-hooked" || !r2.conflict || r2.stale)
        return `sabotage failed: a foreign hook on a fresh document is not reported as a conflict (${JSON.stringify(r2)})`;
      return true;
    } finally {
      await setSince(orig);
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // Live-stream players feed their <video> through srcObject = MediaSourceHandle (MSE in a worker):
  // no URL at all, so the probe used to call them unhookable ('no-src') and the tab went to capture -
  // fullscreen lost while boosted, and a saved level arrived only once the popup was opened. MSE is
  // CORS-clean by construction: such a player is hooked in-page now, with the boost measured
  // through the hook. Then the saved-level half: a new tab gets the level with no popup at all.
  async s53_mse_handle_player_in_page(ctx) {
    const host = "127.0.0.1";
    let page;
    const openPlayer = async () => {
      const p = await ctx.browser.newPage();
      await p.goto(`http://127.0.0.1:${ctx.port}/?auto=msehandle`, { waitUntil: "load" });
      await p.waitForFunction(() => {
        const v = document.getElementById("msehandle");
        return window.mseReady === true && !!v && !v.paused && v.readyState >= 2;
      }, { timeout: 15000 });
      return p;
    };
    try {
      page = await openPlayer();
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      if (pm.mode !== "element") return `BUG: the MediaSource-handle player is not taken in-page: ${JSON.stringify(pm)}`;
      const r = await swSetGain(ctx.sw, tabId, 0.05);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`setGain ${JSON.stringify(r)}, rms ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (r.mode !== "element" || !r.confirmed) return `BUG: no confirmed in-page boost on the handle player: ${JSON.stringify(r)}`;
      if (!m || !m.ok || m.rms > 0.1) return `BUG: the handle player is not ducked (measure ${JSON.stringify(m)})`;
      await swSetGain(ctx.sw, tabId, 1);
      await page.close(); page = null;
      // a saved level reaches such a player in a new tab on its own
      await swSaveSite(ctx.sw, host, 0.05);
      page = await openPlayer();
      const t2 = await tabIdOf(ctx.sw, ctx.port);
      const w = await waitMeasure(ctx.sw, t2, (x) => !!(x && x.ok && x.rms < 0.1), 10000);
      ctx.note(`saved level in a new tab: ${w.m ? "ducked " + w.elapsed + "ms after the player started" : "not applied, last " + JSON.stringify(w.last)}`);
      if (!w.m) return "BUG: the saved level did not reach the handle player without the popup";
      return true;
    } finally {
      await swForgetSite(ctx.sw, host);
      if (page) await page.close().catch(() => {});
    }
  },

  // A level the page knows BEFORE its player starts. The worker pre-arms the top frame while its
  // restore is still waiting for a player, so the frame takes the player in the 'play' event
  // itself, not a probe cadence later: on a tab turned down, the difference between a silent
  // start and a moment of full volume. Two players: one that starts within the restore's
  // patience, one well after it (the frame stays armed past the give-up exit, and reports its
  // hook so the worker tracks the frame without a probe). The tell: the worker's first engage on
  // such a player finds it already hooked (the update path answers without `signal`), and the
  // very first measure already sees the ducked level.
  async s54_armed_frame_takes_player_at_play(ctx) {
    const host = "127.0.0.1";
    const check = async (after, label) => {
      const page = await ctx.browser.newPage();
      try {
        await swClearLog(ctx.sw);
        await page.goto(`http://127.0.0.1:${ctx.port}/?auto=late&after=${after}`, { waitUntil: "load" });
        await page.waitForFunction(() => { const v = document.querySelector("video"); return !!v && !v.paused; }, { timeout: after + 5000 });
        const id = await page.evaluate(() => document.querySelector("video").id);
        const playedAt = await page.evaluate((i) => window.feed.playedAt(i), id);
        const tabId = await tabIdOf(ctx.sw, ctx.port);
        const m = await measureTop(ctx.sw, tabId);
        await sleep(1500);
        const first = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.t >= playedAt - 50 && e.res && e.res.ok);
        const mode = await swGetMode(ctx.sw, tabId);
        ctx.note(`${label}: first measure rms ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}, first engage ${first ? JSON.stringify(first.res) : "none"}, mode ${JSON.stringify(mode)}`);
        if (!m || !m.ok || m.rms > 0.1) return `${label}: the player was not ducked when it started (measure ${JSON.stringify(m)})`;
        if (first && "signal" in first.res) return `${label}: the worker's engage is what hooked the player: it played at native level until then`;
        if (!mode || mode.mode !== "element" || mode.frameId !== 0) return `${label}: the worker does not track the frame's own hook (mode ${JSON.stringify(mode)})`;
        return true;
      } finally { await page.close().catch(() => {}); }
    };
    try {
      await swSaveSite(ctx.sw, host, 0.05);
      const a = await check(1500, "within the restore's patience");
      if (a !== true) return a;
      const b = await check(7500, "after the restore gave up");
      if (b !== true) return b;
      return true;
    } finally { await swForgetSite(ctx.sw, host); }
  },

  // A player told to play BEFORE its stream is attached. Its 'play' finds nothing to hook, and a
  // fresh element stays unpaused through the attachment, so no second 'play' ever comes: only
  // 'playing' marks the real start. The stream arrives late here, after every restore pass has
  // given up (the sourceless 'play' pinged one more), so nothing but the frame's own listeners can
  // catch it: the one-in-twenty tab on a live-streaming site that never got its saved level until
  // the popup opened. Now 'playing' takes the player in-page like 'play' does, on the still-armed
  // top frame, so the level is in place when the sound starts.
  async s55_playing_reveals_late_source(ctx) {
    const host = "127.0.0.1";
    let page;
    try {
      await swSaveSite(ctx.sw, host, 0.05);
      await swClearLog(ctx.sw);
      page = await ctx.browser.newPage();
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=msehandle&order=playfirst&attach=16000`, { waitUntil: "load" });
      await page.waitForFunction(() => window.mseReady === true && !!window.feed.playingAt("msehandle"), { timeout: 30000 });
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const m = await measureTop(ctx.sw, tabId);
      const { playedAt, playingAt, hadSource } = await page.evaluate(() => ({
        playedAt: window.feed.playedAt("msehandle"), playingAt: window.feed.playingAt("msehandle"), hadSource: window.feed.playHadSource("msehandle") }));
      if (hadSource !== false || !(playedAt < playingAt)) return `setup failed: not a play-before-source start (hadSource=${hadSource}, play ${playedAt}, playing ${playingAt})`;
      await sleep(1500);
      const log = await swSpyLog(ctx.sw);
      const late = log.find((e) => e.cmd === "engage" && e.t >= playingAt - 50 && e.res && e.res.ok);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`'playing' ${playingAt - playedAt}ms after the sourceless 'play', first measure rms ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}, engage after it ${late ? JSON.stringify(late.res) : "none"}, mode ${JSON.stringify(mode)}`);
      if (!m || !m.ok || m.rms > 0.1) return `BUG: the saved level never reached the player once its stream started (measure ${JSON.stringify(m)})`;
      if (late && "signal" in late.res) return "BUG: the worker's probe is what hooked the player: the sound started at native level";
      if (!mode || mode.mode !== "element" || mode.frameId !== 0) return `BUG: the frame's own hook is not tracked (mode ${JSON.stringify(mode)})`;
      return true;
    } finally {
      await swForgetSite(ctx.sw, host);
      if (page) await page.close().catch(() => {});
    }
  },

  // Saving a level for a site in one tab must not touch another tab already on that site: the
  // saved level is for tabs ARRIVING there. Tab A sets its own level while nothing is saved; tab B
  // saves another; then A navigates within the site (pushState) - its own level must stay. Also:
  // a save for a site the tab has left since the popup opened is refused.
  async s56_save_leaves_other_tabs_alone(ctx) {
    const host = "127.0.0.1";
    let a, b;
    try {
      a = await ctx.browser.newPage();
      await a.goto(`http://127.0.0.1:${ctx.port}/?auto=audible&tab=a`, { waitUntil: "load" });
      await sleep(400);
      const ta = await tabIdByUrl(ctx.sw, "tab=a");
      const r = await swSetGain(ctx.sw, ta, 3);
      if (r.mode !== "element") return `setup failed: ${JSON.stringify(r)}`;
      b = await ctx.browser.newPage();
      await b.goto(`http://127.0.0.1:${ctx.port}/?tab=b`, { waitUntil: "load" });
      await sleep(300);
      const tb = await tabIdByUrl(ctx.sw, "tab=b");
      const s = await ctx.sw.evaluate((t, h) => siteSave(t, 0.05, h), tb, host);
      if (s.saved !== 0.05) return `setup failed: save answered ${JSON.stringify(s)}`;
      await a.evaluate(() => history.pushState(null, "", "/?auto=audible&tab=a&next=2"));
      await sleep(1500);
      const ga = await swGetGain(ctx.sw, ta);
      ctx.note(`tab A after an in-site navigation: gain=${ga}`);
      if (ga !== 3) return `BUG: saving in another tab replaced this tab's own level (gain ${ga}, expected 3)`;
      // the popup names the site; a tab that is somewhere else by now is not saved for
      const wrong = await ctx.sw.evaluate((t) => siteSave(t, 2, "elsewhere.example"), tb);
      const kept = await swSavedLevel(ctx.sw, host);
      if (wrong.host !== host || kept !== 0.05) return `BUG: a save named for another site went through (${JSON.stringify(wrong)}, stored ${kept})`;
      return true;
    } finally {
      await swForgetSite(ctx.sw, host);
      for (const p of [a, b]) if (p) await p.close().catch(() => {});
    }
  },

  // The 'stale' state (the previous copy's leftover hook) belongs to the document that carried it.
  // After the reload the popup asks for, the restore used to treat the tab as capture-bound: no
  // pre-arm, a capture attempt on the fresh page, and the stale note carried onto it. Recorded
  // here directly (the harness has no capture grant, so the state never survives on its own),
  // then the page reloads with a player that starts a beat after the load.
  async s57_stale_state_ends_with_reload(ctx) {
    const page = await ctx.browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=late&after=1500`, { waitUntil: "load" });
      await page.waitForFunction(() => { const v = document.querySelector("video"); return !!v && !v.paused; }, { timeout: 8000 });
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r = await swSetGain(ctx.sw, tabId, 0.05);
      if (r.mode !== "element") return `setup failed: ${JSON.stringify(r)}`;
      await ctx.sw.evaluate((t) => setMode(t, { mode: "capture", conflict: false, stale: true }), tabId);
      await ctx.sw.evaluate(() => {
        const orig = chrome.tabCapture.getMediaStreamId.bind(chrome.tabCapture);
        globalThis.__s57 = { orig, calls: 0 };
        chrome.tabCapture.getMediaStreamId = (...a) => { globalThis.__s57.calls++; return orig(...a); };
      });
      await swClearLog(ctx.sw);
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => { const v = document.querySelector("video"); return !!v && !v.paused; }, { timeout: 8000 });
      const playedAt = await page.evaluate(() => window.feed.playedAt(document.querySelector("video").id));
      const m = await measureTop(ctx.sw, tabId);
      await sleep(1500);
      const calls = await ctx.sw.evaluate(() => globalThis.__s57.calls);
      const first = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.t >= playedAt - 50 && e.res && e.res.ok);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`capture attempts ${calls}, first measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}, mode ${JSON.stringify(mode)}`);
      if (calls) return `BUG: the reloaded page was treated as capture-bound (${calls} capture attempt(s))`;
      if (!m || !m.ok || m.rms > 0.1) return `BUG: the reloaded page's player was not taken at its start (measure ${JSON.stringify(m)})`;
      if (first && "signal" in first.res) return "BUG: the worker's engage hooked the player, not the pre-armed frame";
      if (!mode || mode.mode !== "element" || mode.stale) return `BUG: the tab did not come back in plain element mode (${JSON.stringify(mode)})`;
      return true;
    } finally {
      await ctx.sw.evaluate(() => {
        if (!globalThis.__s57) return;
        chrome.tabCapture.getMediaStreamId = globalThis.__s57.orig;
        delete globalThis.__s57;
      });
      await page.close().catch(() => {});
    }
  },

  // A frame armed at a level the tab no longer has - a release's stop overtook the restore's arm -
  // must not keep a hook it takes afterwards. Simulated: the frame is armed while the tab has no
  // level, then a player starts. The worker unwinds that hook on the frame's report and records no
  // mode, instead of a boost the popup shows as 1x.
  async s58_hook_without_level_is_undone(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const gain = await swGetGain(ctx.sw, tabId);
      if (gain !== undefined) return `setup failed: the tab already has a level (${gain})`;
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      await ctx.sw.evaluate((t) => toFrame(t, 0, { cmd: "arm", gain: 0.05, useLimiter: true }), tabId);
      await page.evaluate(() => window.feed.addAudible());
      await sleep(1200);
      const m = await measureTop(ctx.sw, tabId);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}, mode ${JSON.stringify(mode)}`);
      if (mode) return `BUG: a hook taken without a level was recorded (${JSON.stringify(mode)})`;
      if (m && m.ok && m.rms < 0.1) return `BUG: the player stays ducked at a level the tab no longer has (rms ${m.rms.toFixed(3)})`;
      return true;
    } finally { await page.close(); }
  },

  // A restore that moves the player from one sub-frame to another. The top frame was pre-armed
  // while the loop waited; parking the old player's frame must not skip parking the top frame, or
  // it stays armed next to the new one - untracked, and able to hook at a level the slider no
  // longer reaches.
  async s59_retarget_parks_armed_top(ctx) {
    const page = await ctx.browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${ctx.port}/frame-same-origin.html`, { waitUntil: "load" });
      await sleep(1000);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r = await swSetGain(ctx.sw, tabId, 0.05);
      const cur = await swGetMode(ctx.sw, tabId);
      if (r.mode !== "element" || !cur || cur.frameId === 0) return `setup failed: player not in a sub-frame (${JSON.stringify(cur)})`;
      // the player "used to be" in another sub-frame
      await ctx.sw.evaluate((t) => setMode(t, { mode: "element", frameId: 999999 }), tabId);
      await swClearLog(ctx.sw);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      for (let i = 0; i < 100 && (await ctx.sw.evaluate((t) => restoring.has(t), tabId)); i++) await sleep(100);
      // Judged on the FIRST pass only (entries carry their send time): between the pass's arm and
      // its engage on the new frame, the top frame must be parked. A later re-run with the player
      // in the same sub-frame parks it either way and would hide the bug.
      const log = await swSpyLog(ctx.sw);
      const firstArm = log.filter((e) => e.cmd === "arm" && e.frameId === 0).sort((x, y) => x.t - y.t)[0];
      const firstEngage = firstArm && log.filter((e) => e.cmd === "engage" && e.frameId === cur.frameId && e.t >= firstArm.t).sort((x, y) => x.t - y.t)[0];
      const oldStop = log.find((e) => e.cmd === "stop" && e.frameId === 999999);
      const topStop = firstEngage && log.find((e) => e.cmd === "stop" && e.frameId === 0 && e.t >= firstArm.t && e.t <= firstEngage.t);
      ctx.note(`armed top: ${!!firstArm}, old frame parked: ${!!oldStop}, top frame parked before the engage: ${!!topStop}`);
      if (!firstArm || !firstEngage || !oldStop) return `setup failed: arm ${!!firstArm}, engage ${!!firstEngage}, old-frame stop ${!!oldStop}`;
      if (!topStop) return "BUG: the pre-armed top frame stays armed next to the player's new frame";
      return true;
    } finally { await page.close(); }
  },

  // The give-up at the end of a restore that found no player. If the player starts during the
  // last probe, the armed top frame takes it on the spot and reports it; the give-up used to
  // disarm every frame regardless and unwind that fresh hook to 1x. The last probe is wrapped so
  // the page starts its player right then; the hook must keep its level.
  async s60_giveup_keeps_fresh_hook(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await swSetGain(ctx.sw, tabId, 0.05); // no media yet: capture fails here, the level stays
      await ctx.sw.evaluate((t) => clearMode(t), tabId);
      // Only the pass under test may run: the new player's churn ping would otherwise queue a
      // re-run, whose engage re-applies the level and hides an unwound hook. (A player that
      // starts without touching the DOM - a stream attached to an element already there - gets
      // no such second chance, which is the case this guards.)
      await ctx.sw.evaluate((t) => {
        const origPredict = predictMode;
        const origKick = kickRestore;
        globalThis.__s60 = { origPredict, origKick, calls: 0, kicks: 0 };
        kickRestore = (id, d) => (id === t && globalThis.__s60.kicks++ > 0) ? Promise.resolve() : origKick(id, d);
        predictMode = async (id) => {
          const res = await origPredict(id);
          if (id === t && ++globalThis.__s60.calls === RESTORE_ATTEMPTS) {
            await chrome.scripting.executeScript({ target: { tabId: id }, world: "MAIN", func: () => window.feed.addAudible() });
            await new Promise((r) => setTimeout(r, 700)); // the frame hooks at 'play' and reports it
          }
          return res;
        };
      }, tabId);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      for (let i = 0; i < 150 && (await ctx.sw.evaluate((t) => restoring.has(t), tabId)); i++) await sleep(100);
      const calls = await ctx.sw.evaluate(() => globalThis.__s60.calls);
      await sleep(300);
      const m = await measureTop(ctx.sw, tabId);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`probes ${calls}, measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}, mode ${JSON.stringify(mode)}`);
      if (calls < 8) return `setup failed: the restore ended after ${calls} probes`;
      if (!m || !m.ok || m.rms > 0.1) return `BUG: the give-up unwound the hook the frame took during the last probe (measure ${JSON.stringify(m)})`;
      if (!mode || mode.mode !== "element") return `BUG: the frame's hook is not tracked after the give-up (${JSON.stringify(mode)})`;
      return true;
    } finally {
      await ctx.sw.evaluate((t) => {
        if (!globalThis.__s60) return;
        predictMode = globalThis.__s60.origPredict;
        kickRestore = globalThis.__s60.origKick;
        pendingRekick.delete(t);
        delete globalThis.__s60;
      }, tabId);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // ---- security hardening (1.2.2) ----
  // Code with content-script privileges in one tab, which a page that has broken into its
  // renderer could run, must not be able to drive the popup's commands: not learn which site
  // another tab shows, not set a level there, not save one, not fake a capture-engine report.
  async s61_popup_commands_only_from_popup(ctx) {
    let a, b;
    try {
      a = await ctx.browser.newPage();
      await a.goto(`http://127.0.0.1:${ctx.port}/?tab=a`, { waitUntil: "load" });
      b = await ctx.browser.newPage();
      await b.goto(`http://localhost:${ctx.port}/?tab=b-private`, { waitUntil: "load" });
      const ta = await tabIdByUrl(ctx.sw, "tab=a");
      const tb = await tabIdByUrl(ctx.sw, "tab=b-private");
      await ctx.sw.evaluate((t) => setMode(t, { mode: "capture", conflict: false }), tb);
      const out = await asContentScript(ctx.sw, ta, async (other) => {
        const ask = (m) => chrome.runtime.sendMessage(m).then((r) => r, (e) => "rejected: " + e.message);
        return {
          prepare: await ask({ type: "prepare", tabId: other }),
          setGain: await ask({ type: "setGain", tabId: other, gain: 4, useLimiter: true }),
          siteSave: await ask({ type: "siteSave", tabId: other, level: 2 }),
          fakeFailure: await ask({ type: "captureFailed", tabId: other }),
        };
      }, [tb]);
      await sleep(500);
      const gain = await swGetGain(ctx.sw, tb);
      const saved = await swSavedLevel(ctx.sw, "localhost");
      const mode = await swGetMode(ctx.sw, tb);
      ctx.note(`answers ${JSON.stringify(out)}, other tab gain=${gain}, saved=${saved}, mode=${JSON.stringify(mode)}`);
      if (out.prepare && typeof out.prepare === "object") return `BUG: a page context learned another tab's state: ${JSON.stringify(out.prepare)}`;
      if (gain !== undefined) return `BUG: a page context set a level in another tab (${gain})`;
      if (saved !== undefined) return `BUG: a page context saved a site level (${saved})`;
      if (!mode || mode.mode !== "capture") return `BUG: a faked capture-engine report cleared another tab's mode (${JSON.stringify(mode)})`;
      return true;
    } finally {
      await swForgetSite(ctx.sw, "localhost").catch(() => {});
      for (const p of [a, b]) if (p) await p.close().catch(() => {});
    }
  },

  // The capture engine (offscreen document) takes commands from the service worker only. A 'stop'
  // sent from a page context gets no answer and tears down nothing.
  async s62_capture_engine_only_from_worker(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      await ctx.sw.evaluate(() => ensureOffscreen());
      const fromWorker = await ctx.sw.evaluate((t) =>
        chrome.runtime.sendMessage({ target: "offscreen", cmd: "stop", tabId: t, immediate: true }).catch((e) => "rejected: " + e.message), tabId);
      if (!fromWorker || fromWorker.ok !== true) return `setup failed: the engine does not answer the worker (${JSON.stringify(fromWorker)})`;
      const fromPage = await asContentScript(ctx.sw, tabId, async (t) =>
        chrome.runtime.sendMessage({ target: "offscreen", cmd: "stop", tabId: t, immediate: true }).then((r) => r, (e) => "rejected: " + e.message), [tabId]);
      ctx.note(`worker -> ${JSON.stringify(fromWorker)}, page context -> ${JSON.stringify(fromPage)}`);
      if (fromPage && typeof fromPage === "object") return `BUG: the capture engine obeyed a page context (${JSON.stringify(fromPage)})`;
      return true;
    } finally { await page.close(); }
  },

  // The list of saved sites lives in storage.local, which Chrome opens to content scripts unless
  // the extension closes it. Ours never read it, and a page context must not either.
  async s63_saved_sites_closed_to_pages(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      await swSaveSite(ctx.sw, "secret-site.example", 1.5);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const got = await asContentScript(ctx.sw, tabId, async () =>
        chrome.storage.local.get(null).then((r) => r, (e) => "rejected: " + e.message), []);
      ctx.note(`storage.local from a page context -> ${JSON.stringify(got)}`);
      if (got && typeof got === "object") return `BUG: a page context read the saved sites (${JSON.stringify(got)})`;
      return true;
    } finally {
      await swForgetSite(ctx.sw, "secret-site.example").catch(() => {});
      await page.close();
    }
  },

  // No HTML parsing of values anywhere in the extension: the popup, the worker, the page script,
  // the selection rule and the engine set text, never markup. A regression guard as much as a
  // check.
  async s64_no_html_sinks(ctx) {
    const hits = [];
    for (const f of ["popup.js", "background.js", "content.js", "offscreen.js", "select.js"]) {
      const src = fs.readFileSync(path.join(REPO, f), "utf8");
      src.split(/\r?\n/).forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        if (/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(/.test(code)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    ctx.note(`${hits.length} HTML/code sinks`);
    if (hits.length) return `BUG: HTML or code evaluation sinks found: ${hits.join(" | ")}`;
    return true;
  },

  // ---- 1.2.3 ----
  // A capture that starts while a restore pass waits for a player. The pass must not arm the top
  // frame under it: the armed frame would take the player in-page and its gain would multiply
  // with the capture gain. The harness has no capture grant, so the engine's update ack is
  // stubbed (as in s44): the worker then holds a live capture by its own records. The setGain
  // runs inside the pass's first probe, the player starts during its last one, and churn re-runs
  // are dropped, so nothing but the pass under test acts.
  async s65_no_arm_under_live_capture(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port); // no media: the probe routes to capture
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await ctx.sw.evaluate(async (t) => {
        await ensureOffscreen();
        await sset(TABGAIN(t), 0.05);
        const st = globalThis.__s65 = {
          origSend: chrome.runtime.sendMessage.bind(chrome.runtime), origPredict: predictMode,
          origKick: kickRestore, probes: 0, kicks: 0, inner: false, mid: null, midAt: 0,
        };
        chrome.runtime.sendMessage = (m, ...rest) => {
          if (m && m.target === "offscreen" && m.cmd === "update" && m.tabId === t) return Promise.resolve({ ok: true });
          return st.origSend(m, ...rest);
        };
        kickRestore = (id, d) => (id === t && st.kicks++ > 0) ? Promise.resolve() : st.origKick(id, d);
        predictMode = async (id) => {
          if (id !== t || st.inner) return st.origPredict(id);
          if (++st.probes === 1) {
            st.inner = true;
            try { st.mid = await serialized(t, () => setGain(t, 0.05, true)); } finally { st.inner = false; }
            st.midAt = Date.now();
          }
          const res = await st.origPredict(id);
          if (st.probes === RESTORE_ATTEMPTS) {
            await chrome.scripting.executeScript({ target: { tabId: id }, world: "MAIN", func: () => window.feed.addAudible() });
            await new Promise((r) => setTimeout(r, 700)); // an armed frame hooks at 'play'
          }
          return res;
        };
      }, tabId);
      await swClearSpy(ctx.sw);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      for (let i = 0; i < 150 && (await ctx.sw.evaluate((t) => restoring.has(t), tabId)); i++) await sleep(100);
      await sleep(500);
      const st = await ctx.sw.evaluate(() => ({ mid: globalThis.__s65.mid, midAt: globalThis.__s65.midAt, probes: globalThis.__s65.probes }));
      const arms = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "arm" && e.t >= st.midAt).length;
      const active = await ctx.sw.evaluate(() => sget("active"));
      const mode = await swGetMode(ctx.sw, tabId);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`mid setGain ${JSON.stringify(st.mid)}, probes ${st.probes}, arms under capture ${arms}, mode ${JSON.stringify(mode)}, measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (!st.mid || st.mid.mode !== "capture") return `setup failed: the mid-pass setGain did not record a capture (${JSON.stringify(st.mid)})`;
      const attempts = await ctx.sw.evaluate(() => RESTORE_ATTEMPTS);
      if (st.probes < attempts) return `setup failed: the pass ended after ${st.probes} probes`;
      const capture = (mode && mode.mode === "capture") || (Array.isArray(active) && active.includes(tabId));
      if (capture && m && m.ok && m.rms < 0.1) return `BUG: element gain stacks on the live capture (frame hooked at the level, rms ${m.rms.toFixed(3)})`;
      if (arms) return `BUG: the pass armed the top frame ${arms} times while the capture was live`;
      return true;
    } finally {
      await ctx.sw.evaluate((t) => {
        const st = globalThis.__s65;
        if (!st) return;
        chrome.runtime.sendMessage = st.origSend;
        predictMode = st.origPredict;
        kickRestore = st.origKick;
        pendingRekick.delete(t);
        delete globalThis.__s65;
      }, tabId);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The backstop: a frame armed anyway (an arm that slipped in before a capture started) takes a
  // player while the tab is recorded as capturing. The hook must not keep its level under the
  // capture: it goes back to unity, and the capture stays. The player starts by play() on an
  // element already in the DOM, so no churn ping follows and only the frame's own report reaches
  // the worker.
  async s66_hook_under_capture_goes_to_unity(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const id = await page.evaluate(() => window.feed.addPaused()); // unmuted, paused, no level yet
      await sleep(2600); // its churn ping drains while no level is set
      await ctx.sw.evaluate(async (t) => {
        await ensureOffscreen();
        const st = globalThis.__s66 = { origSend: chrome.runtime.sendMessage.bind(chrome.runtime) };
        chrome.runtime.sendMessage = (m, ...rest) => {
          if (m && m.target === "offscreen" && m.tabId === t && m.cmd === "update") return Promise.resolve({ ok: true });
          return st.origSend(m, ...rest);
        };
        await sset(TABGAIN(t), 0.05);
        await setMode(t, { mode: "capture", conflict: false });
        await markActive(t);
        await ensureContentScript(t);
        await chrome.tabs.sendMessage(t, { cmd: "arm", gain: 0.05, useLimiter: true }, { frameId: 0 });
      }, tabId);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), id);
      await sleep(1500);
      const hooked = await ctx.sw.evaluate(() => globalThis.__spy.hooked);
      const mode = await swGetMode(ctx.sw, tabId);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`hooked reports ${hooked}, mode ${JSON.stringify(mode)}, measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (!hooked) return "setup failed: the armed frame did not take the player";
      if (!mode || mode.mode !== "capture") return `BUG: the report moved the tab out of capture (${JSON.stringify(mode)})`;
      if (m && m.ok && m.rms < 0.1) return `BUG: the frame's hook keeps the level under the live capture (rms ${m.rms.toFixed(3)})`;
      return true;
    } finally {
      await ctx.sw.evaluate(() => {
        const st = globalThis.__s66;
        if (!st) return;
        chrome.runtime.sendMessage = st.origSend;
        delete globalThis.__s66;
      });
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A restore whose engages are all refused for a reason worth waiting on. It must not leave an
  // element record behind, and a popup waiting on it must not be told element mode: nothing
  // adjusts the tab's audio then. The pass's arms do not reach the frame either: an armed frame
  // takes the clip that already plays in-page (content.js takeSounding), which is no refusal.
  async s67_refused_restore_leaves_no_record(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await page.evaluate(() => window.feed.addAudible());
      await sleep(400);
      await ctx.sw.evaluate((t) => {
        const send = chrome.tabs.sendMessage;
        globalThis.__s67 = { orig: engageFrame, send };
        engageFrame = async (id, f, m) => (id === t ? { ok: false, reason: "cross-origin-no-cors" } : globalThis.__s67.orig(id, f, m));
        chrome.tabs.sendMessage = (id, m, o) => (id === t && m && m.cmd === "arm" ? Promise.resolve({ ok: true, running: false }) : send(id, m, o));
        return sset(TABGAIN(t), 3);
      }, tabId);
      const run = ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      await sleep(300);
      const res = await Promise.race([ctx.sw.evaluate((t) => afterRestore(t), tabId), sleep(20000).then(() => "hung")]);
      await run;
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`popup answer ${JSON.stringify(res)}, mode ${JSON.stringify(mode)}`);
      if (res === "hung") return "BUG: the popup's wait never ended";
      if (res.mode === "element") return `BUG: the popup is told element mode although every engage was refused: ${JSON.stringify(res)}`;
      if (mode && mode.mode === "element") return `BUG: an element record survives the refused restore: ${JSON.stringify(mode)}`;
      return true;
    } finally {
      await ctx.sw.evaluate(() => { if (globalThis.__s67) { engageFrame = globalThis.__s67.orig; chrome.tabs.sendMessage = globalThis.__s67.send; delete globalThis.__s67; } });
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A frame stopped by the worker (a restore that gave up, a retarget) keeps its hook at unity.
  // When that same element plays again, the frame must report it like any other element instead
  // of treating it as handled: otherwise it plays at native level until the popup is opened.
  async s68_stopped_hook_plays_again(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const id = await page.evaluate(() => window.feed.addAudible());
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r = await swSetGain(ctx.sw, tabId, 0.05);
      if (r.mode !== "element" || !r.confirmed) return `setup failed: ${JSON.stringify(r)}`;
      await ctx.sw.evaluate((t) => toFrame(t, null, { cmd: "stop" }), tabId); // the level stays stored
      await page.evaluate((i) => window.feed.pause(i), id);
      await sleep(2600); // churn from the setup drains
      const before = await measureTop(ctx.sw, tabId);
      await page.evaluate((i) => window.feed.play(i), id);
      const w = await waitMeasure(ctx.sw, tabId, (m) => !!(m && m.ok && m.rms < 0.1), 4000);
      ctx.note(`stopped hook ${before && before.ok ? before.rms.toFixed(3) : JSON.stringify(before)}, after play ${w.m ? "ducked " + w.elapsed + "ms" : JSON.stringify(w.last)}`);
      if (!w.m) return `BUG: the stopped hook's element plays at native level when it starts again (${JSON.stringify(w.last)})`;
      return true;
    } finally { await page.close(); }
  },

  // Arming a frame that still holds a hook at unity puts the level back on it at once: a clip
  // that keeps playing gives no play event to react to.
  async s69_arm_reapplies_level_to_held_hook(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      await page.evaluate(() => window.feed.addAudible());
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r = await swSetGain(ctx.sw, tabId, 0.05);
      if (r.mode !== "element" || !r.confirmed) return `setup failed: ${JSON.stringify(r)}`;
      await ctx.sw.evaluate((t) => toFrame(t, null, { cmd: "stop" }), tabId);
      const unity = await waitMeasure(ctx.sw, tabId, (m) => !!(m && m.ok && m.rms > 0.2), 3000);
      if (!unity.m) return `setup failed: the stop did not bring the hook to unity (${JSON.stringify(unity.last)})`;
      await ctx.sw.evaluate((t) => toFrame(t, 0, { cmd: "arm", gain: 0.05, useLimiter: true }), tabId);
      const w = await waitMeasure(ctx.sw, tabId, (m) => !!(m && m.ok && m.rms < 0.1), 2000);
      ctx.note(`after arm: ${w.m ? "ducked " + w.elapsed + "ms" : JSON.stringify(w.last)}`);
      if (!w.m) return `BUG: the armed frame leaves its held hook at unity (${JSON.stringify(w.last)})`;
      return true;
    } finally { await page.close(); }
  },

  // ---- the element a tab's level belongs on (select.js) ----
  // A feed page whose content player plays audibly from another origin without CORS: only
  // capture reaches it. An ad frame holds a hookable but MUTED blob video, off-screen, at 1x1 or
  // in view. A muted element never stands in for sounding media, so the verdict is capture and
  // nothing in the ad frame is hooked. Last variant: the decoy took the level while nothing
  // sounded (accepted: no rule can tell a decoy from a player then), and then the content
  // unmutes. The held decoy is still muted, so it does not stand in either.
  async s70_decoy_frame_never_wins(ctx) {
    for (const where of ["offscreen", "tiny", "visible"]) {
      const { page, inner } = await newDecoyPage(ctx.browser, ctx.port, `decoy=${where}&state=muted`);
      try {
        const tabId = await tabIdOf(ctx.sw, ctx.port);
        await captureSpyOn(ctx.sw);
        await swClearLog(ctx.sw);
        const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
        const res = await swSetGain(ctx.sw, tabId, 3);
        const calls = await captureCalls(ctx.sw);
        const log = await swSpyLog(ctx.sw);
        const decoyEngage = log.find((e) => e.cmd === "engage" && e.frameId !== 0 && e.res && e.res.ok);
        const hooked = await inner.evaluate(() => window.decoy.isHooked());
        ctx.note(`${where}: predict ${pm.mode}${pm.certain ? " certain" : ""}, setGain ${res.mode}, ${calls} capture attempt(s)`);
        if (pm.mode !== "capture" || !pm.certain) return `BUG (${where}): the muted decoy was predicted as the player: ${JSON.stringify(pm)}`;
        if (res.mode === "element") return `BUG (${where}): element mode on the decoy while the content plays at native level: ${JSON.stringify(res)}`;
        if (decoyEngage || hooked) return `BUG (${where}): the decoy in the ad frame was hooked`;
        if (calls < 1) return `BUG (${where}): no capture was tried for the sounding player no hook can take`;
        await swSetGain(ctx.sw, tabId, 1);
      } finally { await captureSpyOff(ctx.sw); await page.close(); }
    }
    const { page } = await newDecoyPage(ctx.browser, ctx.port, "decoy=visible&state=muted&content=muted");
    try {
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      await swClearLog(ctx.sw);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      const took = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.frameId !== 0 && e.res && e.res.ok);
      if (r1.mode !== "element" || !took) return `setup failed: the decoy did not take the level while nothing sounded (${JSON.stringify(r1)})`;
      await captureSpyOn(ctx.sw);
      await page.evaluate(() => { const v = document.getElementById("content"); v.muted = false; v.volume = 1; });
      await sleep(1000); // the unmute pings, its restore pass runs
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      const res = await swSetGain(ctx.sw, tabId, 4);
      const calls = await captureCalls(ctx.sw);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`held decoy: predict ${pm.mode}${pm.certain ? " certain" : ""}, setGain ${res.mode}, ${calls} capture attempt(s)`);
      if (pm.mode !== "capture" || !pm.certain) return `BUG: the held muted decoy stands in for the sounding content: ${JSON.stringify(pm)}`;
      if (res.mode === "element" || (mode && mode.mode === "element")) return `BUG: element mode stays on the held decoy (${JSON.stringify(res)}, record ${JSON.stringify(mode)})`;
      if (calls < 1) return "BUG: no capture was tried once the content sounded";
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, await tabIdOf(ctx.sw, ctx.port), 1).catch(() => {});
      await page.close();
    }
  },

  // An UNMUTED paused player in another frame, next to sounding content without CORS in the top
  // frame. Boxes from different frames are not comparable, so nothing ties that player to the
  // content: across frames only a player the top frame holds stands in, for an ad in a sub-frame,
  // and this one is held by nobody. Capture, certain, and nothing hooked. Last variant: the
  // player took the level while nothing sounded (the content was muted), so it is held, and then
  // the content unmutes. It sits in a sub-frame and has never played, so it does not stand in
  // either, and capture is tried.
  async s71_waiting_player_in_other_frame_no_stand_in(ctx) {
    for (const where of ["visible", "offscreen"]) {
      const { page, inner } = await newDecoyPage(ctx.browser, ctx.port, `decoy=${where}&state=ready`);
      try {
        const tabId = await tabIdOf(ctx.sw, ctx.port);
        await swClearLog(ctx.sw);
        const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
        const res = await swSetGain(ctx.sw, tabId, 3);
        const log = await swSpyLog(ctx.sw);
        const engaged = log.find((e) => e.cmd === "engage" && e.frameId !== 0 && e.res && e.res.ok);
        const hooked = await inner.evaluate(() => window.decoy.isHooked());
        ctx.note(`${where}: predict ${pm.mode}${pm.certain ? " certain" : ""}, setGain ${res.mode}, hooked ${hooked}`);
        if (pm.mode !== "capture" || !pm.certain) return `BUG (${where}): the player in the other frame stood in: ${JSON.stringify(pm)}`;
        if (res.mode === "element" || engaged || hooked) return `BUG (${where}): the player in the other frame was hooked (${JSON.stringify(res)})`;
        await swSetGain(ctx.sw, tabId, 1);
      } finally { await page.close(); }
    }
    const { page } = await newDecoyPage(ctx.browser, ctx.port, "decoy=offscreen&state=ready&content=muted");
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await swClearLog(ctx.sw);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      const took = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.frameId !== 0 && e.res && e.res.ok);
      if (r1.mode !== "element" || !took) return `setup failed: the player did not take the level while nothing sounded (${JSON.stringify(r1)})`;
      await captureSpyOn(ctx.sw);
      await page.evaluate(() => { const v = document.getElementById("content"); v.muted = false; v.volume = 1; });
      await sleep(1000); // the unmute pings, its restore pass runs
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const passCalls = await captureCalls(ctx.sw);
      const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      const res = await swSetGain(ctx.sw, tabId, 4);
      const calls = await captureCalls(ctx.sw);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`held: predict ${pm.mode}${pm.certain ? " certain" : ""}, setGain ${res.mode}, ${passCalls} capture attempt(s) in the pass, ${calls} in all`);
      if (pm.mode !== "capture" || !pm.certain) return `BUG (held): the held player in the ad frame stands in for the sounding content: ${JSON.stringify(pm)}`;
      if (res.mode === "element" || (mode && mode.mode === "element")) return `BUG (held): element mode stays on the ad frame (${JSON.stringify(res)}, record ${JSON.stringify(mode)})`;
      if (passCalls < 1) return "BUG (held): the restore pass did not try a capture once the content sounded";
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The other direction across frames: the player in a sub-frame holds the level and is paused,
  // and a clip without CORS sounds in the top frame. A sub-frame player is no player behind a
  // top-frame clip, so it does not stand in: capture, certain, and the restore pass tries it.
  async s71b_subframe_player_no_stand_in_for_top_clip(ctx) {
    const { page, inner } = await newFramedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const a = await inner.evaluate(() => window.feed.addAudible());
      await sleep(400);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await inner.evaluate((i) => window.feed.pause(i), a);
      await sleep(2600);
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      const src = await adSrc(page);
      await page.evaluate((s) => {
        const v = document.createElement("video");
        v.id = "clip"; v.src = s; v.loop = true;
        v.style.cssText = "width:560px;height:315px;display:block";
        document.body.appendChild(v);
        v.play().catch(() => {});
      }, src);
      await page.waitForFunction(() => { const v = document.getElementById("clip"); return !!v && !v.paused && v.readyState >= 2; }, { timeout: 5000 });
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the clip";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const calls = await captureCalls(ctx.sw);
      const mode = await swGetMode(ctx.sw, tabId);
      const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      ctx.note(`predict ${JSON.stringify(pm)}, mode ${JSON.stringify(mode)}, ${calls} capture attempt(s)`);
      if (pm.mode !== "capture" || !pm.certain) return `BUG: the sub-frame player stands in for the top-frame clip: ${JSON.stringify(pm)}`;
      if (mode && mode.mode === "element") return `BUG: element mode stays on the sub-frame player (${JSON.stringify(mode)})`;
      if (calls < 1) return "BUG: the restore pass did not try a capture for the sounding clip";
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A saved level arriving on the decoy page, with a popup waiting on the restore. The pass must
  // not settle on the decoy: the popup's own apply follows (a capture attempt) and no element
  // record is left behind.
  async s72_decoy_restore_answers_popup(ctx) {
    const host = "127.0.0.1";
    let page = null;
    try {
      await captureSpyOn(ctx.sw);
      await swSaveSite(ctx.sw, host, 3);
      ({ page } = await newDecoyPage(ctx.browser, ctx.port, "decoy=offscreen&state=muted"));
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const res = await Promise.race([ctx.sw.evaluate((t) => afterRestore(t), tabId), sleep(20000).then(() => "hung")]);
      const mode = await swGetMode(ctx.sw, tabId);
      const calls = await captureCalls(ctx.sw);
      ctx.note(`popup answer ${JSON.stringify(res)}, mode ${JSON.stringify(mode)}, ${calls} capture attempt(s)`);
      if (res === "hung") return "BUG: the popup's wait never ended";
      if (res.mode === "element") return `BUG: the popup is told element mode over the decoy: ${JSON.stringify(res)}`;
      if (mode && mode.mode === "element") return `BUG: an element record is left behind: ${JSON.stringify(mode)}`;
      if (calls < 1) return "BUG: nothing tried the capture the page needs";
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swForgetSite(ctx.sw, host);
      if (page) await page.close().catch(() => {});
    }
  },

  // The probe and the engage pick the same element. A muted clip without CORS that plays (an
  // animated image served as video) ranks above a paused hookable clip. The probe's choice is the
  // hookable clip, and the engage hooks that one instead of refusing the playing clip and sending
  // the tab to capture. Once the clip is unmuted and plays, the live graph carries it at the level.
  async s73_engage_takes_the_probes_choice(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const src = await adSrc(page);
      const gif = await page.evaluate((s) => window.feed.addSrc(s, { muted: true }), src);
      const clip = await page.evaluate(() => { const id = window.feed.add(); window.feed.pause(id); return id; });
      await page.waitForFunction((g) => { const v = document.getElementById(g); return v && !v.paused && v.readyState >= 2; }, { timeout: 5000 }, gif);
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      await swClearLog(ctx.sw);
      const res = await swSetGain(ctx.sw, tabId, 0.05);
      const log = await swSpyLog(ctx.sw);
      const refused = log.find((e) => e.cmd === "engage" && e.res && e.res.reason === "cross-origin-no-cors");
      if (refused) return "BUG: the engage took the playing clip the probe had passed over and refused it";
      if (res.mode !== "element") return `BUG: the tab fell to capture although a hookable clip exists: ${JSON.stringify(res)}`;
      await page.evaluate((i) => { window.feed.unmute(i); window.feed.play(i); }, clip);
      await sleep(900);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`setGain ${JSON.stringify(res)}, measure after play ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (!m || !m.ok || !m.signal) return `BUG: the hook is not on the clip (measure ${JSON.stringify(m)})`;
      if (m.rms > 0.1) return `BUG: the clip plays at rms ${m.rms.toFixed(3)}, not at the 0.05x level`;
      return true;
    } finally { await page.close(); }
  },

  // One frame: the hook sits on a muted loop (it was the only element when the level was set),
  // then a separate clip without CORS sounds. Boosting the loop changes nothing anyone hears, so
  // the loop does not keep the level as element mode: capture is tried, and the clip itself is
  // never hooked. The loop keeps its hook, and once unmuted it plays at the tab level.
  async s74_muted_holder_yields_to_unhookable(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const loop = await page.evaluate(() => window.feed.add());
      await sleep(400);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element") return `setup failed: ${JSON.stringify(r1)}`;
      await sleep(2600);
      await captureSpyOn(ctx.sw);
      const src = await adSrc(page);
      const clip = await page.evaluate((s) => window.feed.addSrc(s), src);
      await sleep(1000); // play ping, then its restore pass
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const mode = await swGetMode(ctx.sw, tabId);
      const calls = await captureCalls(ctx.sw);
      await page.evaluate((i) => window.feed.unmute(i), loop);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`mode ${JSON.stringify(mode)}, ${calls} capture attempt(s), loop unmuted ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (mode && mode.mode === "element") return `BUG: element mode stays on the muted loop while the clip plays at native level: ${JSON.stringify(mode)}`;
      if (calls < 1) return "BUG: no capture was tried for the sounding clip";
      if (!m || !m.ok || !m.signal) return `BUG: the loop lost its hook (measure ${JSON.stringify(m)})`;
      if (m.rms > 0.1) return `BUG: the unmuted loop plays at rms ${m.rms.toFixed(3)}, not at the tab's 0.05x`;
      if (await page.evaluate((i) => window.feed.isHooked(i), clip)) return "BUG: the clip without CORS was hooked (silenced for good)";
      return true;
    } finally { await captureSpyOff(ctx.sw); await page.close(); }
  },

  // The click pre-hook takes a video inside an open shadow root on a page that had no shadow DOM
  // before. A slider move afterwards must find that hook as held: element mode, no stop to the
  // frame, no capture, and the level lands on the shadow player, the one that sounds. The click
  // registers the root, so the collector reaches the video here (s75b covers a held element the
  // collector cannot reach).
  async s75_shadow_held_survives_setgain(ctx) {
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
      await sleep(600);
      const pre = await measureTop(ctx.sw, tabId);
      if (!pre || !pre.ok || !pre.signal) return `setup failed: the shadow player was not taken in-page (${JSON.stringify(pre)})`;
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      const r2 = await swSetGain(ctx.sw, tabId, 0.1);
      const stops = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "stop").length;
      const calls = await captureCalls(ctx.sw);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`setGain ${JSON.stringify(r2)}, ${stops} stop(s), ${calls} capture attempt(s), measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (r2.mode !== "element") return `BUG: the slider move left element mode: ${JSON.stringify(r2)}`;
      if (stops) return `BUG: the slider move sent ${stops} stop(s) to the frame`;
      if (calls) return `BUG: the slider move tried a capture (${calls})`;
      if (!m || !m.ok || !m.signal) return `BUG: the level left the sounding shadow player (measure ${JSON.stringify(m)})`;
      if (m.rms > 0.1) return `BUG: the shadow player plays at rms ${m.rms.toFixed(3)}, not at 0.1x`;
      return true;
    } finally { await captureSpyOff(ctx.sw); await page.close(); }
  },

  // The held element where the collector cannot reach it. The page moves the hooked clip into a
  // CLOSED root (the hook follows it there), then that root's host leaves the DOM and comes back
  // in a later task. The removal drops the root from the registry, and no walk can enter a closed
  // root to find it again. A slider move must still find the clip as held: element mode, no stop
  // to the frame, no capture, and the level lands on the clip.
  async s75b_closed_root_held_after_reattach(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => {
        const v = document.getElementById(i);
        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "closed" });
        document.getElementById("feed").appendChild(host);
        root.appendChild(v);
        v.play().catch(() => {});
        window.__closedHost = { host, v };
      }, a);
      await sleep(1500);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      const m0 = await measureTop(ctx.sw, tabId);
      // Taken out and put back in a later task. The removal pauses the clip, the page resumes it.
      await page.evaluate(() => {
        const c = window.__closedHost;
        c.host.remove();
        setTimeout(() => { document.getElementById("feed").appendChild(c.host); c.v.play().catch(() => {}); }, 50);
      });
      await sleep(1500);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      const m1 = await measureTop(ctx.sw, tabId);
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      const r2 = await swSetGain(ctx.sw, tabId, 0.1);
      const stops = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "stop").length;
      const calls = await captureCalls(ctx.sw);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`after the move ${fmtMeasure(m0)}, after the host came back ${fmtMeasure(m1)}, setGain ${JSON.stringify(r2)}, ${stops} stop(s), ${calls} capture attempt(s), measure ${fmtMeasure(m)}`);
      if (!m0 || !m0.ok || !m0.signal || m0.rms > 0.1) return `setup failed: the clip lost its level on the move (${fmtMeasure(m0)})`;
      if (!m1 || !m1.ok || !m1.signal || m1.rms > 0.1) return `BUG: the clip lost its level after its host came back (${fmtMeasure(m1)})`;
      if (r2.mode !== "element") return `BUG: the slider move left element mode: ${JSON.stringify(r2)}`;
      if (stops) return `BUG: the slider move sent ${stops} stop(s) to the frame`;
      if (calls) return `BUG: the slider move tried a capture (${calls})`;
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the level left the clip (${fmtMeasure(m)})`;
      return true;
    } finally { await captureSpyOff(ctx.sw); await page.close(); }
  },

  // An ad break where the player HIDES its content video (display:none, no box at all) and plays
  // an ad without CORS. The hidden player is the held one: it stands in, so the tab keeps element
  // mode, nothing is refused, no capture is tried. After the break the content plays at the level.
  async s76_hidden_content_during_ad_stands_in(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      const ad = await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true, hideContent: true }), main);
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the ad break";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const log = await swSpyLog(ctx.sw);
      const refused = log.find((e) => e.cmd === "engage" && e.res && e.res.ok === false);
      const calls = await captureCalls(ctx.sw);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`during the ad: mode ${JSON.stringify(mode)}, ${calls} capture attempt(s), refusal ${refused ? JSON.stringify(refused.res) : "none"}`);
      if (calls) return `BUG: the hidden content player did not stand in, capture was tried (${calls})`;
      if (refused) return `BUG: an engage was refused during the ad: ${JSON.stringify(refused.res)}`;
      if (!mode || mode.mode !== "element") return `BUG: the tab left element mode for the ad (${JSON.stringify(mode)})`;
      await page.evaluate((a, m) => window.feed.adEnd(a, m), ad, main);
      await sleep(700);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`after the ad: ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (!m || !m.ok || !m.signal) return `BUG: the content is not back on the hook after the ad (measure ${JSON.stringify(m)})`;
      if (m.rms > 0.1) return `BUG: the content plays at rms ${m.rms.toFixed(3)} after the ad, not at the 0.05x level`;
      return true;
    } finally { await captureSpyOff(ctx.sw); await page.close(); }
  },

  // A preroll: the ad without CORS plays over a content player that is loaded, unmuted and paused,
  // and holds no hook yet. The content stands in for the ad, but the user opens the popup because
  // the ad is loud: a slider move never settles on a stand-in and tries the capture that reaches
  // the ad (it fails here, no grant). After the break the content plays at the level in element
  // mode, through the restore pass its play signal starts.
  async s76b_preroll_slider_tries_capture(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addPaused());
      await sleep(300);
      const ad = await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true }), main);
      await page.waitForFunction((i) => { const v = document.getElementById(i); return !!v && !v.paused && v.readyState >= 2; }, { timeout: 5000 }, ad);
      await sleep(300);
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      if (pm.mode !== "element") return `setup failed: the paused content does not stand in for the ad (${JSON.stringify(pm)})`;
      const r = await swSetGain(ctx.sw, tabId, 0.05);
      const calls = await captureCalls(ctx.sw);
      ctx.note(`predict ${pm.mode}, setGain ${JSON.stringify(r)}, ${calls} capture attempt(s)`);
      if (r.mode === "element") return `BUG: the slider move settled on the content standing in for the loud ad (${JSON.stringify(r)})`;
      if (calls < 1) return "BUG: no capture was tried for the ad the user hears";
      await page.evaluate((a, m) => window.feed.adEnd(a, m), ad, main);
      const w = await waitMeasure(ctx.sw, tabId, (m) => !!(m && m.ok && m.signal && m.rms < 0.1), 5000);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`after the ad: ${w.m ? "rms " + w.m.rms.toFixed(3) + " after " + w.elapsed + "ms" : JSON.stringify(w.last)}, mode ${JSON.stringify(mode)}`);
      if (!w.m) return `BUG: the content does not play at the 0.05x level after the ad (last measure ${JSON.stringify(w.last)})`;
      if (!mode || mode.mode !== "element") return `BUG: the tab is not in element mode after the ad (${JSON.stringify(mode)})`;
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // An ad frame over the top frame's player: the top frame holds the content player, which has
  // played and is paused, and a sub-frame plays an ad without CORS. Across frames that is the one
  // direction in which the held player stands in: the restore pass keeps element mode on the top
  // frame and tries no capture. Second page: the same, but the top frame's player took the level
  // before it ever played (unmuted, paused). Nothing ties it to the ad then, and the pass tries
  // the capture.
  async s76c_ad_frame_over_top_player(ctx) {
    const adOn = (inner) => inner.evaluate((s) => window.decoy.playAd(s), `http://127.0.0.1:${ctx.port}/tone.wav`);
    const adPlays = (inner) => inner.waitForFunction(() => { const v = document.getElementById("decoy"); return !v.paused && v.readyState >= 2; }, { timeout: 5000 });
    let { page, inner } = await newDecoyPage(ctx.browser, ctx.port, "decoy=visible&state=muted&content=blob");
    let tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      const mode0 = await swGetMode(ctx.sw, tabId);
      if (r1.mode !== "element" || !r1.confirmed || !mode0 || mode0.frameId !== 0) return `setup failed: the top frame's player did not take the level (${JSON.stringify(r1)}, ${JSON.stringify(mode0)})`;
      await page.evaluate(() => document.getElementById("content").pause());
      await sleep(2600);
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      if (!(await adOn(inner))) return "setup failed: the ad in the sub-frame did not start";
      await adPlays(inner);
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the ad";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const calls = await captureCalls(ctx.sw);
      const refused = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.ok === false);
      const mode = await swGetMode(ctx.sw, tabId);
      const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      ctx.note(`played: predict ${JSON.stringify(pm)}, mode ${JSON.stringify(mode)}, ${calls} capture attempt(s)`);
      if (calls) return `BUG: the held top-frame player did not stand in for the ad frame, capture was tried (${calls})`;
      if (refused) return `BUG: an engage was refused during the ad: ${JSON.stringify(refused.res)}`;
      if (pm.mode !== "element" || pm.frameId !== 0) return `BUG: the probe does not name the top frame's player: ${JSON.stringify(pm)}`;
      if (!mode || mode.mode !== "element" || mode.frameId !== 0) return `BUG: the tab left element mode on the top frame (${JSON.stringify(mode)})`;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
    ({ page, inner } = await newDecoyPage(ctx.browser, ctx.port, "decoy=visible&state=muted&content=blobpaused"));
    tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      const mode0 = await swGetMode(ctx.sw, tabId);
      if (r1.mode !== "element" || !mode0 || mode0.frameId !== 0) return `setup failed (never played): the top frame's player did not take the level (${JSON.stringify(r1)}, ${JSON.stringify(mode0)})`;
      await sleep(1000);
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      if (!(await adOn(inner))) return "setup failed (never played): the ad in the sub-frame did not start";
      await adPlays(inner);
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed (never played): no restore pass looked at the ad";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const calls = await captureCalls(ctx.sw);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`never played: mode ${JSON.stringify(mode)}, ${calls} capture attempt(s)`);
      if (mode && mode.mode === "element") return `BUG: a held player that never played stands in for the ad frame (${JSON.stringify(mode)})`;
      if (calls < 1) return "BUG: no capture was tried for the ad no hook can take";
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A feed that mixes hookable blob clips with clips served from another origin without CORS.
  // Clip A was hooked and is paused, scrolled away. Clip B, unhookable, plays audibly in a post
  // of its own. A is not the player behind B (their boxes do not overlap), so it does not stand in:
  // the verdict is capture, for the restore pass and for a slider move alike, and B is never
  // hooked. A keeps its hook: scrolled back to, it plays at the tab level, never silent, never
  // at native level for good.
  async s77_separate_unhookable_clip_takes_capture(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      const b = await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true, separate: true }), a);
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the second clip";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const passCalls = await captureCalls(ctx.sw);
      const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      const res = await swSetGain(ctx.sw, tabId, 0.1);
      const calls = await captureCalls(ctx.sw);
      const log = await swSpyLog(ctx.sw);
      const toElement = log.find((e) => e.cmd === "engage" && e.res && e.res.ok);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`restore pass ${passCalls} capture attempt(s), predict ${pm.mode}${pm.certain ? " certain" : ""}, setGain ${res.mode}, ${calls} attempt(s) in all`);
      if (pm.mode !== "capture" || !pm.certain) return `BUG: clip A stands in for clip B: ${JSON.stringify(pm)}`;
      if (res.mode === "element" || toElement || (mode && mode.mode === "element")) return `BUG: element mode for clip A while clip B plays at native level (${JSON.stringify(res)})`;
      if (passCalls < 1 || calls < 2) return `BUG: capture was not tried for clip B (restore pass ${passCalls}, in all ${calls})`;
      // scrolled back: B pauses, A plays again
      await swClearLog(ctx.sw);
      await page.evaluate((x, y) => { window.feed.pause(y); window.feed.play(x); }, a, b);
      const w = await waitMeasure(ctx.sw, tabId, (m) => !!(m && m.ok && m.signal && m.rms < 0.1), 5000);
      const lost = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.reason === "own-hook-lost");
      ctx.note(`clip A again: ${w.m ? "at the level after " + w.elapsed + "ms" : JSON.stringify(w.last)}`);
      if (lost) return "BUG: clip A's hook was lost, it plays silent";
      if (!w.m) return `BUG: clip A does not play at the tab level again (last measure ${JSON.stringify(w.last)})`;
      if (await page.evaluate((i) => window.feed.isHooked(i), b)) return "BUG: clip B, without CORS, was hooked (silenced for good)";
      return true;
    } finally { await captureSpyOff(ctx.sw); await page.close(); }
  },

  // An article's "listen" player: a hookable <audio> without controls, which never has a box. It
  // holds the level and is paused, and the site's own video without CORS sounds in a post of its
  // own. A missing box says nothing about an <audio> element, so it does not stand in for the
  // video: capture, certain, and the restore pass tries it.
  async s77b_held_audio_no_stand_in(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await page.evaluate(async () => {
        const a = document.createElement("audio");
        a.id = "listen"; a.loop = true;
        a.src = URL.createObjectURL(await (await fetch("/tone.wav")).blob());
        document.body.appendChild(a);
        await a.play();
      });
      await sleep(400);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate(() => document.getElementById("listen").pause());
      await sleep(2600);
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      const vid = await page.evaluate((s) => window.feed.addSrc(s), await adSrc(page));
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the video";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const calls = await captureCalls(ctx.sw);
      const mode = await swGetMode(ctx.sw, tabId);
      const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      ctx.note(`predict ${JSON.stringify(pm)}, mode ${JSON.stringify(mode)}, ${calls} capture attempt(s)`);
      if (pm.mode !== "capture" || !pm.certain) return `BUG: the held <audio> stands in for the video: ${JSON.stringify(pm)}`;
      if (mode && mode.mode === "element") return `BUG: element mode stays on the paused <audio> while the video plays at native level (${JSON.stringify(mode)})`;
      if (calls < 1) return "BUG: the restore pass did not try a capture for the video";
      if (await page.evaluate((i) => window.feed.isHooked(i), vid)) return "BUG: the video without CORS was hooked (silenced for good)";
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A hidden video that never played (a player preloading the next episode, display:none) took
  // the level while nothing sounded. A separate clip without CORS then sounds. A held video
  // without a box stands in only once it has played, as a content player hidden for an ad has:
  // this one has not, so the verdict is capture and the restore pass tries it.
  async s77c_hidden_unplayed_holder_no_stand_in(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await page.evaluate(() => { const id = window.feed.addPaused(); document.getElementById(id).style.display = "none"; });
      await sleep(400);
      await swClearLog(ctx.sw);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      const took = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.ok);
      if (r1.mode !== "element" || !took) return `setup failed: the hidden video did not take the level (${JSON.stringify(r1)})`;
      await sleep(2600);
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      const clip = await page.evaluate((s) => window.feed.addSrc(s), await adSrc(page));
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the clip";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const calls = await captureCalls(ctx.sw);
      const mode = await swGetMode(ctx.sw, tabId);
      const pm = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      ctx.note(`predict ${JSON.stringify(pm)}, mode ${JSON.stringify(mode)}, ${calls} capture attempt(s)`);
      if (pm.mode !== "capture" || !pm.certain) return `BUG: the hidden video that never played stands in for the clip: ${JSON.stringify(pm)}`;
      if (mode && mode.mode === "element") return `BUG: element mode stays on the hidden video (${JSON.stringify(mode)})`;
      if (calls < 1) return "BUG: the restore pass did not try a capture for the clip";
      if (await page.evaluate((i) => window.feed.isHooked(i), clip)) return "BUG: the clip without CORS was hooked (silenced for good)";
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The sticky capture on a mixed feed. A capture holds the tab (the harness has no capture
  // grant, so the engine's update ack and the active list stand in for a live capture, as in
  // s65 and s66), and the page has sounded a clip without CORS (B, paused since, still in the DOM).
  // Then a hookable blob clip C plays audibly. The restore pass keeps the capture: no engage, no
  // element record, no capture stop. A slider move while no mode is recorded keeps it too. Then
  // without heard unhookable media (B and C gone, and the worker's note of B more than two
  // minutes old, see s100): a hookable clip moves the tab to element mode, as it does for a
  // hookable player after a "next episode" swap.
  async s78_sticky_capture_on_mixed_feed(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    const holdCapture = () => ctx.sw.evaluate(async (t) => {
      await sset(TABGAIN(t), 0.05);
      await setMode(t, { mode: "capture", conflict: false });
      await markActive(t);
    }, tabId);
    try {
      await ctx.sw.evaluate(async (t) => {
        await ensureContentScript(t);
        await ensureOffscreen();
        const st = globalThis.__s78 = { origSend: chrome.runtime.sendMessage.bind(chrome.runtime), stops: 0 };
        chrome.runtime.sendMessage = (m, ...rest) => {
          if (m && m.target === "offscreen" && m.tabId === t) {
            if (m.cmd === "update") return Promise.resolve({ ok: true });
            if (m.cmd === "stop") st.stops++;
          }
          return st.origSend(m, ...rest);
        };
      }, tabId);
      const b = await page.evaluate((s) => window.feed.addSrc(s), await adSrc(page));
      await page.waitForFunction((i) => { const v = document.getElementById(i); return v && !v.paused && v.readyState >= 2; }, { timeout: 5000 }, b);
      await sleep(300);
      await page.evaluate((i) => window.feed.pause(i), b);
      await sleep(2600); // its pings drain while the tab has no level
      await holdCapture();
      await swClearSpy(ctx.sw);
      const c = await page.evaluate(() => window.feed.addAudible());
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the hookable clip";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      let log = await swSpyLog(ctx.sw);
      let engages = log.filter((e) => e.cmd === "engage");
      let mode = await swGetMode(ctx.sw, tabId);
      const stops = await ctx.sw.evaluate(() => globalThis.__s78.stops);
      ctx.note(`with B heard: ${engages.length} engage(s), mode ${JSON.stringify(mode)}, ${stops} capture stop(s)`);
      if (engages.length) return `BUG: the restore engaged clip C and moved the tab off the capture (${JSON.stringify(engages.map((e) => e.res))})`;
      if (!mode || mode.mode !== "capture") return `BUG: the capture record is gone (${JSON.stringify(mode)})`;
      if (stops) return `BUG: the capture was stopped (${stops})`;
      // a slider move right after a pass cleared the mode
      await ctx.sw.evaluate((t) => clearMode(t), tabId);
      await swClearLog(ctx.sw);
      const r = await swSetGain(ctx.sw, tabId, 0.1);
      engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage");
      ctx.note(`slider move: ${JSON.stringify(r)}, ${engages.length} engage(s)`);
      if (r.mode !== "capture" || engages.length) return `BUG: the slider move took the tab off the capture (${JSON.stringify(r)})`;
      // without heard unhookable media
      await page.evaluate((x, y) => { window.feed.remove(x); window.feed.remove(y); }, b, c);
      await sleep(2600);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      await ctx.sw.evaluate(async (t) => { const h = await sget(TABHEARD(t)); if (h) await sset(TABHEARD(t), { ...h, at: Date.now() - 130000 }); }, tabId);
      await holdCapture();
      await swClearSpy(ctx.sw);
      await page.evaluate(() => window.feed.addAudible());
      const { hit } = await waitEngage(ctx.sw, (x) => x.ok === true, 6000);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`without: engage ${hit ? JSON.stringify(hit.res) : "none"}, mode ${JSON.stringify(mode)}`);
      if (!hit || !mode || mode.mode !== "element") return `BUG: without heard unhookable media the hookable clip did not move the tab to element mode (mode ${JSON.stringify(mode)})`;
      return true;
    } finally {
      await ctx.sw.evaluate(() => {
        const st = globalThis.__s78;
        if (!st) return;
        chrome.runtime.sendMessage = st.origSend;
        delete globalThis.__s78;
      });
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A live-stream ad break: the content keeps playing MUTED under an ad without CORS laid over it.
  // A muted player never stands in, so the restore pass captures the ad (stubbed live). The ad
  // then pauses and stays in the page, and the content unmutes. An ad laid over the content player
  // never keeps the tab in capture: the next restore pass moves the tab back to element mode, with
  // the content at the level.
  async s78b_overlay_ad_does_not_keep_capture(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await stubCapture(ctx.sw, tabId);
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await sleep(2600);
      await page.evaluate((m) => { document.getElementById(m).muted = true; }, main);
      const ad = await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true }), main);
      await page.evaluate((m) => window.feed.play(m), main);
      await sleep(1500);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const during = await swGetMode(ctx.sw, tabId);
      if (!during || during.mode !== "capture") return `setup failed: the ad break did not start the capture (${JSON.stringify(during)})`;
      await swClearLog(ctx.sw);
      await page.evaluate((a, m) => { window.feed.pause(a); const v = document.getElementById(m); v.muted = false; v.volume = 1; }, ad, main);
      const { hit } = await waitEngage(ctx.sw, (x) => x.ok === true, 6000);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const after = await swGetMode(ctx.sw, tabId);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`during the ad ${JSON.stringify(during)}, after it ${JSON.stringify(after)}, measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (!hit || !after || after.mode !== "element") return `BUG: the paused ad over the content keeps the tab in capture after the break (mode ${JSON.stringify(after)})`;
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the content does not play at the 0.05x level after the break (measure ${JSON.stringify(m)})`;
      return true;
    } finally {
      await unstubCapture(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A postroll: the ad without CORS plays over content that has ended, which waits for nothing,
  // so the restore pass captures the ad (stubbed live). Then the ad pauses and stays, and the
  // player starts the next video in the same element: the tab moves back to element mode.
  async s78c_postroll_then_next_video(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await stubCapture(ctx.sw, tabId);
      const main = await page.evaluate(() => { const id = window.feed.addAudible(); document.getElementById(id).loop = false; return id; });
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element") return `setup failed: ${JSON.stringify(r1)}`;
      await page.waitForFunction((i) => document.getElementById(i).ended, { timeout: 6000 }, main);
      await sleep(1000);
      const ad = await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true }), main);
      await sleep(1500);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const during = await swGetMode(ctx.sw, tabId);
      if (!during || during.mode !== "capture") return `setup failed: the postroll did not start the capture (${JSON.stringify(during)})`;
      await swClearLog(ctx.sw);
      await page.evaluate((a, m) => { window.feed.pause(a); const v = document.getElementById(m); v.loop = true; v.currentTime = 0; v.play(); }, ad, main);
      const { hit } = await waitEngage(ctx.sw, (x) => x.ok === true, 6000);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const after = await swGetMode(ctx.sw, tabId);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`postroll ${JSON.stringify(during)}, next video ${JSON.stringify(after)}, measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (!hit || !after || after.mode !== "element") return `BUG: the paused postroll keeps the tab in capture for the next video (mode ${JSON.stringify(after)})`;
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the next video does not play at the 0.05x level (measure ${JSON.stringify(m)})`;
      return true;
    } finally {
      await unstubCapture(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The sticky capture keeps the flags of the mode it keeps, and yields where no capture runs. A
  // capture holds the tab with the conflict flag (the popup explains the conflict there), a clip
  // without CORS sounded in a post of its own, and a hookable clip plays. A restore pass keeps the
  // capture and its flag. So does a slider move while a pass runs (no mode recorded then), with
  // the flags of the mode that pass started from. Then the user prefers fullscreen (the popup's
  // toggle): no capture runs for them, so the hookable clip takes the level in element mode
  // instead of the tab pausing with the clip at native level.
  async s78d_sticky_capture_flags_and_fullscreen(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await stubCapture(ctx.sw, tabId);
      await soundedClip(ctx.sw, page, tabId);
      await sleep(2600); // its pings drain while the tab has no level
      await recordCapture(ctx.sw, tabId, 0.05, true);
      await swClearSpy(ctx.sw);
      await page.evaluate(() => window.feed.addAudible());
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the hookable clip";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`restore pass: ${engages} engage(s), mode ${JSON.stringify(mode)}`);
      if (engages || !mode || mode.mode !== "capture") return `setup failed: the restore pass did not keep the capture (${engages} engages, ${JSON.stringify(mode)})`;
      if (!mode.conflict) return `BUG: the restore pass dropped the conflict flag of the capture it keeps (${JSON.stringify(mode)})`;
      const mid = await ctx.sw.evaluate(async (t) => {
        restoring.set(t, { mode: "capture", conflict: true });
        try { await clearMode(t); return await serialized(t, () => setGain(t, 0.1, true)); }
        finally { restoring.delete(t); pendingRekick.delete(t); }
      }, tabId);
      ctx.note(`slider move during a pass: ${JSON.stringify(mid)}`);
      if (mid.mode !== "capture") return `setup failed: the slider move during a pass left the capture (${JSON.stringify(mid)})`;
      if (!mid.conflict) return `BUG: the slider move during a pass dropped the conflict flag (${JSON.stringify(mid)})`;
      await recordCapture(ctx.sw, tabId, 0.1, true);
      await swClearLog(ctx.sw);
      const pref = await ctx.sw.evaluate((t) => serialized(t, async () => {
        await sset(TABFS(t), true);
        await clearMode(t);
        return setGain(t, 0.1, true);
      }), tabId);
      ctx.note(`prefer fullscreen: ${JSON.stringify(pref)}`);
      if (pref.mode !== "element") return `BUG: with fullscreen preferred the hookable clip does not get the level in element mode (${JSON.stringify(pref)})`;
      return true;
    } finally {
      await ctx.sw.evaluate((t) => sdel(TABFS(t)), tabId).catch(() => {});
      await unstubCapture(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The sticky capture keeps only a capture that goes on. The active list names the tab, but the
  // engine holds no graph for it (a lost trackEnded) and the harness has no grant for a new one.
  // A clip without CORS sounded in a post of its own, and a hookable clip plays. The restore pass
  // tries the capture, and when it fails the hookable clip gets the level in element mode in the
  // same pass, instead of playing at native level until the next signal.
  async s78e_sticky_capture_falls_through(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await soundedClip(ctx.sw, page, tabId);
      await sleep(2600);
      await ctx.sw.evaluate(async (t) => { await ensureOffscreen(); await sset(TABGAIN(t), 0.05); await markActive(t); }, tabId);
      await captureSpyOn(ctx.sw);
      await swClearSpy(ctx.sw);
      await page.evaluate(() => window.feed.addAudible());
      const { hit } = await waitEngage(ctx.sw, (x) => x.ok === true, 6000);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const calls = await captureCalls(ctx.sw);
      const mode = await swGetMode(ctx.sw, tabId);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`${calls} capture attempt(s), engage ${hit ? JSON.stringify(hit.res) : "none"}, mode ${JSON.stringify(mode)}, measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (calls < 1) return "setup failed: the pass did not try to keep the capture";
      if (!hit || !mode || mode.mode !== "element") return `BUG: the failed capture left the hookable clip without the level (mode ${JSON.stringify(mode)})`;
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the hookable clip does not play at the 0.05x level (measure ${JSON.stringify(m)})`;
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A long feed: more media elements in one frame than a probe report carries (32). The report
  // keeps what the rule decides around, wherever it ranks. First page: a clip without CORS that
  // sounded and is paused ranks below 40 muted autoplay posts, a capture holds the tab (stubbed),
  // and a hookable clip plays: the heard clip is still reported, so the capture keeps the tab.
  // Second page: the held content player, paused below 40 muted autoplay posts, with an ad without
  // CORS laid over it: the held player is still reported and stands in, so no capture is tried.
  async s78f_long_feed_report_keeps_what_decides(ctx) {
    let page = await newFeedPage(ctx.browser, ctx.port);
    let tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await stubCapture(ctx.sw, tabId);
      await soundedClip(ctx.sw, page, tabId);
      await page.evaluate(() => { for (let i = 0; i < 40; i++) window.feed.add(); });
      await sleep(2600);
      await recordCapture(ctx.sw, tabId, 0.05);
      await swClearSpy(ctx.sw);
      await page.evaluate(() => window.feed.addAudible());
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the hookable clip";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`heard clip below the cap: ${engages} engage(s), mode ${JSON.stringify(mode)}`);
      if (engages || !mode || mode.mode !== "capture") return `BUG: the heard clip fell off the report and the hookable clip moved the tab off the capture (${engages} engages, ${JSON.stringify(mode)})`;
    } finally {
      await unstubCapture(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
    page = await newFeedPage(ctx.browser, ctx.port);
    tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate(() => { for (let i = 0; i < 40; i++) window.feed.add(); });
      await sleep(2600);
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true }), main);
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the ad";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const calls = await captureCalls(ctx.sw);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`held player below the cap: mode ${JSON.stringify(mode)}, ${calls} capture attempt(s)`);
      if (calls) return `BUG: the held player fell off the report and did not stand in for the ad, capture was tried (${calls})`;
      if (!mode || mode.mode !== "element") return `BUG: the tab left element mode for the ad (${JSON.stringify(mode)})`;
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // What counts as heard. First page: a clip without CORS that never played gets volume writes
  // (an ad SDK setting up its element) while a capture holds the tab (stubbed) and a hookable clip
  // plays. Nothing about that clip ever sounded, so the hookable clip moves the tab to element
  // mode. Second page: a clip without CORS that did sound counts for two minutes. Within them the
  // capture keeps the tab. Once two minutes have passed in the frame's clock and since the
  // worker's note of the clip (s100), the next pass moves the tab to element mode. The frame reads
  // its clock through performance.now in its isolated world, which the harness can reach, and the
  // note is moved back two minutes, so the two minutes pass at once.
  async s78g_heard_means_sounded_lately(ctx) {
    let page = await newFeedPage(ctx.browser, ctx.port);
    let tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await stubCapture(ctx.sw, tabId);
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      const quiet = await page.evaluate((s) => window.feed.addSrc(s, { paused: true }), await adSrc(page));
      await page.evaluate((i) => { const v = document.getElementById(i); for (let k = 0; k < 4; k++) v.volume = 0.5 + k / 10; }, quiet);
      await sleep(2600);
      await recordCapture(ctx.sw, tabId, 0.05);
      await swClearSpy(ctx.sw);
      await page.evaluate(() => window.feed.addAudible());
      const { hit } = await waitEngage(ctx.sw, (x) => x.ok === true, 6000);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`volume writes only: mode ${JSON.stringify(mode)}`);
      if (!hit || !mode || mode.mode !== "element") return `BUG: volume writes on a clip that never played keep the tab in capture (mode ${JSON.stringify(mode)})`;
    } finally {
      await unstubCapture(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
    page = await newFeedPage(ctx.browser, ctx.port);
    tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await stubCapture(ctx.sw, tabId);
      await soundedClip(ctx.sw, page, tabId);
      await sleep(2600);
      await recordCapture(ctx.sw, tabId, 0.05);
      await swClearSpy(ctx.sw);
      await page.evaluate(() => window.feed.addAudible());
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the hookable clip";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      let engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
      let mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`heard lately: ${engages} engage(s), mode ${JSON.stringify(mode)}`);
      if (engages || !mode || mode.mode !== "capture") return `setup failed: the capture did not keep the tab while the clip counts as heard (${engages} engages, ${JSON.stringify(mode)})`;
      await asContentScript(ctx.sw, tabId, () => {
        const now = performance.now.bind(performance);
        performance.now = () => now() + 130000;
        return true;
      });
      await ctx.sw.evaluate(async (t) => { const h = await sget(TABHEARD(t)); if (h) await sset(TABHEARD(t), { ...h, at: Date.now() - 130000 }); }, tabId);
      await swClearSpy(ctx.sw);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage" && e.res && e.res.ok).length;
      mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`two minutes later: ${engages} engage(s), mode ${JSON.stringify(mode)}`);
      if (!engages || !mode || mode.mode !== "element") return `BUG: a clip that sounded more than two minutes ago still keeps the tab in capture (mode ${JSON.stringify(mode)})`;
      return true;
    } finally {
      await unstubCapture(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A refusal names what decided it, never an unrelated element. The worker's engage goes to the
  // frame directly. (a) Nothing sounds and nothing is safe: a paused DRM player, ranked below an
  // unmuted paused clip without CORS (which waits, and could still become hookable): drm. (b) A
  // sounding clip without CORS that interrupts nothing (a muted clip never stands in):
  // cross-origin-no-cors. (c) Only a muted, paused clip without CORS: nothing plays and nothing
  // rules a hook out for good, so there is simply no element: no-element. (d) The muted clip of
  // (b), paused under an ad without CORS laid over it: a muted player never stands in, not even
  // under the ad, so again cross-origin-no-cors, and nothing is hooked.
  async s79_refusal_reason_names_what_plays(ctx) {
    const engageTop = (tabId) => ctx.sw.evaluate(async (t) => {
      await ensureContentScript(t);
      return chrome.tabs.sendMessage(t, { cmd: "engage", gain: 3, useLimiter: true }, { frameId: 0 });
    }, tabId);
    let page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const drm = await page.evaluate(() => window.feed.addAudible());
      if (!(await page.evaluate((i) => window.feed.makeDrm(i), drm))) return "setup failed: the fixture could not attach MediaKeys";
      await page.evaluate((i) => { const v = document.getElementById(i); v.pause(); v.muted = true; }, drm);
      await page.evaluate((s) => window.feed.addSrc(s, { paused: true }), await adSrc(page));
      await sleep(400);
      const r = await engageTop(await tabIdOf(ctx.sw, ctx.port));
      ctx.note(`(a) ${JSON.stringify(r)}`);
      if (!r || r.ok || r.reason !== "drm") return `BUG (a): the refusal does not name the DRM player: ${JSON.stringify(r)}`;
    } finally { await page.close(); }
    page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const muted = await page.evaluate(() => { const id = window.feed.add(); window.feed.pause(id); return id; });
      const loud = await page.evaluate((s) => window.feed.addSrc(s), await adSrc(page));
      await page.waitForFunction((i) => { const v = document.getElementById(i); return v && !v.paused && v.readyState >= 2; }, { timeout: 5000 }, loud);
      await sleep(300);
      const r = await engageTop(await tabIdOf(ctx.sw, ctx.port));
      ctx.note(`(b) ${JSON.stringify(r)}`);
      if (!r || r.ok || r.reason !== "cross-origin-no-cors") return `BUG (b): ${JSON.stringify(r)}`;
      if (await page.evaluate((i) => window.feed.isHooked(i), muted)) return "BUG (b): the muted clip stood in and was hooked";
    } finally { await page.close(); }
    page = await newFeedPage(ctx.browser, ctx.port);
    try {
      await page.evaluate((s) => window.feed.addSrc(s, { muted: true, paused: true }), await adSrc(page));
      await sleep(400);
      const r = await engageTop(await tabIdOf(ctx.sw, ctx.port));
      ctx.note(`(c) ${JSON.stringify(r)}`);
      if (!r || r.ok || r.reason !== "no-element") return `BUG (c): ${JSON.stringify(r)}`;
    } finally { await page.close(); }
    page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const muted = await page.evaluate(() => { const id = window.feed.add(); window.feed.pause(id); return id; });
      const ad = await page.evaluate((m) => window.feed.adStart(m, { crossOrigin: true }), muted);
      await page.waitForFunction((i) => { const v = document.getElementById(i); return v && !v.paused && v.readyState >= 2; }, { timeout: 5000 }, ad);
      await sleep(300);
      const r = await engageTop(await tabIdOf(ctx.sw, ctx.port));
      ctx.note(`(d) ${JSON.stringify(r)}`);
      if (!r || r.ok || r.reason !== "cross-origin-no-cors") return `BUG (d): ${JSON.stringify(r)}`;
      if (await page.evaluate((i) => window.feed.isHooked(i), muted)) return "BUG (d): the muted clip under the ad stood in and was hooked";
    } finally { await page.close(); }
    return true;
  },

  // Candidate reports from a page context. The content script's world can be written by a page
  // that has broken into its renderer, so whatever it sends as a report, the probe must still
  // settle and decide only from validated fields. Sent here from the extension's isolated world
  // in reply to every probe: junk entries, an entry with an unknown reason that claims to be safe
  // and sounding, oversized and non-array payloads. The page itself has no media. Second page: a
  // sub-frame reports one valid, sounding, hookable candidate that claims to come from the top
  // frame. The frame a candidate counts for is the one that sent it.
  async s79b_malformed_candidates_contained(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      await asContentScript(ctx.sw, tabId, () => {
        const forged = { safe: "yes", reason: "made-up", playing: 1, audible: 1, area: 1e12, rect: { x: "a", y: null, w: Infinity, h: -5 }, frame: 777 };
        const junk = [
          null, "junk", 7,
          { safe: false, reason: "cross-origin-no-cors", playing: true, audible: true, area: 5000, rect: null },
          { safe: true, reason: "blob", playing: false, audible: true, area: 5000, rect: null, held: "yes" },
          forged,
        ];
        const send = (m) => { try { chrome.runtime.sendMessage(m).catch(() => {}); } catch (_) {} };
        chrome.runtime.onMessage.addListener((m) => {
          if (!m || m.cmd !== "probe") return;
          send({ type: "frameCandidates", cands: junk });
          send({ type: "frameCandidates", cands: new Array(5000).fill(forged) });
          send({ type: "frameCandidates", cands: { length: 1e9 } });
        });
        return true;
      });
      const res = await Promise.race([ctx.sw.evaluate((t) => predictMode(t), tabId), sleep(4000).then(() => "hung")]);
      ctx.note(`junk: probe ${JSON.stringify(res)}`);
      if (res === "hung") return "BUG: a malformed report wedged the probe, it never settled";
      if (res.mode !== "capture") return `BUG: a forged report with an unknown reason was taken as a safe player: ${JSON.stringify(res)}`;
    } finally { await page.close(); }
    const { page: host } = await newFramedPage(ctx.browser, ctx.port);
    try {
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      const inner = await frameIdOf(ctx.sw, tabId, "x-feed.html");
      if (inner == null || inner === 0) return `setup failed: no sub-frame id (${inner})`;
      await asContentScript(ctx.sw, tabId, () => {
        const claim = { safe: true, reason: "blob", playing: true, ended: false, audible: true, area: 5000, rect: { x: 0, y: 0, w: 100, h: 50 }, held: false, heard: true, played: true, video: true, frame: 0 };
        chrome.runtime.onMessage.addListener((m) => {
          if (!m || m.cmd !== "probe") return;
          try { chrome.runtime.sendMessage({ type: "frameCandidates", cands: [claim] }).catch(() => {}); } catch (_) {}
        });
        return true;
      }, [], [inner]);
      const res = await Promise.race([ctx.sw.evaluate((t) => predictMode(t), tabId), sleep(4000).then(() => "hung")]);
      ctx.note(`sub-frame ${inner} claiming frame 0: probe ${JSON.stringify(res)}`);
      if (res === "hung") return "BUG: the sub-frame's report wedged the probe";
      if (res.mode !== "element" || res.frameId !== inner) return `BUG: the candidate does not count for the frame that sent it (${inner}): ${JSON.stringify(res)}`;
      return true;
    } finally { await host.close(); }
  },

  // A page element with id "vbSelect" shows up on window as vbSelect (named access), in the
  // extension's isolated world as well. It must neither pass for the selection rule nor keep the
  // rule from being defined: element mode works on such a page as on any other.
  async s79c_page_element_named_vbselect(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      // before any script of the extension runs in this document
      await page.evaluate(() => { const d = document.createElement("div"); d.id = "vbSelect"; document.body.appendChild(d); });
      await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const res = await swSetGain(ctx.sw, tabId, 3);
      ctx.note(`setGain ${JSON.stringify(res)}`);
      if (res.mode !== "element" || !res.confirmed) return `BUG: element mode fails on a page with an element named vbSelect: ${JSON.stringify(res)}`;
      return true;
    } finally { await page.close(); }
  },

  // An ad laid over the paused, held content player, from a same-origin URL that redirects to
  // another origin, with a redirect check that answers late (/redir-slow.wav). A restore pass's
  // probe finds the verdict still open and names the ad. The engage waits for the verdict before
  // it tears anything down: the ad turns out unhookable, so the held content stands in for it.
  // The content stays the live graph (nothing parked), the tab stays in element mode, and nothing
  // is refused or captured.
  async s79d_overlay_redirect_ad_stands_in(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await sleep(2600);
      const m0 = await measureTop(ctx.sw, tabId);
      if (!m0 || !m0.ok) return `setup failed: no live graph (${JSON.stringify(m0)})`;
      await captureSpyOn(ctx.sw);
      await swClearLog(ctx.sw);
      const ad = await page.evaluate((m) => window.feed.adStart(m, { src: "/redir-slow.wav" }), main);
      if (!(await waitProbe(ctx.sw, 5000))) return "setup failed: no restore pass looked at the ad";
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const log = await swSpyLog(ctx.sw);
      const refused = log.filter((e) => e.cmd === "engage" && e.res && e.res.ok === false).map((e) => e.res.reason);
      const calls = await captureCalls(ctx.sw);
      const mode = await swGetMode(ctx.sw, tabId);
      const m1 = await measureTop(ctx.sw, tabId);
      ctx.note(`refusals ${JSON.stringify(refused)}, ${calls} capture attempt(s), mode ${JSON.stringify(mode)}, parked ${m0.parked} -> ${m1 && m1.parked}`);
      if (refused.length) return `BUG: an engage was refused during the ad: ${JSON.stringify(refused)}`;
      if (calls) return `BUG: the held content did not stand in for the redirecting ad, capture was tried (${calls})`;
      if (!mode || mode.mode !== "element" || mode.frameId !== 0) return `BUG: the tab left element mode on the content (${JSON.stringify(mode)})`;
      if (!m1 || !m1.ok || m1.parked !== m0.parked) return `BUG: the content's hook was given up for the redirecting ad (measure ${JSON.stringify(m1)}, parked before ${m0.parked})`;
      if (await page.evaluate((i) => window.feed.isHooked(i), ad)) return "BUG: the redirecting ad was hooked (silenced for good)";
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // ---- players inside open shadow roots (shadow-feed.html, modelled on the Reddit feed) ----
  // Every clip sits in its player's open root and media events never reach the document, so none
  // of these can pass through the document listeners (s80 and s81 check that the fixture keeps
  // its events inside: docMediaEvents).

  // The probe has to find a player that only exists inside a root, and setGain has to hook it.
  async s80_shadow_probe_finds_player(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await waitClipPlaying(page, a);
      await sleep(300);
      const tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
      const res = await swSetGain(ctx.sw, tabId, 3);
      const doc = await page.evaluate(() => window.docMediaEvents);
      ctx.note(`setGain ${JSON.stringify(res)}`);
      if (doc) return `fixture broken: ${doc} media events reached the document`;
      if (await page.evaluate(() => window.feed.lightMediaCount())) return "fixture broken: media in the light DOM";
      if (res.mode !== "element" || !res.confirmed) return `BUG: the shadow-root player was not hooked: ${JSON.stringify(res)}`;
      return true;
    } finally { await page.close(); }
  },

  // A page with no shadow DOM until its player arrives (?shell=0), and a level on the tab from a
  // light clip that has left the page. A defined player inside a light wrapper starts with no
  // click. The frame's observer checks the wrapper the cheap way and cannot see the root, so only
  // a full walk finds it. A slider move must put the level on it in element mode. The worker's
  // restore passes are dropped for the tab, so no probe walks the page first: the slider move's
  // engage finds the walk due and waits for it.
  async s80b_noshell_slider_finds_wrapped_player(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?shell=0");
    let tabId = null;
    try {
      const s = await armWithLightClip(ctx, page);
      if (typeof s === "string") return s;
      tabId = s.tabId;
      await ctx.sw.evaluate((t) => {
        globalThis.__s80b = { origKick: kickRestore };
        kickRestore = (id, d) => (id === t ? Promise.resolve() : globalThis.__s80b.origKick(id, d));
      }, tabId);
      await page.evaluate(() => document.getElementById("light").remove());
      const id = await page.evaluate(() => window.feed.add({ muted: false }));
      await waitClipPlaying(page, id);
      await sleep(600);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      const r = await swSetGain(ctx.sw, tabId, 0.1);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`setGain ${JSON.stringify(r)}, measure ${fmtMeasure(m)}`);
      if (r.mode !== "element") return `BUG: the slider move did not find the player (${JSON.stringify(r)})`;
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the level is not on the player (${fmtMeasure(m)})`;
      return true;
    } finally {
      await ctx.sw.evaluate((t) => {
        if (!globalThis.__s80b) return;
        kickRestore = globalThis.__s80b.origKick;
        pendingRekick.delete(t);
        delete globalThis.__s80b;
      }, tabId);
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The same page, but the frame still holds its light clip (paused, connected). A defined player
  // inside a light wrapper starts audibly, unseen by the frame's observer. The slider move's
  // engage holds an element, so it answers from the registry at once, and the full walk it finds
  // due puts the level on the player through its missed play. The worker's restore passes are
  // dropped for the tab, so only that walk can find the player.
  async s80j_held_clip_slider_walk_finds_player(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?shell=0&heldwalk");
    let tabId = null;
    try {
      const s = await armWithLightClip(ctx, page);
      if (typeof s === "string") return s;
      tabId = s.tabId;
      await ctx.sw.evaluate((t) => {
        globalThis.__s80j = { origKick: kickRestore };
        kickRestore = (id, d) => (id === t ? Promise.resolve() : globalThis.__s80j.origKick(id, d));
      }, tabId);
      const id = await page.evaluate(() => window.feed.add({ muted: false }));
      await waitClipPlaying(page, id);
      await sleep(600);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      const r = await swSetGain(ctx.sw, tabId, 0.1);
      if (r.mode !== "element") return `BUG: the slider move left element mode (${JSON.stringify(r)})`;
      const w = await waitMeasure(ctx.sw, tabId, (m) => !!(m && m.ok && m.signal && m.rms < 0.1), 3000);
      ctx.note(`setGain ${JSON.stringify(r)}, level on the player after ${w.elapsed} ms (${fmtMeasure(w.m || w.last)})`);
      if (!w.m) return `BUG: the walk the slider move started did not put the level on the player (${fmtMeasure(w.last)})`;
      return true;
    } finally {
      await ctx.sw.evaluate((t) => {
        if (!globalThis.__s80j) return;
        kickRestore = globalThis.__s80j.origKick;
        pendingRekick.delete(t);
        delete globalThis.__s80j;
      }, tabId);
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The walk at injection runs in slices, and the page changes between them. Here it removes the
  // block of light elements the walk stopped in, which leaves the walker in a detached subtree:
  // the walk starts over from the document instead of ending there.
  async s80c_boot_walk_restarts_on_removal(ctx) { return bootWalkRace(ctx, "remove"); },
  // The same with a move of the block to the end of the page: the walker would carry on from
  // there and skip everything in between.
  async s80d_boot_walk_restarts_on_move(ctx) { return bootWalkRace(ctx, "move"); },

  // A player in a root behind 120,000 light elements at injection. Roots are walked after the
  // light tree, so the walk reaches the player's root only past 100,000 elements, and it goes on
  // in its slices until it is done. A probe 1.5 s after the injection reports the player.
  async s80e_player_root_behind_long_page(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?long");
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await waitClipPlaying(page, a);
      await page.evaluate(() => window.feed.bulk(120000, "after"));
      const tabId = await tabIdByUrl(ctx.sw, "?long");
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      await sleep(1500);
      const p = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      ctx.note(`probe 1.5 s after injection ${JSON.stringify(p)}`);
      if (p.mode !== "element") return `BUG: the probe missed the player behind the long page (${JSON.stringify(p)})`;
      return true;
    } finally { await page.close(); }
  },

  // The walk at injection stops inside a block of 90,000 light elements, and in a task between its
  // first and second slice the page moves its player's post from ahead of the walk (after the
  // block) to the top of the page, which the walk has passed. On a page with no shadow DOM until
  // then (?shell=0) the observer's cheap check passes over the post (a defined player inside a
  // light wrapper), so the post goes to the walk in flight, which takes it at its end. The first
  // probe reports the player.
  async s80f_boot_walk_player_moved_behind(ctx) {
    const tag = "bootmove";
    const page = await newShadowPage(ctx.browser, ctx.port, `?shell=0&${tag}`);
    try {
      await page.evaluate(() => window.feed.bulk(90000, "before"));
      const a = await page.evaluate(() => window.feed.addAudible());
      await waitClipPlaying(page, a);
      const tabId = await tabIdByUrl(ctx.sw, tag);
      await asContentScript(ctx.sw, tabId, () => {
        const set = window.setTimeout;
        const st = window.__bootMove = { slices: 0, done: false };
        window.setTimeout = function (fn, ms, ...rest) {
          if (typeof fn === "function" && fn.name === "walkSlice" && ++st.slices === 2) {
            set.call(window, () => {
              const post = document.querySelector("#feed .post");
              if (!post) return;
              document.body.insertBefore(post, document.body.firstChild);
              st.done = true;
            }, 0);
          }
          return set.call(window, fn, ms, ...rest);
        };
        return true;
      });
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      await sleep(200);
      const st = await asContentScript(ctx.sw, tabId, () => window.__bootMove);
      const p = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      ctx.note(`${st && st.slices} slices scheduled, post moved ${st && st.done}, first probe ${JSON.stringify(p)}`);
      if (!st || !st.done) return `setup failed: the page task did not run between two slices (${JSON.stringify(st)})`;
      if (p.mode !== "element") return `BUG: the first probe missed the player moved behind the walk (${JSON.stringify(p)})`;
      return true;
    } finally { await page.close(); }
  },

  // A probe that arrives while the walk at injection is still on its way to the player. The frame
  // reports at once what it has registered: a light clip from another origin without CORS, paused,
  // which alone gives capture. The player sounds in its root behind 200,000 light elements. The
  // walk reports once more when it is complete, inside the worker's window, with the player and
  // its scrub preview as well, and that report replaces the first: the probe answers element, and
  // the worker's rule sees each element once. The frame's reports are counted from its own world,
  // set up before the script arrives.
  async s80g_second_report_names_player(ctx) {
    const tag = "secondreport";
    const page = await newShadowPage(ctx.browser, ctx.port, `?shell=0&${tag}`);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await waitClipPlaying(page, a);
      await page.evaluate(async () => {
        const v = document.createElement("video");
        v.id = "crossclip"; v.preload = "auto";
        v.style.cssText = "width:320px;height:180px;display:block";
        v.src = (await (await fetch("/adsrc")).text()).trim();
        document.body.insertBefore(v, document.body.firstChild);
      });
      await page.waitForFunction(() => document.getElementById("crossclip").readyState >= 1, { timeout: 5000 });
      await page.evaluate(() => window.feed.bulk(200000, "after"));
      const tabId = await tabIdByUrl(ctx.sw, tag);
      await asContentScript(ctx.sw, tabId, () => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        const reports = window.__reports = [];
        chrome.runtime.sendMessage = (m, ...rest) => {
          if (m && m.type === "frameCandidates") reports.push(m.cands.length);
          return send(m, ...rest);
        };
        return true;
      });
      await ctx.sw.evaluate(() => {
        const sel = globalThis.vbSelect;
        globalThis.__s80g = { orig: sel.choose, saw: [] };
        sel.choose = (c) => { globalThis.__s80g.saw.push(c.length); return globalThis.__s80g.orig(c); };
      });
      const t0 = Date.now();
      const p = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      const ms = Date.now() - t0;
      const saw = await ctx.sw.evaluate(() => globalThis.__s80g.saw.slice());
      await sleep(500);
      const reports = (await asContentScript(ctx.sw, tabId, () => window.__reports)) || [];
      ctx.note(`probe ${JSON.stringify(p)} in ${ms} ms, the frame's reports named ${JSON.stringify(reports)} elements, the rule saw ${JSON.stringify(saw)}`);
      if (reports[0] !== 1) return `setup failed: the first report did not name the cross-origin clip alone (${JSON.stringify(reports)})`;
      if (p.mode !== "element") return `BUG: the report of the completed walk did not reach the probe (${JSON.stringify(p)})`;
      const named = reports[reports.length - 1], counted = saw[saw.length - 1];
      if (counted !== named) return `BUG: the rule saw ${counted} candidates for the ${named} elements of the last report: the second report did not replace the first`;
      return true;
    } finally {
      await ctx.sw.evaluate(() => {
        if (!globalThis.__s80g) return;
        globalThis.vbSelect.choose = globalThis.__s80g.orig;
        delete globalThis.__s80g;
      });
      await page.close();
    }
  },

  // The first slider move on a slow page (4x CPU): a player sounds in its root behind 300,000
  // light elements, and the tab has no capture grant. The probe that follows the injection settles
  // before the walk at injection reaches the root, so the slider move ends without a mode. The walk
  // then registers the root and takes the play it finds under way as a missed play: its ping brings
  // a restore pass, which puts the level on the player.
  async s80h_boot_walk_play_after_probe_window(ctx) {
    const tag = "slowboot";
    const page = await newShadowPage(ctx.browser, ctx.port, `?shell=0&${tag}`);
    const cdp = await page.target().createCDPSession();
    let tabId = null;
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await waitClipPlaying(page, a);
      await page.evaluate(() => window.feed.bulk(300000, "after"));
      tabId = await tabIdByUrl(ctx.sw, tag);
      await swClearSpy(ctx.sw);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const r = await swSetGain(ctx.sw, tabId, 0.05);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      const w = await waitMeasure(ctx.sw, tabId, (m) => !!(m && m.ok && m.signal), 8000);
      const m = w.m || w.last;
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      ctx.note(`setGain ${JSON.stringify(r)}, ${pings} ping(s), measure ${fmtMeasure(m)} ${w.elapsed} ms after it`);
      if (r.mode === "element") return `setup failed: the walk at injection was complete inside the probe's window (${JSON.stringify(r)})`;
      if (!m || !m.ok || !m.signal) return `BUG: no pass put the level on the player the walk found after the probe (${fmtMeasure(m)})`;
      if (m.rms > 0.1) return `BUG: the player plays at rms ${m.rms.toFixed(3)}, not at the 0.05x level`;
      return true;
    } finally {
      try { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); } catch (_) {}
      try { await cdp.detach(); } catch (_) {}
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The second report of a probe goes out even when it names nothing. A paused light clip is the
  // page's only medium, behind it 200,000 light elements. The first probe after the injection
  // gets the clip in the frame's first report, and the page removes the clip right after that
  // report, while the walk at injection is still under way. The walk's report is empty and
  // replaces the first, so the worker does not answer element for a clip that has left the page.
  async s80i_empty_second_report_replaces_first(ctx) {
    const tag = "goneclip";
    const page = await newShadowPage(ctx.browser, ctx.port, `?shell=0&${tag}`);
    try {
      await page.evaluate(async () => {
        const v = document.createElement("video");
        v.id = "light"; v.preload = "auto";
        v.style.cssText = "width:320px;height:180px;display:block";
        v.src = URL.createObjectURL(await (await fetch("/tone.wav")).blob());
        document.body.insertBefore(v, document.body.firstChild);
      });
      await page.waitForFunction(() => document.getElementById("light").readyState >= 2, { timeout: 5000 });
      await page.evaluate(() => window.feed.bulk(200000, "after"));
      const tabId = await tabIdByUrl(ctx.sw, tag);
      await asContentScript(ctx.sw, tabId, () => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        const reports = window.__reports = [];
        chrome.runtime.sendMessage = (m, ...rest) => {
          if (m && m.type === "frameCandidates") {
            reports.push(m.cands.length);
            if (reports.length === 1) queueMicrotask(() => { const v = document.getElementById("light"); if (v) v.remove(); });
          }
          return send(m, ...rest);
        };
        return true;
      });
      const p = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      await sleep(500);
      const reports = (await asContentScript(ctx.sw, tabId, () => window.__reports)) || [];
      ctx.note(`probe ${JSON.stringify(p)}, the frame's reports named ${JSON.stringify(reports)} elements`);
      if (reports[0] !== 1) return `setup failed: the first report did not name the clip (${JSON.stringify(reports)})`;
      if (p.mode === "element") return `BUG: the probe answered element for a clip that had left the page (reports ${JSON.stringify(reports)})`;
      return true;
    } finally { await page.close(); }
  },

  // The reels pattern inside a root: the next clip unmutes itself (to 0.25, no gesture). Only a
  // listener on the root hears that volumechange.
  async s81_shadow_autohook_on_self_unmute(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      const b = await page.evaluate(() => window.feed.add());
      await waitClipPlaying(page, b);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.unmute(i, 0.25), b);
      await sleep(200);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
      const doc = await page.evaluate(() => window.docMediaEvents);
      if (doc) return `fixture broken: ${doc} media events reached the document`;
      if (engages) return "an engage landed within 200ms, so this proves nothing about the in-page path";
      if (!(await page.evaluate((i) => window.feed.isHooked(i), b))) return "BUG: the self-unmuting shadow clip was not taken in-page";
      return true;
    } finally { await page.close(); }
  },

  // Reddit's steady state: the clip is unmuted (to 0.25) before it starts, its src is set lazily
  // inside the root, and it starts on scroll with no gesture. The root's 'play' is the only signal,
  // and the level must be on the clip: at 0.25 the x-feed bound would pass native level.
  async s82_shadow_play_after_lazy_src(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      const c = await page.evaluate(() => window.feed.add({ src: "none", autoplay: false }));
      await sleep(300);
      await page.evaluate((i) => { window.feed.setSrc(i, "blob"); window.feed.unmute(i, 0.25); }, c);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), c);
      await sleep(600);
      const m = await measureTop(ctx.sw, setup.tabId);
      ctx.note(`measure ${m && m.ok ? m.rms.toFixed(4) : JSON.stringify(m)}`);
      if (!m || !m.ok || !m.signal) return `BUG: the lazily sourced shadow clip is not on the live graph (measure ${JSON.stringify(m)})`;
      if (m.rms > SHADOW_DUCKED) return m.rms >= SHADOW_UNITY
        ? `BUG: the clip plays at native level (rms ${m.rms.toFixed(4)})`
        : `BUG: the clip plays at rms ${m.rms.toFixed(4)}, not at the 0.05x level`;
      return await assertHookedInPage(ctx, page, c, "play of a lazily sourced shadow clip");
    } finally { await page.close(); }
  },

  // A page with no shadow DOM until its player arrives (?shell=0), and an armed frame. The player
  // host goes straight into the feed, with no wrapper: the frame's observer sees the host itself
  // carry a root and walks it, so the root is observed and listened to before the clip renders.
  // A play in it is taken in-page.
  async s82b_noshell_unwrapped_host_play(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?shell=0");
    try {
      const s = await armWithLightClip(ctx, page);
      if (typeof s === "string") return s;
      const id = await page.evaluate(() => window.feed.add({ bare: true, muted: false, autoplay: false }));
      await page.waitForFunction((i) => { const st = window.feed.state(i); return !!st && st.connected; }, { timeout: 3000 }, id);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), id);
      return await assertHookedInPage(ctx, page, id, "play in a player host inserted without a wrapper");
    } finally { await page.close(); }
  },

  // A saved level on arrival: the armed top frame has to take a shadow player at its first
  // 'play', before any probe could.
  async s83_shadow_saved_level_at_play(ctx) {
    const host = "127.0.0.1";
    const page = await ctx.browser.newPage();
    try {
      await swSaveSite(ctx.sw, host, 0.05);
      await swClearLog(ctx.sw);
      await page.goto(`http://127.0.0.1:${ctx.port}/shadow-feed.html?auto=late&after=1500`, { waitUntil: "load" });
      await page.waitForFunction(() => !!window.autoId && !!window.feed.playedAt(window.autoId), { timeout: 8000 });
      const playedAt = await page.evaluate(() => window.feed.playedAt(window.autoId));
      const tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
      const m = await measureTop(ctx.sw, tabId);
      await sleep(1500);
      const first = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.t >= playedAt - 50 && e.res && e.res.ok);
      const mode = await swGetMode(ctx.sw, tabId);
      ctx.note(`first measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}, mode ${JSON.stringify(mode)}`);
      if (!m || !m.ok || m.rms > 0.1) return `BUG: the saved level did not reach the shadow player at its start (measure ${JSON.stringify(m)})`;
      if (first && "signal" in first.res) return "BUG: the worker's engage hooked the player, so it started at native level";
      if (!mode || mode.mode !== "element" || mode.frameId !== 0) return `BUG: the frame's own hook is not tracked (mode ${JSON.stringify(mode)})`;
      return true;
    } finally {
      await swForgetSite(ctx.sw, host);
      await page.close().catch(() => {});
    }
  },

  // The same arrival on a page with no shadow DOM until its player comes (?shell=0). The player
  // is defined when it arrives, inside a light wrapper, so the frame's observer cannot see its
  // root and the play goes unheard: the start plays at native level (the gap content.js names
  // above scanMutations). The restore pass that is still probing walks the page and puts the
  // level on the clip within 2 s of its start.
  async s83b_noshell_saved_level_by_restore(ctx) {
    const host = "127.0.0.1";
    const page = await ctx.browser.newPage();
    try {
      await swSaveSite(ctx.sw, host, 0.05);
      await swClearLog(ctx.sw);
      await page.goto(`http://127.0.0.1:${ctx.port}/shadow-feed.html?shell=0&auto=late&after=1500`, { waitUntil: "load" });
      await page.waitForFunction(() => !!window.autoId && !!window.feed.playedAt(window.autoId), { timeout: 8000 });
      const playedAt = await page.evaluate(() => window.feed.playedAt(window.autoId));
      const tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
      const m0 = await measureTop(ctx.sw, tabId);
      await sleep(Math.max(0, playedAt + 2000 - Date.now()));
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`at the start ${fmtMeasure(m0)}, 2 s later ${fmtMeasure(m)}`);
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the clip is not at the saved level 2 s after its start (${fmtMeasure(m)})`;
      return true;
    } finally {
      await swForgetSite(ctx.sw, host);
      await page.close().catch(() => {});
    }
  },

  // What holds in that gap without any restore running: the script arrives while the page has no
  // shadow DOM (?shell=0) and no level, then a defined player inside a light wrapper starts
  // audibly, unseen by the frame. The next slider move once a full walk is due again walks the
  // page, finds the player, and puts the level on it in element mode. The walk at injection
  // found no root with media, so the next one is due 2 s after it.
  async s83c_noshell_next_setgain_takes_wrapped_player(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?shell=0");
    let tabId = null;
    try {
      tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      const injectedAt = Date.now();
      await sleep(300);
      const id = await page.evaluate(() => window.feed.add({ muted: false }));
      await waitClipPlaying(page, id);
      await sleep(Math.max(1000, injectedAt + 2600 - Date.now()));
      const r = await swSetGain(ctx.sw, tabId, 0.05);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`setGain ${JSON.stringify(r)}, measure ${fmtMeasure(m)}`);
      if (r.mode !== "element" || !r.confirmed) return `BUG: the slider move did not find the wrapped player: ${JSON.stringify(r)}`;
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the wrapped player is not at the 0.05x level (${fmtMeasure(m)})`;
      return true;
    } finally {
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // s83c with a muted clip looping at the top of the page (a hero background). Muted media does
  // not sound, so the frame still counts as having nothing that sounds: the full walk stays due for
  // the slider moves, which find the audible player and put the level on it.
  async s83d_noshell_muted_hero_keeps_backstop(ctx) { return mutedHeroCase(ctx, "mutedhero", true); },
  // Control, and a pin: the same page with the hero paused. It passes whether muted media counts
  // as sounding or not, so a failure of s83d comes from the playing muted hero.
  async s83e_noshell_paused_hero_control(ctx) { return mutedHeroCase(ctx, "pausedhero", false); },

  // The hooked post is unloaded with its batch while the next clip is already on screen. The
  // restore that elementLost starts must land on that clip and stay there past the give-up point.
  async s84_shadow_unload_keeps_level(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      const b = await page.evaluate(() => window.feed.add());
      await waitClipPlaying(page, b);
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await page.evaluate((i) => window.feed.remove(i), setup.a);
      await sleep(1000);
      for (let i = 0; i < 150 && (await ctx.sw.evaluate((t) => restoring.has(t), setup.tabId)); i++) await sleep(100);
      await page.evaluate((i) => window.feed.unmute(i), b);
      await sleep(700);
      const m = await measureTop(ctx.sw, setup.tabId);
      const mode = await swGetMode(ctx.sw, setup.tabId);
      ctx.note(`after unload: measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}, mode ${JSON.stringify(mode)}`);
      if (!m || !m.ok || m.rms > 0.1) return `BUG: the next clip plays unducked after the hooked post was unloaded (measure ${JSON.stringify(m)})`;
      if (!mode || mode.mode !== "element") return `BUG: the tab lost its element mode (${JSON.stringify(mode)})`;
      return true;
    } finally { await page.close(); }
  },

  // The gate holds inside roots too: an audible clip from another origin without CORS is never
  // hooked, whichever path sees it first. A hook would silence it for good.
  async s85_shadow_cross_origin_refused(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      const x = await page.evaluate(() => window.feed.add({ src: "cross" }));
      await waitClipPlaying(page, x);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.unmute(i), x);
      await sleep(1000);
      await waitIdle(ctx.sw, setup.tabId, 15000, 1500);
      const refusals = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage" && e.res && e.res.reason === "cross-origin-no-cors").length;
      ctx.note(`${refusals} cross-origin refusal(s)`);
      if (await page.evaluate((i) => window.feed.isHooked(i), x)) return "BUG: a cross-origin shadow clip was hooked, which silences it";
      return true;
    } finally { await page.close(); }
  },

  // The bookkeeping of what sounded lives in the shared handlers, so it covers clips inside roots
  // as well. A clip without CORS plays audibly and pauses again inside its own 'play' event: no
  // probe ever sees it play, only the root's listener hears it. The probe then reports it as
  // heard, which is what the worker's sticky capture counts (s78g covers the rule itself).
  async s85b_shadow_heard_by_root_listener(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const x = await page.evaluate(() => window.feed.add({ src: "cross", muted: false, autoplay: false }));
      await page.waitForFunction((i) => { const s = window.feed.state(i); return !!s && s.connected; }, { timeout: 3000 }, x);
      const tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      await sleep(300);
      const before = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      await page.evaluate((i) => window.feed.playOnce(i), x);
      await sleep(400);
      const st = await page.evaluate((i) => window.feed.state(i), x);
      const after = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      ctx.note(`before ${JSON.stringify(before)}, after ${JSON.stringify(after)}, clip paused ${st && st.paused}`);
      if (!st || !st.paused) return `setup failed: the clip did not pause again (${JSON.stringify(st)})`;
      if (before.heardUnhookable) return `setup failed: the clip counts as heard before it played (${JSON.stringify(before)})`;
      if (!after.heardUnhookable) return `BUG: the clip's sound inside its root is not counted as heard (${JSON.stringify(after)})`;
      return true;
    } finally { await page.close(); }
  },

  // A player one root deeper (mux-player style), rendered into its outer root after insertion.
  // Only an observer on the outer root sees the inner player arrive.
  async s86_shadow_nested_player(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      const n = await page.evaluate(() => window.feed.addNested({ muted: false, autoplay: false }));
      await page.waitForFunction((i) => { const s = window.feed.state(i); return !!s && s.connected; }, { timeout: 3000 }, n);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), n);
      return await assertHookedInPage(ctx, page, n, "play in a nested shadow player");
    } finally { await page.close(); }
  },

  // The hooked node moves into another player's root and keeps playing: that is no loss. A later
  // removal inside the NEW root, with no light-DOM change at all, is one and must be reported.
  async s87_shadow_move_then_inner_removal(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      await ctx.sw.evaluate(() => {
        if (globalThis.__lostSpy) return;
        globalThis.__lostSpy = { n: 0 };
        chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "elementLost") globalThis.__lostSpy.n++; });
      });
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      const b = await page.evaluate(() => window.feed.add({ autoplay: false }));
      await sleep(600);
      await ctx.sw.evaluate(() => { globalThis.__lostSpy.n = 0; });
      await page.evaluate((i, j) => window.feed.moveTo(i, j), setup.a, b);
      await sleep(1200);
      const lostAfterMove = await ctx.sw.evaluate(() => globalThis.__lostSpy.n);
      const m = await measureTop(ctx.sw, setup.tabId);
      await page.evaluate((i) => window.feed.removeInRoot(i), setup.a);
      await sleep(1000);
      const lostAfterRemoval = await ctx.sw.evaluate(() => globalThis.__lostSpy.n);
      ctx.note(`after move: ${lostAfterMove} lost, rms ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}, after inner removal: ${lostAfterRemoval} lost`);
      if (lostAfterMove) return "BUG: moving the hooked node between roots was reported as a loss";
      if (!m || !m.ok || m.rms > 0.1) return `BUG: the moved node lost its level (measure ${JSON.stringify(m)})`;
      if (!lostAfterRemoval) return "BUG: removing the hooked video inside its new root went unnoticed";
      return true;
    } finally { await page.close(); }
  },

  // A player inserted before its element is defined: the upgrade attaches the root and renders
  // the video without any mutation record. The recheck of undefined elements comes back for it.
  async s88_shadow_late_upgrade(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      const id = await page.evaluate(() => window.feed.addLate({ muted: false, autoplay: false }, 300));
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), id);
      return await assertHookedInPage(ctx, page, id, "play in a late-upgraded shadow player");
    } finally { await page.close(); }
  },

  // Only custom elements that are not defined yet are rechecked. Defined light-DOM components
  // without a root, which some frameworks render by the thousand, never join the list: here 4500
  // of them arrive in one insertion right before a player whose element is defined later. Were
  // they taken in as well, they would fill the list to its cap (4000) ahead of the player, and
  // its upgrade would go unseen.
  async s88b_shadow_late_upgrade_among_defined_elements(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      const name = await page.evaluate(() => window.feed.addUndefined({ muted: false, autoplay: false }, 4500));
      await sleep(300);
      const id = await page.evaluate((n) => window.feed.defineLate(n), name);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), id);
      return await assertHookedInPage(ctx, page, id, "play in a late-upgraded player behind 4500 defined elements");
    } finally { await page.close(); }
  },

  // One recheck chain at a time. The frame's timers are watched from its own world, wrapped
  // before the script arrives. Two undefined elements are there at injection. One is a player,
  // defined 300 ms later, that renders an element defined nowhere into its root, so the recheck
  // that finds the player notes a new element in the middle of its run. Another undefined element
  // arrives while the chain runs. At no time is more than one recheck timer pending, and the
  // delay of the chain never drops while it runs.
  async s88c_shadow_one_pending_chain(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
      await asContentScript(ctx.sw, tabId, () => {
        const pendingTimers = new Map();
        const st = window.__recheckTimers = { most: 0, delays: [] };
        const set = window.setTimeout, clear = window.clearTimeout;
        window.setTimeout = function (fn, ms, ...rest) {
          if (typeof fn !== "function" || fn.name !== "recheckPending") return set.call(window, fn, ms, ...rest);
          const id = set.call(window, function () { pendingTimers.delete(id); return fn.apply(this, arguments); }, ms, ...rest);
          pendingTimers.set(id, ms);
          st.delays.push(ms);
          st.most = Math.max(st.most, pendingTimers.size);
          return id;
        };
        window.clearTimeout = function (id) { pendingTimers.delete(id); return clear.call(window, id); };
        return true;
      });
      const name = await page.evaluate(() => { window.feed.addNever(); return window.feed.addUndefined({ nested: true, src: "none", autoplay: false }); });
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      await sleep(300);
      await page.evaluate((n) => window.feed.defineLate(n), name);
      await sleep(1200);
      await page.evaluate(() => window.feed.addNever());
      await sleep(4500);
      const st = await asContentScript(ctx.sw, tabId, () => window.__recheckTimers);
      ctx.note(`recheck delays ${JSON.stringify(st && st.delays)}, at most ${st && st.most} pending at once`);
      if (!st || st.delays.length < 5) return `BUG: no recheck chain ran for the undefined elements (${JSON.stringify(st)})`;
      if (st.most > 1) return `BUG: ${st.most} recheck timers were pending at once`;
      const drop = st.delays.findIndex((d, i) => i > 0 && d < st.delays[i - 1]);
      if (drop > 0) return `BUG: the chain's delay dropped from ${st.delays[drop - 1]} to ${st.delays[drop]} ms while it ran`;
      return true;
    } finally { await page.close(); }
  },

  // s88 on a page with no shadow DOM until its player arrives (?shell=0), the frame armed from a
  // light clip. The player is inserted inside a light wrapper before its element is defined. The
  // observer's cheap check finds the undefined element below the wrapper and walks it, so the
  // recheck comes back for it after the upgrade, and a play in it is taken in-page.
  async s88d_noshell_late_upgrade_in_wrapper(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?shell=0");
    try {
      const s = await armWithLightClip(ctx, page);
      if (typeof s === "string") return s;
      const id = await page.evaluate(() => window.feed.addLate({ muted: false, autoplay: false }, 300));
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), id);
      return await assertHookedInPage(ctx, page, id, "play in a late-upgraded player inside a wrapper");
    } finally { await page.close(); }
  },

  // s88d with a light post carrying a muted clip ahead of the player, in the same insertion: the
  // observer's callback has its media hit before it reaches the player's wrapper, and still
  // finds the undefined element below it.
  async s88f_noshell_late_upgrade_after_light_clip(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?shell=0");
    try {
      const s = await armWithLightClip(ctx, page);
      if (typeof s === "string") return s;
      const name = await page.evaluate(() => {
        const post = document.createElement("div");
        post.className = "post";
        const v = post.appendChild(document.createElement("video"));
        v.muted = true;
        document.getElementById("feed").appendChild(post);
        return window.feed.addUndefined({ muted: false, autoplay: false }); // the same task: the same observer callback
      });
      await sleep(300);
      const id = await page.evaluate((n) => window.feed.defineLate(n), name);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), id);
      return await assertHookedInPage(ctx, page, id, "play in a late-upgraded player after a light clip");
    } finally { await page.close(); }
  },

  // s88d with the player host appended straight into #feed before its element is defined, with
  // no wrapper (the mux-player pattern of a host inserted ahead of its script). Only the check of
  // the added node itself for an undefined custom element sends it to the walk that notes it.
  // Defined 300 ms later, it renders a muted autoplaying clip into its root, and an unmute there
  // is taken in-page.
  async s88g_noshell_bare_undefined_host(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?shell=0&barehost");
    try {
      const s = await armWithLightClip(ctx, page);
      if (typeof s === "string") return s;
      await page.evaluate(() => document.getElementById("feed").appendChild(document.createElement("sf-bare-x1")));
      await sleep(300);
      const id = await page.evaluate(() => window.feed.defineLate("sf-bare-x1"));
      if (!id) return "setup failed: the bare player was not defined";
      await waitClipPlaying(page, id);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.unmute(i, 1), id);
      return await assertHookedInPage(ctx, page, id, "unmute in a bare late-upgraded player host");
    } finally { await page.close(); }
  },

  // Light-DOM components inserted before their definition fill the recheck list (4500 of them,
  // past its cap of 4000), and are defined 100 ms later without a root. A recheck drops every one
  // that is defined and has no root, so the list has room again when a player arrives a second
  // later, inserted before its own definition. Were they kept until PENDING_LIFE, the player
  // would not be noted and its upgrade would go unseen.
  async s88e_defined_components_leave_the_recheck(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await page.evaluate(() => window.feed.addLateTags(4500, 100));
      await sleep(1000);
      const id = await page.evaluate(() => window.feed.addLate({ muted: false, autoplay: false }, 300));
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), id);
      return await assertHookedInPage(ctx, page, id, "play in a late-upgraded player after 4500 components");
    } finally { await page.close(); }
  },

  // The orphan standdown on a shadow player: after an update its only continuous trigger is the
  // root's timeupdate, since the document's never fires. The worker's restore passes are dropped
  // for the tab: the simulated orphan still receives the worker's messages, which an orphaned
  // world never does, and the arm of a pass would put the level back on its graph.
  async s89_shadow_orphan_standdown(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    const tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
    try {
      await ctx.sw.evaluate((t) => {
        globalThis.__s89 = { origKick: kickRestore };
        kickRestore = (id, d) => (id === t ? Promise.resolve() : globalThis.__s89.origKick(id, d));
      }, tabId);
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      const m1 = await measureTop(ctx.sw, setup.tabId);
      if (!m1 || !m1.ok || m1.rms > 0.1) return `precondition failed: ducked rms ${m1 && m1.rms}`;
      await ctx.sw.evaluate((t) => chrome.scripting.executeScript({
        target: { tabId: t },
        func: () => { Object.defineProperty(chrome, "runtime", { get: () => undefined, configurable: true }); },
      }), setup.tabId);
      await sleep(900);
      const m2 = await measureTop(ctx.sw, setup.tabId);
      ctx.note(`rms ducked ${m1.rms.toFixed(3)} -> after orphan ${m2 && m2.ok && m2.rms.toFixed(3)}`);
      if (!m2 || !m2.ok) return `measure channel died: ${JSON.stringify(m2)}`;
      if (m2.rms < 0.2) return `BUG: the orphaned world keeps the stale 0.05x level on the shadow player (rms ${m2.rms.toFixed(3)})`;
      return true;
    } finally {
      await ctx.sw.evaluate((t) => {
        if (!globalThis.__s89) return;
        kickRestore = globalThis.__s89.origKick;
        pendingRekick.delete(t);
        delete globalThis.__s89;
      }, tabId);
      await page.close();
    }
  },

  // A player that re-dispatches its media events on its host (the custom-media-element
  // pattern): the document sees copies with the host as their target, the root sees the
  // originals. A clip that unmutes itself is taken in-page exactly once, with no ping and no
  // engage: one more source node is made (the recorder counts them), no more.
  async s90_shadow_redispatch_once(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?redispatch=1");
    try {
      await tapInstall(ctx.sw, await tabIdByUrl(ctx.sw, "redispatch=1"));
      const hooks = (t) => asContentScript(ctx.sw, t, () => window.__tap.nodes.size);
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      const b = await page.evaluate(() => window.feed.add());
      await waitClipPlaying(page, b);
      await sleep(2600);
      const h0 = await hooks(setup.tabId);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.unmute(i, 0.25), b);
      await sleep(600);
      const h1 = await hooks(setup.tabId);
      const m1 = await measureTop(ctx.sw, setup.tabId);
      ctx.note(`hooks ${h0} -> ${h1}, rms ${m1 && m1.ok ? m1.rms.toFixed(4) : JSON.stringify(m1)}`);
      if (h1 !== h0 + 1) return `BUG: not exactly one in-page hook (hooks ${h0} -> ${h1})`;
      if (!m1.ok || !m1.signal || m1.rms > SHADOW_DUCKED) return `BUG: the clip is not at the 0.05x level (measure ${JSON.stringify(m1)})`;
      return await assertHookedInPage(ctx, page, b, "self-unmute behind a re-dispatching host");
    } finally { await page.close(); }
  },

  // Control, and a pin: the same page with CLOSED player roots. Nothing reaches into those, so
  // the tab must not report element mode and the clip stays untouched. This passes without the
  // shadow DOM support as well: it shows that the other shadow scenarios pass because of the
  // open roots.
  async s91_shadow_closed_root_control(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?root=closed");
    let tabId = null;
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await waitClipPlaying(page, a);
      tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
      const r = await swSetGain(ctx.sw, tabId, 0.05);
      ctx.note(`closed root -> ${JSON.stringify(r)}`);
      if (r.mode === "element") return `control broken: a closed-root player reported element mode (${JSON.stringify(r)})`;
      if (await page.evaluate((x) => window.feed.isHooked(x), a)) return "BUG: a closed-root player was hooked";
      return true;
    } finally {
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A pin for the root test. The root node of an element in a detached subtree is that subtree's
  // top element, and an <a href> carries a host property of its own (its hostname). A clip inside
  // a link is removed with it, and its src changes in the same task, so the record still arrives.
  // Later the detached clip changes src again and plays audibly. Were the link taken for a shadow
  // root, it would be observed and listened to: a ping, or a hook on a detached element. This
  // passes without the shadow DOM support as well.
  async s91b_detached_link_is_no_root(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      await page.evaluate(async () => {
        const link = document.createElement("a");
        link.href = "/elsewhere";
        const v = document.createElement("video");
        v.loop = true; v.muted = true;
        v.src = URL.createObjectURL(await (await fetch("/tone.wav")).blob());
        link.appendChild(v);
        document.getElementById("feed").appendChild(link);
        window.__detached = { link, v };
      });
      await sleep(2600);
      await page.evaluate(() => { const d = window.__detached; d.link.remove(); d.v.src = d.v.src; });
      await sleep(2600);
      await swClearSpy(ctx.sw);
      await page.evaluate(() => {
        const v = window.__detached.v;
        v.src = v.src;
        v.muted = false; v.volume = 1;
        v.play().catch(() => {});
      });
      await sleep(1200);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").length;
      const hooked = await page.evaluate(() => {
        const c = new AudioContext();
        try { c.createMediaElementSource(window.__detached.v).connect(c.destination); return false; }
        catch (_) { c.close(); return true; }
      });
      ctx.note(`detached clip: ${pings} ping(s), ${engages} engage(s), hooked ${hooked}`);
      if (hooked) return "BUG: the detached clip inside a link was hooked: the link was taken for a shadow root";
      if (pings || engages) return `BUG: the detached link is observed or listened to (${pings} pings, ${engages} engages)`;
      return true;
    } finally { await page.close(); }
  },

  // Cost on a feed the size of a long Reddit session (59 posts, about 2300 open roots and 18,000
  // elements): the mutation observers take at most 50 ms more for a 46-post batch with the
  // extension than without, as the median of three batches each (a bound generous enough for a
  // loaded machine). The probe still finds the playing clip there. The injection's own cost is
  // s92d's.
  async s92_shadow_feed_cost(ctx) {
    const batchCost = (page) => page.evaluate(() => window.feed.callbackMs(() =>
      window.feed.addBatch(46, { src: "none", autoplay: false, leaves: 35, filler: 150 })));
    const median3 = async (page) => {
      const xs = [];
      for (let i = 0; i < 3; i++) { xs.push(await batchCost(page)); await sleep(400); }
      return xs.sort((x, y) => x - y)[1];
    };
    const control = await newShadowPage(ctx.browser, ctx.port, "?posts=59&control");
    let base;
    try {
      await sleep(500);
      base = await median3(control);
    } finally { await control.close(); }
    const page = await newShadowPage(ctx.browser, ctx.port, "?posts=59&measured");
    try {
      await sleep(500);
      const size = await page.evaluate(() => {
        let els = 0;
        const walk = (r) => { for (const e of r.querySelectorAll("*")) { els++; if (e.shadowRoot) walk(e.shadowRoot); } };
        walk(document);
        return { roots: window.feed.liveRoots(), els };
      });
      const tabId = await tabIdByUrl(ctx.sw, "measured");
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      await sleep(600);
      const withExt = await median3(page);
      const a = await page.evaluate(() => window.feed.addAudible());
      await waitClipPlaying(page, a);
      const info = await ctx.sw.evaluate((t) => predictMode(t), tabId);
      ctx.note(`${size.roots} roots, ${size.els} elements, observers on a batch ${base.toFixed(1)} ms without, ${withExt.toFixed(1)} ms with, probe ${JSON.stringify(info)}`);
      if (withExt - base > 50) return `BUG: the observers take ${(withExt - base).toFixed(1)} ms more for a feed batch with the extension`;
      if (info.mode !== "element") return `BUG: the probe missed the playing clip on a big page (${JSON.stringify(info)})`;
      return true;
    } finally { await page.close(); }
  },

  // The probe's own task on a big page: 120,000 light elements, the page shell's open root
  // without media, nothing playing, so a full walk is due for every probe the interval allows.
  // The handler reports at once from the registry and starts the walk, which runs in its own
  // slices: it never walks the page itself.
  // Timed from the frame's own world, set up before the script arrives: the message handler plus
  // the microtasks it queues at once, for the first probe right after the injection and for two
  // more, 2.5 s and 7 s after it, when a walk is due for each. The median of the three stays
  // under 15 ms. A full walk inside the handler costs about 25 to 40 ms on this page (Chrome
  // 157, measured 2026-10-24).
  async s92b_probe_task_short_on_big_page(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?bulk=120000&probecost");
    try {
      const tabId = await tabIdByUrl(ctx.sw, "probecost");
      await asContentScript(ctx.sw, tabId, () => {
        const ev = chrome.runtime.onMessage;
        const add = ev.addListener.bind(ev);
        const times = window.__probeTask = [];
        ev.addListener = (fn) => add((msg, sender, respond) => {
          const t0 = performance.now();
          try { return fn(msg, sender, respond); }
          finally { if (msg && msg.cmd === "probe") queueMicrotask(() => times.push(performance.now() - t0)); }
        });
        return true;
      });
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      const injectedAt = Date.now();
      const probes = [];
      for (const at of [0, 2500, 7000]) {
        await sleep(Math.max(0, injectedAt + at - Date.now()));
        probes.push((await ctx.sw.evaluate((t) => predictMode(t), tabId)).mode);
      }
      const times = (await asContentScript(ctx.sw, tabId, () => window.__probeTask)) || [];
      const median = times.slice().sort((x, y) => x - y)[1];
      ctx.note(`probe handler ${times.map((x) => x.toFixed(1)).join(", ")} ms, median ${median == null ? "none" : median.toFixed(1)} ms, probes ${probes.join(", ")}`);
      if (times.length !== 3) return `setup failed: ${times.length} probes timed, not 3`;
      if (median > 15) return `BUG: the probe's own task takes ${median.toFixed(1)} ms (median of three) on a big page`;
      return true;
    } finally { await page.close(); }
  },

  // When full walks run, counted from the frame's own world: the timers of their slices, watched
  // from before the script arrives (on this small page every walk is one slice). A clip is hooked
  // in its root and paused, so nothing plays, and the worker's restore passes are dropped for the
  // tab so that only the probes below ask. Probes every 0.7 s for 10 s find a walk due once the
  // last one lies further back than the interval, which doubles after every walk that registers
  // no new root with media (1, 2, 4, 8 s): at most 4 walks. A slider move to a new level starts
  // the interval over, and a walk follows at once. So does a new player root that an observer
  // registers: a probe 1.3 s later walks, inside the 2 s the walk before had set. While the clip
  // plays, a walk is due once the last one lies further back than both 3 s (SWEEP_STALE) and the
  // interval, which goes on doubling: walks at about 3 s and 7 s, 2 in 12 s, where a walk every
  // 3 s would make 4.
  async s92c_walk_schedule(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?walks");
    let tabId = null;
    try {
      tabId = await tabIdByUrl(ctx.sw, "?walks");
      await asContentScript(ctx.sw, tabId, () => {
        const set = window.setTimeout;
        const st = window.__walks = { n: 0 };
        window.setTimeout = function (fn, ms, ...rest) {
          if (typeof fn === "function" && fn.name === "walkSlice") st.n++;
          return set.call(window, fn, ms, ...rest);
        };
        return true;
      });
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await ctx.sw.evaluate((t) => {
        globalThis.__s92c = { origKick: kickRestore };
        kickRestore = (id, d) => (id === t ? Promise.resolve() : globalThis.__s92c.origKick(id, d));
      }, tabId);
      const walks = () => asContentScript(ctx.sw, tabId, () => window.__walks.n);
      const probeFor = async (ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { await ctx.sw.evaluate((t) => predictMode(t), tabId); await sleep(350); }
      };
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      const n0 = await walks();
      await probeFor(10000);
      const n1 = await walks();
      await sleep(1200);
      const r = await swSetGain(ctx.sw, tabId, 0.1);
      const n2 = await walks();
      await page.evaluate(() => window.feed.add({ autoplay: false }));
      await sleep(1300);
      await ctx.sw.evaluate((t) => predictMode(t), tabId);
      const n3 = await walks();
      await page.evaluate((i) => window.feed.play(i), setup.a);
      await sleep(300);
      const n4 = await walks();
      await probeFor(12000);
      const n5 = await walks();
      ctx.note(`walks: ${n1 - n0} in 10 s while nothing plays, ${n2 - n1} at the new level (setGain ${r.mode}), ${n3 - n2} after a new player root, ${n5 - n4} in 12 s while the clip plays`);
      if (n1 - n0 > 4) return `BUG: ${n1 - n0} walks in 10 s while nothing plays: the interval does not back off`;
      if (n1 - n0 < 1) return "BUG: no walk at all while nothing plays";
      if (r.mode !== "element") return `setup failed: the slider move left element mode (${JSON.stringify(r)})`;
      if (n2 - n1 < 1) return "BUG: no walk after the level changed";
      if (n3 - n2 < 1) return "BUG: no walk after a new player root was registered";
      if (n5 - n4 < 1) return "BUG: no walk in 12 s while the clip plays";
      if (n5 - n4 > 2) return `BUG: ${n5 - n4} walks in 12 s while the clip plays: the interval does not slow them`;
      return true;
    } finally {
      await ctx.sw.evaluate((t) => {
        if (!globalThis.__s92c) return;
        kickRestore = globalThis.__s92c.origKick;
        pendingRekick.delete(t);
        delete globalThis.__s92c;
      }, tabId);
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The injection's own task on a big page: 200,000 light elements and the page shell's open root,
  // where one walk of the whole page takes about 70 ms (Chrome 157, measured 2026-10-24). A
  // long-task observer of the page cannot see a task of the extension's world, so a CDP trace times
  // the task that evaluates content.js: it stays under 50 ms. And no walk slice runs in it. The
  // frame's own world, set up before the script arrives, counts the TreeWalkers created from the
  // script's start until a timer it queues there, which runs ahead of every timer the script
  // queues itself: none.
  async s92d_injection_task_runs_no_walk(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?bulk=200000&injectcost");
    try {
      const tabId = await tabIdByUrl(ctx.sw, "injectcost");
      await asContentScript(ctx.sw, tabId, () => {
        const st = window.__inject = { walkers: 0, during: 0, started: false };
        let inInjection = false, init;
        Object.defineProperty(window, "__VB_INIT__", {
          configurable: true,
          get() { return init; },
          set(v) {
            init = v;
            st.started = true;
            inInjection = true;
            setTimeout(() => { inInjection = false; }, 0);
          },
        });
        const make = Document.prototype.createTreeWalker;
        Document.prototype.createTreeWalker = function (...a) {
          st.walkers++;
          if (inInjection) st.during++;
          return make.apply(this, a);
        };
        return true;
      });
      await page.tracing.start({ categories: ["toplevel", "devtools.timeline"] });
      let buf = null;
      try {
        await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
        await sleep(300);
      } finally { buf = await page.tracing.stop(); }
      await sleep(700);
      const st = await asContentScript(ctx.sw, tabId, () => window.__inject);
      const t = buf ? injectionTask(buf) : null;
      ctx.note(`injection task ${t ? t.task.toFixed(1) + " ms (content.js " + t.script.toFixed(1) + " ms)" : "not found"}, TreeWalkers ${st && st.walkers}, ${st && st.during} of them in the injection`);
      if (!st || !st.started || !st.walkers) return `setup failed: the script or its walk did not run (${JSON.stringify(st)})`;
      if (!t) return "setup failed: the trace holds no task that evaluates content.js";
      if (t.task > 50) return `BUG: the injection task took ${t.task.toFixed(1)} ms on a big page`;
      if (st.during) return `BUG: the injection task ran a walk slice (${st.during} TreeWalker(s))`;
      return true;
    } finally { await page.close(); }
  },

  // A page busy with its own scripts: a task of 140 ms every 150 ms, 120,000 light elements, the
  // page shell's open root without media, a light clip paused, nothing sounding, and a full walk
  // due when the probe arrives (the walk at injection lies 3 s back). The frame reports at once,
  // so its report stays inside the worker's window of 350 ms: the probe answers element. Six
  // probes, each on a fresh page: at least five answer element, and the median time from the probe
  // handler to the frame's first report stays under 100 ms. A report held for the walk comes about
  // 320 ms after the handler on this page, and 2 to 4 of 6 such probes answer capture (Chrome 157,
  // measured 2026-10-24).
  async s92e_busy_page_probe_answers_element(ctx) {
    const runs = [];
    for (let i = 0; i < 6; i++) {
      const tag = `busyprobe${i}`;
      const page = await newShadowPage(ctx.browser, ctx.port, `?bulk=120000&${tag}`);
      try {
        await page.evaluate(async () => {
          const v = document.createElement("video");
          v.id = "light"; v.preload = "auto";
          v.style.cssText = "width:320px;height:180px;display:block";
          v.src = URL.createObjectURL(await (await fetch("/tone.wav")).blob());
          document.body.insertBefore(v, document.body.firstChild);
        });
        await page.waitForFunction(() => document.getElementById("light").readyState >= 2, { timeout: 5000 });
        const tabId = await tabIdByUrl(ctx.sw, tag);
        await asContentScript(ctx.sw, tabId, () => {
          const W = window.__probeReport = { at: null, ms: [] };
          const ev = chrome.runtime.onMessage;
          const add = ev.addListener.bind(ev);
          ev.addListener = (fn) => add((msg, sender, respond) => {
            if (msg && msg.cmd === "probe") W.at = performance.now();
            return fn(msg, sender, respond);
          });
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (m, ...rest) => {
            if (m && m.type === "frameCandidates" && W.at != null) { W.ms.push(performance.now() - W.at); W.at = null; }
            return send(m, ...rest);
          };
          return true;
        });
        await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
        await sleep(3000);
        await page.evaluate(() => {
          window.__busy = setInterval(() => { const t0 = performance.now(); while (performance.now() - t0 < 140) {} }, 150);
        });
        await sleep(400 + 50 * i);
        const r = await ctx.sw.evaluate((t) => predictMode(t), tabId);
        await page.evaluate(() => clearInterval(window.__busy));
        const W = await asContentScript(ctx.sw, tabId, () => window.__probeReport);
        runs.push({ mode: r.mode, report: W && W.ms.length ? W.ms[0] : null });
      } finally {
        await page.evaluate(() => clearInterval(window.__busy)).catch(() => {});
        await page.close();
      }
    }
    const element = runs.filter((x) => x.mode === "element").length;
    const lat = runs.map((x) => (x.report == null ? Infinity : x.report)).sort((x, y) => x - y);
    const median = (lat[2] + lat[3]) / 2;
    ctx.note(`${element} of 6 probes element, first report ${runs.map((x) => (x.report == null ? "none" : x.report.toFixed(0))).join(", ")} ms after the handler, median ${median.toFixed(0)} ms`);
    if (median > 100) return `BUG: the frame holds its report ${median.toFixed(0)} ms (median) on a busy page`;
    if (element < 5) return `BUG: ${6 - element} of 6 probes answered capture on a busy page with a paused hookable clip`;
    return true;
  },

  // A slider move on a held clip that sounds, on a big page (120,000 light elements and the page
  // shell's root) at 4x CPU, each 3.5 s after the last, so a full walk is due at each. The engage
  // sets the level without waiting for the walk: nothing a walk registers can move the level off a
  // held element that sounds. Its roundtrip from the worker stays near that of a plain update, the
  // median of three under 120 ms. Waiting for the walk takes about 250 ms there, and a plain update
  // 10 to 25 ms (Chrome 157, measured 2026-10-24).
  async s92f_held_clip_engage_skips_walk(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?bulk=120000&heldengage");
    const cdp = await page.target().createCDPSession();
    let tabId = null;
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await waitClipPlaying(page, a);
      await sleep(300);
      tabId = await tabIdByUrl(ctx.sw, "heldengage");
      const r1 = await swSetGain(ctx.sw, tabId, 0.5);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const runs = [];
      for (let k = 0; k < 3; k++) {
        await sleep(3500);
        runs.push(await ctx.sw.evaluate(async (t, g) => {
          const s = performance.now();
          const r = await engageFrame(t, 0, { cmd: "engage", gain: g, useLimiter: true });
          return { ms: performance.now() - s, ok: !!(r && r.ok), held: !!(r && r.ok && !("signal" in r)) };
        }, tabId, 0.05 + k * 0.01));
      }
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      const median = runs.map((x) => x.ms).sort((x, y) => x - y)[1];
      ctx.note(`engage roundtrips ${runs.map((x) => x.ms.toFixed(0)).join(", ")} ms at 4x CPU, median ${median.toFixed(0)} ms`);
      if (!runs.every((x) => x.ok && x.held)) return `setup failed: an engage did not update the held clip (${JSON.stringify(runs)})`;
      if (median > 120) return `BUG: a slider move on the held clip waits ${median.toFixed(0)} ms (median) for a walk`;
      return true;
    } finally {
      try { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); } catch (_) {}
      try { await cdp.detach(); } catch (_) {}
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The same page with the held clip paused: nothing sounds, so a full walk is due at every slider
  // move (a new level starts the interval over). The engage holds the clip and answers without
  // waiting for that walk, at the cost of an engage that never walks.
  async s92h_held_paused_clip_engage_skips_walk(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?bulk=120000&heldpaused");
    const cdp = await page.target().createCDPSession();
    let tabId = null;
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await waitClipPlaying(page, a);
      await sleep(300);
      tabId = await tabIdByUrl(ctx.sw, "heldpaused");
      const r1 = await swSetGain(ctx.sw, tabId, 0.5);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const runs = [];
      for (let k = 0; k < 3; k++) {
        await sleep(3500);
        runs.push(await ctx.sw.evaluate(async (t, g) => {
          const s = performance.now();
          const r = await engageFrame(t, 0, { cmd: "engage", gain: g, useLimiter: true });
          return { ms: performance.now() - s, ok: !!(r && r.ok), held: !!(r && r.ok && !("signal" in r)) };
        }, tabId, 0.05 + k * 0.01));
      }
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      const median = runs.map((x) => x.ms).sort((x, y) => x - y)[1];
      ctx.note(`engage roundtrips ${runs.map((x) => x.ms.toFixed(0)).join(", ")} ms at 4x CPU, median ${median.toFixed(0)} ms`);
      if (!runs.every((x) => x.ok && x.held)) return `setup failed: an engage did not update the held clip (${JSON.stringify(runs)})`;
      if (median > 120) return `BUG: a slider move on the paused held clip waits ${median.toFixed(0)} ms (median) for a walk`;
      return true;
    } finally {
      try { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); } catch (_) {}
      try { await cdp.detach(); } catch (_) {}
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The restore path's arm at a new level starts the interval of full walks over, as a slider
  // move does. A clip is hooked in its root and paused, so nothing sounds, and the worker's
  // restore passes are dropped for the tab. Probes run until two walks have doubled the interval
  // to at least 4 s. 2 s later a probe finds no walk due. Then the worker arms the frame at a new
  // level (as restoreAfterLoad does), and the next probe walks the page. Walks are counted as in
  // s92c.
  async s92g_arm_new_level_walks_again(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?armwalks");
    let tabId = null;
    try {
      tabId = await tabIdByUrl(ctx.sw, "?armwalks");
      await asContentScript(ctx.sw, tabId, () => {
        const set = window.setTimeout;
        const st = window.__walks = { n: 0 };
        window.setTimeout = function (fn, ms, ...rest) {
          if (typeof fn === "function" && fn.name === "walkSlice") st.n++;
          return set.call(window, fn, ms, ...rest);
        };
        return true;
      });
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await ctx.sw.evaluate((t) => {
        globalThis.__s92g = { origKick: kickRestore };
        kickRestore = (id, d) => (id === t ? Promise.resolve() : globalThis.__s92g.origKick(id, d));
      }, tabId);
      const walks = () => asContentScript(ctx.sw, tabId, () => window.__walks.n);
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      let seen = 0, last = await walks();
      for (const until = Date.now() + 15000; seen < 2 && Date.now() < until;) {
        await ctx.sw.evaluate((t) => predictMode(t), tabId);
        const n = await walks();
        if (n > last) { seen++; last = n; } else await sleep(250);
      }
      if (seen < 2) return `setup failed: ${seen} walk(s) in 15 s of probes while nothing sounds`;
      await sleep(2000);
      const n1 = await walks();
      await ctx.sw.evaluate((t) => predictMode(t), tabId);
      const n2 = await walks();
      const armed = await ctx.sw.evaluate((t) => toFrame(t, 0, { cmd: "arm", gain: 0.1, useLimiter: true }), tabId);
      await ctx.sw.evaluate((t) => predictMode(t), tabId);
      const n3 = await walks();
      ctx.note(`walks: ${n2 - n1} for a probe before the arm, ${n3 - n2} for a probe after it (arm ${JSON.stringify(armed)})`);
      if (n2 - n1) return `setup failed: a walk was due before the arm (${n2 - n1})`;
      if (!armed || !armed.ok) return `setup failed: the arm was not answered (${JSON.stringify(armed)})`;
      if (n3 - n2 < 1) return "BUG: no walk after the arm at a new level";
      return true;
    } finally {
      await ctx.sw.evaluate((t) => {
        if (!globalThis.__s92g) return;
        kickRestore = globalThis.__s92g.origKick;
        pendingRekick.delete(t);
        delete globalThis.__s92g;
      }, tabId);
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A player whose element is defined after insertion starts unmuted the moment it renders, in a
  // root nobody listens to yet. The recheck of undefined elements finds the root after the play
  // and takes it as the missed play, in-page, on the armed frame. The definition is timed from
  // the measured injection, which starts the recheck chain (checks 50, 150, 350, 750, 1550 and
  // 3150 ms after it): at 2200 ms the play lands well between two checks. Nothing asks the
  // frame for a measure until the check is over: a measure holds the frame's command queue for
  // 600 ms, and the hook would then wait for the worker like any play during a command. The
  // worker's restore passes are dropped for the tab meanwhile, so no pass's arm takes it first.
  async s93_shadow_missed_play_on_upgrade(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    let undrop = null;
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await waitClipPlaying(page, a);
      const name = await page.evaluate(() => window.feed.addUndefined({ muted: false }));
      const tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      const injectedAt = Date.now();
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const wait = injectedAt + 2200 - Date.now();
      if (wait < 100) return `setup failed: the setup ran past the planned definition (${-wait} ms late)`;
      await sleep(wait);
      await swClearSpy(ctx.sw);
      undrop = await dropPasses(ctx.sw, tabId);
      const id = await page.evaluate((n) => window.feed.defineLate(n), name);
      await sleep(injectedAt + 3600 - Date.now());
      return await assertTakenInPage(ctx, page, id, tabId, "clip that started at its upgrade");
    } finally {
      if (undrop) await undrop();
      await page.close();
    }
  },

  // A long feed creates far more roots than it keeps (Reddit: 3534 in 75 s, about 2300 live).
  // After more than 10,500 roots came and went, the next batch's players still get their roots
  // observed: a clip renders into its root asynchronously and autoplays audibly, and the armed
  // frame takes it in-page at its start. No cap on observed roots can run out.
  async s94_shadow_long_feed_churn(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      const created = await page.evaluate(() => window.feed.churn(10, 30));
      const live = await page.evaluate(() => window.feed.liveRoots());
      ctx.note(`${created} roots created, ${live} live`);
      if (created < 10500 || live >= 2000) return `setup failed: ${created} roots created, ${live} live`;
      await sleep(2600);
      await waitIdle(ctx.sw, setup.tabId, 15000, 1500);
      await swClearSpy(ctx.sw);
      const ids = await page.evaluate(() => window.feed.addBatch(3, [{}, { muted: false }, {}]));
      await waitClipPlaying(page, ids[1]);
      return await assertTakenInPage(ctx, page, ids[1], setup.tabId, "audible clip of the batch after the churn");
    } finally { await page.close(); }
  },

  // The hooked blob post is unloaded while a clip without CORS sounds, and no capture grant
  // exists (about half of Reddit's clips are packaged mp4 from another origin). The restore pass
  // finds only capture for that clip, cannot start one, and leaves the top frame armed at the
  // level: the next blob clip is taken in-page at its play, the level stays stored, and no
  // stream of refused engages runs (at most 3 in 10 s).
  async s95_shadow_unload_while_mp4_plays(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      const x = await page.evaluate(() => window.feed.add({ src: "cross", muted: false }));
      await waitClipPlaying(page, x);
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await sleep(1000);
      await waitIdle(ctx.sw, setup.tabId, 15000, 1500);
      await swClearSpy(ctx.sw);
      const t0 = Date.now();
      await page.evaluate((i) => window.feed.remove(i), setup.a);
      const c = await page.evaluate(() => window.feed.add({ muted: false, autoplay: false }));
      await page.waitForFunction((i) => { const s = window.feed.state(i); return !!s && s.connected && s.ready >= 1; }, { timeout: 3000 }, c);
      await sleep(1000);
      await waitIdle(ctx.sw, setup.tabId, 15000, 1500);
      const playAt = Date.now();
      await page.evaluate((i) => window.feed.play(i), c);
      await sleep(Math.max(1500, t0 + 10000 - Date.now()));
      const log = await swSpyLog(ctx.sw);
      const refused = log.filter((e) => e.cmd === "engage" && e.res && e.res.ok === false && e.t <= t0 + 10000).length;
      const byWorker = log.find((e) => e.cmd === "engage" && e.t >= playAt - 50 && e.res && e.res.ok && "signal" in e.res);
      const gain = await swGetGain(ctx.sw, setup.tabId);
      const m = await measureTop(ctx.sw, setup.tabId);
      ctx.note(`${refused} refused engage(s) in 10 s, gain ${gain}, measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (gain !== 0.05) return `BUG: the tab lost its level (${gain})`;
      if (refused > 3) return `BUG: ${refused} refused engages in 10 s`;
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the next blob clip does not play at the 0.05x level (measure ${JSON.stringify(m)})`;
      if (byWorker) return "BUG: the worker's engage hooked the next blob clip, so it started at native level";
      if (!(await page.evaluate((i) => window.feed.isHooked(i), c))) return "BUG: the next blob clip was never hooked";
      return true;
    } finally { await page.close(); }
  },

  // A player defined after its element has been pending for longer than PENDING_LIFE (8 s): no
  // recheck looks for it any more. Its clip autoplays audibly in a root nothing observes or
  // listens to, so this frame has no signal of it at all, and it plays at native level until the
  // next probe. That probe (a slider move) sweeps the page, finds the sounding clip and hooks it.
  async s96_shadow_defined_after_pending_life(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    let tabId = null;
    try {
      const name = await page.evaluate(() => window.feed.addUndefined({ muted: false }));
      tabId = await tabIdByUrl(ctx.sw, "shadow-feed.html");
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      const injectedAt = Date.now();
      await sleep(injectedAt + 10500 - Date.now());
      await swClearSpy(ctx.sw);
      const id = await page.evaluate((n) => window.feed.defineLate(n), name);
      await waitClipPlaying(page, id);
      await sleep(1500);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const r = await swSetGain(ctx.sw, tabId, 0.05);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`${pings} ping(s) while the clip played unseen, setGain ${JSON.stringify(r)}, measure ${m && m.ok ? m.rms.toFixed(3) : JSON.stringify(m)}`);
      if (r.mode !== "element" || !r.confirmed) return `BUG: the slider move did not find the late player: ${JSON.stringify(r)}`;
      if (!m || !m.ok || m.rms > 0.1) return `BUG: the late player is not at the 0.05x level (measure ${JSON.stringify(m)})`;
      return true;
    } finally {
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A root with two media, found when the second one already sounds: a paused clip first, then
  // an audible one that started before its host was inserted. Every medium of a root that gets
  // its listeners for the first time is checked, not just the first one the walk meets: the sounding clip
  // is taken in-page as its missed play. The worker's restore passes are dropped for the tab
  // meanwhile, so no pass's arm takes it first.
  async s97_shadow_second_medium_already_sounding(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    let undrop = null;
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      undrop = await dropPasses(ctx.sw, setup.tabId);
      const ids = await page.evaluate(() => window.feed.addPreplayed());
      return await assertTakenInPage(ctx, page, ids.second, setup.tabId, "second medium of a new root");
    } finally {
      if (undrop) await undrop();
      await page.close();
    }
  },

  // A clip started while detached, then inserted as a leaf into a root that carries the
  // listeners already: its play event never reached that root. Sounding as it arrives, it is
  // taken in-page as its missed play. The worker's restore passes are dropped for the tab
  // meanwhile, so no pass's arm takes it first.
  async s98_shadow_leaf_inserted_sounding(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    let undrop = null;
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      undrop = await dropPasses(ctx.sw, setup.tabId);
      const v = await page.evaluate((i) => window.feed.insertPlaying(i), setup.a);
      if (!v) return "setup failed: the clip was not inserted";
      return await assertTakenInPage(ctx, page, v, setup.tabId, "clip inserted while it played");
    } finally {
      if (undrop) await undrop();
      await page.close();
    }
  },

  // One observer callback walks at most SCAN_MAX elements (20,000) in all, however many subtrees
  // its batch brings. Here one insertion of 100 hosts, each with 2000 elements in its root, and a
  // player at its end: the callback stops early, so its cost stays bounded, and hands the rest to
  // a sweep 300 ms later, which finds the player. A play in it is then taken in-page. The
  // worker's restore passes are dropped for the tab meanwhile, so no probe can find it first.
  async s99_shadow_batch_past_budget(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    let tabId = null;
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      tabId = setup.tabId;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await sleep(2600);
      await ctx.sw.evaluate((t) => {
        globalThis.__s99 = { origKick: kickRestore };
        kickRestore = (id, d) => (id === t ? Promise.resolve() : globalThis.__s99.origKick(id, d));
      }, tabId);
      const r = await page.evaluate(() => window.feed.addHeavy(100, 2000));
      ctx.note(`callbacks of the batch ${r.ms.toFixed(1)} ms`);
      if (r.ms > 60) return `BUG: the batch's observer callbacks took ${r.ms.toFixed(1)} ms: the walk is not bounded per callback`;
      await sleep(2600); // the sweep runs at 300 ms and its ping drains
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), r.id);
      return await assertHookedInPage(ctx, page, r.id, "play in the player the sweep found");
    } finally {
      await ctx.sw.evaluate((t) => {
        if (!globalThis.__s99) return;
        kickRestore = globalThis.__s99.origKick;
        pendingRekick.delete(t);
        delete globalThis.__s99;
      }, tabId);
      await page.close();
    }
  },

  // A batch past the callback's budget (100 hosts with 250 elements in their roots) whose last
  // post holds a player inserted before its element is defined, in the same callback. The full
  // walk that takes the rest of the batch notes the undefined element, so the recheck comes back
  // for it after the upgrade. The player starts audibly as it renders, in a root nobody listens
  // to yet, and the recheck takes that play in-page as a missed play.
  async s99b_cut_batch_late_upgrade(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await sleep(2600);
      const name = await page.evaluate(() => {
        const frag = document.createDocumentFragment();
        const inner = "<i></i>".repeat(250);
        for (let i = 0; i < 100; i++) {
          const post = document.createElement("div");
          post.className = "post";
          post.appendChild(document.createElement("div")).attachShadow({ mode: "open" }).innerHTML = inner;
          frag.appendChild(post);
        }
        document.getElementById("feed").appendChild(frag);
        return window.feed.addUndefined({ muted: false }); // the same task: the same observer callback
      });
      await sleep(900);
      await swClearSpy(ctx.sw);
      const id = await page.evaluate((n) => window.feed.defineLate(n), name);
      await waitClipPlaying(page, id);
      await sleep(1000);
      return await assertTakenInPage(ctx, page, id, setup.tabId, "clip that started at its upgrade in a cut batch");
    } finally { await page.close(); }
  },

  // s99 with a player that starts audibly the moment it renders, at the end of the batch past the
  // callback's budget. Its root gets the media listeners only from the full walk that takes the
  // rest of the batch, after the play: the walk takes it in-page as a missed play. The worker's
  // restore passes are dropped for the tab meanwhile, so no probe can find it first.
  async s99c_cut_batch_player_already_sounding(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    let tabId = null;
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      tabId = setup.tabId;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await sleep(2600);
      await ctx.sw.evaluate((t) => {
        globalThis.__s99 = { origKick: kickRestore };
        kickRestore = (id, d) => (id === t ? Promise.resolve() : globalThis.__s99.origKick(id, d));
      }, tabId);
      await swClearSpy(ctx.sw);
      const r = await page.evaluate(() => window.feed.addHeavy(100, 2000, { autoplay: true }));
      await waitClipPlaying(page, r.id);
      return await assertTakenInPage(ctx, page, r.id, tabId, "clip that started at the end of a cut batch");
    } finally {
      await ctx.sw.evaluate((t) => {
        if (!globalThis.__s99) return;
        kickRestore = globalThis.__s99.origKick;
        pendingRekick.delete(t);
        delete globalThis.__s99;
      }, tabId);
      await page.close();
    }
  },

  // An insertion past the callback's budget (140 light posts, 21,000 elements) with an iframe at
  // its end whose page plays an audible clip. The part the budget cut still gets the native query
  // for media and iframes, so the insertion signals at once: the worker injects into the new
  // frame and puts the tab's level on the clip there. At once means from the callback itself,
  // so the signal reaches the worker within 480 ms of the insertion (the ping waits 250 ms). The
  // full walk that takes the cut part finds the iframe as well, but starts only 300 ms later, and
  // its signal waits the same 250 ms on top.
  async s99d_cut_insertion_iframe_gets_level(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await sleep(1000);
      await waitIdle(ctx.sw, setup.tabId, 15000, 1500);
      await sleep(2000); // the last ping lies 2 s back: the next one waits its shortest delay
      await ctx.sw.evaluate(() => {
        if (globalThis.__pingTimes) { globalThis.__pingTimes.length = 0; return; }
        globalThis.__pingTimes = [];
        chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "navigated") globalThis.__pingTimes.push(Date.now()); });
      });
      await swClearSpy(ctx.sw);
      const t0 = Date.now();
      await page.evaluate(() => window.feed.addLight(140, 150, "iframe"));
      let m = null, fid = null;
      while (Date.now() - t0 < 8000 && !(m && m.ok && m.signal)) {
        await sleep(250);
        if (fid == null) fid = await frameIdOf(ctx.sw, setup.tabId, "tailframe=1");
        if (fid != null) m = await ctx.sw.evaluate((t, f) => chrome.tabs.sendMessage(t, { cmd: "measure" }, { frameId: f }).catch(() => null), setup.tabId, fid);
      }
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const first = await ctx.sw.evaluate(() => globalThis.__pingTimes[0] || null);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage" && e.frameId === fid && e.res && e.res.ok).length;
      ctx.note(`${pings} ping(s), the first ${first == null ? "never" : first - t0 + " ms"} after the insertion, ${engages} engage(s) in the new frame, measure there ${fmtMeasure(m)}`);
      if (first == null) return "BUG: the insertion sent no signal";
      if (first - t0 > 480) return `BUG: the insertion signalled ${first - t0} ms late: only the full walk found the iframe`;
      if (!m || !m.ok || !m.signal) return `BUG: the clip in the new frame is not hooked (${fmtMeasure(m)})`;
      if (m.rms > 0.1) return `BUG: the clip in the new frame plays at rms ${m.rms.toFixed(3)}, not at the 0.05x level`;
      if (!engages) return "BUG: no engage reached the new frame";
      return true;
    } finally { await page.close(); }
  },

  // s99d with the whole insertion as ONE added node: a wrapper holding the 140 light posts and the
  // iframe post at its end. The callback's budget cuts the walk of that wrapper itself, so only
  // the native query on the node whose walk was cut signals the iframe at once (within 480 ms of
  // the insertion, as in s99d).
  async s99f_cut_node_holds_iframe(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?cutnode");
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await sleep(1000);
      await waitIdle(ctx.sw, setup.tabId, 15000, 1500);
      await sleep(2000); // the last ping lies 2 s back: the next one waits its shortest delay
      await ctx.sw.evaluate(() => {
        if (globalThis.__pingTimes) { globalThis.__pingTimes.length = 0; return; }
        globalThis.__pingTimes = [];
        chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "navigated") globalThis.__pingTimes.push(Date.now()); });
      });
      await swClearSpy(ctx.sw);
      const t0 = Date.now();
      await page.evaluate(() => {
        const wrap = document.createElement("div");
        for (let i = 0; i < 140; i++) {
          const post = document.createElement("div");
          post.className = "post";
          for (let k = 0; k < 150; k++) post.appendChild(document.createElement(k % 10 ? "span" : "p"));
          wrap.appendChild(post);
        }
        const post = document.createElement("div");
        post.className = "post";
        const f = document.createElement("iframe");
        f.src = "/x-feed.html?auto=audible&tailframe=1";
        f.style.cssText = "width:520px;height:400px;border:0;display:block";
        post.appendChild(f);
        wrap.appendChild(post);
        document.getElementById("feed").appendChild(wrap);
      });
      let m = null, fid = null;
      while (Date.now() - t0 < 8000 && !(m && m.ok && m.signal)) {
        await sleep(250);
        if (fid == null) fid = await frameIdOf(ctx.sw, setup.tabId, "tailframe=1");
        if (fid != null) m = await ctx.sw.evaluate((t, f) => chrome.tabs.sendMessage(t, { cmd: "measure" }, { frameId: f }).catch(() => null), setup.tabId, fid);
      }
      const first = await ctx.sw.evaluate(() => globalThis.__pingTimes[0] || null);
      ctx.note(`first ping ${first == null ? "never" : first - t0 + " ms"} after the insertion, measure in the frame ${fmtMeasure(m)}`);
      if (first == null) return "BUG: the insertion sent no signal";
      if (first - t0 > 480) return `BUG: the insertion signalled ${first - t0} ms late: only the full walk found the iframe`;
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the clip in the new frame is not at the level (${fmtMeasure(m)})`;
      return true;
    } finally { await page.close(); }
  },

  // s99d with the iframe inside the open root of a plain host. The native query cannot see into
  // that root, so the full walk that takes the cut part signals the iframe it meets there, as
  // the insertion would have.
  async s99e_cut_insertion_iframe_in_root(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port);
    try {
      const setup = await shadowSetup(ctx, page, 0.05);
      if (typeof setup === "string") return setup;
      await page.evaluate((i) => window.feed.pause(i), setup.a);
      await sleep(1000);
      await waitIdle(ctx.sw, setup.tabId, 15000, 1500);
      await swClearSpy(ctx.sw);
      await page.evaluate(() => window.feed.addLight(140, 150, "rootframe"));
      const t0 = Date.now();
      let m = null, fid = null;
      while (Date.now() - t0 < 8000 && !(m && m.ok && m.signal)) {
        await sleep(250);
        if (fid == null) fid = await frameIdOf(ctx.sw, setup.tabId, "tailframe=1");
        if (fid != null) m = await ctx.sw.evaluate((t, f) => chrome.tabs.sendMessage(t, { cmd: "measure" }, { frameId: f }).catch(() => null), setup.tabId, fid);
      }
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      ctx.note(`${pings} ping(s), measure in the new frame ${fmtMeasure(m)}`);
      if (!m || !m.ok || !m.signal) return `BUG: the clip in the frame inside the root is not hooked (${fmtMeasure(m)})`;
      if (m.rms > 0.1) return `BUG: the clip in the frame inside the root plays at rms ${m.rms.toFixed(3)}, not at the 0.05x level`;
      return true;
    } finally { await page.close(); }
  },

  // ---- what the real-site measurements asked for ----
  // A capture holds the tab on a feed whose clips no in-page hook can take (another origin, no
  // CORS), and the page drops each clip's element soon after it scrolls away. A pass sees the
  // clip sound (heard, standing apart in a post of its own). Then its element leaves, and the
  // next pass finds nothing in the top frame and only a muted, playing ad video in a sub-frame,
  // which a hook could take. The capture keeps the tab: no engage of the ad video, no capture
  // stop, and the same holds with the moment the probe noted 110 s back, late in the window.
  // Once that moment lies more than two minutes back, the same pass moves
  // the tab to element mode on the ad frame, as it does where nothing was heard. The engine's
  // update ack is stubbed (as in s78), so the capture is live by the worker's records.
  async s100_sticky_capture_outlives_clip_element(ctx) {
    const { page } = await newDecoyPage(ctx.browser, ctx.port, "decoy=offscreen&state=mutedplaying");
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    const stops = () => ctx.sw.evaluate(() => globalThis.__stubCap.stops);
    const heardNote = () => ctx.sw.evaluate((t) => (typeof TABHEARD === "function" ? sget(TABHEARD(t)) : null), tabId);
    try {
      await stubCapture(ctx.sw, tabId);
      await recordCapture(ctx.sw, tabId, 0.05);
      await swClearSpy(ctx.sw);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const m0 = await swGetMode(ctx.sw, tabId);
      const note = await heardNote();
      if (!m0 || m0.mode !== "capture") return `setup failed: the pass over the sounding clip did not keep the capture (${JSON.stringify(m0)})`;
      await ctx.sw.evaluate(() => { globalThis.__stubCap.stops = 0; });
      await swClearSpy(ctx.sw);
      await page.evaluate(() => document.getElementById("content").remove());
      await sleep(2600); // the removal's ping and its pass
      await ctx.sw.evaluate((t) => kickRestore(t, true), tabId);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      let log = await swSpyLog(ctx.sw);
      const probes = log.filter((e) => e.cmd === "probe").length;
      let engages = log.filter((e) => e.cmd === "engage");
      let mode = await swGetMode(ctx.sw, tabId);
      let st = await stops();
      ctx.note(`note ${note ? "kept" : "none"}, after the clip left: ${probes} probe(s), ${engages.length} engage(s), ${st} capture stop(s), mode ${JSON.stringify(mode)}`);
      if (!probes) return "setup failed: no pass looked at the page after the clip left";
      if (engages.length) return `BUG: a quiet pass engaged the ad video and moved the tab off the capture (${JSON.stringify(engages.map((e) => e.res))})`;
      if (st) return `BUG: a quiet pass stopped the capture (${st})`;
      if (!mode || mode.mode !== "capture") return `BUG: the capture record is gone after the clip left (${JSON.stringify(mode)})`;
      // late in the window: a note 110 s old still keeps the capture
      await ctx.sw.evaluate(async (t) => { const h = await sget(TABHEARD(t)); if (h) await sset(TABHEARD(t), { ...h, at: Date.now() - 110000 }); }, tabId);
      await ctx.sw.evaluate(() => { globalThis.__stubCap.stops = 0; });
      await swClearSpy(ctx.sw);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      log = await swSpyLog(ctx.sw);
      engages = log.filter((e) => e.cmd === "engage");
      mode = await swGetMode(ctx.sw, tabId);
      st = await stops();
      ctx.note(`110 s later: ${log.filter((e) => e.cmd === "probe").length} probe(s), ${engages.length} engage(s), ${st} capture stop(s), mode ${JSON.stringify(mode)}`);
      if (engages.length || st || !mode || mode.mode !== "capture") return `BUG: a note 110 s old does not keep the capture (${engages.length} engage(s), ${st} stop(s), mode ${JSON.stringify(mode)})`;
      // the end of the window
      await ctx.sw.evaluate(async (t) => { const h = await sget(TABHEARD(t)); if (h) await sset(TABHEARD(t), { ...h, at: Date.now() - 130000 }); }, tabId);
      await ctx.sw.evaluate(() => { globalThis.__stubCap.stops = 0; });
      await swClearSpy(ctx.sw);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      log = await swSpyLog(ctx.sw);
      engages = log.filter((e) => e.cmd === "engage" && e.frameId !== 0 && e.res && e.res.ok);
      mode = await swGetMode(ctx.sw, tabId);
      st = await stops();
      ctx.note(`two minutes later: ${engages.length} engage(s) on the ad frame, ${st} capture stop(s), mode ${JSON.stringify(mode)}`);
      if (!engages.length || !mode || mode.mode !== "element" || !st) return `BUG: a note older than two minutes still keeps the capture (mode ${JSON.stringify(mode)}, ${st} stop(s))`;
      return true;
    } finally {
      await unstubCapture(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The note belongs to the top document it was made in. A probe notes a heard clip while a
  // capture holds the tab (live by the worker's records, stubbed as in s100), and the tab moves on
  // to another site that plays a hookable clip. The pass there moves the tab to element mode with
  // the level on the clip, as on any page where nothing was heard.
  async s100b_heard_note_stays_with_its_document(ctx) {
    const { page } = await newDecoyPage(ctx.browser, ctx.port, "decoy=offscreen&state=muted");
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await stubCapture(ctx.sw, tabId);
      await recordCapture(ctx.sw, tabId, 0.05);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const note = await ctx.sw.evaluate((t) => sget(TABHEARD(t)), tabId);
      const m0 = await swGetMode(ctx.sw, tabId);
      if (!note || !m0 || m0.mode !== "capture") return `setup failed: no note or no capture (${JSON.stringify(note)}, ${JSON.stringify(m0)})`;
      await swClearSpy(ctx.sw);
      await page.goto(`http://localhost:${ctx.port}/?auto=audible`, { waitUntil: "load" });
      const { hit } = await waitEngage(ctx.sw, (x) => x.ok === true, 8000);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const mode = await swGetMode(ctx.sw, tabId);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`on the next site: engage ${hit ? JSON.stringify(hit.res) : "none"}, mode ${JSON.stringify(mode)}, measure ${fmtMeasure(m)}`);
      if (!hit || !mode || mode.mode !== "element") return `BUG: a note from the previous site keeps the capture on the next one (mode ${JSON.stringify(mode)})`;
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the clip on the next site does not play at the 0.05x level (${fmtMeasure(m)})`;
      return true;
    } finally {
      await unstubCapture(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A feed scrolled back up puts the same node back (a virtualized list keeps it). Clip A holds
  // the level, its node leaves the DOM (the removal pauses it, and its graph goes dormant), four
  // more clips are hooked in-page after it, and A's node comes back and plays. With the worker's
  // passes held back, A is re-adopted in the page as the frame's hook, plays at the level, and
  // its playback advances.
  async s101_parked_clip_back_at_level(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const r = await parkedReturn(ctx, page, tabId);
      if (typeof r === "string") return r;
      ctx.note(`parked ${r.parked} before A came back, A's source sent to ${JSON.stringify(r.asleep)}, A ${JSON.stringify(r.play)}, tap ${JSON.stringify(r.tap)}, live graph ${fmtMeasure(r.m)}`);
      if (!r.play || r.play.advanced < 0.2) return `BUG: the returning clip is stalled (${JSON.stringify(r.play)})`;
      if (!r.tap || !(r.tap.pre > 0.05)) return `BUG: the returning clip is silent (${JSON.stringify(r.tap)})`;
      if (!(r.tap.ratio < 0.1)) return `BUG: the returning clip does not play at the 0.05x level (ratio ${r.tap.ratio})`;
      if (!r.m || !r.m.ok || !r.m.signal || r.m.rms > 0.1) return `BUG: the page's own paths did not take the returning clip back as the frame's hook (live graph ${fmtMeasure(r.m)})`;
      return true;
    } finally { await page.close(); }
  },

  // A parked clip that pauses goes dormant: its source node sends nowhere. Clip A holds the level
  // (0.05x) and pauses, and clip B takes the hook in-page when the page unmutes it, so A is parked
  // while paused. B keeps sounding, and the page plays A again: the rule that never takes the hook
  // off a sounding clip leaves it on B, and A plays on its own graph, woken in its play event, at
  // the tab level and with its playback advancing. Paused again, it goes dormant again. The
  // worker's passes are held back, so the level A plays at is the one its wake set. Once with
  // light-DOM clips, once with clips in open shadow roots.
  async s101b_paused_clip_sleeps_and_wakes_at_level(ctx) {
    for (const kind of ["light", "shadow"]) {
      const page = kind === "light" ? await newFeedPage(ctx.browser, ctx.port) : await newShadowPage(ctx.browser, ctx.port, "?s101b");
      const tabId = kind === "light" ? await tabIdOf(ctx.sw, ctx.port) : await tabIdByUrl(ctx.sw, "s101b");
      const restore = await dropPasses(ctx.sw, tabId);
      try {
        await tapInstall(ctx.sw, tabId);
        const a = await page.evaluate(() => window.feed.addAudible());
        if (kind === "shadow") await waitClipPlaying(page, a);
        await sleep(300);
        const r1 = await swSetGain(ctx.sw, tabId, 0.05);
        if (r1.mode !== "element" || !r1.confirmed) return `setup failed (${kind}): ${JSON.stringify(r1)}`;
        await page.evaluate((i) => window.feed.pause(i), a);
        const b = await page.evaluate(() => window.feed.add());
        if (kind === "shadow") await waitClipPlaying(page, b);
        await sleep(400);
        await page.evaluate((i) => window.feed.unmute(i), b);
        await sleep(2600); // the insertion's churn drains
        const asleep = await tapOuts(ctx.sw, tabId, a);
        const bTaken = await tapOuts(ctx.sw, tabId, b);
        await page.evaluate((i) => window.feed.play(i), a);
        await sleep(600);
        const play = await playback(page, a, 500); // read before the tap below pulls on the source
        const tap = await tapLevels(ctx.sw, tabId, a, 600);
        ctx.note(`${kind}: A's source sent to ${JSON.stringify(asleep)} while paused, A ${JSON.stringify(play)}, tap ${JSON.stringify(tap)}`);
        if (!bTaken) return `setup failed (${kind}): the page's unmute did not hook B`;
        if (!Array.isArray(asleep) || asleep.length) return `BUG (${kind}): the paused parked clip did not go dormant (its source sends to ${JSON.stringify(asleep)})`;
        if (!play || play.paused) return `setup failed (${kind}): A did not play again (${JSON.stringify(play)})`;
        if (play.advanced < 0.2) return `BUG (${kind}): the woken clip is stalled (${JSON.stringify(play)})`;
        if (!tap || !(tap.pre > 0.05)) return `BUG (${kind}): the woken clip is silent (${JSON.stringify(tap)})`;
        if (!(tap.ratio < 0.1)) return `BUG (${kind}): the woken clip does not play at the 0.05x level (ratio ${tap.ratio})`;
        await page.evaluate((i) => window.feed.pause(i), a);
        await sleep(300);
        const again = await tapOuts(ctx.sw, tabId, a);
        if (!Array.isArray(again) || again.length) return `BUG (${kind}): the woken clip did not go dormant again at its next pause (its source sends to ${JSON.stringify(again)})`;
      } finally {
        await restore();
        await swSetGain(ctx.sw, tabId, 1).catch(() => {});
        await page.close();
      }
    }
    return true;
  },

  // A dormant clip played while it is out of the DOM. Clip A holds the level, its post leaves the
  // DOM (the removal pauses it, the frame parks it, and it goes dormant), and the page calls play()
  // on the detached node. Only A's own play listener hears that, and A plays on its graph,
  // advancing, at the tab level.
  async s101c_dormant_clip_plays_out_of_dom(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => { window.__a = document.getElementById(i); window.feed.detach(i); }, a);
      await sleep(2600);
      await waitIdle(ctx.sw, tabId, 12000, 1500); // the pass for the lost element finds nothing and gives up
      const asleep = await tapOuts(ctx.sw, tabId, a);
      const paused = await page.evaluate(() => window.__a.paused);
      await page.evaluate(() => { window.__a.play().catch(() => {}); });
      await sleep(600);
      const play = await page.evaluate(async () => {
        const v = window.__a, t1 = v.currentTime;
        await new Promise((r) => setTimeout(r, 500));
        let d = v.currentTime - t1;
        if (d < 0 && v.loop) d += v.duration;
        return { paused: v.paused, connected: v.isConnected, advanced: +d.toFixed(3) };
      });
      const tap = await tapLevels(ctx.sw, tabId, a, 600);
      ctx.note(`out of the DOM: paused ${paused}, A's source sent to ${JSON.stringify(asleep)}, played there ${JSON.stringify(play)}, tap ${JSON.stringify(tap)}`);
      if (!paused || !Array.isArray(asleep) || asleep.length) return `setup failed: A did not go dormant out of the DOM (paused ${paused}, source sends to ${JSON.stringify(asleep)})`;
      if (play.paused || play.connected) return `setup failed: A did not play out of the DOM (${JSON.stringify(play)})`;
      if (play.advanced < 0.2) return `BUG: the dormant clip played out of the DOM is stalled (${JSON.stringify(play)})`;
      if (!tap || !(tap.pre > 0.05)) return `BUG: the dormant clip played out of the DOM is silent (${JSON.stringify(tap)})`;
      if (!(tap.ratio < 0.1)) return `BUG: the dormant clip played out of the DOM is not at the 0.05x level (ratio ${tap.ratio})`;
      return true;
    } finally {
      await page.evaluate(() => { if (window.__a) window.__a.pause(); }).catch(() => {});
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A dormant clip in an orphaned world (the extension was updated or reloaded: chrome.runtime
  // disappears from the isolated world, as in s33). Clip A holds the level and pauses, clip B
  // takes the hook in-page and pauses as well, so A is dormant. The world is orphaned, and the
  // page plays A: the orphaned world sets no level and keeps nothing, but A's source goes straight
  // to the destination, so A plays at its own level and advances.
  async s101d_orphaned_world_dormant_clip_plays(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const b = await page.evaluate(() => window.feed.add());
      await sleep(400);
      await page.evaluate((i) => window.feed.unmute(i), b);
      await sleep(600);
      await page.evaluate((i) => window.feed.pause(i), b);
      await sleep(2600); // the insertion's churn drains
      const asleep = await tapOuts(ctx.sw, tabId, a);
      await ctx.sw.evaluate((t) => chrome.scripting.executeScript({
        target: { tabId: t },
        func: () => { Object.defineProperty(chrome, "runtime", { get: () => undefined, configurable: true }); },
      }), tabId);
      await page.evaluate((i) => window.feed.play(i), a);
      await sleep(600);
      const play = await playback(page, a, 500); // read before the tap below pulls on the source
      const tap = await tapLevels(ctx.sw, tabId, a, 600);
      ctx.note(`A's source sent to ${JSON.stringify(asleep)} before the orphaning, A ${JSON.stringify(play)}, tap ${JSON.stringify(tap)}`);
      if (!Array.isArray(asleep) || asleep.length) return `setup failed: A did not go dormant (its source sends to ${JSON.stringify(asleep)})`;
      if (!play || play.paused) return `setup failed: A did not play (${JSON.stringify(play)})`;
      if (play.advanced < 0.2) return `BUG: the orphaned world's dormant clip is stalled (${JSON.stringify(play)})`;
      if (!tap || !(tap.pre > 0.05)) return `BUG: the orphaned world's dormant clip is silent (${JSON.stringify(tap)})`;
      const src = (tap.chain && tap.chain.source) || [];
      if (src.length !== 1 || src[0] !== "AudioDestinationNode") return `BUG: the orphaned world's dormant clip does not go straight to the destination (${JSON.stringify(tap.chain)})`;
      return true;
    } finally { await page.close(); }
  },

  // An engage whose rule picks a dormant clip takes its graph back: the hook is ours and still
  // there, never 'own-hook-lost'. Clip A holds the level and pauses, clip B takes the hook in-page
  // and pauses, so A is dormant, and B's post leaves the DOM (the worker's passes are held back).
  // A slider move engages the frame, and the rule picks A, the one element left. The engage takes
  // A's graph back, and A plays at the new level.
  async s101e_engage_readopts_dormant_clip(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    const restore = await dropPasses(ctx.sw, tabId);
    try {
      await tapInstall(ctx.sw, tabId);
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const b = await page.evaluate(() => window.feed.add());
      await sleep(400);
      await page.evaluate((i) => window.feed.unmute(i), b);
      await sleep(600);
      await page.evaluate((i) => { window.feed.pause(i); window.feed.remove(i); }, b);
      await sleep(600); // the frame's watcher parks B
      const asleep = await tapOuts(ctx.sw, tabId, a);
      await swClearSpy(ctx.sw);
      const r2 = await swSetGain(ctx.sw, tabId, 0.1);
      const engages = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage").map((e) => e.res);
      const back = await tapOuts(ctx.sw, tabId, a);
      await page.evaluate((i) => window.feed.play(i), a);
      await sleep(600);
      const play = await playback(page, a, 500);
      const tap = await tapLevels(ctx.sw, tabId, a, 600);
      ctx.note(`A's source sent to ${JSON.stringify(asleep)} before the engage, ${JSON.stringify(back)} after it, slider move ${JSON.stringify(r2)}, engages ${JSON.stringify(engages)}, A ${JSON.stringify(play)}, tap ${JSON.stringify(tap)}`);
      if (!Array.isArray(asleep) || asleep.length) return `setup failed: A did not go dormant (its source sends to ${JSON.stringify(asleep)})`;
      if (engages.some((x) => x && x.reason === "own-hook-lost")) return "BUG: the engage found A's own hook without its graph (own-hook-lost)";
      if (!engages.some((x) => x && x.ok)) return `BUG: the engage did not take the dormant clip back (${JSON.stringify(engages)})`;
      if (!play || play.advanced < 0.2) return `BUG: the re-adopted clip is stalled (${JSON.stringify(play)})`;
      if (!tap || !(tap.pre > 0.05) || !(tap.ratio > 0.07 && tap.ratio < 0.14)) return `BUG: the re-adopted clip does not play at the 0.1x level (${JSON.stringify(tap)})`;
      return true;
    } finally {
      await restore();
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A long feed. Thirty clips are clicked one after the other (the pre-hook takes each in its
  // pointerdown, while the one before still plays), and the page pauses the one before a moment
  // after the click. Every clip is hooked in the page within 50 ms of its pointerdown, none goes
  // to the worker, and the clips behind the feed go dormant at their pause and take no place
  // under PARK_MAX. The renderer's CPU with all thirty behind the feed stays
  // near what it was before any of them was hooked: the median of three 5 s windows at most
  // 150 ms (3% of one core) above it. Thirty parked graphs that cost what a connected one costs
  // would read about 700 ms.
  async s101f_long_feed_sleeps_behind_the_reader(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      await asContentScript(ctx.sw, tabId, () => { window.addEventListener("pointerdown", (e) => { if (e.isTrusted) window.__pd = performance.now(); }, true); return true; });
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const ids = await page.evaluate(() => Array.from({ length: 30 }, () => window.feed.add()));
      await sleep(1500);
      await page.evaluate((list) => list.forEach((x) => window.feed.pause(x)), [main, ...ids]);
      await sleep(2600); // the insertions' churn drains
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const base = await rendererCpu(ctx.browser, 3, 5000);
      await swClearSpy(ctx.sw);
      const lat = [];
      let prev = main;
      for (const id of ids) {
        await clickVideo(page, id);
        await sleep(150);
        await page.evaluate((x) => window.feed.pause(x), prev);
        await sleep(250);
        lat.push(await asContentScript(ctx.sw, tabId, (i) => (window.__tap.at.has(i) ? Math.round(window.__tap.at.get(i) - window.__pd) : null), [id]));
        prev = id;
      }
      await page.evaluate((x) => window.feed.pause(x), prev);
      await sleep(2600);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const m = await measureTop(ctx.sw, tabId);
      const byWorker = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage" && e.res && e.res.ok && "signal" in e.res).length;
      const after = await rendererCpu(ctx.browser, 3, 5000);
      const late = lat.filter((x) => x == null || x > 50).length;
      ctx.note(`hook ms after pointerdown ${lat.join(",")}, worker hooks ${byWorker}, parked ${m && m.parked}, renderer CPU per 5 s before ${base.all.join("/")} (median ${base.med}), with thirty clips behind the feed ${after.all.join("/")} (median ${after.med})`);
      if (late) return `BUG: ${late} of 30 clips were not hooked in the page within 50 ms of the click (${lat.join(",")})`;
      if (byWorker) return `BUG: the worker hooked ${byWorker} clip(s) of the feed`;
      if (after.med > base.med + 150) return `BUG: thirty clips behind the feed cost ${after.med - base.med} ms of renderer CPU per 5 s (${base.med} before, ${after.med} after)`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A parked clip that still plays goes dormant only once it is paused. Clip A plays at the level
  // and the user clicks clip B (the pre-hook takes B while A still plays, so A is parked playing).
  // The page pauses A and plays it again in one task: A's pause event finds it playing, and its
  // source stays connected through it. Paused for real, A goes dormant.
  async s101g_pause_and_play_in_one_task_stays_connected(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const b = await page.evaluate(() => window.feed.add());
      await sleep(2600); // the insertion's churn drains
      await clickVideo(page, b);
      await sleep(600);
      const bTaken = await tapOuts(ctx.sw, tabId, b);
      const parkedPlaying = await page.evaluate((i) => !document.getElementById(i).paused, a);
      await page.evaluate((i) => { const v = document.getElementById(i); v.pause(); v.play().catch(() => {}); }, a);
      await sleep(600);
      const cutsThrough = await tapCuts(ctx.sw, tabId, a);
      const outsThrough = await tapOuts(ctx.sw, tabId, a);
      const play = await playback(page, a, 500);
      await page.evaluate((i) => window.feed.pause(i), a);
      await sleep(300);
      const outsPaused = await tapOuts(ctx.sw, tabId, a);
      ctx.note(`A parked playing ${parkedPlaying}, after pause and play in one task: ${cutsThrough} cut(s), source sends to ${JSON.stringify(outsThrough)}, A ${JSON.stringify(play)}, paused for real: source sends to ${JSON.stringify(outsPaused)}`);
      if (!bTaken || !parkedPlaying) return `setup failed: B not hooked by the click (${JSON.stringify(bTaken)}) or A not playing when parked`;
      if (cutsThrough) return `BUG: a pause the page took back in the same task cut the playing clip off its graph (${cutsThrough} cut(s))`;
      if (!play || play.advanced < 0.2) return `BUG: A is stalled after the pause and play (${JSON.stringify(play)})`;
      if (!Array.isArray(outsPaused) || outsPaused.length) return `BUG: the parked clip did not go dormant at its pause (its source sends to ${JSON.stringify(outsPaused)})`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A parked clip that still plays is unloaded the way video.js dispose and hls.js detachMedia
  // unload it: removeAttribute('src') and load(), with no pause(), and its post leaves the DOM.
  // The load pauses the element without a pause event. Clip A holds the level (0.05x), and
  // PARK_MAX + 2 clips are clicked one after the other while the one before still plays (the
  // pre-hook parks it playing). Right after each click the page unloads the one before. Each
  // unloaded clip's source sends nowhere before the next click, nothing stays parked, and the
  // worker hooks none of the clips: the ceiling is never reached.
  async s101h_unloaded_clip_sleeps(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const ids = await page.evaluate((n) => Array.from({ length: n }, () => window.feed.add()), PARK_MAX + 2);
      await sleep(1500);
      await page.evaluate((list) => list.forEach((x) => window.feed.pause(x)), [main, ...ids]);
      await sleep(2600); // the insertions' churn drains
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      await page.evaluate((i) => window.feed.play(i), main);
      await sleep(500);
      await swClearSpy(ctx.sw);
      let prev = main;
      const rows = [];
      for (const id of ids) {
        await clickVideo(page, id);
        await sleep(200);
        const playing = await page.evaluate((p) => !document.getElementById(p).paused, prev);
        await page.evaluate((p) => {
          const v = document.getElementById(p);
          v.removeAttribute("src");
          v.load();
          v.closest(".post").remove();
        }, prev);
        await sleep(400);
        const outs = await tapOuts(ctx.sw, tabId, prev);
        const m = await measureTop(ctx.sw, tabId);
        rows.push({ prev, playing, outs, parked: m && m.parked });
        prev = id;
      }
      const byWorker = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "engage" && e.res && e.res.ok && "signal" in e.res).length;
      const awake = rows.filter((r) => !Array.isArray(r.outs) || r.outs.length);
      ctx.note(`${rows.length} clips unloaded, parked after each ${rows.map((r) => r.parked).join(",")}, sources still sending ${awake.length}, worker hooks ${byWorker}`);
      const idle = rows.filter((r) => !r.playing);
      if (idle.length) return `setup failed: ${idle.length} clip(s) were not playing when the click parked them (${idle.map((r) => r.prev).join(",")})`;
      if (awake.length) return `BUG: ${awake.length} unloaded clip(s) still send to their graph (${JSON.stringify(awake.slice(0, 3))})`;
      if (rows.some((r) => r.parked !== 0)) return `BUG: unloaded clips stay parked (${rows.map((r) => r.parked).join(",")})`;
      if (byWorker) return `BUG: the worker hooked ${byWorker} clip(s) of the feed, the in-page paths refused`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The two orders a player tears down a playing clip in, each three times: video.js dispose
  // removes the node and then drops the src and calls load(), hls.js detachMedia drops the src and
  // calls load() and leaves the node in the DOM. Clip A holds the level, and six clips are clicked
  // one after the other while the one before still plays. Right after each click the page tears
  // the one before down, alternating the orders. The element hears 'emptied' and no 'pause', and
  // its source sends nowhere a moment later, with nothing parked.
  async s101i_teardown_orders_sleep(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      const main = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const ids = await page.evaluate(() => Array.from({ length: 6 }, () => window.feed.add()));
      await sleep(1500);
      await page.evaluate((list) => list.forEach((x) => window.feed.pause(x)), ids);
      await sleep(2600); // the insertions' churn drains
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      let prev = main;
      const rows = [];
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        const how = k % 2 === 0 ? "videojs" : "hlsjs";
        await clickVideo(page, id);
        await sleep(200);
        const playing = await page.evaluate((p) => !document.getElementById(p).paused, prev);
        await page.evaluate((p, how) => {
          const v = document.getElementById(p);
          const evs = v.__evs = [];
          window.__keep = window.__keep || {};
          window.__keep[p] = v;
          for (const t of ["pause", "emptied", "abort"]) v.addEventListener(t, () => evs.push(t + (v.isConnected ? "" : "@out")));
          if (how === "videojs") {
            const post = v.closest(".post");
            v.parentNode.removeChild(v);
            v.removeAttribute("src");
            v.load();
            post.remove();
          } else {
            v.removeAttribute("src");
            v.load();
          }
        }, prev, how);
        await sleep(500);
        const el = await page.evaluate((p) => ({ evs: window.__keep[p].__evs, paused: window.__keep[p].paused, connected: window.__keep[p].isConnected }), prev);
        const outs = await tapOuts(ctx.sw, tabId, prev);
        const m = await measureTop(ctx.sw, tabId);
        rows.push({ prev, how, playing, ...el, outs, parked: m && m.parked });
        prev = id;
      }
      ctx.note(JSON.stringify(rows.map((r) => ({ how: r.how, evs: r.evs, connected: r.connected, outs: r.outs, parked: r.parked }))));
      const idle = rows.filter((r) => !r.playing);
      if (idle.length) return `setup failed: ${idle.length} clip(s) were not playing when the click parked them`;
      const odd = rows.filter((r) => !r.evs.some((e) => e.startsWith("emptied")) || r.evs.some((e) => e.startsWith("pause")));
      if (odd.length) return `setup failed: a teardown did not fire 'emptied' without 'pause' (${JSON.stringify(odd.map((r) => [r.how, r.evs]))})`;
      const awake = rows.filter((r) => !Array.isArray(r.outs) || r.outs.length);
      if (awake.length) return `BUG: ${awake.length} torn down clip(s) still send to their graph (${JSON.stringify(awake.map((r) => [r.how, r.outs]))})`;
      if (rows.some((r) => r.parked !== 0)) return `BUG: torn down clips stay parked (${rows.map((r) => r.parked).join(",")})`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A page that stops a dormant clip's 'play' before it reaches the element (a capture listener
  // on window). Clip A holds the level (0.05x) and pauses, and clip B takes the hook in-page when
  // the page unmutes it, so A is dormant. The page plays A with its play event stopped: A's
  // 'playing' wakes its graph, and A plays, advancing, at the tab level.
  async s101j_stopped_play_event_still_wakes(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const b = await page.evaluate(() => window.feed.add());
      await sleep(400);
      await page.evaluate((i) => window.feed.unmute(i), b);
      await sleep(2600); // the insertion's churn drains
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const asleep = await tapOuts(ctx.sw, tabId, a);
      await page.evaluate((i) => {
        window.addEventListener("play", (e) => { if (e.target.id === i) e.stopImmediatePropagation(); }, true);
      }, a);
      await page.evaluate((i) => window.feed.play(i), a);
      await sleep(600);
      const play = await playback(page, a, 500); // read before the tap below pulls on the source
      const outs = await tapOuts(ctx.sw, tabId, a);
      const tap = await tapLevels(ctx.sw, tabId, a, 600);
      ctx.note(`A's source sent to ${JSON.stringify(asleep)} while paused, after play() with the play event stopped: A ${JSON.stringify(play)}, source sends to ${JSON.stringify(outs)}, tap ${JSON.stringify(tap)}`);
      if (!Array.isArray(asleep) || asleep.length) return `setup failed: A did not go dormant (its source sends to ${JSON.stringify(asleep)})`;
      if (!play || play.paused) return `setup failed: A did not play (${JSON.stringify(play)})`;
      if (play.advanced < 0.2) return `BUG: the dormant clip whose play event the page stopped is frozen (${JSON.stringify(play)}, source sends to ${JSON.stringify(outs)})`;
      if (!tap || !(tap.pre > 0.05)) return `BUG: the dormant clip whose play event the page stopped is silent (${JSON.stringify(tap)})`;
      if (!(tap.ratio < 0.1)) return `BUG: the dormant clip whose play event the page stopped is not at the 0.05x level (ratio ${tap.ratio})`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A dormant clip starts while an engage that lowers the level waits on a redirect check. The tab
  // is at 2.0x and clip D is dormant (D took the hook from paused A, and A took it back from
  // paused D, with the worker's passes held back). A same-origin clip E starts whose redirect
  // check answers after 1.5 s (/slow.wav). The slider moves to 0.2x, the engage picks E and waits
  // on its check, and the page plays D 400 ms into that. D's gain reads 0.2 from 200 ms after its
  // play on, and D plays at 0.2x.
  async s101k_wake_during_engage_takes_its_level(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    let restore = await dropPasses(ctx.sw, tabId);
    try {
      await tapInstall(ctx.sw, tabId);
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 2);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate((i) => window.feed.pause(i), a);
      const d = await page.evaluate(() => window.feed.add());
      await sleep(400);
      await page.evaluate((i) => window.feed.unmute(i), d);
      await sleep(600);
      const dGain = await asContentScript(ctx.sw, tabId, (id) => {
        const tap = window.__tap;
        window.__dGain = (tap.outs.get(tap.nodes.get(id)) || [])[0] || null;
        return !!window.__dGain;
      }, [d]);
      await page.evaluate((i) => window.feed.pause(i), d);
      await page.evaluate((i) => window.feed.play(i), a);
      await sleep(600);
      await page.evaluate((i) => window.feed.pause(i), a);
      await sleep(300);
      const dAsleep = await tapOuts(ctx.sw, tabId, d);
      await page.evaluate(() => window.feed.addSrc("/slow.wav"));
      await sleep(1500);
      await restore();
      restore = null;
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      // D's gain value every 50 ms for 4 s, on the page's clock.
      await asContentScript(ctx.sw, tabId, () => {
        const g = window.__dGain;
        const s = window.__samples = [];
        const t0 = performance.now();
        const tick = () => {
          s.push([performance.now(), +g.gain.value.toFixed(3)]);
          if (performance.now() - t0 < 4000) setTimeout(tick, 50);
        };
        tick();
        return true;
      });
      const set = swSetGain(ctx.sw, tabId, 0.2);
      await sleep(400);
      const playAt = await page.evaluate((i) => { const t = performance.now(); window.feed.play(i); return t; }, d);
      const playedAt = Date.now();
      const r2 = await set;
      const inFlight = Date.now() - playedAt;
      await sleep(4000);
      const samples = await asContentScript(ctx.sw, tabId, () => window.__samples);
      const steps = [];
      for (const [t, v] of samples) if (!steps.length || steps[steps.length - 1][1] !== v) steps.push([Math.round(t - playAt), v]);
      const late = samples.filter(([t]) => t >= playAt + 200);
      const high = late.filter(([, v]) => v > 0.25);
      const play = await playback(page, d, 500); // read before the tap below pulls on the source
      const tap = await tapLevels(ctx.sw, tabId, d, 600);
      ctx.note(`D dormant ${JSON.stringify(dAsleep)}, slider ${JSON.stringify(r2)}, engage still ran ${inFlight} ms after D's play, D gain steps [ms after D's play, value] ${JSON.stringify(steps)}, D ${JSON.stringify(play)}, tap ${JSON.stringify(tap)}`);
      if (!dGain || !Array.isArray(dAsleep) || dAsleep.length) return `setup failed: D's gain node not found or D not dormant (${JSON.stringify(dAsleep)})`;
      if (inFlight < 500) return `setup failed: the engage was over ${inFlight} ms after D's play, too soon to show the race`;
      if (late.length < 20) return `setup failed: only ${late.length} samples after D's play`;
      if (high.length) return `BUG: D woke at the level the slider moved away from during the engage (${high.length} samples above 0.25 from 200 ms after its play, the first at ${Math.round(high[0][0] - playAt)} ms: ${high[0][1]})`;
      if (!play || play.paused || play.advanced < 0.2) return `BUG: D does not play (${JSON.stringify(play)})`;
      if (!tap || !(tap.pre > 0.05) || !(tap.ratio > 0.14 && tap.ratio < 0.26)) return `BUG: D does not play at the 0.2x level (${JSON.stringify(tap)})`;
      return true;
    } finally {
      if (restore) await restore();
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The level changes while a clip is dormant, and the clip wakes at the new one. Clip A is at
  // 2.0x, pauses, and clip B takes the hook in-page when the page unmutes it, so A is dormant.
  // Then the tab's level changes, and the page plays A. Once a release to 1.0x: A plays at unity,
  // its limiter bypassed (ratio 1, threshold 0). Once a slider move to 0.5x, which B keeps: A
  // plays at 0.5x, its limiter on (ratio 20, threshold -3). The worker's passes are held back, so
  // the level A plays at is the one its wake set.
  async s101l_dormant_clip_wakes_at_the_new_level(ctx) {
    for (const kind of ["release", "move"]) {
      const page = await newFeedPage(ctx.browser, ctx.port);
      const tabId = await tabIdOf(ctx.sw, ctx.port);
      const restore = await dropPasses(ctx.sw, tabId);
      try {
        await tapInstall(ctx.sw, tabId);
        const a = await page.evaluate(() => window.feed.addAudible());
        await sleep(300);
        const r1 = await swSetGain(ctx.sw, tabId, 2);
        if (r1.mode !== "element" || !r1.confirmed) return `setup failed (${kind}): ${JSON.stringify(r1)}`;
        await page.evaluate((i) => window.feed.pause(i), a);
        const b = await page.evaluate(() => window.feed.add());
        await sleep(400);
        await page.evaluate((i) => window.feed.unmute(i), b);
        await sleep(2600); // the insertion's churn drains
        await waitIdle(ctx.sw, tabId, 10000, 1500);
        const asleep = await tapOuts(ctx.sw, tabId, a);
        const level = kind === "release" ? 1 : 0.5;
        const want = kind === "release" ? { ratio: 1, threshold: 0 } : { ratio: 20, threshold: -3 };
        const r2 = await swSetGain(ctx.sw, tabId, level);
        await sleep(300);
        await page.evaluate((i) => window.feed.play(i), a);
        await sleep(600);
        const play = await playback(page, a, 500); // read before the tap below pulls on the source
        const lim = await tapLimiter(ctx.sw, tabId, a);
        const tap = await tapLevels(ctx.sw, tabId, a, 600);
        ctx.note(`${kind}: A's source sent to ${JSON.stringify(asleep)} while paused, level ${level} ${JSON.stringify(r2)}, A ${JSON.stringify(play)}, limiter ${JSON.stringify(lim)}, tap ${JSON.stringify(tap)}`);
        if (!Array.isArray(asleep) || asleep.length) return `setup failed (${kind}): A did not go dormant (its source sends to ${JSON.stringify(asleep)})`;
        if (!play || play.paused) return `setup failed (${kind}): A did not play (${JSON.stringify(play)})`;
        if (play.advanced < 0.2) return `BUG (${kind}): the woken clip is stalled (${JSON.stringify(play)})`;
        if (!tap || !(tap.pre > 0.05)) return `BUG (${kind}): the woken clip is silent (${JSON.stringify(tap)})`;
        if (!(tap.ratio > level * 0.8 && tap.ratio < level * 1.25)) return `BUG (${kind}): the woken clip plays at ratio ${tap.ratio}, not at the ${level}x level`;
        if (!lim || lim.ratio !== want.ratio || lim.threshold !== want.threshold) return `BUG (${kind}): the woken clip's limiter reads ${JSON.stringify(lim)}, not ${JSON.stringify(want)}`;
      } finally {
        await restore();
        await swSetGain(ctx.sw, tabId, 1).catch(() => {});
        await page.close();
      }
    }
    return true;
  },

  // A page that stops a parked clip's 'pause' before it reaches the element (a capture listener on
  // window), so no listener of the frame hears it. Clip A plays at the level (0.05x) and the user
  // clicks clip B (the pre-hook parks A while it plays). The page pauses A with its pause event
  // stopped, and A stays parked with its source connected. The next hook the frame takes, a click
  // on clip C, sends A to sleep: its source sends nowhere.
  async s101m_stopped_pause_event_sleeps_at_next_hook(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const b = await page.evaluate(() => window.feed.add());
      const c = await page.evaluate(() => window.feed.add());
      await sleep(2600); // the insertions' churn drains
      await clickVideo(page, b);
      await sleep(600);
      const bTaken = await tapOuts(ctx.sw, tabId, b);
      const parkedPlaying = await page.evaluate((i) => !document.getElementById(i).paused, a);
      await page.evaluate((i) => {
        window.addEventListener("pause", (e) => { if (e.target.id === i) e.stopImmediatePropagation(); }, true);
        document.getElementById(i).pause();
      }, a);
      await sleep(400);
      const before = await tapOuts(ctx.sw, tabId, a);
      await clickVideo(page, c);
      await sleep(400);
      const cTaken = await tapOuts(ctx.sw, tabId, c);
      const after = await tapOuts(ctx.sw, tabId, a);
      ctx.note(`A parked playing ${parkedPlaying}, paused with its event stopped: source sends to ${JSON.stringify(before)}, after the click on C: ${JSON.stringify(after)}`);
      if (!bTaken || !bTaken.length || !parkedPlaying) return `setup failed: B not hooked by the click (${JSON.stringify(bTaken)}) or A not playing when parked`;
      if (!Array.isArray(before) || !before.length) return `setup failed: A went to sleep before the next hook (its source sends to ${JSON.stringify(before)}), the page did not hold its pause event back`;
      if (!cTaken || !cTaken.length) return `setup failed: the click did not hook C (${JSON.stringify(cTaken)})`;
      if (!Array.isArray(after) || after.length) return `BUG: the paused clip whose pause event the page stopped still sends to its graph after the next hook (${JSON.stringify(after)})`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A feed starts its next clip a moment before it pauses the one it held: the next clip's play
  // comes 10 ms before the held clip's pause. The play is refused (the held clip still sounds),
  // and the holder's pause is the moment the next clip takes the hook in-page: within 50 ms of
  // its first sound, without a hook by the worker, at the level. Once with light-DOM clips (the
  // document's pause listener), once with clips in open shadow roots (each root's own).
  async s102_next_clip_plays_before_pause(ctx) {
    for (const kind of ["light", "shadow"]) {
      const page = kind === "light" ? await newFeedPage(ctx.browser, ctx.port) : await newShadowPage(ctx.browser, ctx.port, "?s102");
      const tabId = kind === "light" ? await tabIdOf(ctx.sw, ctx.port) : await tabIdByUrl(ctx.sw, "s102");
      try {
        await tapInstall(ctx.sw, tabId);
        const a = await page.evaluate(() => window.feed.addAudible());
        if (kind === "shadow") await waitClipPlaying(page, a);
        await sleep(300);
        const r1 = await swSetGain(ctx.sw, tabId, 0.05);
        if (r1.mode !== "element" || !r1.confirmed) return `setup failed (${kind}): ${JSON.stringify(r1)}`;
        const b = await page.evaluate((k) => (k === "light" ? window.feed.addPaused() : window.feed.add({ muted: false, autoplay: false })), kind);
        await sleep(2600); // the insertion's churn drains
        await swClearSpy(ctx.sw);
        await page.evaluate((a, b) => {
          const find = (root, id) => {
            const v = root.getElementById ? root.getElementById(id) : null;
            if (v) return v;
            for (const e of root.querySelectorAll("*")) if (e.shadowRoot) { const r = find(e.shadowRoot, id); if (r) return r; }
            return null;
          };
          const A = find(document, a), B = find(document, b);
          window.__firstSound = null;
          B.addEventListener("playing", () => { if (window.__firstSound == null) window.__firstSound = performance.now(); });
          B.play().catch(() => {});
          setTimeout(() => A.pause(), 10);
        }, a, b);
        await sleep(1500);
        const first = await page.evaluate(() => window.__firstSound);
        const hookAt = await asContentScript(ctx.sw, tabId, (id) => (window.__tap.at.has(id) ? window.__tap.at.get(id) : null), [b]);
        const byWorker = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.ok && "signal" in e.res);
        const m = await measureTop(ctx.sw, tabId);
        const lag = first != null && hookAt != null ? Math.round(hookAt - first) : null;
        ctx.note(`${kind}: hook ${lag == null ? "none" : lag + " ms after the first sound"}, worker hook ${byWorker ? JSON.stringify(byWorker.res) : "none"}, measure ${fmtMeasure(m)}`);
        if (first == null) return `setup failed (${kind}): the next clip never played`;
        if (hookAt == null) return `BUG (${kind}): the next clip was never hooked`;
        if (byWorker) return `BUG (${kind}): the worker's engage hooked the next clip, so it played at native level until then`;
        if (lag > 50) return `BUG (${kind}): the next clip was hooked ${lag} ms after its first sound`;
        if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG (${kind}): the next clip does not play at the 0.05x level (${fmtMeasure(m)})`;
        await swSetGain(ctx.sw, tabId, 1);
      } finally { await page.close(); }
    }
    return true;
  },

  // The held clip goes silent without a pause: the page mutes it in the next clip's 'play'
  // event, after that play was refused. No pause follows, and the next clip's own 'playing' is
  // the moment it takes the hook in-page, within 50 ms of its first sound, at the level.
  async s102b_next_clip_takes_hook_at_its_playing(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await page.evaluate(async () => {
        const v = document.createElement("video");
        v.id = "next"; v.preload = "none"; v.loop = true;
        v.style.cssText = "width:100%;height:315px;display:block";
        v.src = URL.createObjectURL(await (await fetch("/tone.wav")).blob());
        const post = document.createElement("div");
        post.className = "post";
        post.appendChild(v);
        document.getElementById("feed").appendChild(post);
      });
      await sleep(2600); // the insertion's churn drains
      await swClearSpy(ctx.sw);
      await page.evaluate((a) => {
        const A = document.getElementById(a), B = document.getElementById("next");
        window.__firstSound = null;
        window.__readyAtPlay = B.readyState;
        B.addEventListener("play", () => { A.muted = true; }, { once: true });
        B.addEventListener("playing", () => { if (window.__firstSound == null) window.__firstSound = performance.now(); });
        B.play().catch(() => {});
      }, a);
      await sleep(1500);
      const first = await page.evaluate(() => window.__firstSound);
      const readyAtPlay = await page.evaluate(() => window.__readyAtPlay);
      const hookAt = await asContentScript(ctx.sw, tabId, () => (window.__tap.at.has("next") ? window.__tap.at.get("next") : null));
      const byWorker = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.ok && "signal" in e.res);
      const m = await measureTop(ctx.sw, tabId);
      const lag = first != null && hookAt != null ? Math.round(hookAt - first) : null;
      ctx.note(`readyState at play ${readyAtPlay}, hook ${lag == null ? "none" : lag + " ms after the first sound"}, worker hook ${byWorker ? JSON.stringify(byWorker.res) : "none"}, measure ${fmtMeasure(m)}`);
      if (first == null) return "setup failed: the next clip never played";
      if (hookAt == null) return "BUG: the next clip was never hooked";
      if (byWorker) return "BUG: the worker's engage hooked the next clip, so it played at native level until then";
      if (lag > 50) return `BUG: the next clip was hooked ${lag} ms after its first sound`;
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the next clip does not play at the 0.05x level (${fmtMeasure(m)})`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A refusal counts for two seconds. The next clip's play is refused while the held clip sounds,
  // and the held clip pauses 2.5 s later: the next clip is not taken in-page at that pause.
  async s102c_refusal_counts_two_seconds(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      const b = await page.evaluate(() => window.feed.addPaused());
      await sleep(2600); // the insertion's churn drains
      await page.evaluate((b) => document.getElementById(b).play().catch(() => {}), b);
      await sleep(2500);
      const before = await asContentScript(ctx.sw, tabId, (id) => window.__tap.at.has(id), [b]);
      await page.evaluate((a) => document.getElementById(a).pause(), a);
      await sleep(1000);
      const after = await asContentScript(ctx.sw, tabId, (id) => window.__tap.at.has(id), [b]);
      ctx.note(`hooked before the late pause ${before}, after it ${after}`);
      if (before) return "setup failed: the next clip was hooked while the held clip still sounded";
      if (after) return "BUG: a refusal older than two seconds was retried at the holder's pause";
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A page that plays audibly before the content script arrives (the injection waits for the
  // load event), and a level arriving for it (seeded and kicked the way an arrival on a saved
  // site is). The pass's arm proves the context and takes the playing clip in-page: a 'hooked'
  // report, no engage that hooks it, the level on it.
  async s103_arm_takes_player_already_playing(ctx) {
    const page = await ctx.browser.newPage();
    let tabId = null;
    try {
      await page.goto(`http://127.0.0.1:${ctx.port}/?auto=audible&s103`, { waitUntil: "load" });
      await page.waitForFunction(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.readyState >= 2; }, { timeout: 5000 });
      tabId = await tabIdByUrl(ctx.sw, "s103");
      await sleep(300);
      await swClearSpy(ctx.sw);
      await ctx.sw.evaluate(async (t) => { await sset(TABGAIN(t), 0.05); kickRestore(t, false); }, tabId);
      await sleep(500);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const hooked = await ctx.sw.evaluate(() => globalThis.__spy.hooked);
      const byWorker = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.ok && "signal" in e.res);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`'hooked' reports ${hooked}, worker hook ${byWorker ? JSON.stringify(byWorker.res) : "none"}, measure ${fmtMeasure(m)}`);
      if (byWorker) return "BUG: the arm left the playing clip to the engage, at native level until then";
      if (!hooked) return "BUG: the arm did not take the playing clip";
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the clip does not play at the 0.05x level (${fmtMeasure(m)})`;
      return true;
    } finally {
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A page that hooks its own player 100 ms after it starts (its own loudness processing), and
  // an arm that lands about 50 ms after the start in a frame whose context is not proven yet (a
  // fresh document, the content script there already). The arm proves the context and takes the
  // player first: the page's own hook finds it taken, and the level is on it.
  async s103b_arm_beats_page_own_hook(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      const a = await page.evaluate(() => window.feed.addPaused());
      await page.waitForFunction((i) => document.getElementById(i).readyState >= 1, { timeout: 5000 }, a);
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      await sleep(2600); // the insertion's churn drains while the tab has no level
      await ctx.sw.evaluate((t) => sset(TABGAIN(t), 0.05), tabId);
      await swClearSpy(ctx.sw);
      const r = await ctx.sw.evaluate(async (t, id) => {
        await chrome.scripting.executeScript({ target: { tabId: t }, world: "MAIN", args: [id], func: (id) => {
          const v = document.getElementById(id);
          const st = window.__s103b = { playAt: performance.now(), self: null, selfAt: null };
          v.play().catch(() => {});
          setTimeout(() => { st.selfAt = performance.now(); st.self = window.feed.hookSelf(id); }, 100);
        } });
        await new Promise((r) => setTimeout(r, 50));
        const t0 = Date.now();
        const res = await chrome.tabs.sendMessage(t, { cmd: "arm", gain: 0.05, useLimiter: true }, { frameId: 0 });
        return { res, armMs: Date.now() - t0 };
      }, tabId, a);
      await sleep(1000);
      const st = await page.evaluate(() => window.__s103b);
      const hookAt = await asContentScript(ctx.sw, tabId, (id) => (window.__tap.at.has(id) ? window.__tap.at.get(id) : null), [a]);
      const m = await measureTop(ctx.sw, tabId);
      const ext = hookAt == null ? null : Math.round(hookAt - st.playAt);
      ctx.note(`arm answered in ${r.armMs} ms ${JSON.stringify(r.res)}, extension hook ${ext == null ? "none" : ext + " ms after play"}, page's own hook at ${Math.round(st.selfAt - st.playAt)} ms ${st.self ? "took it" : "found it taken"}, measure ${fmtMeasure(m)}`);
      if (st.self === null) return "setup failed: the page's own hook never ran";
      if (st.self) return `BUG: the page's own hook came first (extension hook ${ext == null ? "none" : ext + " ms after play"})`;
      if (ext == null) return "BUG: the extension never hooked the player";
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the player does not play at the 0.05x level (${fmtMeasure(m)})`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A web-component player that starts with sound before the content script arrives, a level
  // arriving for the page (seeded and kicked as in s103). The walk at injection finds the clip
  // sounding before the arm lands, as measured on a standalone player page: its play was taken
  // then, refused (not armed yet), and no second play follows. The arm is held back 150 ms in the
  // worker so that order is certain. The arm takes the clip in-page: a 'hooked' report, no engage
  // that hooks it, the level on it.
  async s103c_arm_takes_shadow_autoplay(ctx) {
    const page = await newShadowPage(ctx.browser, ctx.port, "?auto=audible&s103c");
    let tabId = null;
    try {
      await page.waitForFunction(() => !!window.autoId, { timeout: 5000 });
      const a = await page.evaluate(() => window.autoId);
      await waitClipPlaying(page, a);
      tabId = await tabIdByUrl(ctx.sw, "s103c");
      await ctx.sw.evaluate(() => {
        const send = chrome.tabs.sendMessage;
        globalThis.__s103c = send;
        chrome.tabs.sendMessage = (t, m, o) => (m && m.cmd === "arm" ? new Promise((r) => setTimeout(r, 150)).then(() => send(t, m, o)) : send(t, m, o));
      });
      await sleep(300);
      await swClearSpy(ctx.sw);
      await ctx.sw.evaluate(async (t) => { await sset(TABGAIN(t), 0.05); kickRestore(t, false); }, tabId);
      await sleep(500);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const hooked = await ctx.sw.evaluate(() => globalThis.__spy.hooked);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const byWorker = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.ok && "signal" in e.res);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`${pings} ping(s), 'hooked' reports ${hooked}, worker hook ${byWorker ? JSON.stringify(byWorker.res) : "none"}, measure ${fmtMeasure(m)}`);
      if (byWorker) return "BUG: the arm left the sounding clip to the engage, at native level until then";
      if (!hooked) return "BUG: the arm did not take the sounding clip";
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the clip does not play at the 0.05x level (${fmtMeasure(m)})`;
      return true;
    } finally {
      await ctx.sw.evaluate(() => { if (globalThis.__s103c) { chrome.tabs.sendMessage = globalThis.__s103c; delete globalThis.__s103c; } });
      if (tabId != null) await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // An arm that cannot take the sounding player sends nothing to the worker. The page routes its
  // player through its own audio processing before any level is set, so the extension's hook on
  // it throws. A level arrives (seeded and kicked as in s103): the pass's arm tries the player and
  // fails, no 'navigated' ping follows from that, and no further pass runs.
  async s103d_failed_arm_take_sends_nothing(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      if (!(await page.evaluate((i) => window.feed.hookSelf(i), a))) return "setup failed: the page could not hook its own player";
      await sleep(2600); // the insertion's churn drains while the tab has no level
      await swClearSpy(ctx.sw);
      await ctx.sw.evaluate(async (t) => { await sset(TABGAIN(t), 0.05); kickRestore(t, false); }, tabId);
      await sleep(500);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      await sleep(3000);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const log = await swSpyLog(ctx.sw);
      const probes = log.filter((e) => e.cmd === "probe").length;
      const arms = log.filter((e) => e.cmd === "arm").length;
      ctx.note(`${arms} arm(s), ${probes} probe(s), ${pings} ping(s)`);
      if (!arms) return "setup failed: no arm reached the frame";
      if (pings) return `BUG: the failed take at the arm pinged the worker (${pings}), which starts pass after pass`;
      if (probes > 1) return `BUG: ${probes} passes ran for one arrival`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // The take in a frame whose context is proven already: the frame held a hook and was stopped
  // (no level armed, its hook at unity), and the next clip starts audibly before the pass that
  // its play starts arms the frame again. The arm takes the clip in-page.
  async s103e_arm_takes_sounding_clip_in_proven_frame(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(300);
      const r1 = await swSetGain(ctx.sw, tabId, 0.05);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await ctx.sw.evaluate((t) => toFrame(t, null, { cmd: "stop" }), tabId);
      await page.evaluate((i) => window.feed.pause(i), a);
      await sleep(2600);
      await swClearSpy(ctx.sw);
      const b = await page.evaluate(() => window.feed.addAudible());
      await sleep(1500);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const hooked = await ctx.sw.evaluate(() => globalThis.__spy.hooked);
      const byWorker = (await swSpyLog(ctx.sw)).find((e) => e.cmd === "engage" && e.res && e.res.ok && "signal" in e.res);
      const m = await measureTop(ctx.sw, tabId);
      ctx.note(`'hooked' reports ${hooked}, worker hook ${byWorker ? JSON.stringify(byWorker.res) : "none"}, measure ${fmtMeasure(m)}`);
      if (byWorker) return "BUG: the arm left the sounding clip to the engage, at native level until then";
      if (!hooked || !(await page.evaluate((i) => window.feed.isHooked(i), b))) return "BUG: the arm did not take the sounding clip";
      if (!m || !m.ok || !m.signal || m.rms > 0.1) return `BUG: the clip does not play at the 0.05x level (${fmtMeasure(m)})`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A tab with a level and no capture grant (no popup opened on the page) plays a clip without
  // CORS, so every restore pass decides capture. The first pass tries it (getMediaStreamId fails)
  // and notes the tab. The armed frame then hooks two clips in-page at 0.05x, the first one is
  // parked while it plays on muted (its graph stays connected, never dormant), and the clip
  // without CORS plays again: the next passes make no getMediaStreamId call and send no stop to
  // any frame, and the parked graph keeps the level through them.
  async s104_no_grant_passes_skip_capture(ctx) {
    const page = await newFeedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      await tapInstall(ctx.sw, tabId);
      await captureSpyOn(ctx.sw);
      const u = await page.evaluate(async () => window.feed.addSrc((await (await fetch("/adsrc")).text()).trim()));
      await page.waitForFunction((i) => { const v = document.getElementById(i); return !!v && !v.paused && v.readyState >= 2; }, { timeout: 5000 }, u);
      await sleep(2600);
      await ctx.sw.evaluate((t) => sset(TABGAIN(t), 0.05), tabId);
      await swClearSpy(ctx.sw);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const firstCalls = await captureCalls(ctx.sw);
      if (firstCalls < 1) return "setup failed: the first pass did not try a capture";
      await page.evaluate((i) => window.feed.pause(i), u);
      const a = await page.evaluate(() => window.feed.addAudible());
      await sleep(600);
      const b = await page.evaluate((x) => { document.getElementById(x).muted = true; return window.feed.addAudible(); }, a);
      await sleep(600);
      await page.evaluate((x) => window.feed.pause(x), b);
      const before = await tapLevels(ctx.sw, tabId, a, 100);
      if (!before || before.gain !== 0.05) return `setup failed: the first clip is not parked at the level (${JSON.stringify(before)})`;
      await sleep(2600);
      await captureSpyOn(ctx.sw);
      await swClearSpy(ctx.sw);
      await page.evaluate((i) => window.feed.play(i), u);
      await sleep(1000);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const log = await swSpyLog(ctx.sw);
      const probes = log.filter((e) => e.cmd === "probe").length;
      const frameStops = log.filter((e) => e.cmd === "stop").length;
      const calls = await captureCalls(ctx.sw);
      const after = await tapLevels(ctx.sw, tabId, a, 100);
      ctx.note(`first pass ${firstCalls} getMediaStreamId call(s), later passes: ${probes} probe(s), ${calls} call(s), ${frameStops} stop(s) to frames, parked graph gain ${before.gain} -> ${after && after.gain}`);
      if (probes < 2) return `setup failed: the later passes did not run (${probes} probes)`;
      if (calls) return `BUG: a pass tried the capture again on a tab without a grant (${calls})`;
      if (frameStops) return `BUG: a pass sent ${frameStops} stop(s) to the frames on a tab without a grant`;
      if (!after || after.gain !== 0.05) return `BUG: the parked graph lost the level through the passes (gain ${after && after.gain})`;
      // a user action always tries
      await captureSpyOn(ctx.sw);
      const r = await swSetGain(ctx.sw, tabId, 0.06);
      const userCalls = await captureCalls(ctx.sw);
      ctx.note(`slider move ${JSON.stringify(r)}, ${userCalls} getMediaStreamId call(s)`);
      if (userCalls < 1) return `BUG: a slider move did not try the capture on a tab noted without a grant (${JSON.stringify(r)})`;
      return true;
    } finally {
      await captureSpyOff(ctx.sw);
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // Any popup command lifts that note, since opening the popup is what grants capture. A browser
  // of its own, where the harness opens the extension's real popup on the tab (CDP
  // Extensions.triggerAction, see openPopup), which grants the tab capture as a click on the
  // toolbar icon does. A pass notes that the tab has no grant, the popup opens, its commands lift
  // the note, and its own apply starts the capture.
  async s104b_popup_lifts_no_grant_note(ctx) {
    const browser2 = await launchChrome({ actionDebug: true });
    let page;
    try {
      const sw2 = await getWorker(browser2);
      await installSpy(sw2);
      page = await browser2.newPage();
      await page.goto(`http://127.0.0.1:${ctx.port}/?s104b`, { waitUntil: "load" });
      await page.waitForFunction(() => window.feedReady === true, { timeout: 5000 });
      const tabId = await tabIdByUrl(sw2, "s104b");
      const u = await page.evaluate(async () => window.feed.addSrc((await (await fetch("/adsrc")).text()).trim()));
      await page.waitForFunction((i) => { const v = document.getElementById(i); return !!v && !v.paused && v.readyState >= 2; }, { timeout: 5000 }, u);
      await sleep(2600);
      await sw2.evaluate((t) => sset(TABGAIN(t), 0.05), tabId);
      await sw2.evaluate((t) => kickRestore(t, false), tabId);
      await waitIdle(sw2, tabId, 10000, 1500);
      const noted = await sw2.evaluate((t) => sget(TABNOGRANT(t)), tabId);
      if (noted !== true) return `setup failed: the pass did not note the missing grant (${JSON.stringify(noted)})`;
      const popup = await openPopup(browser2, page);
      let mode = null;
      for (let i = 0; i < 50 && !(mode && mode.mode === "capture"); i++) { await sleep(100); mode = await swGetMode(sw2, tabId); }
      const after = await sw2.evaluate((t) => sget(TABNOGRANT(t)), tabId);
      ctx.note(`note before the popup ${noted}, after ${after}, mode ${JSON.stringify(mode)}`);
      await popup.close().catch(() => {});
      if (after !== undefined) return `BUG: the popup's commands did not lift the note (${after})`;
      if (!mode || mode.mode !== "capture") return `BUG: the popup's apply did not start the capture (${JSON.stringify(mode)})`;
      return true;
    } finally {
      if (page) await page.close().catch(() => {});
      await browser2.close().catch(() => {});
    }
  },

  // A pass that skips the capture on a tab noted without a grant still disarms the sub-frame it
  // leaves untracked. The player sits in a cross-origin iframe, and the slider arms that frame
  // (3x). An ad without CORS plays there and the held clip leaves: the pass decides capture, which
  // fails for lack of a grant and notes the tab. Content returns and a pass arms the sub-frame
  // again. Another ad, the held clip leaves again, and this pass skips the capture: it stops the
  // sub-frame. Then the top frame takes the element record (a big muted video), and the page
  // unmutes a new clip in the sub-frame. A disarmed sub-frame pings the worker, which hooks the
  // clip where the slider reaches it: after a move to 0.5x the clip plays at 0.5x.
  async s104c_skip_disarms_untracked_subframe(ctx) {
    const { page, inner } = await newFramedPage(ctx.browser, ctx.port);
    const tabId = await tabIdOf(ctx.sw, ctx.port);
    try {
      const fid = await frameIdOf(ctx.sw, tabId, "x-feed.html");
      const xo = `http://127.0.0.1:${ctx.port}/tone.wav`; // another origin for the inner frame, no CORS
      const playingAd = () => inner.evaluate(() => Array.from(document.querySelectorAll("video")).find((v) => /127\.0\.0\.1/.test(v.currentSrc) && !v.paused).id);
      const a = await inner.evaluate(() => window.feed.addAudible());
      await sleep(400);
      const r1 = await swSetGain(ctx.sw, tabId, 3);
      if (r1.mode !== "element" || !r1.confirmed) return `setup failed: ${JSON.stringify(r1)}`;
      await inner.evaluate((s) => window.feed.addSrc(s), xo);
      await sleep(600);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      await inner.evaluate((i) => window.feed.remove(i), a);
      await sleep(600);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      const noted = await ctx.sw.evaluate((t) => sget(TABNOGRANT(t)), tabId);
      await inner.evaluate((i) => window.feed.remove(i), await playingAd());
      const b = await inner.evaluate(() => window.feed.addAudible());
      await sleep(600);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      const armed = await swGetMode(ctx.sw, tabId);
      await inner.evaluate((s) => window.feed.addSrc(s), xo);
      await sleep(600);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      await swClearSpy(ctx.sw);
      await inner.evaluate((i) => window.feed.remove(i), b);
      await sleep(600);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      const skipStops = (await swSpyLog(ctx.sw)).filter((e) => e.cmd === "stop").map((e) => (e.frameId === undefined ? "all" : e.frameId));
      await inner.evaluate((i) => window.feed.remove(i), await playingAd());
      await page.evaluate(() => new Promise((res) => {
        const v = document.createElement("video");
        v.src = "/tone.wav"; v.loop = true; v.muted = true; v.playsInline = true;
        v.style.cssText = "width:640px;height:360px;display:block";
        document.body.appendChild(v);
        v.play().finally(res);
      }));
      await sleep(5000);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      const top = await swGetMode(ctx.sw, tabId);
      const c = await inner.evaluate(() => window.feed.add());
      await sleep(2600);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      await swClearSpy(ctx.sw);
      await inner.evaluate((i) => window.feed.unmute(i), c);
      await sleep(1500);
      await waitIdle(ctx.sw, tabId, 15000, 1500);
      const pings = await ctx.sw.evaluate(() => globalThis.__spy.pings);
      const r2 = await swSetGain(ctx.sw, tabId, 0.5);
      await sleep(400);
      const m = await ctx.sw.evaluate((t, f) => chrome.tabs.sendMessage(t, { cmd: "measure" }, { frameId: f }).catch(() => null), tabId, fid);
      ctx.note(`noted ${noted}, sub-frame armed again ${JSON.stringify(armed)}, stops of the skipping pass ${JSON.stringify(skipStops)}, top frame mode ${JSON.stringify(top)}, ${pings} ping(s) at the unmute, slider ${JSON.stringify(r2)}, sub-frame ${fmtMeasure(m)}`);
      if (noted !== true) return `setup failed: the first capture verdict did not note the tab (${JSON.stringify(noted)})`;
      if (!armed || armed.mode !== "element" || armed.frameId !== fid) return `setup failed: the sub-frame was not armed again (${JSON.stringify(armed)})`;
      if (!skipStops.includes(fid)) return `BUG: the pass that skipped the capture left the sub-frame armed (stops ${JSON.stringify(skipStops)})`;
      if (!pings && m && m.ok && m.rms > 0.3) return `BUG: the sub-frame hooked the clip untracked and keeps the 3x level after a slider move to 0.5x (rms ${m.rms.toFixed(3)})`;
      return true;
    } finally {
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
  },

  // A tab that closes while a pass finds it without a grant keeps no note. A pass decides capture
  // for a clip without CORS, and Chrome refuses the stream id for lack of a grant. Once with the
  // tab closed before that answer (the note checks that the tab is still there), once with the
  // tab closing while that check answers (the note is written in the tab's queue, so the tab's
  // cleanup runs behind it). No key of the tab is left in session storage.
  async s104d_closed_tab_keeps_no_note(ctx) {
    const refusal = "Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.";
    for (const when of ["before the check", "during the check"]) {
      const tag = when === "before the check" ? "s104d1" : "s104d2";
      const page = await ctx.browser.newPage();
      await page.goto(`http://127.0.0.1:${ctx.port}/?${tag}`, { waitUntil: "load" });
      await page.waitForFunction(() => window.feedReady === true, { timeout: 5000 });
      const tabId = await tabIdByUrl(ctx.sw, tag);
      try {
        await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
        await page.evaluate((s) => window.feed.addSrc(s), await adSrc(page));
        await sleep(800);
        await ctx.sw.evaluate((t, early, msg) => {
          const z = globalThis.__s104d = { gm: chrome.tabCapture.getMediaStreamId, get: chrome.tabs.get, armed: false, calls: 0 };
          chrome.tabCapture.getMediaStreamId = async (o) => {
            z.calls++;
            if (o && o.targetTabId === t) {
              if (early) { await chrome.tabs.remove(t); await new Promise((r) => setTimeout(r, 300)); }
              else z.armed = true;
            }
            throw new Error(msg);
          };
          chrome.tabs.get = async (id) => {
            const r = await z.get.call(chrome.tabs, id);
            if (z.armed && id === t) {
              z.armed = false;
              await chrome.tabs.remove(t);
              await new Promise((res) => setTimeout(res, 300));
            }
            return r;
          };
          return sset(TABGAIN(t), 0.05).then(() => sdel(TABNOGRANT(t)));
        }, tabId, when === "before the check", refusal);
        await ctx.sw.evaluate((t) => { kickRestore(t, false); }, tabId);
        for (let i = 0; i < 100 && !(await page.isClosed()); i++) {
          if (!(await ctx.sw.evaluate((t) => chrome.tabs.query({}).then((l) => l.some((x) => x.id === t)), tabId))) break;
          await sleep(100);
        }
        await sleep(2500);
        const out = await ctx.sw.evaluate(async (t) => {
          const all = await chrome.storage.session.get(null);
          const keys = Object.keys(all).filter((k) => k.endsWith(":" + t));
          return { keys, calls: globalThis.__s104d.calls, open: (await chrome.tabs.query({})).some((x) => x.id === t) };
        }, tabId);
        ctx.note(`tab closed ${when}: ${out.calls} getMediaStreamId call(s), tab open ${out.open}, keys left ${JSON.stringify(out.keys)}`);
        if (!out.calls || out.open) return `setup failed (${when}): ${out.calls} call(s), tab open ${out.open}`;
        if (out.keys.length) return `BUG: a tab closed ${when} keeps session keys: ${out.keys.join(", ")}`;
      } finally {
        await ctx.sw.evaluate(() => {
          const z = globalThis.__s104d;
          if (!z) return;
          chrome.tabCapture.getMediaStreamId = z.gm;
          chrome.tabs.get = z.get;
          delete globalThis.__s104d;
        });
        await page.close().catch(() => {});
      }
    }
    return true;
  },

  // Only Chrome's answer for a missing grant notes the tab. A pass decides capture for a clip
  // without CORS, and the stream id is refused for another reason (another capturer holds the
  // tab): the tab is not noted, and the next pass tries the capture again.
  async s104e_other_refusals_note_nothing(ctx) {
    const page = await ctx.browser.newPage();
    await page.goto(`http://127.0.0.1:${ctx.port}/?s104e`, { waitUntil: "load" });
    await page.waitForFunction(() => window.feedReady === true, { timeout: 5000 });
    const tabId = await tabIdByUrl(ctx.sw, "s104e");
    try {
      await ctx.sw.evaluate((t) => ensureContentScript(t), tabId);
      await page.evaluate((s) => window.feed.addSrc(s), await adSrc(page));
      await sleep(2600);
      await ctx.sw.evaluate(() => {
        const z = globalThis.__s104e = { gm: chrome.tabCapture.getMediaStreamId, calls: 0 };
        chrome.tabCapture.getMediaStreamId = async () => { z.calls++; throw new Error("Cannot capture a tab with an active stream."); };
      });
      await ctx.sw.evaluate((t) => sset(TABGAIN(t), 0.05), tabId);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const first = await ctx.sw.evaluate(() => globalThis.__s104e.calls);
      const noted = await ctx.sw.evaluate((t) => sget(TABNOGRANT(t)), tabId);
      await ctx.sw.evaluate((t) => kickRestore(t, false), tabId);
      await waitIdle(ctx.sw, tabId, 10000, 1500);
      const second = (await ctx.sw.evaluate(() => globalThis.__s104e.calls)) - first;
      ctx.note(`first pass ${first} getMediaStreamId call(s), note ${JSON.stringify(noted)}, second pass ${second} call(s)`);
      if (!first) return "setup failed: the first pass did not try the capture";
      if (noted !== undefined) return `BUG: a refusal for another reason noted the tab as without a grant (${JSON.stringify(noted)})`;
      if (!second) return "BUG: the next pass skipped the capture after a refusal for another reason";
      return true;
    } finally {
      await ctx.sw.evaluate(() => {
        const z = globalThis.__s104e;
        if (!z) return;
        chrome.tabCapture.getMediaStreamId = z.gm;
        delete globalThis.__s104e;
      });
      await swSetGain(ctx.sw, tabId, 1).catch(() => {});
      await page.close();
    }
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

// The suite's browser runs with the autoplay policy switched OFF (media plays unattended). s41
// needs the real policy in a fresh profile: puppeteer gives every launch its own temp profile, so
// that browser has never heard audio from any origin.
// Where the headed test window goes. With more than one monitor it opens on one that is NOT the
// primary, out of the way of whatever is being watched there (TVB_WINDOW_POS=x,y overrides,
// TVB_WINDOW_POS=main keeps it on the primary). Windows only; elsewhere Chrome decides.
let windowPosition;
function testWindowPosition() {
  if (windowPosition !== undefined) return windowPosition;
  windowPosition = null;
  const env = process.env.TVB_WINDOW_POS;
  if (env === "main") return null;
  if (env && /^-?\d+,-?\d+$/.test(env)) return (windowPosition = env);
  if (process.platform !== "win32") return null;
  try {
    const out = require("child_process").execFileSync("powershell", ["-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1 | ForEach-Object { '{0},{1}' -f ($_.Bounds.X + 40), ($_.Bounds.Y + 40) }"],
      { encoding: "utf8", timeout: 10000 }).trim();
    if (/^-?\d+,-?\d+$/.test(out)) windowPosition = out;
  } catch (_) { /* no PowerShell, no second screen: Chrome decides */ }
  return windowPosition;
}

// actionDebug: a pipe connection and --enable-unsafe-extension-debugging, which CDP
// Extensions.triggerAction needs to open the extension's real popup (see openPopup).
function launchChrome(opts) {
  const o = opts || {};
  const pos = testWindowPosition();
  return puppeteer.launch({
    executablePath: CHROME,
    headless: false, // extension + media playback: headed is the reliable path; window is small and brief
    ...(o.actionDebug ? { pipe: true } : {}),
    args: [
      ...(o.actionDebug ? ["--enable-unsafe-extension-debugging"] : []),
      `--disable-extensions-except=${REPO}`,
      `--load-extension=${REPO}`,
      ...(o.autoplayPolicyOff === false ? [] : ["--autoplay-policy=no-user-gesture-required"]),
      "--mute-audio", // audio still flows through WebAudio graphs; just don't blast the speakers
      "--window-size=800,600",
      ...(pos ? [`--window-position=${pos}`] : []),
      "--no-first-run", "--no-default-browser-check",
    ],
  });
}

// ---- main ---------------------------------------------------------------
(async () => {
  const { server, adServer, counts, port } = await serveFixtures();
  const browser = await launchChrome();

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
      if (outcome && typeof outcome === "object" && typeof outcome.skip === "string") {
        console.log(`SKIP  ${name}  (${outcome.skip})`);
        await swClearLog(sw);
        continue;
      }
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
