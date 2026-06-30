/* Canvassing Planner — standalone map + weekly shift planner.
   Pure vanilla JS + Leaflet. No build step, no API keys, no backend. */
/* global L */
(function () {
  "use strict";

  var DV = "?v=12"; // cache-buster for data files (bump when data changes)
  var DATA = {
    districts: "data/districts.geojson",
    boreslasher: "data/bores_lasher_results.geojson",
    adlines: "data/ad_boundaries.geojson",
    neighborhoods: "data/neighborhoods.geojson",
    subway: "data/subway_stations.geojson",
    polls: "data/election_day_poll_sites.geojson",
    early: "data/early_voting_sites.geojson",
    groc: "data/supermarkets.geojson",
    availability: "data/fellow_availability.json",
  };
  // Photon (OpenStreetMap) finds places/POIs ("Hunter College"), not just addresses.
  // Biased to NYC by proximity + bounding box.
  var GEOCODE = "https://photon.komoot.io/api/?limit=7&lang=en&lat=40.77&lon=-73.96&bbox=-74.30,40.45,-73.65,40.95&q=";
  function photonParts(p) {
    var name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || p.street || p.city || "Result";
    var bits = [];
    if (p.name) { var sa = [p.housenumber, p.street].filter(Boolean).join(" "); if (sa) bits.push(sa); }
    var loc = p.district || p.neighbourhood || p.city || "";
    if (loc && loc.toLowerCase() !== name.toLowerCase()) bits.push(loc);
    if (p.postcode) bits.push(p.postcode);
    return { name: name, addr: bits.join(", ") };
  }
  var PLAN_KEY = "cm_plan_v3"; // plan items are now {k,id,label,lat,lng,icon}

  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  // distinct color per day for the "Week overview" map view (Mon..Sun)
  var DAY_COLORS = ["#e6194B", "#f58231", "#2e8b57", "#1f6feb", "#911eb4", "#008080", "#9a6324"];
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
  function leanColor(cat) { cat = String(cat || ""); if (/bores/i.test(cat)) return "#006544"; if (/lasher/i.test(cat)) return "#c79100"; return "#6b7785"; }
  var RAMPS = {
    opportunity: [[255, 247, 232], [150, 0, 12]], turnout: [[233, 242, 255], [3, 41, 99]], coverage: [[233, 250, 236], [0, 78, 33]],
    persuasion: [[243, 240, 252], [88, 28, 135]], gotv: [[235, 250, 245], [5, 102, 84]],
  };

  var state = {
    geo: {}, edProps: {},
    shadingMode: "none",
    weekStart: null, activeDay: null, activeShift: "AM", plan: {},
    pcts: {}, wx: null, events: [], avail: null, recMode: "persuasion", weekOverview: false,
  };

  var map, legend, districtLayer, R, searchMarker = null, searchTimer = null, searchAbort = null;
  var edHighlight = null, highlightRenderer = null;
  var weekDayMap = {}; // elect_dist -> earliest day index (0=Mon) planned this week
  var overlay = { lines: null, labels: null, hoods: null, subway: null, polls: null, early: null, groc: null, meet: null };
  var reviewOpen = false, meetPick = null, reviewSetOverview = false;
  var edCentroid = {};
  var maxBallots = 1, maxCoverage = 1, maxOpportunity = 1;
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
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function escAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
  function edShort(ed) { ed = String(ed); return Number(ed.slice(0, -3)) + "/" + Number(ed.slice(-3)); }
  // Map label: "ED/AD" with the ED zero-padded to 2 digits, e.g. "07/67", "46/76".
  function edAd(p) { var e = String(p.election_district); if (e.length < 2) e = "0" + e; return e + "/" + p.assembly_district; }
  function edLabel(ed) { ed = String(ed); return "AD " + Number(ed.slice(0, -3)) + " · ED " + Number(ed.slice(-3)); }

  function lerp(a, b, t) { return a.map(function (x, i) { return Math.round(x + (b[i] - x) * t); }); }
  function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }
  function rampCol(mode, t) { var r = RAMPS[mode] || RAMPS.opportunity; return rgb(lerp(r[0], r[1], clamp01(t))); }
  function lowerBound(arr, v) { var lo = 0, hi = arr.length; while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }
  function percentile(name, v) { var a = state.pcts[name]; if (!a || a.length < 2) return 1; return lowerBound(a, v) / (a.length - 1); }

  function ensureData(name) {
    if (state.geo[name]) return Promise.resolve(state.geo[name]);
    return fetch(DATA[name] + DV).then(function (r) { return r.json(); }).then(function (g) { state.geo[name] = g; return g; });
  }

  // ====================================================================
  //  PLAN MODEL  — plan[iso][shift] = [ {k,id,label,lat,lng,icon}, ... ]
  // ====================================================================
  function loadPlan() { try { state.plan = JSON.parse(localStorage.getItem(PLAN_KEY)) || {}; } catch (e) { state.plan = {}; } }
  function savePlan() { try { localStorage.setItem(PLAN_KEY, JSON.stringify(state.plan)); } catch (e) {} }
  function shiftArr(iso, shift, make) { var d = state.plan[iso]; if (!d) { if (!make) return []; d = state.plan[iso] = { AM: [], PM: [] }; } if (!d[shift]) d[shift] = []; return d[shift]; }
  // per-shift meeting point: stored on plan[iso].meet[shift] = {label, lat, lng}
  function getMeet(iso, shift) { var d = state.plan[iso]; return (d && d.meet && d.meet[shift]) || null; }
  function setMeet(iso, shift, obj) { var d = state.plan[iso]; if (!d) { d = state.plan[iso] = { AM: [], PM: [] }; } if (!d.meet) d.meet = {}; d.meet[shift] = obj; savePlan(); }
  function clearMeet(iso, shift) { var d = state.plan[iso]; if (d && d.meet) { delete d.meet[shift]; savePlan(); } }
  function activeHas(id) { return shiftArr(state.activeDay, state.activeShift, false).some(function (x) { return x.id === id; }); }
  function activeEdSet() { return new Set(shiftArr(state.activeDay, state.activeShift, false).filter(function (x) { return x.k === "ed"; }).map(function (x) { return x.id; })); }
  function toggleItem(item) {
    var arr = shiftArr(state.activeDay, state.activeShift, true);
    var i = arr.map(function (x) { return x.id; }).indexOf(item.id);
    if (i === -1) arr.push(item); else arr.splice(i, 1);
    savePlan(); refreshDistricts(); renderPlan();
  }
  function removeItem(iso, shift, id) {
    var arr = shiftArr(iso, shift, false), i = arr.map(function (x) { return x.id; }).indexOf(id);
    if (i !== -1) arr.splice(i, 1); savePlan(); refreshDistricts(); renderPlan();
  }
  function activeShiftLabel() { var d = parseISO(state.activeDay); return dowName(d) + " " + state.activeShift; }
  function addBtnHtml(item) {
    var inShift = activeHas(item.id);
    return '<button class="plan-add' + (inShift ? " in" : "") + '"' +
      ' data-k="' + escAttr(item.k) + '" data-id="' + escAttr(item.id) + '" data-label="' + escAttr(item.label) + '"' +
      ' data-lat="' + item.lat + '" data-lng="' + item.lng + '" data-icon="' + escAttr(item.icon || "") + '">' +
      (inShift ? "✓ In " + activeShiftLabel() + " — remove" : "➕ Add to " + activeShiftLabel()) + "</button>";
  }

  // ====================================================================
  //  DISTRICTS
  // ====================================================================
  function districtMetric(p, mode) {
    var ballots = num(p.ballots_cast), cov = num(p.distance_adjusted_weighted_person_days) || num(p.weighted_person_days);
    if (mode === "turnout") return ballots;
    if (mode === "coverage") return cov;
    var cN = maxCoverage > 0 ? cov / maxCoverage : 0, gap = 1 - clamp01(cN);
    if (mode === "gotv") {
      // Mobilization: registered Dems who DON'T reliably vote, in under-canvassed turf.
      var regDem = num(p.reg_dem_2024), tr = clamp01(num(p.turnout_per_reg_dem));
      return regDem * (1 - tr) * gap;
    }
    // persuasion / opportunity: where actual voters are, in under-canvassed turf.
    var tN = maxBallots > 0 ? ballots / maxBallots : 0;
    return tN * gap;
  }
  function buildPercentiles(feats) {
    function sortedBy(fn, filter) { var a = []; feats.forEach(function (f) { if (filter && !filter(f.properties)) return; a.push(fn(f.properties)); }); a.sort(function (x, y) { return x - y; }); return a; }
    state.pcts.opportunity = sortedBy(function (p) { return districtMetric(p, "opportunity"); });
    state.pcts.persuasion = sortedBy(function (p) { return districtMetric(p, "persuasion"); });
    state.pcts.gotv = sortedBy(function (p) { return districtMetric(p, "gotv"); });
    state.pcts.turnout = sortedBy(function (p) { return num(p.ballots_cast); });
    state.pcts.coverage = sortedBy(function (p) { return num(p.distance_adjusted_weighted_person_days) || num(p.weighted_person_days); });
    state.pcts.mayorShare = sortedBy(function (p) { return num(p.top_mayor_rank1_share); }, function (p) { return p.top_mayor_rank1_candidate; });
    state.pcts.blMargin = sortedBy(function (p) { return Math.abs(num(p.bl_margin)); }, function (p) { return num(p.bl_total) > 0; });
  }
  function districtStyle(feature) {
    var mode = state.shadingMode, p = feature.properties, sel = activeEdSet().has(String(p.elect_dist));
    // boundaries are drawn by the separate ED/AD lines layer; here only the selection highlight strokes
    var st = { color: "#1f6feb", weight: sel ? 2.8 : 0, opacity: 1 };
    if (state.weekOverview) {
      var di = weekDayMap[String(p.elect_dist)];
      if (di === undefined) { st.fill = true; st.fillColor = "#cfd6dd"; st.fillOpacity = 0.05; return st; }
      st.fill = true; st.fillColor = DAY_COLORS[di]; st.fillOpacity = 0.62; st.color = DAY_COLORS[di]; st.weight = sel ? 3 : 1.2; return st;
    }
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
      var val = mode === "turnout" ? num(p.ballots_cast) : mode === "coverage" ? (num(p.distance_adjusted_weighted_person_days) || num(p.weighted_person_days)) : districtMetric(p, mode);
      var tt = percentile(mode, val);
      st.fillColor = rampCol(mode, tt); st.fillOpacity = 0.45 + tt * 0.42;
    }
    return st;
  }
  function districtTooltip(p) {
    return "ED " + p.election_district + " · AD " + p.assembly_district + "<br><span class='tt-hint'>Click for details &amp; to add to a shift</span>";
  }
  function edPopupHtml(p) {
    var ed = String(p.elect_dist), regDem = num(p.reg_dem_2024), regTot = num(p.reg_total_2024);
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
    var c = edCentroid[ed] || { lat: 0, lng: 0 };
    var item = { k: "ed", id: ed, label: "ED " + edShort(ed), lat: c.lat, lng: c.lng, icon: "🗳" };
    function topPct(name) { return Math.max(1, Math.round((1 - percentile(name, districtMetric(p, name))) * 100)); }
    var targetLine = "<span class='k'>Persuasion</span><span>top " + topPct("persuasion") + "%</span>" +
      "<span class='k'>Turnout (GOTV)</span><span>top " + topPct("gotv") + "%</span>";
    return '<div class="popup-title">Election District ' + p.election_district + " <span class='sub'>(AD " + p.assembly_district + ")</span></div>" +
      "<div class='popup-grid'><span class='k'>Registered Dems</span><span>" + commas(regDem) + (regTot ? " <span class='sub'>of " + commas(regTot) + "</span>" : "") + "</span></div>" +
      "<div class='popup-sec'><strong>Canvassing targeting</strong><div class='popup-grid'>" + targetLine + "</div></div>" +
      "<div class='popup-sec'><strong>2026 Dem primary</strong><div class='popup-grid'><span class='k'>Turnout</span><span>" + commas(primT) + primPct + "</span><span class='k'>Result</span><span>" + primLine + "</span></div></div>" +
      "<div class='popup-sec'><strong>2025 Mayor (Dem primary)</strong><div class='popup-grid'><span class='k'>Turnout</span><span>" + commas(mayT) + mayPct + "</span><span class='k'>Result</span><span>" + mayLine + "</span></div></div>" +
      addBtnHtml(item);
  }
  function openEdPopup(p, latlng) { L.popup({ maxWidth: 300, className: "ed-popup" }).setLatLng(latlng).setContent(edPopupHtml(p)).openOn(map); }
  function buildDistrictLayer(g) {
    districtLayer = L.geoJSON(g, {
      renderer: R, style: districtStyle,
      onEachFeature: function (f, layer) {
        var ed = String(f.properties.elect_dist);
        state.edProps[ed] = f.properties;
        try { edCentroid[ed] = layer.getBounds().getCenter(); } catch (e) {}
        layer.bindTooltip(districtTooltip(f.properties), { sticky: true });
        layer.on("click", function (e) { openEdPopup(f.properties, e.latlng); });
      },
    }).addTo(map);
  }
  function buildWeekDayMap() {
    weekDayMap = {};
    weekDays().forEach(function (d, i) {
      var iso = isoOf(d);
      ["AM", "PM"].forEach(function (sh) {
        shiftArr(iso, sh, false).forEach(function (it) {
          if (it.k === "ed" && !(it.id in weekDayMap)) weekDayMap[it.id] = i;
        });
      });
    });
  }
  function refreshDistricts() { if (!districtLayer) return; if (state.weekOverview) buildWeekDayMap(); districtLayer.setStyle(districtStyle); updateLegend(); }
  function toggleWeekOverview() {
    state.weekOverview = !state.weekOverview;
    var btn = document.getElementById("week-overview");
    if (btn) { btn.textContent = state.weekOverview ? "Hide week overview" : "Show week overview"; btn.classList.toggle("on", state.weekOverview); }
    refreshDistricts();
    if (state.weekOverview) { // frame the whole week's turf
      var lls = [];
      weekDays().forEach(function (d) {
        var iso = isoOf(d);
        ["AM", "PM"].forEach(function (sh) {
          shiftArr(iso, sh, false).forEach(function (x) { if (x.k === "ed") { var c = edCentroid[String(x.id)]; if (c) lls.push([c.lat, c.lng]); } });
        });
      });
      if (lls.length) { try { map.fitBounds(L.latLngBounds(lls), { padding: [60, 60], maxZoom: 15 }); } catch (e) {} }
    }
  }
  function edFeature(ed) {
    var fs = state.geo.districts && state.geo.districts.features; if (!fs) return null;
    for (var i = 0; i < fs.length; i++) if (String(fs[i].properties.elect_dist) === String(ed)) return fs[i];
    return null;
  }
  // Center, zoom in, and draw a bright outline around an ED so it's easy to spot.
  function highlightEd(ed) {
    var feat = edFeature(ed); if (!feat) return;
    if (!highlightRenderer) highlightRenderer = L.svg({ pane: "pane-highlight" });
    if (edHighlight) { map.removeLayer(edHighlight); edHighlight = null; }
    edHighlight = L.geoJSON(feat, { renderer: highlightRenderer, interactive: false,
      style: { color: "#ff6a00", weight: 4, opacity: 1, fill: true, fillColor: "#ff6a00", fillOpacity: 0.08, className: "ed-highlight" } }).addTo(map);
    try { map.fitBounds(edHighlight.getBounds(), { padding: [70, 70], maxZoom: 16, animate: true }); }
    catch (e) { var c = edCentroid[String(ed)]; if (c) map.setView([c.lat, c.lng], 16); }
  }

  // ====================================================================
  //  POINT OVERLAYS  (each marker's popup has an Add-to-shift button)
  // ====================================================================
  // ED + AD boundary lines (one toggle for both)
  function toggleLines(on) {
    if (!on) { if (overlay.lines) map.removeLayer(overlay.lines); return; }
    if (overlay.lines) { overlay.lines.addTo(map); overlay.lines.bringToFront && overlay.lines.bringToFront(); return; }
    overlay.lines = L.layerGroup().addTo(map);
    // ED lines (thin but always visible) from the districts we already have
    if (state.geo.districts) {
      L.geoJSON(state.geo.districts, { renderer: R, interactive: false, style: { fill: false, color: "#56697d", weight: 1, opacity: 0.9 } }).addTo(overlay.lines);
    }
    // AD division lines (thick, dark navy) from the dissolved boundaries
    ensureData("adlines").then(function (g) {
      L.geoJSON(g, { renderer: R, interactive: false, style: { fill: false, color: "#14253a", weight: 2.6, opacity: 1 } }).addTo(overlay.lines);
    });
  }
  // ED + AD number labels (one toggle). AD labels always show; ED labels only when zoomed in.
  function toggleLabels(on) {
    if (!on) { if (overlay.labels) map.removeLayer(overlay.labels); return; }
    if (overlay.labels) { overlay.labels.addTo(map); return; }
    if (!state.geo.districts) return;
    overlay.labels = L.layerGroup().addTo(map);
    // One "ED/AD" label per district, placed at the district's representative
    // interior point (falls back to the bounds center) so it stays well centered.
    Object.keys(edCentroid).forEach(function (ed) {
      var p = state.edProps[ed]; if (!p) return;
      var c = edCentroid[ed];
      var lat = num(p.representative_latitude) || c.lat, lng = num(p.representative_longitude) || c.lng;
      L.marker([lat, lng], { pane: "pane-labels", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "maplabel ed-label", html: edAd(p), iconSize: [36, 12], iconAnchor: [18, 6] }) }).addTo(overlay.labels);
    });
  }
  function toggleHoods(on) {
    if (!on) { if (overlay.hoods) map.removeLayer(overlay.hoods); return; }
    if (overlay.hoods) { overlay.hoods.addTo(map); return; }
    ensureData("neighborhoods").then(function (g) {
      overlay.hoods = L.geoJSON(g, { renderer: R, interactive: false, style: { fill: false, color: "#6a4c93", weight: 1.4, opacity: 0.85, dashArray: "4 3" },
        onEachFeature: function (f, l) { l.bindTooltip(escapeHtml(f.properties.name || "Neighborhood"), { permanent: true, direction: "center", className: "hood-label" }); } }).addTo(map);
    });
  }
  function pinIcon(cls, color, glyph) { return L.divIcon({ className: "", html: '<div class="' + cls + '" style="background:' + color + '">' + glyph + "</div>", iconSize: [18, 18], iconAnchor: [9, 9] }); }
  function ll(f) { var c = f.geometry.coordinates; return { lat: c[1], lng: c[0] }; }
  function ptId(prefix, p) { return prefix + ":" + p.lat.toFixed(5) + "," + p.lng.toFixed(5); }

  function toggleSubway(on) {
    if (!on) { if (overlay.subway) map.removeLayer(overlay.subway); return; }
    if (overlay.subway) { overlay.subway.addTo(map); return; }
    ensureData("subway").then(function (g) {
      overlay.subway = L.geoJSON(g, {
        pointToLayer: function (f, latlng) { return L.circleMarker(latlng, { renderer: R, radius: 4.5, color: "#fff", weight: 1.5, fillColor: trunkColor(f.properties.routes), fillOpacity: 1 }); },
        onEachFeature: function (f, l) {
          var p = ll(f), name = f.properties.name || "Station", routes = f.properties.routes || "";
          var disp = routes ? name + " " + routes : name;
          l.bindTooltip(escapeHtml(name), { permanent: true, direction: "right", offset: [6, 0], className: "station-label" });
          l.bindPopup('<div class="popup-title">🚇 ' + escapeHtml(name) + "</div><div class='sub'>" + (routes ? "Lines " + escapeHtml(routes) : "Subway") + "</div>" +
            addBtnHtml({ k: "pt", id: ptId("sub", p), label: disp, lat: p.lat, lng: p.lng, icon: "🚇" }), { maxWidth: 260 });
        },
      }).addTo(map);
    });
  }
  function togglePolls(on) {
    if (!on) { if (overlay.polls) map.removeLayer(overlay.polls); return; }
    if (overlay.polls) { overlay.polls.addTo(map); return; }
    ensureData("polls").then(function (g) {
      overlay.polls = L.geoJSON(g, {
        pointToLayer: function (f, latlng) { return L.marker(latlng, { icon: pinIcon("poll-pin", leanColor(f.properties.category), "🗳"), pane: "pane-polls" }); },
        onEachFeature: function (f, l) {
          var q = f.properties, p = ll(f), name = q.name || "Poll site";
          l.bindPopup('<div class="popup-title">🗳 ' + escapeHtml(name) + "</div><div class='sub'>Priority Election Day poll site</div>" +
            "<div class='popup-grid'>" + (q.address ? "<span class='k'>Address</span><span>" + escapeHtml(q.address) + "</span>" : "") +
            (q.neighborhood ? "<span class='k'>Area</span><span>" + escapeHtml(q.neighborhood) + "</span>" : "") +
            (q.category ? "<span class='k'>Lean</span><span>" + escapeHtml(q.category) + "</span>" : "") +
            (q.priority ? "<span class='k'>Priority</span><span>" + escapeHtml(q.priority) + "</span>" : "") +
            (q.bodies_am_pm ? "<span class='k'>Bodies (AM/PM)</span><span>" + escapeHtml(q.bodies_am_pm) + "</span>" : "") + "</div>" +
            addBtnHtml({ k: "pt", id: ptId("poll", p), label: name, lat: p.lat, lng: p.lng, icon: "🗳" }), { maxWidth: 280 });
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
        onEachFeature: function (f, l) {
          var p = ll(f), name = f.properties.name || "Early voting site";
          l.bindPopup('<div class="popup-title">🗳 ' + escapeHtml(name) + "</div><div class='sub'>Early voting site</div>" +
            addBtnHtml({ k: "pt", id: ptId("ev", p), label: name, lat: p.lat, lng: p.lng, icon: "🗳" }), { maxWidth: 260 });
        },
      }).addTo(map);
    });
  }
  function toggleGroc(on) {
    if (!on) { if (overlay.groc) map.removeLayer(overlay.groc); return; }
    if (overlay.groc) { overlay.groc.addTo(map); return; }
    ensureData("groc").then(function (g) {
      overlay.groc = L.geoJSON(g, {
        pointToLayer: function (f, latlng) { return L.marker(latlng, { icon: pinIcon("groc-pin", "#2e7d32", "🛒"), pane: "pane-groc" }); },
        onEachFeature: function (f, l) {
          var p = ll(f), name = f.properties.name || "Supermarket", cross = f.properties.cross || "";
          var disp = cross ? name + " (" + cross + ")" : name;
          l.bindPopup('<div class="popup-title">🛒 ' + escapeHtml(name) + "</div><div class='sub'>Supermarket" + (cross ? " · " + escapeHtml(cross) : "") + "</div>" +
            addBtnHtml({ k: "pt", id: ptId("groc", p), label: disp, lat: p.lat, lng: p.lng, icon: "🛒" }), { maxWidth: 280 });
        },
      }).addTo(map);
    });
  }

  // ====================================================================
  //  SEARCH (geocoder — any address or place)
  // ====================================================================
  function doSearch(q) {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    fetch(GEOCODE + encodeURIComponent(q), { signal: searchAbort.signal })
      .then(function (r) { return r.json(); })
      .then(function (d) { renderResults((d.features || []).slice(0, 7)); })
      .catch(function () {});
  }
  function renderResults(features) {
    var ul = document.getElementById("search-results");
    if (!features.length) { ul.innerHTML = ""; ul.classList.remove("show"); return; }
    ul.innerHTML = features.map(function (f, i) {
      var c = f.geometry.coordinates, parts = photonParts(f.properties);
      var label = parts.name + (parts.addr ? " — " + parts.addr : "");
      return '<li data-i="' + i + '" data-lat="' + c[1] + '" data-lng="' + c[0] + '" data-label="' + escAttr(label) + '">' +
        '<span class="r-name">' + escapeHtml(parts.name) + '</span><span class="r-addr">' + escapeHtml(parts.addr) + "</span></li>";
    }).join("");
    ul.classList.add("show");
    Array.prototype.forEach.call(ul.querySelectorAll("li"), function (li) {
      li.addEventListener("click", function () { pickResult(+li.getAttribute("data-lat"), +li.getAttribute("data-lng"), li.getAttribute("data-label")); });
    });
  }
  function pickResult(lat, lng, label) {
    document.getElementById("search-results").classList.remove("show");
    document.getElementById("search").value = label;
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.marker([lat, lng], { icon: pinIcon("search-pin", "#1f6feb", "📍"), pane: "pane-search" }).addTo(map);
    searchMarker.bindPopup('<div class="popup-title">📍 ' + escapeHtml(label) + "</div>" +
      addBtnHtml({ k: "pt", id: "pin:" + lat.toFixed(5) + "," + lng.toFixed(5), label: label, lat: lat, lng: lng, icon: "📍" }) +
      '<button class="pin-remove">✕ Remove this pin</button>', { maxWidth: 300 });
    map.setView([lat, lng], 16, { animate: false });
    searchMarker.openPopup();
  }

  // ---- legend ----------------------------------------------------------
  function updateLegend() {
    if (!legend) return;
    var el = legend.getContainer(), mode = state.shadingMode;
    if (state.weekOverview) {
      var html = "<h4>Week overview</h4>", any = false;
      weekDays().forEach(function (d, i) {
        var iso = isoOf(d);
        var has = ["AM", "PM"].some(function (sh) { return shiftArr(iso, sh, false).some(function (x) { return x.k === "ed"; }); });
        if (has) { any = true; html += cat(DAY_COLORS[i], DAY_NAMES[i] + " " + prettyDate(d)); }
      });
      el.innerHTML = html + (any ? "" : "<div class='sub'>No districts planned yet.</div>");
      return;
    }
    if (mode === "none") { el.innerHTML = "<h4>Map</h4><div class='sub'>Click a district for details.</div>"; return; }
    if (mode === "mayor2025") { el.innerHTML = "<h4>2025 Mayor — who led each ED</h4>" + cat(MAYOR_COLORS["Zohran Kwame Mamdani"], "Mamdani") + cat(MAYOR_COLORS["Andrew M. Cuomo"], "Cuomo") + cat(MAYOR_COLORS["Brad Lander"], "Lander") + '<div class="sub">Stronger color = bigger win.</div>'; return; }
    if (mode === "boreslasher") { el.innerHTML = "<h4>2026 Dem Primary — who won each ED</h4>" + cat(BL_COLORS.Bores, "Bores") + cat(BL_COLORS.Lasher, "Lasher") + cat(BL_COLORS.Tie, "Tie / other") + '<div class="sub">Stronger color = bigger margin.</div>'; return; }
    var titles = { opportunity: "Priority for next week", persuasion: "Persuasion targets", gotv: "Turnout (GOTV) targets", turnout: "2025 Dem primary turnout", coverage: "Canvassing coverage so far" };
    var ends = {
      opportunity: ["covered / low turnout", "high turnout, under-canvassed"],
      persuasion: ["covered / few voters", "many voters, under-canvassed"],
      gotv: ["covered / few idle Dems", "many non-voting Dems, uncovered"],
      turnout: ["fewer voters", "more voters"], coverage: ["not canvassed", "heavily canvassed"],
    };
    var ramp = ""; for (var i = 0; i <= 8; i++) ramp += '<span style="background:' + rampCol(mode, i / 8) + '"></span>';
    el.innerHTML = "<h4>" + titles[mode] + "</h4><div class='ramp'>" + ramp + "</div><div class='ends'><span>" + ends[mode][0] + "</span><span>" + ends[mode][1] + "</span></div>";
  }
  function cat(color, label) { return '<div class="cat"><span class="box" style="background:' + color + '"></span>' + escapeHtml(label) + "</div>"; }

  // ====================================================================
  //  WEEKLY SHIFT PLANNER UI
  // ====================================================================
  function nextMonday() { var day = TODAY.getDay(), delta = ((8 - day) % 7) || 7; return addDays(TODAY, delta); }
  function weekDays() { var out = []; for (var i = 0; i < 7; i++) out.push(addDays(state.weekStart, i)); return out; }
  // Aggregated assigned-fellow counts for the planned week, bridged (counts
  // only, no PII) from the scheduling project's Supabase via
  // export_fellow_availability.py. Reflects who is actually assigned to each
  // shift (optimizer schedule + hand edits), not just who is available.
  function weekAvail() {
    if (!state.avail || !state.avail.weeks) return null;
    return state.avail.weeks[isoOf(state.weekStart)] || null;
  }
  function shiftKey(date, shift) { return dowName(date).toLowerCase() + "_inperson_" + shift.toLowerCase(); }
  function fellowCount(date, shift) {
    var wa = weekAvail(); if (!wa || !wa.shift_counts) return null;
    return wa.shift_counts[shiftKey(date, shift)] || 0;
  }
  function fellowNames(date, shift) {
    var wa = weekAvail(); if (!wa || !wa.shift_volunteers) return null;
    return wa.shift_volunteers[shiftKey(date, shift)] || [];
  }
  function fellowBadge(date, shift) {
    var n = fellowCount(date, shift);
    if (n === null) return ""; // no assignment data for this week yet
    var clickable = n > 0 && fellowNames(date, shift);
    return '<span class="sh-fellows' + (n ? "" : " zero") + (clickable ? " has-names" : "") + '"' +
      (clickable ? ' data-iso="' + isoOf(date) + '" data-sh="' + shift + '"' : "") +
      ' title="' + (clickable ? "Click to see who's assigned" : "Volunteers assigned to this shift") + '">' +
      "👥 " + n + "</span>";
  }
  // Popover listing the fellows assigned to a shift (names come from the
  // scheduling site's published schedule).
  function showFellowsPopover(anchor, iso, sh) {
    hideFellowsPopover();
    var names = (weekAvail() && weekAvail().shift_volunteers && weekAvail().shift_volunteers[shiftKey(parseISO(iso), sh)]) || [];
    var pop = document.createElement("div");
    pop.className = "fellows-pop"; pop.id = "fellows-pop";
    pop.innerHTML = "<div class='fp-head'>" + dowName(parseISO(iso)) + " " + sh + " · " + names.length + " assigned</div>" +
      (names.length ? "<ul>" + names.map(function (n) { return "<li>" + escapeHtml(n) + "</li>"; }).join("") + "</ul>"
        : "<div class='fp-empty'>No names available.</div>");
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + "px";
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
    setTimeout(function () { document.addEventListener("click", onPopOutside, true); }, 0);
  }
  function onPopOutside(e) { if (!e.target.closest("#fellows-pop") && !e.target.closest(".sh-fellows")) hideFellowsPopover(); }
  function hideFellowsPopover() { var p = document.getElementById("fellows-pop"); if (p) p.remove(); document.removeEventListener("click", onPopOutside, true); }
  function loadAvailability(bust) {
    // Prefer the LIVE endpoint (Netlify function / serve.py), which reads the
    // scheduling site's current published schedule. Fall back to the last
    // exported static file if no endpoint is available (e.g. a plain server).
    var t = bust ? "?t=" + Date.now() : "";
    return fetch("/api/fellow-availability" + t).then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .catch(function () { return fetch(DATA.availability + DV + (bust ? "&t=" + Date.now() : "")).then(function (r) { return r.json(); }); })
      .then(function (a) { state.avail = a; renderPlan(); renderFellowStatus(); })
      .catch(function () { /* optional — planner works without it */ });
  }
  function asOfText(iso) {
    if (!iso) return "";
    var d = new Date(iso); if (isNaN(d)) return "";
    var h = d.getHours(), ampm = h >= 12 ? "pm" : "am", h12 = (h % 12) || 12;
    return prettyDate(d) + ", " + h12 + ":" + String(d.getMinutes()).padStart(2, "0") + ampm;
  }
  function renderFellowStatus() {
    var el = document.getElementById("fellows-status"); if (!el) return;
    var wa = weekAvail();
    if (!state.avail) { el.textContent = ""; return; }
    if (!wa) { el.textContent = "👥 No assigned schedule for this week yet."; return; }
    var asof = asOfText(wa.published_at);
    el.textContent = "👥 " + wa.assigned_total + " assigned" + (asof ? " · as of " + asof : "");
  }
  function refreshFellows() {
    var btn = document.getElementById("fellows-refresh");
    if (btn) { btn.disabled = true; btn.textContent = "↻ Updating…"; }
    loadAvailability(true).then(function () {
      if (btn) { btn.textContent = "✓ Updated"; setTimeout(function () { if (btn) { btn.disabled = false; btn.textContent = "↻ Update assigned counts"; } }, 2000); }
    });
  }
  function renderShiftBanner() {
    var b = document.getElementById("shift-banner"); if (!b) return; var d = parseISO(state.activeDay);
    b.innerHTML = "Now adding to <strong>" + dowName(d) + " " + prettyDate(d) + " · " + state.activeShift + " (" + shiftTime(d, state.activeShift) + ")</strong>";
  }
  function renderWeekLabel() { var days = weekDays(); document.getElementById("week-label").textContent = "Week of " + prettyDate(days[0]) + " – " + prettyDate(days[6]); }
  // Is this ED already placed in ANY shift this week?
  function edInWeekPlan(ed) {
    return weekDays().some(function (d) {
      var iso = isoOf(d);
      return ["AM", "PM"].some(function (sh) {
        return shiftArr(iso, sh, false).some(function (x) { return x.k === "ed" && x.id === ed; });
      });
    });
  }
  // Recommended top targets for the week, by the selected goal (persuasion/gotv).
  // Ranking already accounts for prior canvassing coverage (person-days) and,
  // for GOTV, registered Democrats — see districtMetric().
  function renderRecommendations() {
    var el = document.getElementById("rec-list"); if (!el) return;
    var g = state.geo.districts;
    if (!g || !g.features) { el.innerHTML = "<li class='rec-empty'>Loading districts…</li>"; return; }
    var mode = state.recMode;
    var ranked = g.features.map(function (f) { return { p: f.properties, v: districtMetric(f.properties, mode) }; })
      .filter(function (x) { return x.v > 0; })
      .sort(function (a, b) { return b.v - a.v; }).slice(0, 8);
    var active = activeEdSet();
    el.innerHTML = ranked.map(function (x, i) {
      var p = x.p, ed = String(p.elect_dist), c = edCentroid[ed] || { lat: 0, lng: 0 };
      var regDem = num(p.reg_dem_2024);
      var cov = num(p.distance_adjusted_weighted_person_days) || num(p.weighted_person_days);
      var topp = Math.max(1, Math.round((1 - percentile(mode, x.v)) * 100));
      var covTxt = cov > 0 ? fmt(cov) + " person-days canvassed" : "never canvassed";
      var inActive = active.has(ed), inWeek = edInWeekPlan(ed);
      var flag = inActive ? "" : (inWeek ? " <span class='rec-inplan'>• already in plan</span>" : "");
      return '<li class="rec-item">' +
        '<div class="rec-main"><span class="rec-rank">' + (i + 1) + '</span>' +
        '<span class="rec-ed" data-ed="' + escAttr(ed) + '">' + edLabel(ed) + "</span>" + flag + "</div>" +
        '<div class="rec-stats">' + commas(regDem) + " reg. Dems · " + covTxt + " · top " + topp + "%</div>" +
        '<button class="rec-add' + (inActive ? " in" : "") + '" data-id="' + escAttr(ed) + '" data-lat="' + c.lat + '" data-lng="' + c.lng +
        '" data-label="' + escAttr("ED " + edShort(ed)) + '">' +
        (inActive ? "✓ In " + activeShiftLabel() : "➕ Add to " + activeShiftLabel()) + "</button></li>";
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll(".rec-ed"), function (s) {
      s.addEventListener("click", function () { highlightEd(s.getAttribute("data-ed")); });
    });
    Array.prototype.forEach.call(el.querySelectorAll(".rec-add"), function (btn) {
      btn.addEventListener("click", function () {
        toggleItem({ k: "ed", id: btn.getAttribute("data-id"), label: btn.getAttribute("data-label"),
          lat: +btn.getAttribute("data-lat"), lng: +btn.getAttribute("data-lng"), icon: "🗳" });
      });
    });
  }
  // Auto-fill every EMPTY in-person shift this week with a geographic cluster of
  // top-ranked districts (by the selected goal), each cluster sized to cover ~a
  // team's walkable turf for one shift. Never touches shifts you've already filled.
  var AUTOPLAN_TARGET_ACRES = 30; // enough turf for a group of ~20-30 canvassers per shift
  var AUTOPLAN_MAX_PER_SHIFT = 8;
  function autoPlanWeek() {
    var msg = document.getElementById("rec-autoplan-msg");
    var g = state.geo.districts; if (!g || !g.features) return;
    var mode = state.recMode;
    // candidate districts (need a center + an area), ranked by the chosen goal
    var cand = [];
    Object.keys(state.edProps).forEach(function (ed) {
      var p = state.edProps[ed], c = edCentroid[ed], acres = num(p.area_acres);
      if (!c || acres <= 0) return;
      cand.push({ ed: ed, score: districtMetric(p, mode), lat: c.lat, lng: c.lng, acres: acres });
    });
    cand.sort(function (a, b) { return b.score - a.score; });
    var used = {};
    weekDays().forEach(function (d) {
      var iso = isoOf(d);
      ["AM", "PM"].forEach(function (sh) { shiftArr(iso, sh, false).forEach(function (it) { if (it.k === "ed") used[it.id] = 1; }); });
    });
    function dist2(a, b) { var dy = (a.lat - b.lat) * 111, dx = (a.lng - b.lng) * 84; return dy * dy + dx * dx; }
    function nextSeed() { for (var i = 0; i < cand.length; i++) if (!used[cand[i].ed]) return cand[i]; return null; }

    var filledShifts = 0, totalEds = 0;
    weekDays().forEach(function (d) {
      var iso = isoOf(d);
      ["AM", "PM"].forEach(function (sh) {
        if (shiftArr(iso, sh, false).length) return; // empty shifts only
        var seed = nextSeed(); if (!seed) return;
        var pool = cand.filter(function (x) { return !used[x.ed]; });
        pool.sort(function (a, b) { return dist2(a, seed) - dist2(b, seed); }); // seed is nearest to itself
        var cluster = [], area = 0;
        for (var i = 0; i < pool.length && area < AUTOPLAN_TARGET_ACRES && cluster.length < AUTOPLAN_MAX_PER_SHIFT; i++) {
          cluster.push(pool[i]); used[pool[i].ed] = 1; area += pool[i].acres;
        }
        if (!cluster.length) return;
        var arr = shiftArr(iso, sh, true);
        cluster.forEach(function (x) { arr.push({ k: "ed", id: x.ed, label: "ED " + edShort(x.ed), lat: x.lat, lng: x.lng, icon: "🗳" }); });
        filledShifts++; totalEds += cluster.length;
      });
    });
    savePlan(); refreshDistricts(); renderPlan();
    if (msg) {
      msg.textContent = filledShifts
        ? "Filled " + filledShifts + " empty shift" + (filledShifts > 1 ? "s" : "") + " with " + totalEds + " districts (" + (mode === "gotv" ? "turnout" : "persuasion") + ")."
        : "Every shift already has districts — nothing to fill.";
      setTimeout(function () { if (msg) msg.textContent = ""; }, 7000);
    }
  }
  function renderPlan() {
    renderWeekLabel(); renderShiftBanner(); renderWeather(); renderFellowStatus(); renderRecommendations(); renderEvents();
    if (reviewOpen) { renderReview(); renderMeetMarkers(); }
    var container = document.getElementById("plan-days");
    container.innerHTML = weekDays().map(function (d) {
      var iso = isoOf(d);
      var shifts = ["AM", "PM"].map(function (sh) {
        var items = shiftArr(iso, sh, false), isActive = (iso === state.activeDay && sh === state.activeShift) ? " active" : "";
        var chips = items.map(function (it) {
          return '<li class="ed-chip"><span class="ed-go" data-lat="' + it.lat + '" data-lng="' + it.lng + '">' + (it.icon ? escapeHtml(it.icon) + " " : "") + escapeHtml(it.label) +
            '</span><button class="rm-btn" data-rm="' + escAttr(it.id) + '" data-day="' + iso + '" data-shift="' + sh + '">✕</button></li>';
        }).join("");
        return '<div class="shift-row' + isActive + '" data-day="' + iso + '" data-shift="' + sh + '"><div class="shift-head"><span class="sh-name">' + sh + '</span><span class="sh-time">' + shiftTime(d, sh) + '</span>' + fellowBadge(d, sh) + '<span class="sh-count">' + (items.length ? items.length + " stop" + (items.length > 1 ? "s" : "") : "select") + "</span></div><ul class='ed-chips'>" + chips + "</ul></div>";
      }).join("");
      return '<div class="day-card"><div class="day-head static"><span class="d-name">' + dowName(d) + " " + prettyDate(d) + "</span></div>" + shifts + "</div>";
    }).join("");
    Array.prototype.forEach.call(container.querySelectorAll(".sh-fellows.has-names"), function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); showFellowsPopover(b, b.getAttribute("data-iso"), b.getAttribute("data-sh")); });
    });
    Array.prototype.forEach.call(container.querySelectorAll(".shift-row"), function (row) {
      row.querySelector(".shift-head").addEventListener("click", function () { state.activeDay = row.getAttribute("data-day"); state.activeShift = row.getAttribute("data-shift"); refreshDistricts(); renderPlan(); });
    });
    Array.prototype.forEach.call(container.querySelectorAll(".rm-btn"), function (btn) {
      btn.addEventListener("click", function (e) { e.stopPropagation(); removeItem(btn.getAttribute("data-day"), btn.getAttribute("data-shift"), btn.getAttribute("data-rm")); });
    });
    Array.prototype.forEach.call(container.querySelectorAll(".ed-go"), function (g) {
      g.addEventListener("click", function (e) { e.stopPropagation(); var la = +g.getAttribute("data-lat"), ln = +g.getAttribute("data-lng"); if (la && ln) map.setView([la, ln], Math.max(map.getZoom(), 15)); });
    });
  }
  function itemText(it) { return it.k === "ed" ? edLabel(it.id) : (it.icon ? it.icon + " " : "") + it.label; }
  function planAsText() {
    var lines = ["Canvassing plan — " + document.getElementById("week-label").textContent, ""];
    weekDays().forEach(function (d) {
      var iso = isoOf(d); if (!["AM", "PM"].some(function (sh) { return shiftArr(iso, sh, false).length; })) return;
      lines.push(dowName(d) + " " + prettyDate(d) + ":");
      ["AM", "PM"].forEach(function (sh) {
        var items = shiftArr(iso, sh, false); if (!items.length) return;
        lines.push("  " + sh + " (" + shiftTime(d, sh) + "): " + items.map(itemText).join(", "));
        var m = getMeet(iso, sh); if (m) lines.push("    Meet: " + m.label);
      });
      lines.push("");
    });
    if (lines.length <= 2) lines.push("(nothing assigned yet)");
    return lines.join("\n");
  }
  function copyPlan() {
    var text = planAsText(), done = function () { var el = document.getElementById("review-copied"); if (!el) return; el.textContent = "Copied to clipboard ✓"; setTimeout(function () { el.textContent = ""; }, 2500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt("Copy the plan:", text); }); else window.prompt("Copy the plan:", text);
  }
  function printPlan() {
    var rows = weekDays().map(function (d) {
      var iso = isoOf(d);
      var inner = ["AM", "PM"].map(function (sh) {
        var items = shiftArr(iso, sh, false); var m = getMeet(iso, sh);
        return "<div class='sh'><strong>" + sh + " (" + shiftTime(d, sh) + ")</strong>: " + (items.length ? items.map(itemText).join(", ") : "—") +
          (m ? "<div class='meet'>📍 Meet: " + escapeHtml(m.label) + "</div>" : "") + "</div>";
      }).join("");
      return "<div class='d'><h3>" + dowName(d) + " " + prettyDate(d) + "</h3>" + inner + "</div>";
    }).join("");
    var html = "<html><head><title>Canvassing plan</title><style>body{font-family:-apple-system,Arial,sans-serif;margin:32px;color:#1f2b38}h1{font-size:20px}h3{font-size:14px;margin:0 0 4px;border-bottom:1px solid #ccc;padding-bottom:3px}.d{margin-bottom:12px}.sh{font-size:13px;margin:2px 0}.meet{font-size:12px;color:#555;margin:1px 0 0 14px}</style></head><body><h1>Canvassing plan</h1><h2 style='font-size:14px;color:#555'>" + escapeHtml(document.getElementById("week-label").textContent) + "</h2>" + rows + "</body></html>";
    var w = window.open("", "_blank"); if (!w) { alert("Please allow pop-ups to print the plan."); return; }
    w.document.write(html); w.document.close(); w.focus(); setTimeout(function () { w.print(); }, 250);
  }

  // ====================================================================
  //  REVIEW & PUBLISH  (slide-in panel: week overview + per-shift meeting points + export)
  // ====================================================================
  function geocodePlaces(q) {
    return fetch(GEOCODE + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (d) {
      return (d.features || []).map(function (f) {
        var pp = photonParts(f.properties);
        return { name: pp.name, addr: pp.addr, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
      });
    }).catch(function () { return []; });
  }
  function reverseGeocode(lat, lng) {
    return fetch("https://photon.komoot.io/reverse?lat=" + lat + "&lon=" + lng).then(function (r) { return r.json(); })
      .then(function (d) { var f = d.features && d.features[0]; if (!f) return null; var pp = photonParts(f.properties); return pp.name + (pp.addr ? ", " + pp.addr : ""); })
      .catch(function () { return null; });
  }
  function meetLabel(iso, sh) { return dowName(parseISO(iso)) + " " + sh; }
  function renderMeetMarkers() {
    if (overlay.meet) { map.removeLayer(overlay.meet); overlay.meet = null; }
    if (!reviewOpen) return;
    overlay.meet = L.layerGroup().addTo(map);
    weekDays().forEach(function (d, di) {
      var iso = isoOf(d);
      ["AM", "PM"].forEach(function (sh) {
        var m = getMeet(iso, sh); if (!m) return;
        L.marker([m.lat, m.lng], { icon: pinIcon("meet-pin", DAY_COLORS[di], "M"), pane: "pane-search" })
          .addTo(overlay.meet).bindTooltip(meetLabel(iso, sh) + " — " + m.label, { direction: "top" });
      });
    });
  }
  // Bounds covering all the districts in one shift (used to frame the map when
  // you start setting that shift's meeting point).
  function shiftBounds(iso, sh) {
    var lls = [];
    shiftArr(iso, sh, false).forEach(function (it) {
      if (it.k !== "ed") return;
      var f = edFeature(it.id);
      if (f) { try { var b = L.geoJSON(f).getBounds(); lls.push(b.getSouthWest(), b.getNorthEast()); return; } catch (e) {} }
      var c = edCentroid[String(it.id)]; if (c) lls.push([c.lat, c.lng]);
    });
    return lls.length ? L.latLngBounds(lls) : null;
  }
  // keep the districts out from under the open review panel
  function panelOffset() { var p = document.getElementById("review-panel"); return (p && p.classList.contains("open")) ? Math.round(p.getBoundingClientRect().width) + 30 : 70; }
  function fitShift(iso, sh) {
    var b = shiftBounds(iso, sh); if (!b) return;
    try { map.fitBounds(b, { paddingTopLeft: [70, 70], paddingBottomRight: [panelOffset(), 70], maxZoom: 16 }); } catch (e) {}
  }
  function renderReview() {
    var wk = document.getElementById("review-week"); if (wk) wk.textContent = document.getElementById("week-label").textContent;
    var body = document.getElementById("review-body"); if (!body) return;
    var html = "", any = false;
    weekDays().forEach(function (d, di) {
      var iso = isoOf(d);
      var shifts = ["AM", "PM"].filter(function (sh) { return shiftArr(iso, sh, false).length; });
      if (!shifts.length) return; any = true;
      html += '<div class="rv-day"><div class="rv-day-head"><span class="rv-dot" style="background:' + DAY_COLORS[di] + '"></span>' + dowName(d) + " " + prettyDate(d) + "</div>";
      shifts.forEach(function (sh) {
        var items = shiftArr(iso, sh, false);
        var chips = items.map(function (it) { return '<span class="rv-chip">' + (it.icon ? escapeHtml(it.icon) + " " : "") + escapeHtml(it.label) + "</span>"; }).join("");
        var meet = getMeet(iso, sh), mh;
        if (meet) {
          mh = '<div class="rv-meet set"><div class="rv-meet-top"><span class="rv-meet-label">📍 ' + escapeHtml(meet.label) + "</span>" +
            '<button class="rv-meet-change" data-iso="' + iso + '" data-sh="' + sh + '">change</button>' +
            '<button class="rv-meet-clear" data-iso="' + iso + '" data-sh="' + sh + '" title="Remove">✕</button></div>' +
            '<div class="rv-meet-send-row"><button class="rv-meet-send" data-iso="' + iso + '" data-sh="' + sh + '">Send to schedule</button><span class="rv-send-status"></span></div></div>';
        } else {
          mh = '<div class="rv-meet"><div class="rv-meet-row">' +
            '<input class="rv-meet-search" type="search" placeholder="Search a meeting place…" data-iso="' + iso + '" data-sh="' + sh + '" />' +
            '<button class="rv-meet-auto" data-iso="' + iso + '" data-sh="' + sh + '" title="Pick a subway/grocery in the districts (or a central spot)">✨ Auto</button>' +
            '<button class="rv-meet-map" data-iso="' + iso + '" data-sh="' + sh + '">📍 Map</button></div>' +
            '<ul class="rv-meet-results"></ul></div>';
        }
        html += '<div class="rv-shift"><div class="rv-shift-head">' + sh + ' <span class="rv-time">' + shiftTime(d, sh) + "</span></div>" +
          '<div class="rv-chips">' + chips + "</div>" + mh + "</div>";
      });
      html += "</div>";
    });
    body.innerHTML = any ? html : '<div class="rv-empty">No districts planned yet — add some to a shift first, then come back to set meeting points and publish.</div>';
    wireReviewControls(body);
  }
  function wireReviewControls(body) {
    function meetReset(b) { clearMeet(b.getAttribute("data-iso"), b.getAttribute("data-sh")); renderReview(); renderMeetMarkers(); }
    Array.prototype.forEach.call(body.querySelectorAll(".rv-meet-clear"), function (b) { b.addEventListener("click", function () { meetReset(b); }); });
    Array.prototype.forEach.call(body.querySelectorAll(".rv-meet-change"), function (b) { b.addEventListener("click", function () { meetReset(b); }); });
    Array.prototype.forEach.call(body.querySelectorAll(".rv-meet-map"), function (b) { b.addEventListener("click", function () { pickMeetOnMap(b.getAttribute("data-iso"), b.getAttribute("data-sh")); }); });
    Array.prototype.forEach.call(body.querySelectorAll(".rv-meet-auto"), function (b) {
      b.addEventListener("click", function () {
        b.disabled = true; b.textContent = "…";
        autoPickMeeting(b.getAttribute("data-iso"), b.getAttribute("data-sh")).then(function () { renderReview(); renderMeetMarkers(); });
      });
    });
    Array.prototype.forEach.call(body.querySelectorAll(".rv-meet-send"), function (b) {
      b.addEventListener("click", function () {
        var status = b.parentNode.querySelector(".rv-send-status");
        b.disabled = true; if (status) status.textContent = "Sending…";
        pushMeeting(b.getAttribute("data-iso"), b.getAttribute("data-sh")).then(function (res) {
          b.disabled = false;
          if (status) status.textContent = res && res.ok ? "✓ on schedule" : "✗ " + ((res && res.error) || "failed");
        });
      });
    });
    Array.prototype.forEach.call(body.querySelectorAll(".rv-meet-search"), function (inp) {
      var timer = null, results = inp.parentNode.parentNode.querySelector(".rv-meet-results");
      inp.addEventListener("focus", function () { fitShift(inp.getAttribute("data-iso"), inp.getAttribute("data-sh")); });
      inp.addEventListener("input", function () {
        var q = inp.value.trim(); clearTimeout(timer);
        if (q.length < 3) { results.innerHTML = ""; return; }
        timer = setTimeout(function () {
          geocodePlaces(q).then(function (rs) {
            results.innerHTML = rs.slice(0, 5).map(function (r, i) { return '<li data-i="' + i + '"><strong>' + escapeHtml(r.name) + "</strong>" + (r.addr ? " <span class='sub'>" + escapeHtml(r.addr) + "</span>" : "") + "</li>"; }).join("");
            Array.prototype.forEach.call(results.querySelectorAll("li"), function (li) {
              li.addEventListener("click", function () {
                var r = rs[+li.getAttribute("data-i")];
                setMeet(inp.getAttribute("data-iso"), inp.getAttribute("data-sh"), { label: r.name + (r.addr ? ", " + r.addr : ""), lat: r.lat, lng: r.lng });
                renderReview(); renderMeetMarkers();
              });
            });
          });
        }, 280);
      });
    });
  }
  function pickMeetOnMap(iso, sh) {
    meetPick = { iso: iso, sh: sh };
    document.getElementById("review-panel").classList.remove("open"); // slide out first so the fit uses the full map
    fitShift(iso, sh);
    var banner = document.getElementById("meet-banner");
    banner.textContent = "Click the map to set the meeting point for " + meetLabel(iso, sh) + "  (Esc to cancel)";
    banner.classList.add("show");
    map.getContainer().style.cursor = "crosshair";
    map.once("click", onMeetClick);
  }
  function onMeetClick(e) {
    var p = meetPick; if (!p) return; endMeetPickUi();
    var lat = e.latlng.lat, lng = e.latlng.lng;
    reverseGeocode(lat, lng).then(function (label) {
      setMeet(p.iso, p.sh, { label: label || "Pinned spot", lat: lat, lng: lng });
      renderMeetMarkers(); openReview();
    });
  }
  function endMeetPickUi() {
    meetPick = null;
    var b = document.getElementById("meet-banner"); if (b) b.classList.remove("show");
    if (map) map.getContainer().style.cursor = "";
  }
  function cancelMeetPick() { if (!meetPick) return; map.off("click", onMeetClick); endMeetPickUi(); openReview(); }
  function openReview() {
    reviewOpen = true;
    if (!state.weekOverview) {
      reviewSetOverview = true; state.weekOverview = true;
      var b = document.getElementById("week-overview"); if (b) { b.textContent = "Hide week overview"; b.classList.add("on"); }
      refreshDistricts();
    }
    renderReview(); renderMeetMarkers();
    document.getElementById("review-panel").classList.add("open");
    document.body.classList.add("review-open");
  }
  function closeReview() {
    reviewOpen = false;
    document.getElementById("review-panel").classList.remove("open");
    document.body.classList.remove("review-open");
    if (reviewSetOverview) {
      reviewSetOverview = false; state.weekOverview = false;
      var b = document.getElementById("week-overview"); if (b) { b.textContent = "Show week overview"; b.classList.remove("on"); }
      refreshDistricts();
    }
    renderMeetMarkers();
  }
  // Push meeting points to the scheduling site (via serve.py -> push_meeting_point.py).
  function shiftKeyFor(iso, sh) { return dowName(parseISO(iso)).toLowerCase() + "_inperson_" + sh.toLowerCase(); }
  function pushMeeting(iso, sh) {
    var m = getMeet(iso, sh); if (!m) return Promise.resolve({ ok: false, error: "no meeting point" });
    return fetch("/api/push-meeting", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ week_start: isoOf(state.weekStart), shift_key: shiftKeyFor(iso, sh), label: m.label, lat: m.lat, lng: m.lng }) })
      .then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: "offline" }; });
  }
  function setReviewSendStatus(msg) { var el = document.getElementById("review-send-status"); if (el) el.textContent = msg; }
  function sendAllMeetings() {
    var jobs = [];
    weekDays().forEach(function (d) { var iso = isoOf(d); ["AM", "PM"].forEach(function (sh) { if (getMeet(iso, sh)) jobs.push({ iso: iso, sh: sh }); }); });
    if (!jobs.length) { setReviewSendStatus("Set at least one meeting point first."); return; }
    setReviewSendStatus("Sending " + jobs.length + " meeting point" + (jobs.length > 1 ? "s" : "") + "…");
    Promise.all(jobs.map(function (j) { return pushMeeting(j.iso, j.sh); })).then(function (rs) {
      var ok = rs.filter(function (r) { return r && r.ok; }).length;
      var firstErr = (rs.filter(function (r) { return r && !r.ok; })[0] || {}).error;
      setReviewSendStatus(ok === jobs.length
        ? "✓ Sent all " + ok + " to the schedule."
        : "Sent " + ok + " of " + jobs.length + (firstErr ? " — " + firstErr : "") + " (is the scheduling project on this Mac?)");
      renderReview();
    });
  }

  // ---- auto-pick a meeting point per shift: a subway stop or grocery store
  // inside the shift's districts, else a central intersection ----
  function shiftPolyIndex(iso, sh) {
    var out = [];
    shiftArr(iso, sh, false).forEach(function (it) {
      if (it.k !== "ed") return; var f = edFeature(it.id); if (!f || !f.geometry) return;
      var g = f.geometry, polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
      var bb = [1e9, 1e9, -1e9, -1e9];
      polys.forEach(function (poly) { poly[0].forEach(function (pt) { if (pt[0] < bb[0]) bb[0] = pt[0]; if (pt[1] < bb[1]) bb[1] = pt[1]; if (pt[0] > bb[2]) bb[2] = pt[0]; if (pt[1] > bb[3]) bb[3] = pt[1]; }); });
      out.push({ bb: bb, polys: polys });
    });
    return out;
  }
  function inShiftPolys(lng, lat, idx) {
    for (var k = 0; k < idx.length; k++) { var d = idx[k], b = d.bb; if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue; for (var p = 0; p < d.polys.length; p++) if (pipPoly(lng, lat, d.polys[p])) return true; }
    return false;
  }
  function shiftCenter(iso, sh) {
    var la = 0, ln = 0, n = 0;
    shiftArr(iso, sh, false).forEach(function (it) {
      if (it.k !== "ed") return; var p = state.edProps[it.id], c = edCentroid[String(it.id)];
      var lat = (p && num(p.representative_latitude)) || (c && c.lat), lng = (p && num(p.representative_longitude)) || (c && c.lng);
      if (lat && lng) { la += lat; ln += lng; n++; }
    });
    return n ? { lat: la / n, lng: ln / n } : null;
  }
  function poiMeters(c, lat, lng) { var dy = (lat - c.lat) * 111000, dx = (lng - c.lng) * 84000; return Math.sqrt(dx * dx + dy * dy); }
  // Best POI for a shift: prefer one inside its districts; otherwise the nearest
  // within `maxM` meters of the cluster center (EDs are tiny, so stops/stores
  // usually sit just outside on a bordering street).
  function bestPOIForShift(geo, idx, center, maxM) {
    var insideBest = null, nearBest = null;
    ((geo && geo.features) || []).forEach(function (f) {
      if (!f.geometry || f.geometry.type !== "Point") return;
      var lng = f.geometry.coordinates[0], lat = f.geometry.coordinates[1], m = poiMeters(center, lat, lng);
      if (inShiftPolys(lng, lat, idx)) { if (!insideBest || m < insideBest.m) insideBest = { f: f, lat: lat, lng: lng, m: m }; }
      else if (m <= maxM && (!nearBest || m < nearBest.m)) nearBest = { f: f, lat: lat, lng: lng, m: m };
    });
    return insideBest || nearBest;
  }
  function autoPickMeeting(iso, sh) {
    var idx = shiftPolyIndex(iso, sh), center = shiftCenter(iso, sh);
    if (!idx.length || !center) return Promise.resolve(false);
    return Promise.all([ensureData("subway"), ensureData("groc")]).then(function (res) {
      var sub = bestPOIForShift(res[0], idx, center, 600);
      if (sub) { setMeet(iso, sh, { label: (sub.f.properties.name || "Subway") + " subway", lat: sub.lat, lng: sub.lng }); return true; }
      var g = bestPOIForShift(res[1], idx, center, 600);
      if (g) { var nm = g.f.properties.name || "Supermarket", cr = g.f.properties.cross; setMeet(iso, sh, { label: nm + (cr ? " (" + cr + ")" : ""), lat: g.lat, lng: g.lng }); return true; }
      return reverseGeocode(center.lat, center.lng).then(function (label) {
        setMeet(iso, sh, { label: label || "Central point", lat: center.lat, lng: center.lng }); return true;
      });
    });
  }
  function autoPickAllMeetings() {
    var status = document.getElementById("review-autopick-status");
    var jobs = [];
    weekDays().forEach(function (d) {
      var iso = isoOf(d);
      ["AM", "PM"].forEach(function (sh) { if (shiftArr(iso, sh, false).some(function (x) { return x.k === "ed"; }) && !getMeet(iso, sh)) jobs.push({ iso: iso, sh: sh }); });
    });
    if (!jobs.length) { if (status) status.textContent = "Every shift with districts already has a meeting point."; return; }
    if (status) status.textContent = "Picking " + jobs.length + " meeting point" + (jobs.length > 1 ? "s" : "") + "…";
    Promise.all(jobs.map(function (j) { return autoPickMeeting(j.iso, j.sh); })).then(function () {
      renderReview(); renderMeetMarkers();
      if (status) { status.textContent = "Picked " + jobs.length + " — review and adjust as needed."; setTimeout(function () { if (status) status.textContent = ""; }, 6000); }
    });
  }

  // ====================================================================
  //  COMMUNITY EVENTS (NYC permitted events / SAPO — free, CORS-friendly)
  //  Curated "street & neighborhood" types, inside the district, this week.
  // ====================================================================
  var EVENTS_API = "https://data.cityofnewyork.us/resource/tvpp-9vvx.json";
  var EVENT_TYPES = ["Farmers Market", "Street Festival", "Single Block Festival", "Block Party", "Sidewalk Sale", "Health Fair"];
  var NY12_CB = { 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 }; // fallback when an event can't be geocoded
  var eventMarker = null;

  // point-in-polygon test against the district polygons (built when districts load)
  function buildDistrictIndex(features) {
    state.distIdx = features.map(function (f) {
      var g = f.geometry, polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
      var bb = [1e9, 1e9, -1e9, -1e9];
      polys.forEach(function (poly) { poly[0].forEach(function (pt) { if (pt[0] < bb[0]) bb[0] = pt[0]; if (pt[1] < bb[1]) bb[1] = pt[1]; if (pt[0] > bb[2]) bb[2] = pt[0]; if (pt[1] > bb[3]) bb[3] = pt[1]; }); });
      return { bb: bb, polys: polys };
    });
  }
  function pipRing(x, y, ring) {
    var inside = false, n = ring.length, j = n - 1;
    for (var i = 0; i < n; i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
      j = i;
    }
    return inside;
  }
  function pipPoly(x, y, poly) { if (!pipRing(x, y, poly[0])) return false; for (var i = 1; i < poly.length; i++) if (pipRing(x, y, poly[i])) return false; return true; }
  function inDistrict(lng, lat) {
    if (!state.distIdx) return false;
    for (var k = 0; k < state.distIdx.length; k++) {
      var d = state.distIdx[k], b = d.bb;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      for (var p = 0; p < d.polys.length; p++) if (pipPoly(lng, lat, d.polys[p])) return true;
    }
    return false;
  }
  function cbNum(s) { var m = String(s || "").match(/\d+/); return m ? +m[0] : 0; }
  function evIcon(t) { return /farmers/i.test(t) ? "🥕" : /health/i.test(t) ? "➕" : "🎪"; }
  function eventsUrl() {
    var start = isoOf(state.weekStart) + "T00:00:00", end = isoOf(addDays(state.weekStart, 7)) + "T00:00:00";
    var types = EVENT_TYPES.map(function (t) { return "event_type='" + t + "'"; }).join(" OR ");
    var where = "event_borough='Manhattan' AND start_date_time>='" + start + "' AND start_date_time<'" + end + "' AND (" + types + ")";
    return EVENTS_API + "?$order=start_date_time&$limit=80&$where=" + encodeURIComponent(where);
  }
  function parseLoc(loc) {
    loc = String(loc || ""); var main = loc.split(/ between /i)[0].trim();
    var cross = "", m = loc.match(/ between (.+?)(?: and )/i); if (m) cross = m[1].trim();
    return { main: main, cross: cross };
  }
  // Photon does NYC intersections; GeoSearch does not. We only trust the point
  // when the result name has a street number (a real intersection, not an avenue fallback).
  function geocodeEvent(loc) {
    var p = parseLoc(loc); if (!p.main) return Promise.resolve(null);
    var q = (p.cross ? p.main + " & " + p.cross : p.main) + " Manhattan New York";
    return fetch("https://photon.komoot.io/api/?limit=1&lat=40.77&lon=-73.96&q=" + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var f = d.features && d.features[0]; if (!f) return null;
        var label = (f.properties.name || "") + " " + (f.properties.street || "");
        return { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], hasNum: /\d/.test(label) };
      }).catch(function () { return null; });
  }
  function ecHeader() { var d = parseISO(state.activeDay); return '<div class="ic-title">Events · ' + dowName(d) + " " + prettyDate(d) + "</div>"; }
  function loadEvents() {
    var card = document.getElementById("events-card"); if (!card) return;
    card.innerHTML = ecHeader() + '<div class="ic-muted">Loading events…</div>';
    var reqWeek = state.weekStart;
    fetch(eventsUrl()).then(function (r) { return r.json(); }).then(function (rows) {
      // Community board is the authoritative in-district filter (reliable). Geocoding
      // is only used, best-effort, to place a map pin — never to decide in/out.
      var seen = {};
      var inDist = (rows || []).filter(function (e) {
        if (!NY12_CB[cbNum(e.community_board)]) return false;
        var key = (e.event_name || "") + "|" + (e.start_date_time || "").slice(0, 10);
        if (seen[key]) return false; seen[key] = 1; return true;
      });
      return Promise.all(inDist.map(function (e) {
        return geocodeEvent(e.event_location).then(function (geo) {
          var lat = null, lng = null;
          if (geo && geo.hasNum && inDistrict(geo.lng, geo.lat)) { lat = geo.lat; lng = geo.lng; }
          return { name: e.event_name, type: e.event_type, date: (e.start_date_time || "").slice(0, 10), loc: e.event_location, lat: lat, lng: lng };
        });
      }));
    }).then(function (arr) {
      if (reqWeek !== state.weekStart) return; // week changed mid-load
      state.events = arr; renderEvents();
    }).catch(function () { card.innerHTML = ecHeader() + '<div class="ic-muted">Events unavailable right now.</div>'; });
  }
  function renderEvents() {
    var card = document.getElementById("events-card"); if (!card) return;
    // Only the day currently being planned (state.activeDay).
    var evs = (state.events || []).filter(function (e) { return e.date === state.activeDay; });
    if (!evs.length) { card.innerHTML = ecHeader() + '<div class="ic-muted">No district events on this day.</div>'; return; }
    card.innerHTML = ecHeader() + '<ul class="ev-list">' + evs.map(function (e, i) {
      return '<li class="ev-row" data-i="' + i + '"><span class="ev-n">' + evIcon(e.type) + " " + escapeHtml(e.name) + "</span></li>";
    }).join("") + '</ul><div class="ev-note" id="ev-note"></div>';
    Array.prototype.forEach.call(card.querySelectorAll(".ev-row"), function (li) {
      li.addEventListener("click", function () { focusEvent(evs[+li.getAttribute("data-i")]); });
    });
  }
  function focusEvent(e) {
    if (!e) return;
    var note = document.getElementById("ev-note");
    var d = parseISO(e.date);
    if (e.lat == null || e.lng == null) {  // no reliable coordinate -> show its location inline
      if (note) note.innerHTML = "📍 <strong>" + escapeHtml(e.name) + "</strong> — " + escapeHtml(e.loc || "") + " <span class='sub'>(couldn't pin exactly)</span>";
      return;
    }
    if (note) note.textContent = "";
    if (eventMarker) map.removeLayer(eventMarker);
    eventMarker = L.marker([e.lat, e.lng], { icon: pinIcon("event-pin", "#b8860b", "📅"), pane: "pane-search" }).addTo(map);
    eventMarker.bindPopup('<div class="popup-title">' + evIcon(e.type) + " " + escapeHtml(e.name) + "</div><div class='sub'>" +
      escapeHtml(e.type) + " · " + dowName(d) + " " + prettyDate(d) + "</div><div class='popup-dates'>" + escapeHtml(e.loc || "") + "</div>" +
      addBtnHtml({ k: "pt", id: "evt:" + e.lat.toFixed(5) + "," + e.lng.toFixed(5), label: e.name + " (" + prettyDate(d) + ")", lat: e.lat, lng: e.lng, icon: "📅" }), { maxWidth: 280 });
    map.setView([e.lat, e.lng], 16, { animate: false });
    eventMarker.openPopup();
  }

  // ====================================================================
  //  WEATHER (Open-Meteo — free, no key, CORS-friendly)
  // ====================================================================
  var WX = "https://api.open-meteo.com/v1/forecast?latitude=40.78&longitude=-73.96" +
    "&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=16";
  function wxInfo(code) {
    code = num(code);
    if (code === 0) return { i: "☀️", t: "Clear" };
    if (code <= 2) return { i: "🌤️", t: "Mostly sunny" };
    if (code === 3) return { i: "☁️", t: "Cloudy" };
    if (code <= 48) return { i: "🌫️", t: "Fog" };
    if (code <= 57) return { i: "🌦️", t: "Drizzle" };
    if (code <= 67) return { i: "🌧️", t: "Rain" };
    if (code <= 77) return { i: "🌨️", t: "Snow" };
    if (code <= 82) return { i: "🌦️", t: "Showers" };
    if (code <= 86) return { i: "🌨️", t: "Snow showers" };
    return { i: "⛈️", t: "Thunderstorms" };
  }
  // Show the forecast for the day currently being planned (state.activeDay).
  function renderWeather() {
    var card = document.getElementById("weather-card"); if (!card || !state.wx) return;
    var day = state.wx.daily || {}, times = day.time || [], idx = times.indexOf(state.activeDay);
    var dd = parseISO(state.activeDay);
    var head = '<div class="ic-title">Weather · ' + dowName(dd) + " " + prettyDate(dd) + "</div>";
    if (idx === -1) { card.innerHTML = head + '<div class="ic-muted">Forecast not available this far ahead yet.</div>'; return; }
    var w = wxInfo(day.weather_code[idx]);
    var hi = Math.round(num(day.temperature_2m_max[idx])), lo = Math.round(num(day.temperature_2m_min[idx])), pp = num(day.precipitation_probability_max[idx]);
    card.innerHTML = head +
      '<div class="wx-current"><span class="wx-temp">' + hi + "°</span>" +
      '<span class="wx-cond">' + w.i + " " + w.t +
      "<br><span class='sub'>High " + hi + "° · Low " + lo + "° · 💧" + pp + "% rain</span></span></div>";
  }
  function initWeather() {
    var card = document.getElementById("weather-card"); if (!card) return;
    fetch(WX).then(function (r) { return r.json(); })
      .then(function (d) { state.wx = d; renderWeather(); })
      .catch(function () { card.innerHTML = '<div class="ic-title">NYC weather</div><div class="ic-muted">Weather unavailable right now.</div>'; });
  }

  // ---- init ------------------------------------------------------------
  function makePanes() {
    // pane-labels sits below Leaflet's tooltipPane (z 650) so the hover banner covers the labels.
    [["pane-groc", 610], ["pane-early", 615], ["pane-polls", 620], ["pane-search", 630], ["pane-labels", 640], ["pane-highlight", 645]].forEach(function (d) { map.createPane(d[0]); map.getPane(d[0]).style.zIndex = d[1]; });
    R = L.canvas({ padding: 0.5 });
  }
  function updateZoomClass() {
    var z = map.getZoom();
    map.getContainer().classList.toggle("show-stop-labels", z >= 14);
  }

  function wireUi() {
    var input = document.getElementById("search"), results = document.getElementById("search-results");
    input.addEventListener("input", function (e) {
      var q = e.target.value.trim(); clearTimeout(searchTimer);
      if (q.length < 3) { renderResults([]); return; }
      searchTimer = setTimeout(function () { doSearch(q); }, 280);
    });
    document.addEventListener("click", function (e) { if (!e.target.closest(".search-wrap")) results.classList.remove("show"); });

    document.getElementById("shading-mode").addEventListener("change", function (e) { state.shadingMode = e.target.value; refreshDistricts(); });
    document.getElementById("lyr-lines").addEventListener("change", function (e) { toggleLines(e.target.checked); });
    document.getElementById("lyr-labels").addEventListener("change", function (e) { toggleLabels(e.target.checked); });
    document.getElementById("lyr-hoods").addEventListener("change", function (e) { toggleHoods(e.target.checked); });
    document.getElementById("lyr-subway").addEventListener("change", function (e) { toggleSubway(e.target.checked); });
    document.getElementById("lyr-polls").addEventListener("change", function (e) { togglePolls(e.target.checked); });
    document.getElementById("lyr-early").addEventListener("change", function (e) { toggleEarly(e.target.checked); });
    document.getElementById("lyr-groc").addEventListener("change", function (e) { toggleGroc(e.target.checked); });
    document.getElementById("week-prev").addEventListener("click", function () { state.weekStart = addDays(state.weekStart, -7); state.activeDay = isoOf(state.weekStart); refreshDistricts(); renderPlan(); loadEvents(); });
    document.getElementById("week-next").addEventListener("click", function () { state.weekStart = addDays(state.weekStart, 7); state.activeDay = isoOf(state.weekStart); refreshDistricts(); renderPlan(); loadEvents(); });
    document.getElementById("rec-mode").addEventListener("change", function (e) { state.recMode = e.target.value; renderRecommendations(); });
    document.getElementById("rec-autoplan").addEventListener("click", autoPlanWeek);
    document.getElementById("week-overview").addEventListener("click", toggleWeekOverview);
    document.getElementById("fellows-refresh").addEventListener("click", refreshFellows);
    document.getElementById("plan-review").addEventListener("click", openReview);
    document.getElementById("review-close").addEventListener("click", closeReview);
    document.getElementById("review-print").addEventListener("click", printPlan);
    document.getElementById("review-copy").addEventListener("click", copyPlan);
    document.getElementById("review-autopick").addEventListener("click", autoPickAllMeetings);
    document.getElementById("review-sendall").addEventListener("click", sendAllMeetings);
    document.getElementById("plan-clear").addEventListener("click", function () { if (!confirm("Remove everything from this week's plan?")) return; weekDays().forEach(function (d) { delete state.plan[isoOf(d)]; }); savePlan(); refreshDistricts(); renderPlan(); });

    var modal = document.getElementById("info-modal");
    document.getElementById("info-btn").addEventListener("click", function () { modal.classList.remove("hidden"); });
    document.getElementById("info-close").addEventListener("click", function () { modal.classList.add("hidden"); });
    modal.addEventListener("click", function (e) { if (e.target === modal) modal.classList.add("hidden"); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (meetPick) { cancelMeetPick(); return; }
      if (reviewOpen) { closeReview(); return; }
      modal.classList.add("hidden");
    });

    map.on("zoomend", updateZoomClass);
    map.on("popupopen", function (e) {
      var root = e.popup.getElement(); if (!root) return;
      var rem = root.querySelector(".pin-remove");
      if (rem) rem.addEventListener("click", function () { if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; } map.closePopup(); });
      var btn = root.querySelector(".plan-add"); if (!btn) return;
      btn.addEventListener("click", function () {
        var item = { k: btn.dataset.k, id: btn.dataset.id, label: btn.dataset.label, lat: +btn.dataset.lat, lng: +btn.dataset.lng, icon: btn.dataset.icon };
        toggleItem(item);
        var inShift = activeHas(item.id);
        btn.classList.toggle("in", inShift);
        btn.textContent = inShift ? "✓ In " + activeShiftLabel() + " — remove" : "➕ Add to " + activeShiftLabel();
      });
    });
  }

  function init() {
    map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([40.78, -73.96], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 19 }).addTo(map);
    makePanes();
    legend = L.control({ position: "bottomright" });
    legend.onAdd = function () { return L.DomUtil.create("div", "legend"); };
    legend.addTo(map);

    // info button — navy "i" in the map's top-right corner
    var infoCtl = L.control({ position: "topright" });
    infoCtl.onAdd = function () {
      var b = L.DomUtil.create("button", "info-btn");
      b.id = "info-btn"; b.type = "button"; b.title = "How this works"; b.setAttribute("aria-label", "How this works"); b.innerHTML = "i";
      L.DomEvent.disableClickPropagation(b);
      return b;
    };
    infoCtl.addTo(map);

    loadPlan();
    initWeather();
    state.weekStart = nextMonday();
    state.activeDay = isoOf(state.weekStart);
    loadAvailability();

    Promise.all([
      fetch(DATA.districts + DV).then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch(DATA.boreslasher + DV).then(function (r) { return r.json(); }).catch(function () { return null; }),
    ]).then(function (res) {
      var districts = res[0];
      if (districts && res[1]) {
        var bl = {}; res[1].features.forEach(function (f) { bl[String(f.properties.elect_dist)] = f.properties; });
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
        buildDistrictIndex(districts.features);
        buildDistrictLayer(districts);
        toggleLines(true); // default: ED + AD boundary lines on
        loadEvents();
        map.invalidateSize();
        try { map.fitBounds(districtLayer.getBounds(), { padding: [20, 20], animate: false }); } catch (e) {}
      }
      renderPlan(); updateLegend(); updateZoomClass();
    }).catch(function (err) { console.error(err); });

    wireUi();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
