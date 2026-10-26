// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 marcanxo
//
// select.js: the rule that names the element a tab's level belongs on.
//
// The worker loads it with importScripts and every frame gets it injected right before
// content.js, so the probe, the worker's frame choice and the engage decide with the same code.
// A frame applies it to its own media elements, the worker to the candidates every frame
// reported, and both come to the same answer for the same facts.
//
// A candidate: { safe, reason, playing, ended, audible, area, rect, held, heard, played, video, frame }
//   safe, reason  the non-destructive verdict of content.js (assess, plus a failed redirect check)
//   playing       not paused, not ended, has data
//   ended         played to its end
//   audible       not muted and volume above 0, whether or not it plays
//   area, rect    its box in its frame's viewport, rect as { x, y, w, h } in whole pixels
//   held          the element its frame has hooked and still applies the level to
//   heard         sounded in its document within the last two minutes
//   played        has played in its document at some point
//   video         a <video> element (an <audio> element without controls has no box at all)
//   frame         the frame that reported it (the worker's frameId, "self" inside a frame)
(function (g) {
  // Checked as the real object: a page element with id or name "vbSelect" shows up on window as
  // well (named access). The assignment at the end makes an own property that shadows it.
  if (g.vbSelect && typeof g.vbSelect.choose === "function") return;

  // What the user hears at this moment.
  const sounding = (c) => !!(c.playing && c.audible);
  // Unmuted and not started, or paused before its end: a content player behind an ad.
  const waiting = (c) => !!(c.audible && !c.playing && !c.ended);
  // Unhookable for a reason that can pass: an ad served without CORS, a URL that redirects to
  // another origin. DRM, a media stream and an unparseable URL stay unhookable for good.
  const passing = (reason) => reason === "cross-origin-no-cors" || reason === "cross-origin-redirect";
  // An element no in-page hook can ever take, however long anyone waits.
  function unhookableForGood(c) {
    if (c.safe) return false;
    if (c.reason === "drm" || c.reason === "bad-url") return true;
    return !!c.playing && (c.reason === "no-src" || passing(c.reason));
  }
  // Playing first, then audible, then the bigger box.
  const score = (c) => (c.playing ? 2 : 0) + (c.audible ? 1 : 0);
  const byRank = (a, b) => score(b) - score(a) || b.area - a.area;

  // Whether two boxes of one frame overlap by at least half of the smaller one: an ad container
  // laid over the content player. Boxes from different frames are not comparable.
  function overlaps(a, b) {
    if (!(a.area > 0 && b.area > 0)) return false;
    const p = a.rect, q = b.rect;
    const w = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
    const h = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
    return w > 0 && h > 0 && w * h >= Math.min(p.w * p.h, q.w * q.h) / 2;
  }

  // Whether `c` is the player behind the loud element. Inside one frame the boxes tell. A held
  // video that has played and has no box at all counts too: a content player hidden for the ad.
  // An <audio> element without controls never has a box, so its missing box says nothing. Across
  // frames only one direction counts: an ad frame over the player the top frame holds, once that
  // player has played. A held player in a sub-frame does not stand in for a clip in the top frame,
  // and a decoy that took the level while nothing sounded has never played.
  function associated(c, loud) {
    if (c.frame !== loud.frame) return !!(c.held && c.played && c.frame === 0 && loud.frame !== 0);
    if (c.held && c.video && c.played && c.area === 0) return true;
    return overlaps(c, loud);
  }

  // A clip that stands apart: it has a box, and no hookable element of its frame lies under it.
  // A separate clip in a feed does. An ad laid over the content player or a hidden ad container
  // does not.
  function standsApart(c, cands) {
    return c.area > 0 && !cands.some((s) => s.safe && s.frame === c.frame && overlaps(s, c));
  }

  // Returns { pick, loud, certain }:
  //   pick     the candidate the level belongs on, or null when only capture reaches what plays
  //   loud     the sounding element no hook can take, when that is what decided (with a pick: the
  //            pick stands in for the player behind it)
  //   certain  no pick, and waiting for a hookable element cannot change that
  function choose(cands) {
    const all = cands.slice().sort(byRank);
    const held = all.find((c) => c.safe && c.held) || null;
    const loudOnes = all.filter(sounding);
    if (loudOnes.length) {
      // A hook on media the user hears never moves to other media.
      if (held && sounding(held)) return { pick: held, loud: null, certain: false };
      const hookable = loudOnes.find((c) => c.safe);
      if (hookable) return { pick: hookable, loud: null, certain: false };
      // Only unhookable media sounds, and hooking anything else changes nothing the user hears.
      // One exception: an ad without CORS in front of the content player. That player is unmuted
      // and waiting, and keeps (or gets) the hook for when the ad ends. A muted element never
      // stands in: nothing about it says it is the player the ad interrupts.
      const loud = loudOnes[0];
      if (passing(loud.reason)) {
        const stand = all.filter((c) => c.safe && waiting(c) && associated(c, loud));
        const pick = stand.find((c) => c.held) || stand[0] || null;
        if (pick) return { pick, loud, certain: false };
      }
      // DRM, a media stream, or an unhookable clip that interrupts nothing: only capture.
      return { pick: null, loud, certain: true };
    }
    // Nothing sounds. The hook stays where it is, otherwise the best safe element takes it.
    const pick = held || all.find((c) => c.safe) || null;
    return { pick, loud: null, certain: !pick && all.some(unhookableForGood) };
  }

  g.vbSelect = { choose, unhookableForGood, byRank, passing, standsApart };
})(globalThis);
