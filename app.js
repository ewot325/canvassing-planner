/* Canvassing Planner — standalone map + weekly shift planner.
   Pure vanilla JS + Leaflet. No build step, no API keys, no backend. */
/* global L */
(function () {
  "use strict";

  var DV = "?v=8"; // cache-buster for data files (bump when data changes)
  var DATA = {
    districts: "data/districts.geojson",
    boreslasher: "data/bores_lasher_results.geojson",
    adlines: "data/ad_boundaries.geojson",
    neighborhoods: "data/neighborhoods.geojson",
    subway: "data/subway_stations.geojson",
    polls: "data/election_day_poll_sites.geojson",
    early: "data/early_voting_sites.geojson",
    groc: "data/supermarkets.geojson",
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
  var RAMPS = { opportunity: [[255, 247, 232], [150, 0, 12]], turnout: [[233, 242, 255], [3, 41, 99]], coverage: [[233, 250, 236], [0, 78, 33]] };

  var state = {
    geo: {}, edProps: {},
    shadingMode: "none",
    weekStart: null, activeDay: null, activeShift: "AM", plan: {},
    pcts: {},
  };

  var map, legend, districtLayer, R, searchMarker = null, searchTimer = null, searchAbort = null;
  var overlay = { lines: null, hoods: null, subway: null, polls: null, early: null, groc: null };
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
  function districtStyle(feature) {
    var mode = state.shadingMode, p = feature.properties, sel = activeEdSet().has(String(p.elect_dist));
    // boundaries are drawn by the separate ED/AD lines layer; here only the selection highlight strokes
    var st = { color: "#1f6feb", weight: sel ? 2.8 : 0, opacity: 1 };
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
    return '<div class="popup-title">Election District ' + p.election_district + " <span class='sub'>(AD " + p.assembly_district + ")</span></div>" +
      "<div class='popup-grid'><span class='k'>Registered Dems</span><span>" + commas(regDem) + (regTot ? " <span class='sub'>of " + commas(regTot) + "</span>" : "") + "</span></div>" +
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
  function refreshDistricts() { if (!districtLayer) return; districtLayer.setStyle(districtStyle); updateLegend(); }

  // ====================================================================
  //  POINT OVERLAYS  (each marker's popup has an Add-to-shift button)
  // ====================================================================
  // ED + AD boundary lines (one toggle for both)
  function toggleLines(on) {
    if (!on) { if (overlay.lines) map.removeLayer(overlay.lines); return; }
    if (overlay.lines) { overlay.lines.addTo(map); overlay.lines.bringToFront && overlay.lines.bringToFront(); return; }
    overlay.lines = L.layerGroup().addTo(map);
    // ED lines (thin) from the districts we already have
    if (state.geo.districts) {
      L.geoJSON(state.geo.districts, { renderer: R, interactive: false, style: { fill: false, color: "#6b7c8f", weight: 0.6, opacity: 0.7 } }).addTo(overlay.lines);
    }
    // AD division lines (thick) from the dissolved boundaries
    ensureData("adlines").then(function (g) {
      L.geoJSON(g, { renderer: R, interactive: false, style: { fill: false, color: "#2b3f57", weight: 2, opacity: 0.9 } }).addTo(overlay.lines);
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
    map.setView([lat, lng], 16);
    searchMarker.openPopup();
  }

  // ---- legend ----------------------------------------------------------
  function updateLegend() {
    if (!legend) return;
    var el = legend.getContainer(), mode = state.shadingMode;
    if (mode === "none") { el.innerHTML = "<h4>Map</h4><div class='sub'>Click a district for details.</div>"; return; }
    if (mode === "mayor2025") { el.innerHTML = "<h4>2025 Mayor — who led each ED</h4>" + cat(MAYOR_COLORS["Zohran Kwame Mamdani"], "Mamdani") + cat(MAYOR_COLORS["Andrew M. Cuomo"], "Cuomo") + cat(MAYOR_COLORS["Brad Lander"], "Lander") + '<div class="sub">Stronger color = bigger win.</div>'; return; }
    if (mode === "boreslasher") { el.innerHTML = "<h4>2026 Dem Primary — who won each ED</h4>" + cat(BL_COLORS.Bores, "Bores") + cat(BL_COLORS.Lasher, "Lasher") + cat(BL_COLORS.Tie, "Tie / other") + '<div class="sub">Stronger color = bigger margin.</div>'; return; }
    var titles = { opportunity: "Priority for next week", turnout: "2025 Dem primary turnout", coverage: "Canvassing coverage so far" };
    var ends = { opportunity: ["covered / low turnout", "high turnout, under-canvassed"], turnout: ["fewer voters", "more voters"], coverage: ["not canvassed", "heavily canvassed"] };
    var ramp = ""; for (var i = 0; i <= 8; i++) ramp += '<span style="background:' + rampCol(mode, i / 8) + '"></span>';
    el.innerHTML = "<h4>" + titles[mode] + "</h4><div class='ramp'>" + ramp + "</div><div class='ends'><span>" + ends[mode][0] + "</span><span>" + ends[mode][1] + "</span></div>";
  }
  function cat(color, label) { return '<div class="cat"><span class="box" style="background:' + color + '"></span>' + escapeHtml(label) + "</div>"; }

  // ====================================================================
  //  WEEKLY SHIFT PLANNER UI
  // ====================================================================
  function nextMonday() { var day = TODAY.getDay(), delta = ((8 - day) % 7) || 7; return addDays(TODAY, delta); }
  function weekDays() { var out = []; for (var i = 0; i < 7; i++) out.push(addDays(state.weekStart, i)); return out; }
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
        var items = shiftArr(iso, sh, false), isActive = (iso === state.activeDay && sh === state.activeShift) ? " active" : "";
        var chips = items.map(function (it) {
          return '<li class="ed-chip"><span class="ed-go" data-lat="' + it.lat + '" data-lng="' + it.lng + '">' + (it.icon ? escapeHtml(it.icon) + " " : "") + escapeHtml(it.label) +
            '</span><button class="rm-btn" data-rm="' + escAttr(it.id) + '" data-day="' + iso + '" data-shift="' + sh + '">✕</button></li>';
        }).join("");
        return '<div class="shift-row' + isActive + '" data-day="' + iso + '" data-shift="' + sh + '"><div class="shift-head"><span class="sh-name">' + sh + '</span><span class="sh-time">' + shiftTime(d, sh) + '</span><span class="sh-count">' + (items.length ? items.length + " stop" + (items.length > 1 ? "s" : "") : "select") + "</span></div><ul class='ed-chips'>" + chips + "</ul></div>";
      }).join("");
      return '<div class="day-card"><div class="day-head static"><span class="d-name">' + dowName(d) + " " + prettyDate(d) + "</span></div>" + shifts + "</div>";
    }).join("");
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
      ["AM", "PM"].forEach(function (sh) { var items = shiftArr(iso, sh, false); if (items.length) lines.push("  " + sh + " (" + shiftTime(d, sh) + "): " + items.map(itemText).join(", ")); });
      lines.push("");
    });
    if (lines.length <= 2) lines.push("(nothing assigned yet)");
    return lines.join("\n");
  }
  function copyPlan() {
    var text = planAsText(), done = function () { var el = document.getElementById("plan-copied"); el.textContent = "Copied to clipboard ✓"; setTimeout(function () { el.textContent = ""; }, 2500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt("Copy the plan:", text); }); else window.prompt("Copy the plan:", text);
  }
  function printPlan() {
    var rows = weekDays().map(function (d) {
      var iso = isoOf(d);
      var inner = ["AM", "PM"].map(function (sh) { var items = shiftArr(iso, sh, false); return "<div class='sh'><strong>" + sh + " (" + shiftTime(d, sh) + ")</strong>: " + (items.length ? items.map(itemText).join(", ") : "—") + "</div>"; }).join("");
      return "<div class='d'><h3>" + dowName(d) + " " + prettyDate(d) + "</h3>" + inner + "</div>";
    }).join("");
    var html = "<html><head><title>Canvassing plan</title><style>body{font-family:-apple-system,Arial,sans-serif;margin:32px;color:#1f2b38}h1{font-size:20px}h3{font-size:14px;margin:0 0 4px;border-bottom:1px solid #ccc;padding-bottom:3px}.d{margin-bottom:12px}.sh{font-size:13px;margin:2px 0}</style></head><body><h1>Canvassing plan</h1><h2 style='font-size:14px;color:#555'>" + escapeHtml(document.getElementById("week-label").textContent) + "</h2>" + rows + "</body></html>";
    var w = window.open("", "_blank"); if (!w) { alert("Please allow pop-ups to print the plan."); return; }
    w.document.write(html); w.document.close(); w.focus(); setTimeout(function () { w.print(); }, 250);
  }

  // ---- init ------------------------------------------------------------
  function makePanes() {
    [["pane-groc", 610], ["pane-early", 615], ["pane-polls", 620], ["pane-search", 630]].forEach(function (d) { map.createPane(d[0]); map.getPane(d[0]).style.zIndex = d[1]; });
    R = L.canvas({ padding: 0.5 });
  }
  function updateZoomClass() { map.getContainer().classList.toggle("show-stop-labels", map.getZoom() >= 14); }

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
    document.getElementById("lyr-hoods").addEventListener("change", function (e) { toggleHoods(e.target.checked); });
    document.getElementById("lyr-subway").addEventListener("change", function (e) { toggleSubway(e.target.checked); });
    document.getElementById("lyr-polls").addEventListener("change", function (e) { togglePolls(e.target.checked); });
    document.getElementById("lyr-early").addEventListener("change", function (e) { toggleEarly(e.target.checked); });
    document.getElementById("lyr-groc").addEventListener("change", function (e) { toggleGroc(e.target.checked); });
    document.getElementById("week-prev").addEventListener("click", function () { state.weekStart = addDays(state.weekStart, -7); state.activeDay = isoOf(state.weekStart); refreshDistricts(); renderPlan(); });
    document.getElementById("week-next").addEventListener("click", function () { state.weekStart = addDays(state.weekStart, 7); state.activeDay = isoOf(state.weekStart); refreshDistricts(); renderPlan(); });
    document.getElementById("plan-print").addEventListener("click", printPlan);
    document.getElementById("plan-copy").addEventListener("click", copyPlan);
    document.getElementById("plan-clear").addEventListener("click", function () { if (!confirm("Remove everything from this week's plan?")) return; weekDays().forEach(function (d) { delete state.plan[isoOf(d)]; }); savePlan(); refreshDistricts(); renderPlan(); });

    var modal = document.getElementById("info-modal");
    document.getElementById("info-btn").addEventListener("click", function () { modal.classList.remove("hidden"); });
    document.getElementById("info-close").addEventListener("click", function () { modal.classList.add("hidden"); });
    modal.addEventListener("click", function (e) { if (e.target === modal) modal.classList.add("hidden"); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") modal.classList.add("hidden"); });

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
    state.weekStart = nextMonday();
    state.activeDay = isoOf(state.weekStart);

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
        buildDistrictLayer(districts);
        toggleLines(true); // default: ED + AD boundary lines on
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
