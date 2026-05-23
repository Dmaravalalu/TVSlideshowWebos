/*
 * Remote / keyboard handler.
 *
 * Listens for window keydown events and forwards them as
 * { type: "remote", key: "<action>" } over the WS via window.__slideshowSend.
 *
 * WebOS Magic Remote keys (461 Back, 415 Play, 19 Pause) sit alongside the
 * regular arrow / Enter mappings. Each key is debounced to 150 ms so a held
 * button doesn't flood the server.
 *
 * Loaded BEFORE app.js — app.js is what installs window.__slideshowSend, but
 * key events that arrive before the WS is open are simply silently dropped.
 */

(function () {
  "use strict";

  // keyCode -> action label
  var MAP = {
    37: "prev",            // ArrowLeft
    39: "next",            // ArrowRight
    38: "volUp",           // ArrowUp
    40: "volDown",         // ArrowDown
    13: "pause",           // Enter / OK
    461: "prev",           // WebOS Back
    415: "pause",          // WebOS Play
    19:  "pause",          // WebOS Pause
    82:  "shuffleToggle",  // R
  };

  // Keys that exit the slideshow back to the settings page.
  // Esc (27) for desktop browsers; 10009 is WebOS Magic Remote "Exit/Back".
  var EXIT_KEYS = { 27: true, 10009: true };

  var lastFire = {};
  var DEBOUNCE_MS = 150;

  window.addEventListener("keydown", function (ev) {
    if (EXIT_KEYS[ev.keyCode]) {
      ev.preventDefault();
      location.href = "/setup";
      return;
    }
    var action = MAP[ev.keyCode];
    if (!action) return;
    ev.preventDefault();
    var now = Date.now();
    if (lastFire[action] && now - lastFire[action] < DEBOUNCE_MS) return;
    lastFire[action] = now;
    if (window.__slideshowSend) {
      window.__slideshowSend({ type: "remote", key: action });
    }
  });
})();
