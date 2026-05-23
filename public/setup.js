/*
 * Setup page client.
 *
 * Browses the server's allowed roots (drive letters on Windows; ~, /mnt, /media,
 * /home on Linux). When the user clicks "Use this folder", POSTs to /api/root,
 * then polls /api/status for indexing progress until it's done, at which point
 * the page redirects to /slideshow.
 *
 * Vanilla ES5/ES2019 — no top-level await, no fetch generator helpers.
 */

(function () {
  "use strict";

  var driveSel = document.getElementById("drive");
  var crumbs = document.getElementById("crumbs");
  var dirsEl = document.getElementById("dirs");
  var upBtn = document.getElementById("up");
  var pickBtn = document.getElementById("pick");
  var statusEl = document.getElementById("status");
  var progressWrap = document.getElementById("progressWrap");
  var progressBar = document.getElementById("progressBar");
  var tvUrl = document.getElementById("tvUrl");

  var current = null;
  var isWindows = false;

  // Best-effort: show the actual host in the TV-URL hint.
  tvUrl.textContent = "http://" + location.hostname + ":" + location.port + "/slideshow";

  function setStatus(msg) { statusEl.textContent = msg; }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function postJSON(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      if (!r.ok && r.status !== 202) throw new Error("HTTP " + r.status);
      return r.status === 202 ? {} : r.json();
    });
  }

  function loadDirs(p) {
    setStatus("Loading " + p + " ...");
    return getJSON("/api/dirs?path=" + encodeURIComponent(p)).then(function (data) {
      current = data.path;
      crumbs.textContent = data.path;
      dirsEl.innerHTML = "";
      if (data.dirs.length === 0) {
        var empty = document.createElement("div");
        empty.style.padding = "10px 12px";
        empty.style.color = "#666";
        empty.textContent = "(no subfolders)";
        dirsEl.appendChild(empty);
      } else {
        data.dirs.forEach(function (d) {
          var b = document.createElement("button");
          b.className = "dir";
          b.type = "button";
          b.textContent = d.name;
          b.addEventListener("click", function () { loadDirs(d.path); });
          dirsEl.appendChild(b);
        });
      }
      upBtn.disabled = !data.parent;
      upBtn.onclick = function () { if (data.parent) loadDirs(data.parent); };
      setStatus("Browsing " + data.path);
    }).catch(function (err) {
      setStatus("Error loading directory: " + err.message);
    });
  }

  // Build the drive dropdown (Windows) or hide it (Linux/macOS).
  getJSON("/api/drives").then(function (resp) {
    if (resp.drives && resp.drives.length > 0) {
      isWindows = true;
      var df = document.getElementById("driveField");
      df.style.display = "";
      resp.drives.forEach(function (d) {
        var opt = document.createElement("option");
        opt.value = d.path;
        opt.textContent = d.letter + ":";
        driveSel.appendChild(opt);
      });
      driveSel.addEventListener("change", function () { loadDirs(driveSel.value); });
      loadDirs(resp.drives[0].path);
    } else {
      // Hide the drive picker; start from ~/.
      var df = document.getElementById("driveField");
      df.style.display = "none";
      // Probe a few common roots; first that lists wins.
      var roots = ["/mnt", "/media", "/home"];
      function tryRoot(i) {
        if (i >= roots.length) {
          // Fall back to home: ask the server by attempting to load "/".
          loadDirs("/");
          return;
        }
        getJSON("/api/dirs?path=" + encodeURIComponent(roots[i])).then(function (d) {
          current = d.path; crumbs.textContent = d.path; loadDirs(d.path);
        }).catch(function () { tryRoot(i + 1); });
      }
      tryRoot(0);
    }
  }).catch(function (err) {
    setStatus("Failed to enumerate drives: " + err.message);
  });

  pickBtn.addEventListener("click", function () {
    if (!current) return;
    pickBtn.disabled = true;
    setStatus("Saving media root and starting index ...");
    postJSON("/api/root", { path: current }).then(function () {
      progressWrap.style.display = "";
      pollStatus();
    }).catch(function (err) {
      pickBtn.disabled = false;
      setStatus("Failed: " + err.message);
    });
  });

  function pollStatus() {
    getJSON("/api/status").then(function (s) {
      if (typeof s.indexingProgress === "number") {
        progressBar.style.width = Math.round(s.indexingProgress * 100) + "%";
        setStatus("Indexing ... " + Math.round(s.indexingProgress * 100) + "%");
        setTimeout(pollStatus, 750);
      } else if (s.indexed && s.total > 0) {
        progressBar.style.width = "100%";
        setStatus("Indexed " + s.total + " files. Redirecting to slideshow ...");
        setTimeout(function () { location.href = "/slideshow"; }, 800);
      } else {
        setStatus("Indexing ...");
        setTimeout(pollStatus, 750);
      }
    }).catch(function () { setTimeout(pollStatus, 1500); });
  }
})();
