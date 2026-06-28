/* Past Canvassing Locations — standalone map.
   Pure vanilla JS + Leaflet. No build step, no API keys. */
/* global L */
(function () {
  "use strict";

  var DATA = {
    locations: "data/locations.json",
    summary: "data/summary.json",
    districts: "data/districts.geojson",
  };

  var state = {
    locations: [],
    summary: null,
    districts: null,
    markersById: {},
    selectedId: null,
    sort: "weighted_person_days",
    search: "",
  };

  var map, markerLayer, districtLayer, legend;
  var maxWeighted = 1;

  // ---- helpers ---------------------------------------------------------

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function fmt(n) {
    n = num(n);
    return n % 1 === 0 ? String(n) : n.toFixed(1);
  }

  // Color ramp (light blue -> deep blue) by share of the busiest site.
  function colorFor(weighted) {
    var t = Math.sqrt(num(weighted) / maxWeighted); // sqrt = perceptual boost for small sites
    t = Math.max(0, Math.min(1, t));
    var lo = [159, 208, 255]; // --dot-low
    var hi = [11, 79, 158]; // --dot-high
    var c = lo.map(function (l, i) {
      return Math.round(l + (hi[i] - l) * t);
    });
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  }

  // Marker radius: area roughly proportional to coverage, with a floor.
  function radiusFor(weighted) {
    var t = Math.sqrt(num(weighted) / maxWeighted);
    return 5 + t * 20;
  }

  function firstAlias(loc) {
    var a = (loc.location_aliases || "").split("|")[0].trim();
    return a || ("Site at " + loc.latitude.toFixed(4) + ", " + loc.longitude.toFixed(4));
  }

  function pipeList(s) {
    return (s || "")
      .split("|")
      .map(function (x) { return x.trim(); })
      .filter(Boolean);
  }

  // ---- rendering -------------------------------------------------------

  function buildSummary() {
    var s = state.summary || {};
    var totalPeopleDays = num(s.total_raw_person_days_all_locations);
    var stats = [
      { num: state.locations.length, lbl: "Locations canvassed" },
      { num: num(s.site_days_total), lbl: "Site-days" },
      { num: Math.round(totalPeopleDays), lbl: "Total person-days" },
      { num: fmt(s.total_weighted_person_days_all_locations), lbl: "Weighted coverage" },
    ];
    document.getElementById("summary").innerHTML = stats
      .map(function (x) {
        return '<div class="stat"><div class="num">' + x.num +
          '</div><div class="lbl">' + x.lbl + "</div></div>";
      })
      .join("");
  }

  function visibleLocations() {
    var q = state.search.trim().toLowerCase();
    var list = state.locations.filter(function (loc) {
      if (!q) return true;
      return (
        (loc.location_aliases || "").toLowerCase().indexOf(q) !== -1 ||
        (loc.unique_people || "").toLowerCase().indexOf(q) !== -1
      );
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === "location_aliases") {
        return firstAlias(a).localeCompare(firstAlias(b));
      }
      return num(b[key]) - num(a[key]);
    });
    return list;
  }

  function renderList() {
    var list = visibleLocations();
    var ul = document.getElementById("location-list");
    ul.innerHTML = list
      .map(function (loc) {
        var active = loc.location_id === state.selectedId ? " active" : "";
        return (
          '<li class="loc-item' + active + '" data-id="' + loc.location_id + '">' +
          '<div class="name"><span class="swatch" style="background:' +
          colorFor(loc.weighted_person_days) + '"></span>' +
          escapeHtml(firstAlias(loc)) + "</div>" +
          '<div class="meta">' +
          num(loc.days_active) + " days · " +
          num(loc.raw_person_days) + " person-days · " +
          num(loc.unique_people_count) + " volunteers</div>" +
          "</li>"
        );
      })
      .join("");
    document.getElementById("count-line").textContent =
      list.length + " of " + state.locations.length + " locations shown";

    Array.prototype.forEach.call(ul.querySelectorAll(".loc-item"), function (li) {
      li.addEventListener("click", function () {
        selectLocation(li.getAttribute("data-id"), true);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function popupHtml(loc) {
    var people = pipeList(loc.unique_people);
    var dates = pipeList(loc.dates_active);
    return (
      '<div class="popup-title">' + escapeHtml(firstAlias(loc)) + "</div>" +
      '<div class="popup-grid">' +
      '<span class="k">Days active</span><span>' + num(loc.days_active) + "</span>" +
      '<span class="k">Person-days</span><span>' + num(loc.raw_person_days) + "</span>" +
      '<span class="k">Coverage (weighted)</span><span>' + fmt(loc.weighted_person_days) + "</span>" +
      '<span class="k">Unique volunteers</span><span>' + num(loc.unique_people_count) + "</span>" +
      "</div>" +
      '<div class="popup-dates"><strong>Dates:</strong> ' +
      (dates.length ? escapeHtml(dates.join(", ")) : "—") +
      "</div>" +
      (people.length
        ? '<div class="popup-dates"><strong>Volunteers:</strong> ' +
          escapeHtml(people.slice(0, 12).join(", ")) +
          (people.length > 12 ? " +" + (people.length - 12) + " more" : "") +
          "</div>"
        : "")
    );
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    state.markersById = {};
    state.locations.forEach(function (loc) {
      if (!isFinite(loc.latitude) || !isFinite(loc.longitude)) return;
      var m = L.circleMarker([loc.latitude, loc.longitude], {
        radius: radiusFor(loc.weighted_person_days),
        color: "#ffffff",
        weight: 1,
        fillColor: colorFor(loc.weighted_person_days),
        fillOpacity: 0.85,
      });
      m.bindPopup(popupHtml(loc), { maxWidth: 320 });
      m.on("click", function () { selectLocation(loc.location_id, false); });
      m.addTo(markerLayer);
      state.markersById[loc.location_id] = m;
    });
  }

  function selectLocation(id, fromList) {
    state.selectedId = id;
    var loc = state.locations.filter(function (l) { return l.location_id === id; })[0];
    if (!loc) return;
    var m = state.markersById[id];
    if (m) {
      if (fromList) map.setView([loc.latitude, loc.longitude], Math.max(map.getZoom(), 15));
      m.openPopup();
    }
    renderList();
    var li = document.querySelector('.loc-item[data-id="' + cssEscape(id) + '"]');
    if (li && fromList === false) li.scrollIntoView({ block: "nearest" });
  }

  function cssEscape(s) {
    return String(s).replace(/"/g, '\\"');
  }

  // ---- district turnout overlay (optional) -----------------------------

  function districtColor(v, max) {
    var t = max > 0 ? num(v) / max : 0;
    t = Math.max(0, Math.min(1, Math.sqrt(t)));
    var lo = [40, 50, 65];
    var hi = [220, 90, 70];
    var c = lo.map(function (l, i) { return Math.round(l + (hi[i] - l) * t); });
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  }

  function toggleDistricts(on) {
    if (!on) {
      if (districtLayer) { map.removeLayer(districtLayer); }
      return;
    }
    if (districtLayer) { districtLayer.addTo(map); districtLayer.bringToBack(); return; }
    if (!state.districts) return;
    var maxBallots = 0;
    state.districts.features.forEach(function (f) {
      maxBallots = Math.max(maxBallots, num(f.properties.ballots_cast));
    });
    districtLayer = L.geoJSON(state.districts, {
      style: function (f) {
        return {
          fillColor: districtColor(f.properties.ballots_cast, maxBallots),
          fillOpacity: 0.45,
          color: "#3a4757",
          weight: 0.5,
        };
      },
      onEachFeature: function (f, layer) {
        var p = f.properties;
        layer.bindTooltip(
          "ED " + p.election_district + " (AD " + p.assembly_district + ")<br>" +
          num(p.ballots_cast) + " Dem primary voters (2025)",
          { sticky: true }
        );
      },
    }).addTo(map);
    districtLayer.bringToBack();
  }

  function addLegend() {
    legend = L.control({ position: "bottomright" });
    legend.onAdd = function () {
      var div = L.DomUtil.create("div", "legend");
      div.innerHTML =
        "<h4>Dot = canvassing coverage</h4>" +
        '<div class="row"><span class="dot" style="width:8px;height:8px;background:' +
        colorFor(maxWeighted * 0.03) + '"></span> Light visits</div>' +
        '<div class="row"><span class="dot" style="width:20px;height:20px;background:' +
        colorFor(maxWeighted) + '"></span> Heavy, repeat canvassing</div>';
      return div;
    };
    legend.addTo(map);
  }

  // ---- init ------------------------------------------------------------

  function init() {
    map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([40.78, -73.96], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; ' +
        '<a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);

    Promise.all([
      fetch(DATA.locations).then(function (r) { return r.json(); }),
      fetch(DATA.summary).then(function (r) { return r.json(); }).catch(function () { return null; }),
    ])
      .then(function (res) {
        state.locations = (res[0] || []).filter(function (l) {
          return isFinite(l.latitude) && isFinite(l.longitude);
        });
        state.summary = res[1];
        maxWeighted = state.locations.reduce(function (m, l) {
          return Math.max(m, num(l.weighted_person_days));
        }, 1);

        buildSummary();
        renderMarkers();
        renderList();
        addLegend();

        var pts = state.locations.map(function (l) { return [l.latitude, l.longitude]; });
        if (pts.length) map.fitBounds(pts, { padding: [40, 40] });
      })
      .catch(function (err) {
        document.getElementById("subtitle").textContent =
          "Could not load data — make sure you opened this through the local server (see README).";
        console.error(err);
      });

    // Lazy-load districts only if/when toggled on.
    document.getElementById("toggle-districts").addEventListener("change", function (e) {
      var on = e.target.checked;
      if (on && !state.districts) {
        fetch(DATA.districts)
          .then(function (r) { return r.json(); })
          .then(function (g) { state.districts = g; toggleDistricts(true); })
          .catch(function (err) { console.error(err); e.target.checked = false; });
      } else {
        toggleDistricts(on);
      }
    });

    document.getElementById("search").addEventListener("input", function (e) {
      state.search = e.target.value;
      renderList();
    });
    document.getElementById("sort").addEventListener("change", function (e) {
      state.sort = e.target.value;
      renderList();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
