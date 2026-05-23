/*
 * Slideshow frontend (TV-facing).
 *
 * Responsibilities:
 *
 *   - Connect to the server WS at /ctrl, reconnect with exponential backoff
 *     capped at 10 s.
 *   - Receive `show` messages and crossfade between two stacked layers.
 *   - Drive image timing locally (setTimeout(imgSec*1000) -> {type:"ended"});
 *     videos use their native `ended` event. A 500 ms error fallback prevents
 *     a corrupt file from stalling the show.
 *   - Display current folder bottom-left, live clock bottom-right.
 *   - Show transient toasts for volume / mode / paused changes.
 *
 * Target: WebOS browser ~ Chromium 87. No optional chaining (`?.`), no
 * nullish coalescing (`??`), no top-level await.
 */

(function () {
  "use strict";

  var stage = document.getElementById("stage");
  var layers = [document.getElementById("layerA"), document.getElementById("layerB")];
  var preloader = document.getElementById("preloader");
  var folderEl = document.getElementById("folder");
  var clockEl = document.getElementById("clock");
  var toastEl = document.getElementById("toast");
  var overlay = document.getElementById("overlay");

  var active = 0; // which layer is currently visible
  var imgTimer = null;
  var lastShown = null;
  var imgSecLocal = 5;
  var pausedLocal = false;
  var endFallback = null;
  var ws = null;
  var backoff = 500;

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function tickClock() {
    var d = new Date();
    clockEl.textContent = pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  setInterval(tickClock, 1000); tickClock();

  // Reveal the Exit link briefly on tap/click (TV browsers won't fire :hover).
  var chromeTimer = null;
  function revealChrome() {
    stage.classList.add("show-chrome");
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = setTimeout(function () { stage.classList.remove("show-chrome"); }, 3000);
  }
  stage.addEventListener("click", revealChrome);
  stage.addEventListener("touchstart", revealChrome);

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toastEl.classList.remove("show"); }, 1400);
  }

  function sendEnded() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ended" }));
  }

  function clearImgTimer() {
    if (imgTimer) { clearTimeout(imgTimer); imgTimer = null; }
    if (endFallback) { clearTimeout(endFallback); endFallback = null; }
  }

  function buildMedia(item) {
    var el;
    if (item.kind === "video") {
      el = document.createElement("video");
      el.src = item.url;
      el.autoplay = true;
      el.muted = false;
      el.playsInline = true;
      el.controls = false;
      el.preload = "auto";
      el.addEventListener("ended", function () { sendEnded(); });
      el.addEventListener("error", function () {
        // Corrupt file: don't stall; pretend it ended after a brief delay.
        if (endFallback) clearTimeout(endFallback);
        endFallback = setTimeout(sendEnded, 500);
      });
    } else {
      el = document.createElement("img");
      el.src = item.url;
      el.alt = "";
      el.addEventListener("error", function () {
        if (endFallback) clearTimeout(endFallback);
        endFallback = setTimeout(sendEnded, 500);
      });
    }
    return el;
  }

  function readyEvent(el) {
    return new Promise(function (resolve) {
      var done = false;
      function fire() { if (!done) { done = true; resolve(); } }
      if (el.tagName === "VIDEO") {
        el.addEventListener("loadeddata", fire, { once: true });
        el.addEventListener("canplay", fire, { once: true });
        // Safety net so we don't hang forever if the codec lies.
        setTimeout(fire, 2000);
      } else {
        if (el.complete && el.naturalWidth > 0) { fire(); return; }
        el.addEventListener("load", fire, { once: true });
        // Same safety net for stuck image decodes.
        setTimeout(fire, 2000);
      }
    });
  }

  function showItem(item) {
    if (!item) return;
    clearImgTimer();
    overlay.classList.add("hidden");
    var inactiveIdx = 1 - active;
    var nextLayer = layers[inactiveIdx];
    nextLayer.innerHTML = "";
    var el = buildMedia(item);
    nextLayer.appendChild(el);
    readyEvent(el).then(function () {
      // Update folder label in lockstep with the crossfade so the label
      // doesn't change ahead of the picture.
      folderEl.textContent = item.rel;
      nextLayer.classList.add("visible");
      layers[active].classList.remove("visible");
      // Wait for fade to complete before clearing the previous layer.
      setTimeout(function () { layers[active].innerHTML = ""; active = inactiveIdx; }, 250);
      if (item.kind === "image" && !pausedLocal) {
        imgTimer = setTimeout(sendEnded, imgSecLocal * 1000);
      }
      lastShown = item;
    });
  }

  function preload(hint) {
    if (!hint || !hint.url) return;
    preloader.innerHTML = "";
    var el;
    if (hint.kind === "video") {
      el = document.createElement("video");
      el.preload = "auto";
      el.muted = true;
      el.src = hint.url;
    } else {
      el = document.createElement("img");
      el.src = hint.url;
    }
    preloader.appendChild(el);
  }

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ctrl");
    ws.addEventListener("open", function () {
      overlay.textContent = "Loading ...";
      backoff = 500;
      ws.send(JSON.stringify({ type: "ready" }));
    });
    ws.addEventListener("message", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (_e) { return; }
      switch (msg.type) {
        case "show":
          imgSecLocal = msg.imgSec || imgSecLocal;
          showItem(msg.item);
          if (msg.nextHint) preload(msg.nextHint);
          break;
        case "volume":
          showToast("Volume " + Math.round(msg.value * 100) + "%");
          break;
        case "paused":
          pausedLocal = !!msg.value;
          showToast(pausedLocal ? "Paused" : "Playing");
          if (pausedLocal) clearImgTimer();
          else if (lastShown && lastShown.kind === "image") imgTimer = setTimeout(sendEnded, imgSecLocal * 1000);
          break;
        case "mode":
          showToast("Mode: " + msg.value);
          break;
        case "status":
          if (!msg.indexed) {
            overlay.classList.remove("hidden");
            overlay.textContent = msg.root
              ? "Indexing your media ..."
              : "Open the setup page on a phone or laptop:\nhttp://" + location.host + "/";
          }
          // Sync client paused state from server so we don't silently sit on a
          // persisted paused state with no indication.
          if (typeof msg.paused === "boolean") {
            pausedLocal = msg.paused;
            if (pausedLocal) showToast("Paused");
          }
          break;
        case "error":
          // No-op for now; server logs already have the detail.
          break;
      }
    });
    ws.addEventListener("close", function () {
      overlay.classList.remove("hidden");
      overlay.textContent = "Reconnecting ...";
      setTimeout(connect, backoff);
      backoff = Math.min(10000, Math.round(backoff * 1.8));
    });
    ws.addEventListener("error", function () { try { ws.close(); } catch (_e) {} });
  }
  connect();

  // Expose a hook the remote uses to forward keypresses.
  window.__slideshowSend = function (msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };
})();
