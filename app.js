/* Canvassing Planner — standalone map + weekly shift planner.
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
    polls: "data/election_day_poll_sites.geojson",
    early: "data/early_voting_sites.geojson",
    groc: "data/supermarkets.geojson",
  };
  var PLAN_KEY = "cm_plan_v2";

  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function shiftTime(date, shift) {
    var weekend = date.getDay() === 0 || date.getDay() === 6;
    if (weekend) return shift === "AM" ? "9a–1p" : "12–4p";
    return shift === "AM" ? "8a–12p" : "4–8p";
  }

  var MTA = {
    "1": "#EE352E", "2": "#EE352E", "3": "#EE352E", "4": "#00933C", "5": "#00933C", "6": "#00933C",
    "7": "#B933AD", "A": "#0039A6", "C": "#0039A6", "E": "#0039A6", "B": "#FF6319", "D": "#FF6319",
    "F": "#FF6319", "M": "#FF6319", "N": "#FCCC0A", "Q": "#FCCC0A", "R": "#FCCC0A", "W": "#FCCC0A",
    "G": "#6CBE45", "J": "#996633", "Z": "#996633", "L": "#A7A9AC", "S": "#808183",
  };
  function trunkColor(routes) { var f = String(routes || "").split(/[-\s]/)[0].toUpperCase(); return MTA[f] || "#444"; }

  var MAYOR_COLORS = { "Zohran Kwame Mamdani": "#f4845f", "Andrew M. Cuomo": "#3a6ea5", "Brad Lander": "#6a4c93", "": "#cfd6dd" };
  var MAYOR_SHORT = { "Zohran Kwame Mamdani": "Mamdani", "Andrew M. Cuomo": "Cuomo", "Brad Lander": "Lander" };
  var BL_COLORS = { Bores: "#006544", Lasher: "#fdb800", Tie: "#9aa7b4", "No votes": "#e6eaee" };
  function leanColor(cat) {
    cat = String(cat || "");
    if (/bores/i.test(cat)) return "#006544";
    if (/lasher/i.test(cat)) return "#c79100";
    return "#6b7785";
  }

  // stronger ramps (darker high end) for clearer high/low separation
  var RAMPS = { opportunity: [[255, 247, 232], [150, 0, 12]], turnout: [[233, 242, 255], [3, 41, 99]], coverage: [[233, 250, 236], [0, 78, 33]] };

  var state = {
    locations: [], summary: null, locById: {}, markersById: {},
    geo: {}, edProps: {},
    selectedId: null, sort: "opportunity", search: "",
    shadingMode: "opportunity",
    weekStart: null, activeDay: null, activeShift: "AM", plan: {},
    pcts: {},
  };

  var map, legend, districtLayer, markerLayer;
  var overlay = { hoods: null, subway: null, polls: null, early: null, groc: null };
  var renderers = {};
  var edCentroid = {};
  var maxWeighted = 1, maxBallots = 1, maxCoverage = 1, maxOpportunity = 1;
  var TODAY = startOfDay(new Date());

  // ---- helpers ---------------------------------------------------------
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmt(n) { n = num(n); return n % 1 === 0 ? String(n) : n.toFixed(1); }
  function commas(n) { return num(n).toLocaleString("en-US"); }
  function pct(x) { return (num(x) * 100).toFixed(0) + "%"; }
  function clamp01(t) { return Math.max(0, Math.min(1, t)); }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function parseISO(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function isoOf(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function prettyDate(d) { return MONTHS[d.getMonth()] + " " + d.getDate(); }
  function dowName(d) { return DAY_NAMES[(d.getDay() + 6) % 7]; }
  function pipeList(s) { return (s || "").split("|").map(function (x) { return x.trim(); }).filter(Boolean); }
  function firstAlias(loc) { var a = (loc.location_aliases || "").split("|")[0].trim(); return a || ("Site at " + loc.latitude.toFixed(4) + ", " + loc.longitude.toFixed(4)); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function edShort(ed) { ed = String(ed); return Number(ed.slice(0, -3)) + "/" + Number(ed.slice(-3)); }
  function edLabel(ed) { ed = String(ed); return "AD " + Number(ed.slice(0, -3)) + " · ED " + Number(ed.slice(-3)); }

  function lastCanvassed(loc) {
    var dates = pipeList(loc.dates_active).map(parseISO).filter(function (d) { return !isNaN(d); });
    return dates.length ? dates.reduce(function (a, b) { return b > a ? b : a; }) : null;
  }
  function recencyLabel(loc) {
    var last = lastCanvassed(loc);
    if (!last) return { text: "never", cls: "stale", days: 99999 };
    var d = Math.round((TODAY - last) / 86400000), weeks = Math.round(d / 7);
    return { text: d <= 7 ? "this week" : (weeks <= 1 ? "1 wk ago" : weeks + " wks ago"), cls: d >= 35 ? "stale" : (d <= 14 ? "fresh" : ""), days: d };
  }

  function lerp(a, b, t) { return a.map(function (x, i) { return Math.round(x + (b[i] - x) * t); }); }
  function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }
  function rampCol(mode, t) { var r = RAMPS[mode] || RAMPS.opportunity; return rgb(lerp(r[0], r[1], clamp01(t))); }

  // percentile (rank) of a value within a precomputed sorted array — spreads colors evenly
  function lowerBound(arr, v) { var lo = 0, hi = arr.length; while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }
  function percentile(name, v) { var a = state.pcts[name]; if (!a || a.length < 2) return 1; return lowerBound(a, v) / (a.length - 1); }

  function ensureData(name) {
    if (state.geo[name]) return Promise.resolve(state.geo[name]);
    return fetch(DATA[name]).then(function (r) { return r.json(); }).then(function (g) { state.geo[name] = g; return g; });
  }

  // ---- summary + browse list -------------------------------------------
  function buildSummary() {
    var s = state.summary || {};
    var stats = [
      { num: state.locations.length, lbl: "Past locations" },
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
    if (key === "opportunity") { var rec = recencyLabel(loc).days; return Math.min(rec, 120) * Math.sqrt(num(loc.raw_person_days) + 1); }
    return num(loc[key]);
  }
  function visibleLocations() {
    var q = state.search.trim().toLowerCase();
    var list = state.locations.filter(function (loc) {
      if (!q) return true;
      return (loc.location_aliases || "").toLowerCase().indexOf(q) !== -1 || (loc.unique_people || "").toLowerCase().indexOf(q) !== -1;
    });
    var key = state.sort;
    list.sort(function (a, b) { return key === "location_aliases" ? firstAlias(a).localeCompare(firstAlias(b)) : locScore(b, key) - locScore(a, key); });
    return list;
  }
  function renderList() {
    var list = visibleLocations(), ul = document.getElementById("location-list");
    ul.innerHTML = list.map(function (loc) {
      var active = loc.location_id === state.selectedId ? " active" : "", rec = recencyLabel(loc);
      return '<li class="loc-row' + active + '" data-id="' + escapeHtml(loc.location_id) + '"><div class="loc-main">' +
        '<div class="name"><span class="swatch" style="background:' + rampCol("coverage", num(loc.weighted_person_days) / maxWeighted) + '"></span>' +
        escapeHtml(firstAlias(loc)) + "</div>" +
        '<div class="meta">Last canvassed <span class="recency ' + rec.cls + '">' + rec.text + "</span> · " +
        num(loc.raw_person_days) + " person-days · " + num(loc.unique_people_count) + " volunteers</div></div></li>";
    }).join("");
    document.getElementById("count-line").textContent = list.length + " of " + state.locations.length + " past sites";
    Array.prototype.forEach.call(ul.querySelectorAll(".loc-row"), function (li) {
      li.addEventListener("click", function () { selectLocation(li.getAttribute("data-id"), true); });
    });
  }

  // ---- canvassing site markers -----------------------------------------
  function radiusFor(w) { return 5 + Math.sqrt(num(w) / maxWeighted) * 18; }
  function sitePopup(loc) {
    var people = pipeList(loc.unique_people), dates = pipeList(loc.dates_active), rec = recencyLabel(loc);
    return '<div class="popup-title">' + escapeHtml(firstAlias(loc)) + "</div><div class='popup-grid'>" +
      '<span class="k">Last canvassed</span><span>' + rec.text + "</span>" +
      '<span class="k">Days active</span><span>' + num(loc.days_active) + "</span>" +
      '<span class="k">Person-days</span><span>' + num(loc.raw_person_days) + "</span>" +
      '<span class="k">Unique volunteers</span><span>' + num(loc.unique_people_count) + "</span></div>" +
      '<div class="popup-dates"><strong>Dates:</strong> ' + (dates.length ? escapeHtml(dates.join(", ")) : "—") + "</div>" +
      (people.length ? '<div class="popup-dates"><strong>Volunteers:</strong> ' + escapeHtml(people.slice(0, 12).join(", ")) + (people.length > 12 ? " +" + (people.length - 12) + " more" : "") + "</div>" : "");
  }
  function renderMarkers() {
    markerLayer.clearLayers(); state.markersById = {};
    state.locations.forEach(function (loc) {
      if (!isFinite(loc.latitude) || !isFinite(loc.longitude)) return;
      var m = L.circleMarker([loc.latitude, loc.longitude], { radius: radiusFor(loc.weighted_person_days), color: "#fff", weight: 1.5, fillColor: "#243b53", fillOpacity: 0.9, pane: "pane-sites", renderer: renderers.sites });
      m.bindPopup(sitePopup(loc), { maxWidth: 320 });
      m.on("click", function () { selectLocation(loc.location_id, false); });
      m.addTo(markerLayer); state.markersById[loc.location_id] = m;
    });
  }
  function selectLocation(id, fromList) {
    state.selectedId = id; var loc = state.locById[id]; if (!loc) return;
    var m = state.markersById[id];
    if (m) { if (fromList) map.setView([loc.latitude, loc.longitude], Math.max(map.getZoom(), 15)); m.openPopup(); }
    renderList();
  }

  // ====================================================================
  //  DISTRICTS — always-present, clickable layer
  // ====================================================================
  function districtMetric(p, mode) {
    var ballots = num(p.ballots_cast), cov = num(p.distance_adjusted_weighted_person_days) || num(p.weighted_person_days);
    if (mode === "turnout") return ballots;
    if (mode === "coverage") return cov;
    var tN = maxBallots > 0 ? ballots / maxBallots : 0, cN = maxCoverage > 0 ? cov / maxCoverage : 0;
    return tN * (1 - clamp01(cN));
  }
  function buildPercentiles(feats) {
    function sortedBy(fn, filter) { var a = []; feats.forEach(function (f) { if (filter && !filter(f.properties)) return; a.push(fn(f.properties)); }); a.sort(function (x, y) { return x - y; }); return a; }
    state.pcts.opportunity = sortedBy(function (p) { return districtMetric(p, "opportunity"); });
    state.pcts.turnout = sortedBy(function (p) { return num(p.ballots_cast); });
    state.pcts.coverage = sortedBy(function (p) { return num(p.distance_adjusted_weighted_person_days) || num(p.weighted_person_days); });
    state.pcts.mayorShare = sortedBy(function (p) { return num(p.top_mayor_rank1_share); }, function (p) { return p.top_mayor_rank1_candidate; });
    state.pcts.blMargin = sortedBy(function (p) { return Math.abs(num(p.bl_margin)); }, function (p) { return num(p.bl_total) > 0; });
  }
  function activeSet() { var d = state.plan[state.activeDay]; return new Set((d && d[state.activeShift]) || []); }
  function districtStyle(feature) {
    var mode = state.shadingMode, p = feature.properties, sel = activeSet().has(String(p.elect_dist));
    var st = { color: sel ? "#1f6feb" : "#7e93a8", weight: sel ? 2.8 : 0.4, opacity: 1 };
    if (mode === "none") { st.fill = true; st.fillColor = "#fff"; st.fillOpacity = 0.02; return st; }
    if (mode === "mayor2025") {
      var t = percentile("mayorShare", num(p.top_mayor_rank1_share));
      st.fillColor = MAYOR_COLORS[p.top_mayor_rank1_candidate] || "#cfd6dd";
      st.fillOpacity = p.top_mayor_rank1_candidate ? 0.35 + t * 0.5 : 0.12;
    } else if (mode === "boreslasher") {
      var tm = percentile("blMargin", Math.abs(num(p.bl_margin)));
      st.fillColor = BL_COLORS[p.bl_winner] || "#b48ead";
      st.fillOpacity = num(p.bl_total) > 0 ? 0.3 + tm * 0.55 : 0.1;
    } else {
      var val = mode === "turnout" ? num(p.ballots_cast) : mode === "coverage" ? (num(p.distance_adjusted_weighted_person_days) || num(p.weighted_person_days)) : districtMetric(p, "opportunity");
      var tt = percentile(mode, val);
      st.fillColor = rampCol(mode, tt); st.fillOpacity = 0.45 + tt * 0.42;
    }
    return st;
  }
  function districtTooltip(p) {
    var head = "ED " + p.election_district + " · AD " + p.assembly_district;
    return head + "<br><span class='tt-hint'>Click for details &amp; to add to a shift</span>";
  }

  function activeShiftLabel() { var d = parseISO(state.activeDay); return dowName(d) + " " + state.activeShift; }
  function edPopupHtml(p) {
    var ed = String(p.elect_dist);
    var regDem = num(p.reg_dem_2024), regTot = num(p.reg_total_2024);
    var primT = num(p.bl_total), primLine;
    if (primT > 0) {
      var margPts = Math.round(Math.abs(num(p.bl_bores_share) - num(p.bl_lasher_share)) * 100);
      primLine = "<strong>" + escapeHtml(p.bl_winner) + "</strong> by " + margPts + " pts<br><span class='sub'>Bores " +
        pct(p.bl_bores_share) + " (" + commas(p.bl_bores) + ") · Lasher " + pct(p.bl_lasher_share) + " (" + commas(p.bl_lasher) + ")</span>";
    } else primLine = "no votes recorded";
    var mayT = num(p.mayor_rank1_valid_ballots) || num(p.ballots_cast), mw = p.top_mayor_rank1_candidate;
    var mayLine = mw ? "<strong>" + escapeHtml(MAYOR_SHORT[mw] || mw) + "</strong> led with " + pct(p.top_mayor_rank1_share) + "<br><span class='sub'>" + commas(p.top_mayor_rank1_votes) + " votes</span>" : "no data";
    var primPct = regDem ? " (" + Math.round(primT / regDem * 100) + "% of Dems)" : "";
    var mayPct = regDem ? " (" + Math.round(mayT / regDem * 100) + "% of Dems)" : "";
    var inShift = activeSet().has(ed);
    var btn = '<button class="ed-add' + (inShift ? " in" : "") + '" data-ed="' + ed + '">' +
      (inShift ? "✓ In " + activeShiftLabel() + " — click to remove" : "➕ Add to " + activeShiftLabel()) + "</button>";
    return '<div class="popup-title">Election District ' + p.election_district + " <span class='sub'>(AD " + p.assembly_district + ")</span></div>" +
      "<div class='popup-grid'><span class='k'>Registered Dems</span><span>" + commas(regDem) + (regTot ? " <span class='sub'>of " + commas(regTot) + "</span>" : "") + "</span></div>" +
      "<div class='popup-sec'><strong>2026 Dem primary</strong><div class='popup-grid'>" +
      "<span class='k'>Turnout</span><span>" + commas(primT) + primPct + "</span>" +
      "<span class='k'>Result</span><span>" + primLine + "</span></div></div>" +
      "<div class='popup-sec'><strong>2025 Mayor (Dem primary)</strong><div class='popup-grid'>" +
      "<span class='k'>Turnout</span><span>" + commas(mayT) + mayPct + "</span>" +
      "<span class='k'>Result</span><span>" + mayLine + "</span></div></div>" + btn;
  }
  function openEdPopup(p, latlng) { L.popup({ maxWidth: 300, className: "ed-popup" }).setLatLng(latlng).setContent(edPopupHtml(p)).openOn(map); }

  function buildDistrictLayer(g) {
    districtLayer = L.geoJSON(g, {
      pane: "pane-shading", renderer: renderers.shading, style: districtStyle,
      onEachFeature: function (f, layer) {
        var ed = String(f.properties.elect_dist);
        state.edProps[ed] = f.properties;
        try { edCentroid[ed] = layer.getBounds().getCenter(); } catch (e) {}
        layer.bindTooltip(districtTooltip(f.properties), { sticky: true });
        layer.on("click", function (e) { openEdPopup(f.properties, e.latlng); });
      },
    }).addTo(map);
  }
  function refreshDistricts() {
    if (!districtLayer) return;
    districtLayer.setStyle(districtStyle);
    updateLegend();
  }

  // ====================================================================
  //  POINT OVERLAYS
  // ====================================================================
  function toggleSites(on) { if (on) markerLayer.addTo(map); else map.removeLayer(markerLayer); }
  function toggleHoods(on) {
    if (!on) { if (overlay.hoods) map.removeLayer(overlay.hoods); return; }
    if (overlay.hoods) { overlay.hoods.addTo(map); return; }
    ensureData("neighborhoods").then(function (g) {
      overlay.hoods = L.geoJSON(g, { pane: "pane-hoods", renderer: renderers.hoods, style: { fill: false, color: "#6a4c93", weight: 1.4, opacity: 0.85, dashArray: "4 3" },
        onEachFeature: function (f, l) { l.bindTooltip(escapeHtml(f.properties.name || "Neighborhood"), { permanent: true, direction: "center", className: "hood-label" }); } }).addTo(map);
    });
  }
  function toggleSubway(on) {
    if (!on) { if (overlay.subway) map.removeLayer(overlay.subway); return; }
    if (overlay.subway) { overlay.subway.addTo(map); return; }
    ensureData("subway").then(function (g) {
      overlay.subway = L.geoJSON(g, {
        pointToLayer: function (f, latlng) { return L.circleMarker(latlng, { pane: "pane-subway", renderer: renderers.subway, radius: 4.5, color: "#fff", weight: 1.5, fillColor: trunkColor(f.properties.routes), fillOpacity: 1 }); },
        onEachFeature: function (f, l) {
          var p = f.properties, label = escapeHtml(p.name || "");
          l.bindTooltip(label, { permanent: true, direction: "right", offset: [6, 0], className: "station-label" });
          l.bindPopup("<strong>🚇 " + label + "</strong><br>" + escapeHtml(p.routes || ""));
        },
      }).addTo(map);
    });
  }
  function pinIcon(cls, color, glyph) { return L.divIcon({ className: "", html: '<div class="' + cls + '" style="background:' + color + '">' + glyph + "</div>", iconSize: [18, 18], iconAnchor: [9, 9] }); }
  function togglePolls(on) {
    if (!on) { if (overlay.polls) map.removeLayer(overlay.polls); return; }
    if (overlay.polls) { overlay.polls.addTo(map); return; }
    ensureData("polls").then(function (g) {
      overlay.polls = L.geoJSON(g, {
        pointToLayer: function (f, latlng) { return L.marker(latlng, { icon: pinIcon("poll-pin", leanColor(f.properties.category), "🗳"), pane: "pane-polls" }); },
        onEachFeature: function (f, l) {
          var p = f.properties;
          l.bindTooltip("<strong>" + escapeHtml(p.name || "") + "</strong> <span style='color:#888'>(priority poll site)</span><br>" + escapeHtml(p.address || "") +
            (p.neighborhood ? "<br>" + escapeHtml(p.neighborhood) : "") + (p.category ? "<br>Lean: " + escapeHtml(p.category) : "") +
            (p.priority ? " · Priority " + escapeHtml(p.priority) : "") + (p.bodies_am_pm ? "<br>Bodies needed (AM/PM): " + escapeHtml(p.bodies_am_pm) : ""), { sticky: true });
        },
      }).addTo(map);
    });
  }
  function toggleEarly(on) {
    if (!on) { if (overlay.early) map.removeLayer(overlay.early); return; }
    if (overlay.early) { overlay.early.addTo(map); return; }
    ensureData("early").then(function (g) {
      overlay.early = L.geoJSON(g, {
        pointToLayer: function (f, latlng) { return L.marker(latlng, { icon: pinIcon("early-pin", "#5b21b6", "EV"), pane: "pane-early" }); },
        onEachFeature: function (f, l) { l.bindTooltip("<strong>" + escapeHtml(f.properties.name || "") + "</strong><br>Early voting site", { sticky: true }); },
      }).addTo(map);
    });
  }
  function toggleGroc(on) {
    if (!on) { if (overlay.groc) map.removeLayer(overlay.groc); return; }
    if (overlay.groc) { overlay.groc.addTo(map); return; }
    ensureData("groc").then(function (g) {
      overlay.groc = L.geoJSON(g, {
        pointToLayer: function (f, latlng) { return L.marker(latlng, { icon: pinIcon("groc-pin", "#2e7d32", "🛒"), pane: "pane-groc" }); },
        onEachFeature: function (f, l) { l.bindTooltip("🛒 " + escapeHtml(f.properties.name || "Supermarket"), { sticky: true }); },
      }).addTo(map);
    });
  }

  // ---- legend ----------------------------------------------------------
  function updateLegend() {
    if (!legend) return;
    var el = legend.getContainer(), mode = state.shadingMode;
    var dotNote = '<div class="dotnote"><span class="dot"></span> Dot = past canvassing site (bigger = more)</div>';
    if (mode === "none") { el.innerHTML = "<h4>Map</h4>" + dotNote; return; }
    if (mode === "mayor2025") {
      el.innerHTML = "<h4>2025 Mayor — who led each ED</h4>" + cat(MAYOR_COLORS["Zohran Kwame Mamdani"], "Mamdani") + cat(MAYOR_COLORS["Andrew M. Cuomo"], "Cuomo") + cat(MAYOR_COLORS["Brad Lander"], "Lander") + '<div class="sub">Stronger color = bigger win.</div>' + dotNote; return;
    }
    if (mode === "boreslasher") {
      el.innerHTML = "<h4>2026 Dem Primary — who won each ED</h4>" + cat(BL_COLORS.Bores, "Bores") + cat(BL_COLORS.Lasher, "Lasher") + cat(BL_COLORS.Tie, "Tie / other") + '<div class="sub">Stronger color = bigger margin.</div>' + dotNote; return;
    }
    var titles = { opportunity: "Priority for next week", turnout: "2025 Dem primary turnout", coverage: "Canvassing coverage so far" };
    var ends = { opportunity: ["covered / low turnout", "high turnout, under-canvassed"], turnout: ["fewer voters", "more voters"], coverage: ["not canvassed", "heavily canvassed"] };
    var ramp = ""; for (var i = 0; i <= 8; i++) ramp += '<span style="background:' + rampCol(mode, i / 8) + '"></span>';
    el.innerHTML = "<h4>" + titles[mode] + "</h4><div class='ramp'>" + ramp + "</div><div class='ends'><span>" + ends[mode][0] + "</span><span>" + ends[mode][1] + "</span></div>" + dotNote;
  }
  function cat(color, label) { return '<div class="cat"><span class="box" style="background:' + color + '"></span>' + escapeHtml(label) + "</div>"; }

  // ====================================================================
  //  WEEKLY SHIFT PLANNER (by election district)
  // ====================================================================
  function loadPlan() { try { state.plan = JSON.parse(localStorage.getItem(PLAN_KEY)) || {}; } catch (e) { state.plan = {}; } }
  function savePlan() { try { localStorage.setItem(PLAN_KEY, JSON.stringify(state.plan)); } catch (e) {} }
  function nextMonday() { var day = TODAY.getDay(), delta = ((8 - day) % 7) || 7; return addDays(TODAY, delta); }
  function weekDays() { var out = []; for (var i = 0; i < 7; i++) out.push(addDays(state.weekStart, i)); return out; }
  function shiftArr(iso, shift, make) { var d = state.plan[iso]; if (!d) { if (!make) return []; d = state.plan[iso] = { AM: [], PM: [] }; } if (!d[shift]) d[shift] = []; return d[shift]; }
  function toggleEd(ed) { var arr = shiftArr(state.activeDay, state.activeShift, true), i = arr.indexOf(ed); if (i === -1) arr.push(ed); else arr.splice(i, 1); savePlan(); refreshDistricts(); renderPlan(); }
  function removeEd(iso, shift, ed) { var arr = shiftArr(iso, shift, false), i = arr.indexOf(ed); if (i !== -1) arr.splice(i, 1); savePlan(); refreshDistricts(); renderPlan(); }

  function renderShiftBanner() {
    var b = document.getElementById("shift-banner"); if (!b) return; var d = parseISO(state.activeDay);
    b.innerHTML = "Now adding to <strong>" + dowName(d) + " " + prettyDate(d) + " · " + state.activeShift + " (" + shiftTime(d, state.activeShift) + ")</strong>";
  }
  function renderWeekLabel() { var days = weekDays(); document.getElementById("week-label").textContent = "Week of " + prettyDate(days[0]) + " – " + prettyDate(days[6]); }
  function renderPlan() {
    renderWeekLabel(); renderShiftBanner();
    var container = document.getElementById("plan-days");
    container.innerHTML = weekDays().map(function (d) {
      var iso = isoOf(d);
      var shifts = ["AM", "PM"].map(function (sh) {
        var eds = shiftArr(iso, sh, false), isActive = (iso === state.activeDay && sh === state.activeShift) ? " active" : "";
        var chips = eds.map(function (ed) {
          return '<li class="ed-chip"><span class="ed-go" data-ed="' + ed + '">' + escapeHtml(edShort(ed)) + '</span><button class="rm-btn" data-rm="' + ed + '" data-day="' + iso + '" data-shift="' + sh + '">✕</button></li>';
        }).join("");
        return '<div class="shift-row' + isActive + '" data-day="' + iso + '" data-shift="' + sh + '"><div class="shift-head"><span class="sh-name">' + sh + '</span><span class="sh-time">' + shiftTime(d, sh) + '</span><span class="sh-count">' + (eds.length ? eds.length + " ED" + (eds.length > 1 ? "s" : "") : "select") + "</span></div><ul class='ed-chips'>" + chips + "</ul></div>";
      }).join("");
      return '<div class="day-card"><div class="day-head static"><span class="d-name">' + dowName(d) + " " + prettyDate(d) + "</span></div>" + shifts + "</div>";
    }).join("");
    Array.prototype.forEach.call(container.querySelectorAll(".shift-row"), function (row) {
      row.querySelector(".shift-head").addEventListener("click", function () { state.activeDay = row.getAttribute("data-day"); state.activeShift = row.getAttribute("data-shift"); refreshDistricts(); renderPlan(); });
    });
    Array.prototype.forEach.call(container.querySelectorAll(".rm-btn"), function (btn) {
      btn.addEventListener("click", function (e) { e.stopPropagation(); removeEd(btn.getAttribute("data-day"), btn.getAttribute("data-shift"), btn.getAttribute("data-rm")); });
    });
    Array.prototype.forEach.call(container.querySelectorAll(".ed-go"), function (g) {
      g.addEventListener("click", function (e) { e.stopPropagation(); var c = edCentroid[g.getAttribute("data-ed")]; if (c) map.setView(c, Math.max(map.getZoom(), 15)); });
    });
  }

  function planAsText() {
    var lines = ["Canvassing plan — " + document.getElementById("week-label").textContent, ""];
    weekDays().forEach(function (d) {
      var iso = isoOf(d); if (!["AM", "PM"].some(function (sh) { return shiftArr(iso, sh, false).length; })) return;
      lines.push(dowName(d) + " " + prettyDate(d) + ":");
      ["AM", "PM"].forEach(function (sh) { var eds = shiftArr(iso, sh, false); if (eds.length) lines.push("  " + sh + " (" + shiftTime(d, sh) + "): " + eds.map(edLabel).join(", ")); });
      lines.push("");
    });
    if (lines.length <= 2) lines.push("(no districts assigned yet)");
    return lines.join("\n");
  }
  function copyPlan() {
    var text = planAsText(), done = function () { var el = document.getElementById("plan-copied"); el.textContent = "Copied to clipboard ✓"; setTimeout(function () { el.textContent = ""; }, 2500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt("Copy the plan:", text); }); else window.prompt("Copy the plan:", text);
  }
  function printPlan() {
    var rows = weekDays().map(function (d) {
      var iso = isoOf(d);
      var inner = ["AM", "PM"].map(function (sh) { var eds = shiftArr(iso, sh, false); return "<div class='sh'><strong>" + sh + " (" + shiftTime(d, sh) + ")</strong>: " + (eds.length ? eds.map(edLabel).join(", ") : "—") + "</div>"; }).join("");
      return "<div class='d'><h3>" + dowName(d) + " " + prettyDate(d) + "</h3>" + inner + "</div>";
    }).join("");
    var html = "<html><head><title>Canvassing plan</title><style>body{font-family:-apple-system,Arial,sans-serif;margin:32px;color:#1f2b38}h1{font-size:20px}h3{font-size:14px;margin:0 0 4px;border-bottom:1px solid #ccc;padding-bottom:3px}.d{margin-bottom:12px}.sh{font-size:13px;margin:2px 0}</style></head><body><h1>Canvassing plan</h1><h2 style='font-size:14px;color:#555'>" + escapeHtml(document.getElementById("week-label").textContent) + "</h2>" + rows + "</body></html>";
    var w = window.open("", "_blank"); if (!w) { alert("Please allow pop-ups to print the plan."); return; }
    w.document.write(html); w.document.close(); w.focus(); setTimeout(function () { w.print(); }, 250);
  }

  // ---- init ------------------------------------------------------------
  function makePanes() {
    var defs = [["pane-shading", 410], ["pane-hoods", 420], ["pane-subway", 440], ["pane-sites", 450], ["pane-groc", 610], ["pane-early", 615], ["pane-polls", 620]];
    defs.forEach(function (d) { map.createPane(d[0]); map.getPane(d[0]).style.zIndex = d[1]; });
    renderers.shading = L.canvas({ pane: "pane-shading" });
    renderers.hoods = L.canvas({ pane: "pane-hoods" });
    renderers.subway = L.canvas({ pane: "pane-subway" });
    renderers.sites = L.canvas({ pane: "pane-sites" });
  }
  function updateZoomClass() { map.getContainer().classList.toggle("show-stop-labels", map.getZoom() >= 14); }

  function wireUi() {
    document.getElementById("search").addEventListener("input", function (e) { state.search = e.target.value; renderList(); });
    document.getElementById("sort").addEventListener("change", function (e) { state.sort = e.target.value; renderList(); });
    document.getElementById("shading-mode").addEventListener("change", function (e) { state.shadingMode = e.target.value; refreshDistricts(); });
    document.getElementById("lyr-sites").addEventListener("change", function (e) { toggleSites(e.target.checked); });
    document.getElementById("lyr-hoods").addEventListener("change", function (e) { toggleHoods(e.target.checked); });
    document.getElementById("lyr-subway").addEventListener("change", function (e) { toggleSubway(e.target.checked); });
    document.getElementById("lyr-polls").addEventListener("change", function (e) { togglePolls(e.target.checked); });
    document.getElementById("lyr-early").addEventListener("change", function (e) { toggleEarly(e.target.checked); });
    document.getElementById("lyr-groc").addEventListener("change", function (e) { toggleGroc(e.target.checked); });
    document.getElementById("week-prev").addEventListener("click", function () { state.weekStart = addDays(state.weekStart, -7); state.activeDay = isoOf(state.weekStart); refreshDistricts(); renderPlan(); });
    document.getElementById("week-next").addEventListener("click", function () { state.weekStart = addDays(state.weekStart, 7); state.activeDay = isoOf(state.weekStart); refreshDistricts(); renderPlan(); });
    document.getElementById("plan-print").addEventListener("click", printPlan);
    document.getElementById("plan-copy").addEventListener("click", copyPlan);
    document.getElementById("plan-clear").addEventListener("click", function () { if (!confirm("Remove all districts from this week's plan?")) return; weekDays().forEach(function (d) { delete state.plan[isoOf(d)]; }); savePlan(); refreshDistricts(); renderPlan(); });
    map.on("zoomend", updateZoomClass);
    map.on("popupopen", function (e) {
      var pop = e.popup, root = pop.getElement(); if (!root) return;
      var btn = root.querySelector(".ed-add"); if (!btn) return;
      btn.addEventListener("click", function () {
        var ed = btn.getAttribute("data-ed");
        toggleEd(ed);
        // reopen with refreshed content -> fires popupopen again and rebinds cleanly
        openEdPopup(state.edProps[ed], pop.getLatLng());
      });
    });
  }

  function init() {
    map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([40.78, -73.96], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 19 }).addTo(map);
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
      fetch(DATA.boreslasher).then(function (r) { return r.json(); }).catch(function () { return null; }),
    ]).then(function (res) {
      state.locations = (res[0] || []).filter(function (l) { return isFinite(l.latitude) && isFinite(l.longitude); });
      state.summary = res[1];
      state.locations.forEach(function (l) { state.locById[l.location_id] = l; });
      maxWeighted = state.locations.reduce(function (m, l) { return Math.max(m, num(l.weighted_person_days)); }, 1);

      var districts = res[2];
      if (districts && res[3]) {
        var bl = {}; res[3].features.forEach(function (f) { bl[String(f.properties.elect_dist)] = f.properties; });
        districts.features.forEach(function (f) {
          var p = f.properties, b = bl[String(p.elect_dist)];
          if (b) { p.bl_bores = b.bores; p.bl_lasher = b.lasher; p.bl_total = b.total_votes; p.bl_bores_share = b.bores_share; p.bl_lasher_share = b.lasher_share; p.bl_margin = b.margin; p.bl_winner = b.winner; }
          else { p.bl_winner = "No votes"; p.bl_total = 0; }
        });
      }
      if (districts) {
        state.geo.districts = districts;
        districts.features.forEach(function (f) {
          maxBallots = Math.max(maxBallots, num(f.properties.ballots_cast));
          maxCoverage = Math.max(maxCoverage, num(f.properties.distance_adjusted_weighted_person_days) || num(f.properties.weighted_person_days));
        });
        maxOpportunity = districts.features.reduce(function (m, f) { return Math.max(m, districtMetric(f.properties, "opportunity")); }, 0.0001);
        buildPercentiles(districts.features);
        buildDistrictLayer(districts);
      }

      renderMarkers(); markerLayer.addTo(map);
      buildSummary(); renderList(); renderPlan(); updateLegend();
      var pts = state.locations.map(function (l) { return [l.latitude, l.longitude]; });
      if (pts.length) { map.invalidateSize(); map.fitBounds(pts, { padding: [40, 40], maxZoom: 15, animate: false }); }
      updateZoomClass();
    }).catch(function (err) {
      document.getElementById("subtitle").textContent = "Could not load data — open this through start_map.command (see README).";
      console.error(err);
    });

    wireUi();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
