// Renders the Chrome Web Store images from the HTML templates in this folder
// using headless Chrome. Output lands one level up, in store-assets/.
//
//   node build.js              -> all 14 localized screenshots + tile + marquee
//   node build.js en de        -> just those screenshot locales
//   node build.js tiles        -> just the tile + marquee
//
// Popup UI strings come straight from ../../_locales/<code>/messages.json,
// headline/subline/chips from promo-strings.json next to this file.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SRC = __dirname;
const OUT = path.dirname(SRC);                 // store-assets/
const REPO = path.dirname(OUT);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const promo = JSON.parse(fs.readFileSync(path.join(SRC, "promo-strings.json"), "utf8"));
const ICON = "file:///" + path.join(REPO, "icons", "icon128.png").replace(/\\/g, "/");

function fill(templateFile, map) {
  let html = fs.readFileSync(path.join(SRC, templateFile), "utf8");
  for (const [k, v] of Object.entries(map)) html = html.split("{{" + k + "}}").join(v);
  for (const ch of ["—", "–"]) {
    if (html.includes(ch)) throw new Error("banned dash in " + templateFile);
  }
  const left = html.match(/\{\{[A-Z0-9_]+\}\}/);
  if (left) throw new Error("unfilled placeholder " + left[0] + " in " + templateFile);
  return html;
}

function shoot(html, outPng, w, h) {
  const tmp = path.join(os.tmpdir(), "tvb-promo-" + path.basename(outPng, ".png") + ".html");
  fs.writeFileSync(tmp, html, "utf8");
  execFileSync(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--default-background-color=FF0B0D12",
    "--screenshot=" + outPng,
    "--window-size=" + w + "," + h,
    "file:///" + tmp.replace(/\\/g, "/"),
  ], { stdio: "pipe" });
  fs.unlinkSync(tmp);
  console.log("OK " + outPng);
}

function popupStrings(code) {
  const msgs = JSON.parse(fs.readFileSync(path.join(REPO, "_locales", code, "messages.json"), "utf8"));
  const m = (k) => msgs[k].message;
  return {
    P_RESET: m("resetBtn"),
    P_THISTAB: m("subThisTab"),
    P_MODE: m("modeElement"),
    P_SCALEOFF: m("scaleOff"),
    P_LIMITER: m("limiterLabel"),
    P_LIMITERHINT: m("limiterHint"),
  };
}

function screenshot(code) {
  const p = promo[code];
  if (!p) { console.error("SKIP " + code + ": no promo strings"); return; }
  const html = fill("template-screenshot.html", {
    LANG: code.replace("_", "-"),
    ICON,
    H1A: p.h1a, H1B: p.h1b, SUB: p.sub,
    CHIP1: p.chips[0], CHIP2: p.chips[1], CHIP3: p.chips[2], CHIP4: p.chips[3],
    ...popupStrings(code),
  });
  shoot(html, path.join(OUT, "screenshot-1280x800-" + code + ".png"), 1280, 800);
}

function tiles() {
  shoot(fill("template-tile.html", { ICON }), path.join(OUT, "promo-small-440x280.png"), 440, 280);
  const p = promo.en;
  const html = fill("template-marquee.html", {
    ICON,
    H1A: p.h1a, H1B: p.h1b, SUB: p.sub,
    CHIP1: p.chips[0], CHIP2: p.chips[1], CHIP3: p.chips[2], CHIP4: p.chips[3],
    ...popupStrings("en"),
  });
  shoot(html, path.join(OUT, "promo-marquee-1400x560.png"), 1400, 560);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  for (const code of Object.keys(promo)) screenshot(code);
  tiles();
} else if (args[0] === "tiles") {
  tiles();
} else {
  for (const code of args) screenshot(code);
}