/* Canvassing Planner — standalone map + weekly planner.
   Pure vanilla JS + Leaflet. No build step, no API keys, no backend. */
/* global L */
(function () {
  "use strict";

  var DATA = {
    locations: "data/locations.json",
    summary: "data/summary.json",
    districts: "data/districts.geojson",
    boreslasher: "data/bores_lasher_results.geojson",
    neighborhoods: "data/neighborhoods.geojson",
    subway: "data/subway_stations.geojson",
  };
  var PLAN_KEY = "cm_plan_v1";

  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // candidate colors
  var MAYOR_COLORS = {
    "Zohran Kwame Mamdani": "#f4845f",
    "Andrew M. Cuomo": "#3a6ea5",
    "Brad Lander": "#6a4c93",
    "": "#cfd6dd",
  };
  var MAYOR_SHORT = {
    "Zohran Kwame Mamdani": "Mamdani",
    "Andrew M. Cuomo": "Cuomo",
    "Brad Lander": "Lander",
  };
  var BL_COLORS = { Bores: "#006544", Lasher: "#fdb800", Tie: "#9aa7b4", "No votes": "#e6eaee" };

  var state = {
    locations: [], summary: null,
    locById: {}, markersById: {},
    geo: {},               // cache of loaded geojson by name
    selectedId: null,
    sort: "opportunity",
    search: "",
    shadingMode: "opportunity",
    weekStart: null, activeDay: null, plan: {},
  };

  var map, legend;
  var renderers = {};
  var markerLayer;                 // canvassing sites
  var shadingLayer = null;
  var overlayLayers = { hoods: null, eds: null, subway: null };
  var maxWeighted = 1, maxBallots = 1, maxCoverage = 1, maxOpportunity = 1;
  var TODAY = startOfDay(new Date());

  // ---- helpers ---------------------------------------------------------
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmt(n) { n = num(n); return n % 1 === 0 ? String(n) : n.toFixed(1); }
  function pct(x) { return (num(x) * 100).toFixed(0) + "%"; }
  function clamp01(t) { return Math.max(0, Math.min(1, t)); }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function parseISO(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function isoOf(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
  }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function prettyDate(d) { return MONTHS[d.getMonth()] + " " + d.getDate(); }
  function pipeList(s) { return (s || "").split("|").map(function (x) { return x.trim(); }).filter(Boolean); }
  function firstAlias(loc) {
    var a = (loc.location_aliases || "").split("|")[0].trim();
    return a || ("Site at " + loc.latitude.toFixed(4) + ", " + loc.longitude.toFixed(4));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function lastCanvassed(loc) {
    var dates = pipeList(loc.dates_active).map(parseISO).filter(function (d) { return !isNaN(d); });
    if (!dates.length) return null;
    return dates.reduce(function (a, b) { return b > a ? b : a; });
  }
  function recencyLabel(loc) {
    var last = lastCanvassed(loc);
    if (!last) return { text: "never", cls: "stale", days: 99999 };
    var d = Math.round((TODAY - last) / 86400000);
    var weeks = Math.round(d / 7);
    var text = d <= 7 ? "this week" : (weeks <= 1 ? "1 wk ago" : weeks + " wks ago");
    var cls = d >= 35 ? "stale" : (d <= 14 ? "fresh" : "");
    return { text: text, cls: cls, days: d };
  }

  function lerp(a, b, t) { return a.map(function (x, i) { return Math.round(x + (b[i] - x) * t); }); }
  function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }
  var RAMPS = {
    opportunity: [[255, 245, 224], [203, 24, 29]],
    turnout: [[235, 244, 255], [8, 69, 148]],
    coverage: [[235, 250, 238], [0, 109, 44]],
  };
  function rampColor(mode, t) {
    var r = RAMPS[mode] || RAMPS.opportunity;
    return rgb(lerp(r[0], r[1], clamp01(Math.sqrt(t))));
  }

  // ---- lazy data loader ------------------------------------------------
  function ensureData(name) {
    if (state.geo[name]) return Promise.resolve(state.geo[name]);
    return fetch(DATA[name]).then(function (r) { return r.json(); })
      .then(function (g) { state.geo[name] = g; return g; });
  }

  // ---- summary + list (unchanged behavior) -----------------------------
  function buildSummary() {
    var s = state.summary || {};
    var stats = [
      { num: state.locations.length, lbl: "Locations canvassed" },
      { num: num(s.site_days_total), lbl: "Site-days" },
      { num: Math.round(num(s.total_raw_person_days_all_locations)), lbl: "Total person-days" },
      { num: fmt(s.total_weighted_person_days_all_locations), lbl: "Weighted coverage" },
    ];
    document.getElementById("summary").innerHTML = stats.map(function (x) {
      return '<div class="stat"><div class="num">' + x.num + '</div><div class="lbl">' + x.lbl + "</div></div>";
    }).join("");
  }
  function locScore(loc, key) {
    if (key === "recency") return recencyLabel(loc).days;
    if (key === "opportunity") {
      var rec = recencyLabel(loc).days;
      return Math.min(rec, 120) * Math.sqrt(num(loc.raw_person_days) + 1);
    }
    return num(loc[key]);
  }
  function visibleLocations() {
    var q = state.search.trim().toLowerCase();
    var list = state.locations.filter(function (loc) {
      if (!q) return true;
      return (loc.location_aliases || "").toLowerCase().indexOf(q) !== -1 ||
        (loc.unique_people || "").toLowerCase().indexOf(q) !== -1;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === "location_aliases") return firstAlias(a).localeCompare(firstAlias(b));
      return locScore(b, key) - locScore(a, key);
    });
    return list;
  }
  function renderList() {
    var list = visibleLocations();
    var ul = document.getElementById("location-list");
    ul.innerHTML = list.map(function (loc) {
      var active = loc.location_id === state.selectedId ? " active" : "";
      var rec = recencyLabel(loc);
      return (
        '<li class="loc-row' + active + '" data-id="' + escapeHtml(loc.location_id) + '">' +
        '<div class="loc-main" data-act="select">' +
          '<div class="name"><span class="swatch" style="background:' +
            rampColor("coverage", num(loc.weighted_person_days) / maxWeighted) + '"></span>' +
            escapeHtml(firstAlias(loc)) + "</div>" +
          '<div class="meta">Last canvassed <span class="recency ' + rec.cls + '">' + rec.text +
            "</span> · " + num(loc.raw_person_days) + " person-days · " + num(loc.unique_people_count) + " volunteers</div>" +
        "</div>" +
        '<button class="add-btn" data-act="add" title="Add to the selected day">+ Add</button>' +
        "</li>"
      );
    }).join("");
    document.getElementById("count-line").textContent =
      list.length + " of " + state.locations.length + " locations shown";
    Array.prototype.forEach.call(ul.querySelectorAll(".loc-row"), function (li) {
      var id = li.getAttribute("data-id");
      li.querySelector('[data-act="select"]').addEventListener("click", function () { selectLocation(id, true); });
      li.querySelector('[data-act="add"]').addEventListener("click", function (e) { e.stopPropagation(); addToPlan(id, state.activeDay); });
    });
  }

  // ---- canvassing site markers -----------------------------------------
  function radiusFor(weighted) { return 5 + Math.sqrt(num(weighted) / maxWeighted) * 18; }
  function popupHtml(loc) {
    var people = pipeList(loc.unique_people), dates = pipeList(loc.dates_active), rec = recencyLabel(loc);
    return (
      '<div class="popup-title">' + escapeHtml(firstAlias(loc)) + "</div>" +
      '<div class="popup-grid">' +
      '<span class="k">Last canvassed</span><span>' + rec.text + "</span>" +
      '<span class="k">Days active</span><span>' + num(loc.days_active) + "</span>" +
      '<span class="k">Person-days</span><span>' + num(loc.raw_person_days) + "</span>" +
      '<span class="k">Unique volunteers</span><span>' + num(loc.unique_people_count) + "</span>" +
      "</div>" +
      '<div class="popup-dates"><strong>Dates:</strong> ' + (dates.length ? escapeHtml(dates.join(", ")) : "—") + "</div>" +
      (people.length ? '<div class="popup-dates"><strong>Volunteers:</strong> ' +
        escapeHtml(people.slice(0, 12).join(", ")) + (people.length > 12 ? " +" + (people.length - 12) + " more" : "") + "</div>" : "") +
      '<button class="popup-add" data-add="' + escapeHtml(loc.location_id) + '">+ Add to selected day</button>'
    );
  }
  function renderMarkers() {
    markerLayer.clearLayers();
    state.markersById = {};
    state.locations.forEach(function (loc) {
      if (!isFinite(loc.latitude) || !isFinite(loc.longitude)) return;
      var m = L.circleMarker([loc.latitude, loc.longitude], {
        radius: radiusFor(loc.weighted_person_days), color: "#ffffff", weight: 1.5,
        fillColor: "#243b53", fillOpacity: 0.9, pane: "pane-sites", renderer: renderers.sites,
      });
      m.bindPopup(popupHtml(loc), { maxWidth: 320 });
      m.on("click", function () { selectLocation(loc.location_id, false); });
      m.addTo(markerLayer);
      state.markersById[loc.location_id] = m;
    });
  }
  function selectLocation(id, fromList) {
    state.selectedId = id;
    var loc = state.locById[id]; if (!loc) return;
    var m = state.markersById[id];
    if (m) { if (fromList) map.setView([loc.latitude, loc.longitude], Math.max(map.getZoom(), 15)); m.openPopup(); }
    renderList();
  }

  // ====================================================================
  //  DISTRICT SHADING (choropleth) — one active at a time
  // ====================================================================
  function districtMetric(p, mode) {
    var ballots = num(p.ballots_cast);
    var cov = num(p.distance_adjusted_weighted_person_days) || num(p.weighted_person_days);
    if (mode === "turnout") return ballots;
    if (mode === "coverage") return cov;
    var tN = maxBallots > 0 ? ballots / maxBallots : 0;
    var cN = maxCoverage > 0 ? cov / maxCoverage : 0;
    return tN * (1 - clamp01(cN));
  }
  function shadingStyle(feature) {
    var mode = state.shadingMode, p = feature.properties, base = { color: "#8aa0b6", weight: 0.4 };
    if (mode === "mayor2025") {
      base.fillColor = MAYOR_COLORS[p.top_mayor_rank1_candidate] || "#cfd6dd";
      base.fillOpacity = p.top_mayor_rank1_candidate ? 0.3 + clamp01(num(p.top_mayor_rank1_share)) * 0.45 : 0.15;
    } else if (mode === "boreslasher") {
      base.fillColor = BL_COLORS[p.winner] || "#b48ead";
      base.fillOpacity = num(p.total_votes) > 0 ? 0.32 + Math.min(Math.abs(num(p.margin)), 0.4) / 0.4 * 0.45 : 0.12;
    } else {
      var maxV = mode === "turnout" ? maxBallots : mode === "coverage" ? maxCoverage : maxOpportunity;
      base.fillColor = rampColor(mode, maxV > 0 ? districtMetric(p, mode) / maxV : 0);
      base.fillOpacity = 0.6;
    }
    return base;
  }
  function shadingTooltip(p) {
    var mode = state.shadingMode;
    if (mode === "mayor2025") {
      var w = p.top_mayor_rank1_candidate;
      return "ED " + p.election_district + " · AD " + p.assembly_district + "<br>" +
        (w ? "<strong>" + escapeHtml(MAYOR_SHORT[w] || w) + "</strong> led with " + pct(p.top_mayor_rank1_share) +
          " (" + num(p.top_mayor_rank1_votes) + " of " + num(p.mayor_rank1_valid_ballots) + ")" : "No mayoral data");
    }
    if (mode === "boreslasher") {
      return "ED " + p.elect_dist + "<br>" +
        '<span style="color:' + BL_COLORS.Bores + '">Bores</span> ' + num(p.bores) + " (" + pct(p.bores_share) + ") · " +
        '<span style="color:#b8860b">Lasher</span> ' + num(p.lasher) + " (" + pct(p.lasher_share) + ")<br>" +
        "<strong>" + escapeHtml(p.winner) + "</strong>" + (num(p.total_votes) ? "" : " — no votes");
    }
    var ballots = num(p.ballots_cast);
    var cov = num(p.distance_adjusted_weighted_person_days) || num(p.weighted_person_days);
    var head = "ED " + p.election_district + " · AD " + p.assembly_district;
    if (mode === "turnout") return head + "<br><strong>" + ballots + "</strong> Dem voters (2025)";
    if (mode === "coverage") return head + "<br>Coverage: <strong>" + fmt(cov) + "</strong> weighted person-days";
    return head + "<br><strong>" + ballots + "</strong> Dem voters (2025)<br>Coverage so far: " + fmt(cov) +
      (cov < 1 ? " — barely canvassed" : "");
  }
  function renderShading() {
    if (shadingLayer) { map.removeLayer(shadingLayer); shadingLayer = null; }
    updateLegend();
    if (state.shadingMode === "none") return;
    var src = state.shadingMode === "boreslasher" ? "boreslasher" : "districts";
    ensureData(src).then(function (g) {
      if (state.shadingMode === "none") return; // changed while loading
      shadingLayer = L.geoJSON(g, {
        pane: "pane-shading", renderer: renderers.shading, style: shadingStyle,
        onEachFeature: function (f, layer) { layer.bindTooltip(shadingTooltip(f.properties), { sticky: true }); },
      }).addTo(map);
    });
  }

  // ====================================================================
  //  TOGGLEABLE OVERLAYS
  // ====================================================================
  function toggleEds(on) {
    if (!on) { if (overlayLayers.eds) map.removeLayer(overlayLayers.eds); return; }
    if (overlayLayers.eds) { overlayLayers.eds.addTo(map); return; }
    ensureData("districts").then(function (g) {
      overlayLayers.eds = L.geoJSON(g, {
        pane: "pane-eds", renderer: renderers.eds,
        style: { fill: false, color: "#5a6b7d", weight: 0.6, opacity: 0.7 },
        onEachFeature: function (f, l) {
          l.bindTooltip("ED " + f.properties.election_district + " · AD " + f.properties.assembly_district, { sticky: true });
        },
      }).addTo(map);
    });
  }
  function toggleHoods(on) {
    if (!on) { if (overlayLayers.hoods) map.removeLayer(overlayLayers.hoods); return; }
    if (overlayLayers.hoods) { overlayLayers.hoods.addTo(map); return; }
    ensureData("neighborhoods").then(function (g) {
      overlayLayers.hoods = L.geoJSON(g, {
        pane: "pane-hoods", renderer: renderers.hoods,
        style: { fill: false, color: "#6a4c93", weight: 1.4, opacity: 0.85, dashArray: "4 3" },
        onEachFeature: function (f, l) {
          l.bindTooltip(escapeHtml(f.properties.name || "Neighborhood"),
            { permanent: true, direction: "center", className: "hood-label" });
        },
      }).addTo(map);
    });
  }
  function toggleSubway(on) {
    if (!on) { if (overlayLayers.subway) map.removeLayer(overlayLayers.subway); return; }
    if (overlayLayers.subway) { overlayLayers.subway.addTo(map); return; }
    ensureData("subway").then(function (g) {
      overlayLayers.subway = L.geoJSON(g, {
        pane: "pane-subway",
        pointToLayer: function (f, latlng) {
          return L.circleMarker(latlng, {
            pane: "pane-subway", renderer: renderers.subway,
            radius: 3.5, color: "#111", weight: 1, fillColor: "#fff", fillOpacity: 1,
          });
        },
        onEachFeature: function (f, l) {
          var p = f.properties;
          l.bindTooltip("🚇 " + escapeHtml(p.name || "") + (p.routes ? " (" + escapeHtml(p.routes) + ")" : ""), { sticky: true });
        },
      }).addTo(map);
    });
  }
  function toggleSites(on) { if (on) markerLayer.addTo(map); else map.removeLayer(markerLayer); }

  // ---- legend ----------------------------------------------------------
  function updateLegend() {
    if (!legend) return;
    var el = legend.getContainer(), mode = state.shadingMode;
    var dotNote = '<div class="dotnote"><span class="dot"></span> Dot = a past canvassing site (bigger = more)</div>';
    if (mode === "none") { el.innerHTML = "<h4>Map</h4>" + dotNote; return; }
    if (mode === "mayor2025") {
      el.innerHTML = "<h4>2025 Mayor — who led each ED</h4>" +
        cat(MAYOR_COLORS["Zohran Kwame Mamdani"], "Mamdani") +
        cat(MAYOR_COLORS["Andrew M. Cuomo"], "Cuomo") +
        cat(MAYOR_COLORS["Brad Lander"], "Lander") +
        '<div class="sub">Stronger color = bigger win.</div>' + dotNote;
      return;
    }
    if (mode === "boreslasher") {
      el.innerHTML = "<h4>Our race — who won each ED</h4>" +
        cat(BL_COLORS.Bores, "Bores") + cat(BL_COLORS.Lasher, "Lasher") + cat(BL_COLORS.Tie, "Tie / other") +
        '<div class="sub">Stronger color = bigger margin.</div>' + dotNote;
      return;
    }
    var titles = { opportunity: "Priority for next week", turnout: "2025 Dem primary turnout", coverage: "Canvassing coverage so far" };
    var ends = {
      opportunity: ["already covered / low turnout", "high turnout, under-canvassed"],
      turnout: ["fewer voters", "more voters"],
      coverage: ["not canvassed", "heavily canvassed"],
    };
    var ramp = "";
    for (var i = 0; i <= 8; i++) ramp += '<span style="background:' + rampColor(mode, i / 8) + '"></span>';
    el.innerHTML = "<h4>" + titles[mode] + "</h4>" +
      '<div class="ramp">' + ramp + "</div>" +
      '<div class="ends"><span>' + ends[mode][0] + "</span><span>" + ends[mode][1] + "</span></div>" + dotNote;
  }
  function cat(color, label) {
    return '<div class="cat"><span class="box" style="background:' + color + '"></span>' + escapeHtml(label) + "</div>";
  }

  // ====================================================================
  //  WEEKLY PLANNER  (unchanged)
  // ====================================================================
  function loadPlan() { try { state.plan = JSON.parse(localStorage.getItem(PLAN_KEY)) || {}; } catch (e) { state.plan = {}; } }
  function savePlan() { try { localStorage.setItem(PLAN_KEY, JSON.stringify(state.plan)); } catch (e) {} }
  function nextMonday() { var day = TODAY.getDay(); var delta = ((8 - day) % 7) || 7; return addDays(TODAY, delta); }
  function weekDays() { var out = []; for (var i = 0; i < 7; i++) out.push(addDays(state.weekStart, i)); return out; }
  function dowName(d) { return DAY_NAMES[(d.getDay() + 6) % 7]; }
  function flashAddingBanner() {
    var b = document.getElementById("adding-banner");
    if (!state.activeDay) { b.classList.remove("show"); return; }
    var d = parseISO(state.activeDay);
    b.textContent = "+ Add will drop sites on " + dowName(d) + " " + prettyDate(d);
    b.classList.add("show");
  }
  function addToPlan(locId, dayIso) {
    if (!dayIso) return;
    var arr = state.plan[dayIso] || (state.plan[dayIso] = []);
    if (arr.indexOf(locId) === -1) arr.push(locId);
    savePlan(); renderPlan();
    var loc = state.locById[locId], b = document.getElementById("adding-banner"), d = parseISO(dayIso);
    b.textContent = "Added “" + firstAlias(loc) + "” to " + dowName(d) + " " + prettyDate(d);
    b.classList.add("show");
  }
  function removeFromPlan(locId, dayIso) {
    var arr = state.plan[dayIso]; if (!arr) return;
    var i = arr.indexOf(locId); if (i !== -1) arr.splice(i, 1);
    if (!arr.length) delete state.plan[dayIso];
    savePlan(); renderPlan();
  }
  function renderWeekLabel() {
    var days = weekDays();
    document.getElementById("week-label").textContent = "Week of " + prettyDate(days[0]) + " – " + prettyDate(days[6]);
  }
  function renderPlan() {
    renderWeekLabel(); flashAddingBanner();
    var container = document.getElementById("plan-days");
    container.innerHTML = weekDays().map(function (d) {
      var iso = isoOf(d), sites = state.plan[iso] || [], isActive = iso === state.activeDay ? " active" : "";
      var sitesHtml = sites.map(function (id) {
        var loc = state.locById[id], nm = loc ? firstAlias(loc) : id;
        return '<li><span class="s-name" data-go="' + escapeHtml(id) + '">' + escapeHtml(nm) +
          '</span><button class="rm-btn" data-rm="' + escapeHtml(id) + '" data-day="' + iso + '">✕</button></li>';
      }).join("");
      return '<div class="day-card' + isActive + '" data-day="' + iso + '">' +
        '<div class="day-head" data-act="pick"><span class="d-name">' + dowName(d) + " " + prettyDate(d) + "</span>" +
        '<span class="d-count">' + (sites.length ? sites.length + " site" + (sites.length > 1 ? "s" : "") : "select") + "</span></div>" +
        '<ul class="day-sites">' + sitesHtml + "</ul></div>";
    }).join("");
    Array.prototype.forEach.call(container.querySelectorAll(".day-card"), function (card) {
      var iso = card.getAttribute("data-day");
      card.querySelector('[data-act="pick"]').addEventListener("click", function () { state.activeDay = iso; renderPlan(); });
      Array.prototype.forEach.call(card.querySelectorAll(".rm-btn"), function (btn) {
        btn.addEventListener("click", function () { removeFromPlan(btn.getAttribute("data-rm"), btn.getAttribute("data-day")); });
      });
      Array.prototype.forEach.call(card.querySelectorAll(".s-name"), function (sn) {
        sn.addEventListener("click", function () { switchTab("locations"); selectLocation(sn.getAttribute("data-go"), true); });
      });
    });
  }
  function planAsText() {
    var lines = ["Canvassing plan — " + document.getElementById("week-label").textContent, ""];
    weekDays().forEach(function (d) {
      var iso = isoOf(d), sites = state.plan[iso] || []; if (!sites.length) return;
      lines.push(dowName(d) + " " + prettyDate(d) + ":");
      sites.forEach(function (id) { var loc = state.locById[id]; lines.push("  • " + (loc ? firstAlias(loc) : id)); });
      lines.push("");
    });
    if (lines.length <= 2) lines.push("(no sites added yet)");
    return lines.join("\n");
  }
  function copyPlan() {
    var text = planAsText(), done = function () {
      var el = document.getElementById("plan-copied"); el.textContent = "Copied to clipboard ✓";
      setTimeout(function () { el.textContent = ""; }, 2500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(text).then(done, function () { window.prompt("Copy the plan:", text); });
    else window.prompt("Copy the plan:", text);
  }
  function printPlan() {
    var rows = weekDays().map(function (d) {
      var iso = isoOf(d), sites = (state.plan[iso] || []).map(function (id) {
        var loc = state.locById[id]; if (!loc) return "<li>" + escapeHtml(id) + "</li>";
        var rec = recencyLabel(loc);
        return "<li><strong>" + escapeHtml(firstAlias(loc)) + "</strong> — last canvassed " + rec.text +
          ", " + num(loc.raw_person_days) + " past person-days</li>";
      }).join("");
      return "<div class='d'><h3>" + dowName(d) + " " + prettyDate(d) + "</h3><ul>" + (sites || "<li class='empty'>—</li>") + "</ul></div>";
    }).join("");
    var html = "<html><head><title>Canvassing plan</title><style>" +
      "body{font-family:-apple-system,Arial,sans-serif;margin:32px;color:#1f2b38}h1{font-size:20px}" +
      "h3{font-size:14px;margin:0 0 4px;border-bottom:1px solid #ccc;padding-bottom:3px}.d{margin-bottom:14px}" +
      "ul{margin:4px 0 0 18px;padding:0}li{font-size:13px;margin:3px 0}.empty{color:#999;list-style:none;margin-left:-18px}" +
      "</style></head><body><h1>Canvassing plan</h1><h2 style='font-size:14px;color:#555'>" +
      escapeHtml(document.getElementById("week-label").textContent) + "</h2>" + rows + "</body></html>";
    var w = window.open("", "_blank");
    if (!w) { alert("Please allow pop-ups to print the plan."); return; }
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(function () { w.print(); }, 250);
  }

  // ---- tabs ------------------------------------------------------------
  function switchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === name);
    });
    document.getElementById("panel-locations").classList.toggle("hidden", name !== "locations");
    document.getElementById("panel-plan").classList.toggle("hidden", name !== "plan");
    setTimeout(function () { map.invalidateSize(); }, 50);
  }

  // ---- init ------------------------------------------------------------
  function makePanes() {
    var defs = [["pane-shading", 410], ["pane-hoods", 420], ["pane-eds", 430], ["pane-subway", 440], ["pane-sites", 450]];
    defs.forEach(function (d) { map.createPane(d[0]); map.getPane(d[0]).style.zIndex = d[1]; });
    renderers.shading = L.canvas({ pane: "pane-shading" });
    renderers.hoods = L.canvas({ pane: "pane-hoods" });
    renderers.eds = L.canvas({ pane: "pane-eds" });
    renderers.subway = L.canvas({ pane: "pane-subway" });
    renderers.sites = L.canvas({ pane: "pane-sites" });
  }
  function wireUi() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      t.addEventListener("click", function () { switchTab(t.getAttribute("data-tab")); });
    });
    document.getElementById("search").addEventListener("input", function (e) { state.search = e.target.value; renderList(); });
    document.getElementById("sort").addEventListener("change", function (e) { state.sort = e.target.value; renderList(); });
    document.getElementById("shading-mode").addEventListener("change", function (e) { state.shadingMode = e.target.value; renderShading(); });
    document.getElementById("lyr-sites").addEventListener("change", function (e) { toggleSites(e.target.checked); });
    document.getElementById("lyr-eds").addEventListener("change", function (e) { toggleEds(e.target.checked); });
    document.getElementById("lyr-hoods").addEventListener("change", function (e) { toggleHoods(e.target.checked); });
    document.getElementById("lyr-subway").addEventListener("change", function (e) { toggleSubway(e.target.checked); });
    document.getElementById("week-prev").addEventListener("click", function () { state.weekStart = addDays(state.weekStart, -7); state.activeDay = isoOf(state.weekStart); renderPlan(); });
    document.getElementById("week-next").addEventListener("click", function () { state.weekStart = addDays(state.weekStart, 7); state.activeDay = isoOf(state.weekStart); renderPlan(); });
    document.getElementById("plan-print").addEventListener("click", printPlan);
    document.getElementById("plan-copy").addEventListener("click", copyPlan);
    document.getElementById("plan-clear").addEventListener("click", function () {
      if (!confirm("Remove all sites from this week's plan?")) return;
      weekDays().forEach(function (d) { delete state.plan[isoOf(d)]; }); savePlan(); renderPlan();
    });
    map.on("popupopen", function (e) {
      var btn = e.popup.getElement().querySelector(".popup-add");
      if (btn) btn.addEventListener("click", function () { addToPlan(btn.getAttribute("data-add"), state.activeDay); });
    });
  }
  function init() {
    map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([40.78, -73.96], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }).addTo(map);
    makePanes();
    markerLayer = L.layerGroup();

    legend = L.control({ position: "bottomright" });
    legend.onAdd = function () { return L.DomUtil.create("div", "legend"); };
    legend.addTo(map);

    loadPlan();
    state.weekStart = nextMonday();
    state.activeDay = isoOf(state.weekStart);

    Promise.all([
      fetch(DATA.locations).then(function (r) { return r.json(); }),
      fetch(DATA.summary).then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch(DATA.districts).then(function (r) { return r.json(); }).catch(function () { return null; }),
    ]).then(function (res) {
      state.locations = (res[0] || []).filter(function (l) { return isFinite(l.latitude) && isFinite(l.longitude); });
      state.summary = res[1];
      if (res[2]) state.geo.districts = res[2];
      state.locations.forEach(function (l) { state.locById[l.location_id] = l; });
      maxWeighted = state.locations.reduce(function (m, l) { return Math.max(m, num(l.weighted_person_days)); }, 1);
      if (res[2]) {
        res[2].features.forEach(function (f) {
          maxBallots = Math.max(maxBallots, num(f.properties.ballots_cast));
          maxCoverage = Math.max(maxCoverage, num(f.properties.distance_adjusted_weighted_person_days) || num(f.properties.weighted_person_days));
        });
        maxOpportunity = res[2].features.reduce(function (m, f) { return Math.max(m, districtMetric(f.properties, "opportunity")); }, 0.0001);
      }
      renderMarkers();
      markerLayer.addTo(map);          // sites on by default
      buildSummary(); renderList(); renderPlan();
      renderShading();                 // default: priority
      var pts = state.locations.map(function (l) { return [l.latitude, l.longitude]; });
      if (pts.length) { map.invalidateSize(); map.fitBounds(pts, { padding: [40, 40], maxZoom: 15, animate: false }); }
    }).catch(function (err) {
      document.getElementById("subtitle").textContent = "Could not load data — open this through start_map.command (see README).";
      console.error(err);
    });

    wireUi();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
