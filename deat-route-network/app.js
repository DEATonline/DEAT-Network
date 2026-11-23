/* ==========================================================================
   DEAT GLOBAL ROUTE NETWORK — APPLICATION LOGIC (v2)
   Fixes:
   1. Map visual glitches: single clean world landmass rendering without
      overlapping/double-stroke artifacts, proper SVG pane sizing, clean
      great-circle arcs without straight wrap-around chords, and centered
      airport pins + collision-free labels.
   2. Password-protected editing: All route/airport/aircraft/settings/import/
      reset/visibility-editing actions require unlocking with the SHA-256
      salted password hash (stored in sessionStorage for active browser tab,
      with one-click Lock or Password Change).
   ========================================================================== */

const STORAGE_KEY = "deat_online_network_v2";
const SESSION_AUTH_KEY = "deat_editor_unlocked_v2";

let networkData = null;
let pendingProtectedAction = null;

let state = {
  colorMode: "brand",
  filters: {
    continents: new Set(),
    aircraft: new Set(),
    categories: new Set(),
    country: "",
    hub: "",
    hubsOnly: false
  },
  display: {
    showIcao: true,
    showCity: true,
    showArrows: false
  },
  selection: {
    type: null,
    id: null
  }
};

let map = null;
let routesLayerGroup = null;
let markersLayerGroup = null;
let routeLayersById = new Map();
let markerLayersByIcao = new Map();

const CONTINENT_COLORS = {
  "Europe": "#EE1C25",
  "Asia": "#0F172A",
  "North America": "#0284C7",
  "South America": "#059669",
  "Africa": "#D97706",
  "Oceania": "#7C3AED"
};

const CATEGORY_COLORS = {
  "Long-Haul": "#EE1C25",
  "Medium-Haul": "#1E293B",
  "Regional": "#0284C7",
  "Seasonal": "#D97706",
  "Cargo": "#059669"
};

/* ==========================================================================
   1. CRYPTOGRAPHIC PASSWORD VERIFICATION (WEB CRYPTO SHA-256)
   ========================================================================== */
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const data = enc.encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function isEditorUnlocked() {
  return sessionStorage.getItem(SESSION_AUTH_KEY) === "true";
}

function setEditorUnlocked(unlocked) {
  if (unlocked) {
    sessionStorage.setItem(SESSION_AUTH_KEY, "true");
  } else {
    sessionStorage.removeItem(SESSION_AUTH_KEY);
  }
  updateAuthButtonUI();
}

function updateAuthButtonUI() {
  const btn = document.getElementById("btn-open-editor");
  if (!btn) return;
  if (isEditorUnlocked()) {
    btn.className = "btn btn-unlocked";
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
      Network Editor (Unlocked)
    `;
  } else {
    btn.className = "btn btn-primary";
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Edit Network (Locked)
    `;
  }
}

function requireUnlocked(actionFn) {
  if (isEditorUnlocked()) {
    actionFn();
    return;
  }
  pendingProtectedAction = actionFn;
  openPasswordModal();
}

function openPasswordModal() {
  const errEl = document.getElementById("auth-error");
  errEl.classList.remove("show");
  errEl.textContent = "";
  const pwInput = document.getElementById("auth-password-input");
  pwInput.value = "";
  document.getElementById("auth-modal").classList.add("open");
  setTimeout(() => pwInput.focus(), 50);
}

function closePasswordModal() {
  pendingProtectedAction = null;
  document.getElementById("auth-modal").classList.remove("open");
}

/* ==========================================================================
   2. DATA LOADING & PERSISTENCE
   ========================================================================== */
async function loadInitialData() {
  // 1. Check localStorage first so user edits persist across reloads
  try {
    const savedRaw = localStorage.getItem(STORAGE_KEY);
    if (savedRaw) {
      const parsed = JSON.parse(savedRaw);
      if (parsed && Array.isArray(parsed.airports) && Array.isArray(parsed.routes)) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn("localStorage unavailable or corrupted:", err);
  }

  // 2. Fetch external ./data/network.json
  const res = await fetch("./data/network.json", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} loading ./data/network.json`);
  }
  return await res.json();
}

function saveNetworkData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(networkData));
    document.getElementById("footer-storage-status").textContent =
      "SAVED " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    showToast("Could not write to browser storage.");
  }
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 3000);
}

/* ==========================================================================
   3. GEODESIC MATH & CLEAN ANTIMERIDIAN FLIGHT PATHS (GLITCH-FREE)
   ========================================================================== */
function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * Computes smooth great-circle flight paths and splits cleanly at ±180°
 * so Leaflet never draws a horizontal line across the entire world map.
 */
function computeSplitFlightArcs(ap1, ap2) {
  const lat1 = toRad(ap1.lat);
  const lon1 = toRad(ap1.lng);
  const lat2 = toRad(ap2.lat);
  const lon2 = toRad(ap2.lng);

  const cosD =
    Math.sin(lat1) * Math.sin(lat2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  const d = Math.acos(Math.max(-1, Math.min(1, cosD)));

  const steps = 64;
  const rawPts = [];

  if (d < 0.0001) {
    rawPts.push([ap1.lat, ap1.lng], [ap2.lat, ap2.lng]);
  } else {
    const sinD = Math.sin(d);
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const A = Math.sin((1 - f) * d) / sinD;
      const B = Math.sin(f * d) / sinD;
      const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
      const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
      const z = A * Math.sin(lat1) + B * Math.sin(lat2);
      const lat = toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)));
      let lon = toDeg(Math.atan2(y, x));
      // Normalize lon to [-180, 180]
      lon = ((lon + 540) % 360) - 180;
      rawPts.push([lat, lon]);
    }
  }

  // Split segment whenever consecutive points jump across the ±180° antimeridian
  const segments = [[]];
  for (let i = 0; i < rawPts.length; i++) {
    const curr = rawPts[i];
    const currentSeg = segments[segments.length - 1];
    if (currentSeg.length > 0) {
      const prev = currentSeg[currentSeg.length - 1];
      if (Math.abs(curr[1] - prev[1]) > 180) {
        segments.push([curr]);
        continue;
      }
    }
    currentSeg.push(curr);
  }

  return segments.filter(seg => seg.length >= 2);
}

/* ==========================================================================
   4. MAP INITIALIZATION & CUSTOM LANDMASS RENDERING
   ========================================================================== */
async function initMap() {
  const center = (networkData.settings && networkData.settings.defaultCenter) || [26, 48];
  const zoom = (networkData.settings && networkData.settings.defaultZoom) || 3;

  map = L.map("map", {
    center,
    zoom,
    minZoom: 2,
    maxZoom: 11,
    zoomControl: false,
    worldCopyJump: true,
    preferCanvas: false
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);

  routesLayerGroup = L.layerGroup().addTo(map);
  markersLayerGroup = L.layerGroup().addTo(map);

  await loadCleanWorldLandmasses();

  map.on("mousemove", (e) => {
    const lat = e.latlng.lat;
    const lng = ((e.latlng.lng + 540) % 360) - 180;
    const ns = lat >= 0 ? "N" : "S";
    const ew = lng >= 0 ? "E" : "W";
    document.getElementById("footer-cursor-coords").textContent =
      `LAT ${Math.abs(lat).toFixed(2)}°${ns}  LON ${Math.abs(lng).toFixed(2).padStart(6, "0")}°${ew}`;
  });

  map.on("zoomend", updateLabelDensity);
  map.on("moveend", updateLabelDensity);
  map.on("resize", () => map.invalidateSize());

  map.on("click", () => {
    if (state.selection.type) {
      clearSelection();
    }
  });

  applyBrandTheme();
  updateAuthButtonUI();
  rebuildFilterUI();
  renderNetwork();
}

async function loadCleanWorldLandmasses() {
  const sources = [
    "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
    "https://unpkg.com/world-atlas@2/countries-110m.json"
  ];

  let topology = null;
  for (const url of sources) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        topology = await resp.json();
        break;
      }
    } catch (_) {
      // Try fallback CDN
    }
  }

  if (topology && window.topojson) {
    const geo = topojson.feature(topology, topology.objects.countries);
    geo.features = geo.features.filter(f => String(f.id) !== "010");

    // Single crisp vector layer (avoids triple-stacked stroke artifacts)
    L.geoJSON(geo, {
      interactive: false,
      style: {
        fillColor: "#D6D8DC",
        fillOpacity: 1,
        color: "#FFFFFF",
        weight: 0.85,
        opacity: 1,
        lineJoin: "round"
      }
    }).addTo(map);
  } else {
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap &copy; CARTO",
      subdomains: "abcd",
      maxZoom: 18
    }).addTo(map);
  }
}

/* ==========================================================================
   5. FILTERING, COLOR MODES & NETWORK RENDERING
   ========================================================================== */
function getAirportMap() {
  const m = new Map();
  networkData.airports.forEach(ap => m.set(ap.icao, ap));
  return m;
}

function getFilteredRoutes() {
  const apMap = getAirportMap();
  return networkData.routes.filter((r) => {
    if (!r.visible) return false;
    const orig = apMap.get(r.origin);
    const dest = apMap.get(r.destination);
    if (!orig || !dest) return false;

    if (state.filters.hubsOnly && (!orig.isHub || !dest.isHub)) return false;

    if (state.filters.continents.size > 0) {
      if (!state.filters.continents.has(orig.continent) && !state.filters.continents.has(dest.continent)) {
        return false;
      }
    }

    if (state.filters.aircraft.size > 0 && !state.filters.aircraft.has(r.aircraft)) {
      return false;
    }

    if (state.filters.categories.size > 0 && !state.filters.categories.has(r.category)) {
      return false;
    }

    if (state.filters.country) {
      if (orig.country !== state.filters.country && dest.country !== state.filters.country) {
        return false;
      }
    }

    if (state.filters.hub) {
      if (r.origin !== state.filters.hub && r.destination !== state.filters.hub) {
        return false;
      }
    }

    return true;
  });
}

function resolveRouteColor(route, apMap) {
  if (state.colorMode === "brand") {
    return route.color || (networkData.settings && networkData.settings.brandColor) || "#EE1C25";
  }
  if (state.colorMode === "aircraft") {
    const ac = networkData.aircraft.find(a => a.type === route.aircraft);
    return ac ? ac.color : "#475569";
  }
  if (state.colorMode === "continent") {
    const dest = apMap.get(route.destination);
    return (dest && CONTINENT_COLORS[dest.continent]) || "#EE1C25";
  }
  if (state.colorMode === "category") {
    return CATEGORY_COLORS[route.category] || "#EE1C25";
  }
  return route.color || "#EE1C25";
}

function renderNetwork() {
  routesLayerGroup.clearLayers();
  markersLayerGroup.clearLayers();
  routeLayersById.clear();
  markerLayersByIcao.clear();

  const apMap = getAirportMap();
  const filteredRoutes = getFilteredRoutes();

  const hasFilters =
    state.filters.continents.size > 0 ||
    state.filters.aircraft.size > 0 ||
    state.filters.categories.size > 0 ||
    state.filters.country !== "" ||
    state.filters.hub !== "" ||
    state.filters.hubsOnly;

  const activeIcaos = new Set();
  filteredRoutes.forEach(r => {
    activeIcaos.add(r.origin);
    activeIcaos.add(r.destination);
  });

  const visibleAirports = networkData.airports.filter(ap => {
    if (state.filters.hubsOnly && !ap.isHub) return false;
    if (!hasFilters) return true;
    return activeIcaos.has(ap.icao);
  });

  // Render curved routes cleanly without cross-map chords
  filteredRoutes.forEach((route) => {
    const orig = apMap.get(route.origin);
    const dest = apMap.get(route.destination);
    if (!orig || !dest) return;

    const color = resolveRouteColor(route, apMap);
    const segments = computeSplitFlightArcs(orig, dest);
    const lines = [];

    segments.forEach((latlngs) => {
      const hitLine = L.polyline(latlngs, {
        color: "#000000",
        weight: 12,
        opacity: 0,
        interactive: true
      }).addTo(routesLayerGroup);

      const visualLine = L.polyline(latlngs, {
        color,
        weight: route.weight || 2.2,
        opacity: route.opacity || 0.92,
        lineCap: "round",
        lineJoin: "round",
        interactive: false
      }).addTo(routesLayerGroup);

      if (state.display.showArrows && latlngs.length > 6) {
        const midIdx = Math.floor(latlngs.length / 2);
        const p1 = latlngs[midIdx - 1];
        const p2 = latlngs[midIdx];
        const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * (180 / Math.PI);
        L.marker(latlngs[midIdx], {
          interactive: false,
          icon: L.divIcon({
            className: "deat-airport-marker",
            html: `<div style="transform:translate(-50%,-50%) rotate(${angle - 90}deg);color:${color};font-size:10px;font-weight:900;line-height:1;text-shadow:0 0 2px #fff;">▲</div>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0]
          })
        }).addTo(routesLayerGroup);
      }

      hitLine.on("mouseover", () => handleRouteHover(route.id, true));
      hitLine.on("mouseout", () => handleRouteHover(route.id, false));
      hitLine.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        selectRoute(route.id);
      });

      lines.push({
        visualLine,
        hitLine,
        baseWeight: route.weight || 2.2,
        baseOpacity: route.opacity || 0.92
      });
    });

    routeLayersById.set(route.id, { route, lines });
  });

  // Render airport markers
  visibleAirports.forEach((ap) => {
    const marker = L.marker([ap.lat, ap.lng], {
      icon: buildAirportDivIcon(ap),
      zIndexOffset: ap.isHub ? 600 : 200
    }).addTo(markersLayerGroup);

    marker.bindTooltip(
      `<strong>${ap.icao}</strong> — ${ap.city}<br><span style="font-size:10px;color:#555;">${ap.name} (${ap.country})</span>`,
      { direction: "top", offset: [0, -10] }
    );

    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      selectAirport(ap.icao);
    });

    markerLayersByIcao.set(ap.icao, { airport: ap, marker });
  });

  applySelectionStyling();
  updateLabelDensity();
  updateStats(filteredRoutes, visibleAirports);
  updateLegend(filteredRoutes, apMap);
}

function buildAirportDivIcon(ap) {
  const isSelected = state.selection.type === "airport" && state.selection.id === ap.icao;
  const cityHtml = state.display.showCity
    ? `<div class="airport-label-city">${escapeHtml(ap.city.toLowerCase())}</div>`
    : "";
  const icaoHtml = state.display.showIcao
    ? `<div class="airport-label-icao">${escapeHtml(ap.icao)}</div>`
    : "";

  return L.divIcon({
    className: "deat-airport-marker",
    html: `
      <div class="airport-pin-wrap ${ap.isHub ? "hub" : ""} ${isSelected ? "selected" : ""}" data-icao="${ap.icao}">
        <div class="airport-ring"></div>
        <div class="airport-label">${cityHtml}${icaoHtml}</div>
      </div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 0]
  });
}

function updateLabelDensity() {
  const zoom = map.getZoom();
  const placedBoxes = [];

  const entries = Array.from(markerLayersByIcao.values()).sort((a, b) => {
    const rankA = state.selection.id === a.airport.icao ? 2 : (a.airport.isHub ? 1 : 0);
    const rankB = state.selection.id === b.airport.icao ? 2 : (b.airport.isHub ? 1 : 0);
    return rankB - rankA;
  });

  entries.forEach(({ airport, marker }) => {
    const el = marker.getElement();
    if (!el) return;
    const labelEl = el.querySelector(".airport-label");
    if (!labelEl) return;

    const isPriority =
      airport.isHub ||
      state.selection.id === airport.icao ||
      (state.selection.type === "route" && isAirportInSelectedRoute(airport.icao));

    if (zoom <= 2 && !isPriority) {
      labelEl.style.display = "none";
      return;
    }

    const pt = map.latLngToContainerPoint(marker.getLatLng());
    const box = {
      left: pt.x - 36,
      right: pt.x + 36,
      top: pt.y + 4,
      bottom: pt.y + 28
    };

    if (isPriority || zoom >= 6) {
      labelEl.style.display = "block";
      placedBoxes.push(box);
    } else {
      const overlaps = placedBoxes.some(b =>
        !(box.right < b.left || box.left > b.right || box.bottom < b.top || box.top > b.bottom)
      );
      if (overlaps) {
        labelEl.style.display = "none";
      } else {
        labelEl.style.display = "block";
        placedBoxes.push(box);
      }
    }
  });
}

function isAirportInSelectedRoute(icao) {
  if (state.selection.type !== "route") return false;
  const r = networkData.routes.find(x => x.id === state.selection.id);
  return r && (r.origin === icao || r.destination === icao);
}

/* ==========================================================================
   6. SELECTION, HIGHLIGHTING & INSPECTOR
   ========================================================================== */
function handleRouteHover(routeId, isHover) {
  if (state.selection.type) return;
  const entry = routeLayersById.get(routeId);
  if (!entry) return;
  entry.lines.forEach(l => {
    l.visualLine.setStyle({
      weight: isHover ? l.baseWeight + 2 : l.baseWeight,
      opacity: isHover ? 1 : l.baseOpacity
    });
    if (isHover) l.visualLine.bringToFront();
  });
}

function applySelectionStyling() {
  const sel = state.selection;

  routeLayersById.forEach(({ route, lines }, id) => {
    let isHighlighted = false;
    let isDimmed = false;

    if (sel.type === "route") {
      isHighlighted = id === sel.id;
      isDimmed = !isHighlighted;
    } else if (sel.type === "airport") {
      isHighlighted = route.origin === sel.id || route.destination === sel.id;
      isDimmed = !isHighlighted;
    }

    lines.forEach(l => {
      if (isHighlighted) {
        l.visualLine.setStyle({ weight: l.baseWeight + 1.8, opacity: 1 });
        l.visualLine.bringToFront();
      } else if (isDimmed) {
        l.visualLine.setStyle({ weight: Math.max(1.2, l.baseWeight - 0.5), opacity: 0.16 });
      } else {
        l.visualLine.setStyle({ weight: l.baseWeight, opacity: l.baseOpacity });
      }
    });
  });

  markerLayersByIcao.forEach(({ marker }, icao) => {
    let isConnected = true;
    if (sel.type === "airport") {
      isConnected = icao === sel.id || Array.from(routeLayersById.values()).some(({ route }) =>
        (route.origin === sel.id && route.destination === icao) ||
        (route.destination === sel.id && route.origin === icao)
      );
    } else if (sel.type === "route") {
      isConnected = isAirportInSelectedRoute(icao);
    }

    const el = marker.getElement();
    if (!el) return;
    const wrap = el.querySelector(".airport-pin-wrap");
    if (!wrap) return;
    wrap.classList.toggle("dimmed", sel.type !== null && !isConnected);
    wrap.classList.toggle("selected",
      (sel.type === "airport" && sel.id === icao) ||
      (sel.type === "route" && isAirportInSelectedRoute(icao))
    );
  });
}

function clearSelection() {
  state.selection = { type: null, id: null };
  document.getElementById("inspector-panel").classList.remove("open");
  applySelectionStyling();
  updateLabelDensity();
}

function selectAirport(icao, panTo = false) {
  const ap = networkData.airports.find(a => a.icao === icao);
  if (!ap) return;

  state.selection = { type: "airport", id: icao };
  applySelectionStyling();
  updateLabelDensity();

  if (panTo) {
    map.flyTo([ap.lat, ap.lng], Math.max(map.getZoom(), 5), { duration: 0.65 });
  }

  const apMap = getAirportMap();
  const connectedRoutes = networkData.routes.filter(r => r.origin === icao || r.destination === icao);
  const aircraftSet = new Set(connectedRoutes.map(r => r.aircraft));
  const destSet = new Set(connectedRoutes.map(r => (r.origin === icao ? r.destination : r.origin)));

  const hero = document.getElementById("inspector-hero");
  hero.className = "inspector-hero" + (ap.isHub ? " hub-hero" : "");
  document.getElementById("inspector-kicker").innerHTML =
    `<span>ICAO STATION</span>${ap.isHub ? '<span class="hub-badge">PRIMARY HUB</span>' : ""}`;
  document.getElementById("inspector-code").textContent = ap.icao;
  document.getElementById("inspector-title").textContent = ap.name;
  document.getElementById("inspector-sub").textContent = `${ap.city}, ${ap.country} • ${ap.continent}`;

  document.getElementById("inspector-body").innerHTML = `
    <div class="meta-grid">
      <div><div class="meta-cell-lbl">Destinations</div><div class="meta-cell-val">${destSet.size} Stations</div></div>
      <div><div class="meta-cell-lbl">Total Routes</div><div class="meta-cell-val">${connectedRoutes.length} Sectors</div></div>
      <div><div class="meta-cell-lbl">Coordinates</div><div class="meta-cell-val">${ap.lat.toFixed(2)}°, ${ap.lng.toFixed(2)}°</div></div>
      <div><div class="meta-cell-lbl">Operating Fleet</div><div class="meta-cell-val">${aircraftSet.size} Types</div></div>
    </div>

    <div style="display:flex;gap:6px;">
      <button class="btn btn-sm" style="flex:1;justify-content:center;" onclick="requireUnlocked(() => openEditorForAirport('${ap.icao}'))">Edit Airport</button>
      <button class="btn btn-sm btn-primary" style="flex:1;justify-content:center;" onclick="requireUnlocked(() => openNewRouteFrom('${ap.icao}'))">+ Add Route</button>
    </div>

    <div class="section-subhead">Connected Destinations (${connectedRoutes.length})</div>
    <div class="connected-list">
      ${connectedRoutes.map(r => {
        const otherIcao = r.origin === icao ? r.destination : r.origin;
        const other = apMap.get(otherIcao);
        if (!other) return "";
        const dist = haversineDistanceKm(ap.lat, ap.lng, other.lat, other.lng);
        return `
          <div class="connected-item" onclick="selectAirport('${other.icao}', true)">
            <div class="ci-main">
              <span class="ci-city">${escapeHtml(other.city)} <span class="mono" style="color:var(--deat-red);">(${other.icao})</span></span>
              <span class="ci-meta">${escapeHtml(other.country)} • ${dist.toLocaleString()} km</span>
            </div>
            <div class="ci-right">
              <span class="ci-aircraft">${escapeHtml(r.aircraft)}</span>
              <span style="font-size:9.5px;color:var(--deat-muted);">${escapeHtml(r.category)}</span>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;

  document.getElementById("inspector-panel").classList.add("open");
}

function selectRoute(routeId) {
  const route = networkData.routes.find(r => r.id === routeId);
  if (!route) return;

  state.selection = { type: "route", id: routeId };
  applySelectionStyling();
  updateLabelDensity();

  const apMap = getAirportMap();
  const orig = apMap.get(route.origin);
  const dest = apMap.get(route.destination);
  if (!orig || !dest) return;

  const distKm = haversineDistanceKm(orig.lat, orig.lng, dest.lat, dest.lng);
  const distNm = Math.round(distKm * 0.539957);
  const estHours = (distKm / 840 + 0.4).toFixed(1);

  const hero = document.getElementById("inspector-hero");
  hero.className = "inspector-hero hub-hero";
  document.getElementById("inspector-kicker").innerHTML =
    `<span>FLIGHT CORRIDOR</span><span class="hub-badge">${escapeHtml(route.status || "Active")}</span>`;
  document.getElementById("inspector-code").textContent = `${orig.icao} — ${dest.icao}`;
  document.getElementById("inspector-title").textContent = `${orig.city} to ${dest.city}`;
  document.getElementById("inspector-sub").textContent = `${route.category} • ${route.aircraft}`;

  document.getElementById("inspector-body").innerHTML = `
    <div class="meta-grid">
      <div><div class="meta-cell-lbl">Great Circle Dist.</div><div class="meta-cell-val">${distKm.toLocaleString()} km (${distNm.toLocaleString()} NM)</div></div>
      <div><div class="meta-cell-lbl">Est. Block Time</div><div class="meta-cell-val">~${estHours} hrs</div></div>
      <div><div class="meta-cell-lbl">Assigned Fleet</div><div class="meta-cell-val">${escapeHtml(route.aircraft)}</div></div>
      <div><div class="meta-cell-lbl">Route Color</div><div class="meta-cell-val" style="display:flex;align-items:center;gap:6px;"><span style="width:11px;height:11px;background:${route.color};display:inline-block;border:1px solid #ccc;"></span>${escapeHtml(route.color)}</div></div>
    </div>

    ${route.notes ? `<div style="background:#FFF8F8;border-left:3px solid var(--deat-red);padding:8px 10px;font-size:11.5px;"><strong>Notes:</strong> ${escapeHtml(route.notes)}</div>` : ""}

    <div class="section-subhead">Endpoints</div>
    <div class="connected-list">
      <div class="connected-item" onclick="selectAirport('${orig.icao}', true)">
        <div class="ci-main"><span class="ci-city"><span class="mono" style="color:var(--deat-red);">${orig.icao}</span> — ${escapeHtml(orig.city)}</span><span class="ci-meta">${escapeHtml(orig.name)}</span></div>
        <span style="font-size:10px;color:var(--deat-muted);">Origin &rarr;</span>
      </div>
      <div class="connected-item" onclick="selectAirport('${dest.icao}', true)">
        <div class="ci-main"><span class="ci-city"><span class="mono" style="color:var(--deat-red);">${dest.icao}</span> — ${escapeHtml(dest.city)}</span><span class="ci-meta">${escapeHtml(dest.name)}</span></div>
        <span style="font-size:10px;color:var(--deat-muted);">Dest. &rarr;</span>
      </div>
    </div>

    <div style="display:flex;gap:6px;margin-top:4px;">
      <button class="btn btn-sm btn-primary" style="flex:1;justify-content:center;" onclick="requireUnlocked(() => openEditorForRoute('${route.id}'))">Edit Route</button>
      <button class="btn btn-sm" onclick="requireUnlocked(() => toggleRouteVisibility('${route.id}'))">Hide Route</button>
    </div>
  `;

  document.getElementById("inspector-panel").classList.add("open");
}

/* ==========================================================================
   7. STATS, LEGEND & FILTER CONTROLS
   ========================================================================== */
function updateStats(filteredRoutes, visibleAirports) {
  document.getElementById("stat-routes").textContent = filteredRoutes.length;
  document.getElementById("stat-airports").textContent = visibleAirports.length;
  document.getElementById("stat-countries").textContent = new Set(visibleAirports.map(a => a.country)).size;
  document.getElementById("stat-continents").textContent = new Set(visibleAirports.map(a => a.continent)).size;
  document.getElementById("stat-fleet").textContent = new Set(filteredRoutes.map(r => r.aircraft)).size;

  const counts = {};
  filteredRoutes.forEach(r => {
    counts[r.origin] = (counts[r.origin] || 0) + 1;
    counts[r.destination] = (counts[r.destination] || 0) + 1;
  });
  let topIcao = "—";
  let maxC = 0;
  Object.entries(counts).forEach(([icao, c]) => {
    if (c > maxC) { maxC = c; topIcao = icao; }
  });
  document.getElementById("stat-top-hub").textContent = maxC > 0 ? `${topIcao} (${maxC})` : "—";
}

function updateLegend(filteredRoutes) {
  const titleEl = document.getElementById("legend-mode-title");
  const itemsEl = document.getElementById("legend-items");
  let html = `<div class="legend-item"><span class="legend-hub-dot"></span>Hub Airport</div>`;

  if (state.colorMode === "brand") {
    titleEl.textContent = "LEGEND — DEAT BRAND NETWORK";
    html += `<div class="legend-item"><span class="legend-line" style="background:${networkData.settings.brandColor};"></span>Scheduled Route</div>`;
  } else if (state.colorMode === "aircraft") {
    titleEl.textContent = "LEGEND — BY AIRCRAFT TYPE";
    const activeTypes = new Set(filteredRoutes.map(r => r.aircraft));
    networkData.aircraft.filter(a => activeTypes.has(a.type)).forEach(ac => {
      html += `<div class="legend-item"><span class="legend-line" style="background:${ac.color};"></span>${escapeHtml(ac.type)}</div>`;
    });
  } else if (state.colorMode === "continent") {
    titleEl.textContent = "LEGEND — BY CONTINENT";
    Object.entries(CONTINENT_COLORS).forEach(([cont, col]) => {
      html += `<div class="legend-item"><span class="legend-line" style="background:${col};"></span>${cont}</div>`;
    });
  } else if (state.colorMode === "category") {
    titleEl.textContent = "LEGEND — BY CATEGORY";
    Object.entries(CATEGORY_COLORS).forEach(([cat, col]) => {
      html += `<div class="legend-item"><span class="legend-line" style="background:${col};"></span>${cat}</div>`;
    });
  }

  itemsEl.innerHTML = html;
}

function rebuildFilterUI() {
  const continents = ["Europe", "Asia", "North America", "South America", "Africa", "Oceania"];
  document.getElementById("filter-continents").innerHTML = continents.map(c => `
    <button class="filter-chip ${state.filters.continents.has(c) ? "active" : ""}" data-filter-type="continents" data-val="${c}">${c}</button>
  `).join("");

  document.getElementById("filter-aircraft").innerHTML = networkData.aircraft.map(ac => `
    <button class="filter-chip ${state.filters.aircraft.has(ac.type) ? "active" : ""}" data-filter-type="aircraft" data-val="${escapeHtml(ac.type)}">
      <span class="chip-swatch" style="background:${ac.color};"></span>${escapeHtml(ac.type)}
    </button>
  `).join("");

  const categories = ["Long-Haul", "Medium-Haul", "Regional", "Seasonal", "Cargo"];
  document.getElementById("filter-categories").innerHTML = categories.map(cat => `
    <button class="filter-chip ${state.filters.categories.has(cat) ? "active" : ""}" data-filter-type="categories" data-val="${cat}">${cat}</button>
  `).join("");

  const countries = Array.from(new Set(networkData.airports.map(a => a.country))).sort();
  document.getElementById("filter-country").innerHTML =
    `<option value="">All Countries (${countries.length})</option>` +
    countries.map(c => `<option value="${escapeHtml(c)}" ${state.filters.country === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");

  const hubs = networkData.airports.filter(a => a.isHub);
  document.getElementById("filter-hub").innerHTML =
    `<option value="">All Hubs &amp; Stations</option>` +
    hubs.map(h => `<option value="${h.icao}" ${state.filters.hub === h.icao ? "selected" : ""}>${h.icao} — ${escapeHtml(h.city)}</option>`).join("");

  document.querySelectorAll(".filter-chip").forEach(btn => {
    btn.onclick = () => {
      const type = btn.dataset.filterType;
      const val = btn.dataset.val;
      if (state.filters[type].has(val)) {
        state.filters[type].delete(val);
        btn.classList.remove("active");
      } else {
        state.filters[type].add(val);
        btn.classList.add("active");
      }
      renderNetwork();
    };
  });
}

/* ==========================================================================
   8. SEARCH BAR
   ========================================================================== */
function initSearch() {
  const input = document.getElementById("airport-search");
  const box = document.getElementById("search-results");

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      box.classList.remove("open");
      return;
    }
    const matches = networkData.airports.filter(ap =>
      ap.icao.toLowerCase().includes(q) ||
      ap.city.toLowerCase().includes(q) ||
      ap.name.toLowerCase().includes(q) ||
      ap.country.toLowerCase().includes(q)
    ).slice(0, 10);

    box.innerHTML = matches.length === 0
      ? `<div style="padding:10px;font-size:11px;color:var(--deat-muted);">No airports matching "${escapeHtml(q)}"</div>`
      : matches.map(ap => `
          <div class="search-result-item" data-icao="${ap.icao}">
            <div class="sr-left">
              <span class="sr-city">${escapeHtml(ap.city)}, ${escapeHtml(ap.country)}</span>
              <span class="sr-name">${escapeHtml(ap.name)}</span>
            </div>
            <span class="sr-icao">${ap.icao}</span>
          </div>
        `).join("");

    box.classList.add("open");
    box.querySelectorAll(".search-result-item").forEach(item => {
      item.onclick = () => {
        box.classList.remove("open");
        input.value = "";
        selectAirport(item.dataset.icao, true);
      };
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-container")) box.classList.remove("open");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      e.preventDefault();
      input.focus();
    } else if (e.key === "Escape") {
      box.classList.remove("open");
      closePasswordModal();
      document.getElementById("editor-modal").classList.remove("open");
      clearSelection();
    }
  });
}

/* ==========================================================================
   9. PROTECTED EDITOR & CRUD OPERATIONS
   ========================================================================== */
function openEditor(tabName = "routes") {
  if (!isEditorUnlocked()) {
    requireUnlocked(() => openEditor(tabName));
    return;
  }
  document.getElementById("editor-modal").classList.add("open");
  switchEditorTab(tabName);
  populateEditorDropdowns();
  renderEditorTables();
}

function switchEditorTab(tabName) {
  document.querySelectorAll(".editor-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
  document.querySelectorAll(".editor-pane").forEach(p => p.classList.toggle("active", p.id === `pane-${tabName}`));
}

function populateEditorDropdowns() {
  const sorted = [...networkData.airports].sort((a, b) => a.icao.localeCompare(b.icao));
  const opts = sorted.map(ap => `<option value="${ap.icao}">${ap.icao} — ${escapeHtml(ap.city)} (${escapeHtml(ap.country)})</option>`).join("");
  document.getElementById("route-origin").innerHTML = opts;
  document.getElementById("route-dest").innerHTML = opts;
  if (sorted.length > 1) document.getElementById("route-dest").selectedIndex = 1;

  document.getElementById("route-aircraft").innerHTML = networkData.aircraft.map(ac =>
    `<option value="${escapeHtml(ac.type)}">${escapeHtml(ac.type)}</option>`
  ).join("");
}

function renderEditorTables() {
  document.getElementById("tab-count-routes").textContent = networkData.routes.length;
  document.getElementById("tab-count-airports").textContent = networkData.airports.length;
  document.getElementById("tab-count-aircraft").textContent = networkData.aircraft.length;

  const apMap = getAirportMap();
  const rFilter = document.getElementById("editor-route-filter").value.trim().toLowerCase();

  document.getElementById("table-routes-body").innerHTML = networkData.routes
    .filter(r => {
      if (!rFilter) return true;
      const o = apMap.get(r.origin);
      const d = apMap.get(r.destination);
      return r.origin.toLowerCase().includes(rFilter) ||
        r.destination.toLowerCase().includes(rFilter) ||
        r.aircraft.toLowerCase().includes(rFilter) ||
        (o && o.city.toLowerCase().includes(rFilter)) ||
        (d && d.city.toLowerCase().includes(rFilter));
    })
    .map(r => {
      const o = apMap.get(r.origin);
      const d = apMap.get(r.destination);
      const dist = (o && d) ? haversineDistanceKm(o.lat, o.lng, d.lat, d.lng).toLocaleString() + " km" : "—";
      return `
        <tr>
          <td><strong class="mono">${r.origin} &rarr; ${r.destination}</strong><br><span style="font-size:10px;color:var(--deat-muted);">${o ? escapeHtml(o.city) : ""} to ${d ? escapeHtml(d.city) : ""}</span></td>
          <td class="mono">${escapeHtml(r.aircraft)}</td>
          <td>${escapeHtml(r.category)}</td>
          <td class="mono">${dist}</td>
          <td><span style="display:inline-block;width:14px;height:14px;background:${r.color};border:1px solid #ccc;"></span></td>
          <td><input type="checkbox" ${r.visible ? "checked" : ""} onchange="requireUnlocked(() => toggleRouteVisibility('${r.id}'))" /></td>
          <td style="white-space:nowrap;">
            <button class="btn btn-sm" onclick="requireUnlocked(() => editRouteInForm('${r.id}'))">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="requireUnlocked(() => deleteRoute('${r.id}'))">Del</button>
          </td>
        </tr>
      `;
    }).join("");

  const aFilter = document.getElementById("editor-airport-filter").value.trim().toLowerCase();
  document.getElementById("table-airports-body").innerHTML = networkData.airports
    .filter(ap => !aFilter ||
      ap.icao.toLowerCase().includes(aFilter) ||
      ap.city.toLowerCase().includes(aFilter) ||
      ap.name.toLowerCase().includes(aFilter) ||
      ap.country.toLowerCase().includes(aFilter))
    .map(ap => `
      <tr>
        <td class="mono"><strong>${ap.icao}</strong></td>
        <td><strong>${escapeHtml(ap.city)}</strong><br><span style="font-size:10px;color:var(--deat-muted);">${escapeHtml(ap.name)}</span></td>
        <td>${escapeHtml(ap.country)}<br><span style="font-size:10px;color:var(--deat-muted);">${escapeHtml(ap.continent)}</span></td>
        <td class="mono" style="font-size:10.5px;">${ap.lat.toFixed(3)}, ${ap.lng.toFixed(3)}</td>
        <td>${ap.isHub ? '<span class="hub-badge">HUB</span>' : "Station"}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" onclick="requireUnlocked(() => editAirportInForm('${ap.icao}'))">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="requireUnlocked(() => deleteAirport('${ap.icao}'))">Del</button>
        </td>
      </tr>
    `).join("");

  document.getElementById("table-aircraft-body").innerHTML = networkData.aircraft.map(ac => {
    const used = networkData.routes.filter(r => r.aircraft === ac.type).length;
    return `
      <tr>
        <td class="mono"><strong>${escapeHtml(ac.type)}</strong></td>
        <td>${escapeHtml(ac.family || "—")}</td>
        <td class="mono">${ac.rangeKm ? ac.rangeKm.toLocaleString() + " km" : "—"}</td>
        <td><input type="color" value="${ac.color}" onchange="requireUnlocked(() => updateAircraftColor('${escapeHtml(ac.type)}', this.value))" style="width:36px;height:22px;border:1px solid #ccc;padding:1px;" /></td>
        <td class="mono">${used}</td>
        <td><button class="btn btn-sm btn-danger" onclick="requireUnlocked(() => deleteAircraft('${escapeHtml(ac.type)}'))">Remove</button></td>
      </tr>
    `;
  }).join("");
}

window.editRouteInForm = function (id) {
  const r = networkData.routes.find(x => x.id === id);
  if (!r) return;
  document.getElementById("form-route-title").textContent = `Edit Route (${r.origin} → ${r.destination})`;
  document.getElementById("edit-route-id").value = r.id;
  document.getElementById("route-origin").value = r.origin;
  document.getElementById("route-dest").value = r.destination;
  document.getElementById("route-aircraft").value = r.aircraft;
  document.getElementById("route-category").value = r.category;
  document.getElementById("route-color").value = r.color;
  document.getElementById("route-status").value = r.status || "Active";
  document.getElementById("route-weight").value = r.weight || 2.2;
  document.getElementById("route-opacity").value = r.opacity || 0.92;
  document.getElementById("route-notes").value = r.notes || "";
  document.getElementById("route-visible").checked = r.visible !== false;
  document.getElementById("btn-cancel-route-edit").style.display = "inline-flex";
};

window.openEditorForRoute = function (id) {
  openEditor("routes");
  editRouteInForm(id);
};

window.openNewRouteFrom = function (originIcao) {
  openEditor("routes");
  resetRouteForm();
  document.getElementById("route-origin").value = originIcao;
};

function resetRouteForm() {
  document.getElementById("form-route").reset();
  document.getElementById("edit-route-id").value = "";
  document.getElementById("route-color").value = networkData.settings.brandColor || "#EE1C25";
  document.getElementById("form-route-title").textContent = "Add New Flight Route";
  document.getElementById("btn-cancel-route-edit").style.display = "none";
}

window.toggleRouteVisibility = function (id) {
  const r = networkData.routes.find(x => x.id === id);
  if (!r) return;
  r.visible = !r.visible;
  saveNetworkData();
  renderNetwork();
  if (document.getElementById("editor-modal").classList.contains("open")) renderEditorTables();
  showToast(r.visible ? "Route shown." : "Route hidden.");
};

window.deleteRoute = function (id) {
  if (!confirm("Delete this route?")) return;
  networkData.routes = networkData.routes.filter(r => r.id !== id);
  if (state.selection.type === "route" && state.selection.id === id) clearSelection();
  saveNetworkData();
  renderEditorTables();
  renderNetwork();
  showToast("Route deleted.");
};

window.editAirportInForm = function (icao) {
  const ap = networkData.airports.find(a => a.icao === icao);
  if (!ap) return;
  document.getElementById("form-airport-title").textContent = `Edit Airport (${ap.icao})`;
  document.getElementById("edit-airport-original-icao").value = ap.icao;
  document.getElementById("ap-icao").value = ap.icao;
  document.getElementById("ap-name").value = ap.name;
  document.getElementById("ap-city").value = ap.city;
  document.getElementById("ap-country").value = ap.country;
  document.getElementById("ap-continent").value = ap.continent;
  document.getElementById("ap-lat").value = ap.lat;
  document.getElementById("ap-lng").value = ap.lng;
  document.getElementById("ap-hub").checked = !!ap.isHub;
  document.getElementById("btn-cancel-ap-edit").style.display = "inline-flex";
};

window.openEditorForAirport = function (icao) {
  openEditor("airports");
  editAirportInForm(icao);
};

function resetAirportForm() {
  document.getElementById("form-airport").reset();
  document.getElementById("edit-airport-original-icao").value = "";
  document.getElementById("form-airport-title").textContent = "Add / Edit Airport";
  document.getElementById("btn-cancel-ap-edit").style.display = "none";
}

window.deleteAirport = function (icao) {
  const used = networkData.routes.filter(r => r.origin === icao || r.destination === icao).length;
  if (used > 0) {
    alert(`Cannot delete ${icao}: used by ${used} route(s).`);
    return;
  }
  if (!confirm(`Delete airport ${icao}?`)) return;
  networkData.airports = networkData.airports.filter(a => a.icao !== icao);
  if (state.selection.type === "airport" && state.selection.id === icao) clearSelection();
  saveNetworkData();
  populateEditorDropdowns();
  rebuildFilterUI();
  renderEditorTables();
  renderNetwork();
  showToast(`Airport ${icao} removed.`);
};

window.updateAircraftColor = function (type, color) {
  const ac = networkData.aircraft.find(a => a.type === type);
  if (ac) {
    ac.color = color;
    saveNetworkData();
    rebuildFilterUI();
    renderNetwork();
  }
};

window.deleteAircraft = function (type) {
  const used = networkData.routes.filter(r => r.aircraft === type).length;
  if (used > 0) {
    alert(`Cannot remove ${type}: assigned to ${used} route(s).`);
    return;
  }
  networkData.aircraft = networkData.aircraft.filter(a => a.type !== type);
  saveNetworkData();
  populateEditorDropdowns();
  rebuildFilterUI();
  renderEditorTables();
  renderNetwork();
  showToast(`Aircraft ${type} removed.`);
};

/* ==========================================================================
   10. BRANDING & PNG EXPORT
   ========================================================================== */
function applyBrandTheme() {
  const { airlineName, networkSubtitle, brandColor } = networkData.settings;
  document.documentElement.style.setProperty("--deat-red", brandColor);
  document.querySelectorAll(".brand-wordmark, #footer-airline-name").forEach(el => {
    el.textContent = airlineName;
  });
  document.getElementById("header-network-subtitle").textContent = networkSubtitle;
  document.getElementById("footer-network-subtitle").textContent = networkSubtitle;
  document.getElementById("setting-airline-name").value = airlineName;
  document.getElementById("setting-network-subtitle").value = networkSubtitle;
  document.getElementById("setting-brand-color").value = brandColor;
}

function exportMapSnapshotPNG() {
  showToast("Exporting route map snapshot...");
  const mapEl = document.getElementById("map");
  const w = mapEl.clientWidth * 2;
  const h = mapEl.clientHeight * 2 + 80;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);

  const svgEl = mapEl.querySelector("svg");
  if (!svgEl) return;

  const cloned = svgEl.cloneNode(true);
  cloned.setAttribute("width", mapEl.clientWidth);
  cloned.setAttribute("height", mapEl.clientHeight);
  const blob = new Blob([new XMLSerializer().serializeToString(cloned)], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, w, mapEl.clientHeight * 2);
    URL.revokeObjectURL(url);

    markerLayersByIcao.forEach(({ airport, marker }) => {
      const pt = map.latLngToContainerPoint(marker.getLatLng());
      if (pt.x < -30 || pt.x > mapEl.clientWidth + 30 || pt.y < -30 || pt.y > mapEl.clientHeight + 30) return;
      const cx = pt.x * 2;
      const cy = pt.y * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, airport.isHub ? 10 : 7.5, 0, Math.PI * 2);
      ctx.fillStyle = "#FFFFFF";
      ctx.fill();
      ctx.lineWidth = airport.isHub ? 5.5 : 4;
      ctx.strokeStyle = networkData.settings.brandColor;
      ctx.stroke();

      ctx.font = "italic bold 19px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = networkData.settings.brandColor;
      ctx.fillText(`${airport.city.toLowerCase()} (${airport.icao})`, cx, cy + 30);
    });

    const fy = mapEl.clientHeight * 2;
    ctx.fillStyle = networkData.settings.brandColor;
    ctx.fillRect(0, fy, w, 80);
    ctx.font = "italic 800 40px Inter, sans-serif";
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "left";
    ctx.fillText(`${networkData.settings.airlineName} — ${networkData.settings.networkSubtitle}`, 32, fy + 52);

    const a = document.createElement("a");
    a.download = `${networkData.settings.airlineName}_Network_Map.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
    showToast("PNG map exported.");
  };
  img.src = url;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ==========================================================================
   11. EVENT BINDINGS
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    networkData = await loadInitialData();
  } catch (err) {
    console.error("Failed to load network data:", err);
    showToast("Error loading ./data/network.json — check server/paths.");
    return;
  }

  await initMap();
  initSearch();

  // Password modal submit
  document.getElementById("form-password-unlock").onsubmit = async (e) => {
    e.preventDefault();
    const inputPass = document.getElementById("auth-password-input").value;
    const salt = (networkData.security && networkData.security.salt) || "deat_vienna_salt_2026";
    const expectedHash = (networkData.security && networkData.security.passwordHash) || "";
    const actualHash = await hashPassword(inputPass, salt);

    if (actualHash === expectedHash) {
      setEditorUnlocked(true);
      const nextAction = pendingProtectedAction;
      closePasswordModal();
      showToast("Editing mode unlocked for this session.");
      if (typeof nextAction === "function") {
        nextAction();
      }
    } else {
      const errEl = document.getElementById("auth-error");
      errEl.textContent = "Incorrect password. Access to editing controls denied.";
      errEl.classList.add("show");
    }
  };

  document.getElementById("btn-close-auth").onclick = closePasswordModal;
  document.getElementById("btn-cancel-auth").onclick = closePasswordModal;

  // Lock editor session button inside editor
  document.getElementById("btn-lock-session").onclick = () => {
    setEditorUnlocked(false);
    document.getElementById("editor-modal").classList.remove("open");
    showToast("Editing mode locked.");
  };

  // Change password form
  document.getElementById("btn-change-password").onclick = async () => {
    if (!isEditorUnlocked()) return;
    const newPass = document.getElementById("new-editor-password").value;
    if (!newPass || newPass.length < 8) {
      alert("Please enter a new password of at least 8 characters.");
      return;
    }
    const newSalt = "deat_salt_" + Date.now();
    networkData.security = {
      salt: newSalt,
      passwordHash: await hashPassword(newPass, newSalt),
      hint: "Custom password configured"
    };
    document.getElementById("new-editor-password").value = "";
    saveNetworkData();
    showToast("Editor password updated.");
  };

  // Header & filter controls
  document.getElementById("btn-toggle-filters").onclick = function () {
    this.classList.toggle("active");
    document.getElementById("filter-panel").classList.toggle("collapsed");
  };

  document.getElementById("btn-reset-view").onclick = () => {
    clearSelection();
    map.flyTo([26, 48], 3, { duration: 0.65 });
  };

  document.getElementById("btn-export-png").onclick = exportMapSnapshotPNG;
  document.getElementById("btn-close-inspector").onclick = clearSelection;

  document.getElementById("select-color-mode").onchange = (e) => {
    state.colorMode = e.target.value;
    renderNetwork();
  };

  document.getElementById("filter-country").onchange = (e) => {
    state.filters.country = e.target.value;
    renderNetwork();
  };

  document.getElementById("filter-hub").onchange = (e) => {
    state.filters.hub = e.target.value;
    renderNetwork();
  };

  document.getElementById("toggle-icao-labels").onchange = (e) => {
    state.display.showIcao = e.target.checked;
    renderNetwork();
  };

  document.getElementById("toggle-city-labels").onchange = (e) => {
    state.display.showCity = e.target.checked;
    renderNetwork();
  };

  document.getElementById("toggle-arrows").onchange = (e) => {
    state.display.showArrows = e.target.checked;
    renderNetwork();
  };

  document.getElementById("toggle-hubs-only").onchange = (e) => {
    state.filters.hubsOnly = e.target.checked;
    renderNetwork();
  };

  document.querySelectorAll("[data-clear]").forEach(btn => {
    btn.onclick = () => {
      state.filters[btn.dataset.clear].clear();
      rebuildFilterUI();
      renderNetwork();
    };
  });

  document.getElementById("btn-clear-all-filters").onclick = () => {
    state.filters.continents.clear();
    state.filters.aircraft.clear();
    state.filters.categories.clear();
    state.filters.country = "";
    state.filters.hub = "";
    state.filters.hubsOnly = false;
    document.getElementById("toggle-hubs-only").checked = false;
    rebuildFilterUI();
    renderNetwork();
    showToast("Filters reset.");
  };

  // Editor modal controls
  document.getElementById("btn-open-editor").onclick = () => openEditor("routes");
  document.getElementById("btn-close-editor").onclick = () => {
    document.getElementById("editor-modal").classList.remove("open");
  };

  document.querySelectorAll(".editor-tab").forEach(tab => {
    tab.onclick = () => switchEditorTab(tab.dataset.tab);
  });

  document.getElementById("editor-route-filter").oninput = renderEditorTables;
  document.getElementById("editor-airport-filter").oninput = renderEditorTables;
  document.getElementById("btn-cancel-route-edit").onclick = resetRouteForm;
  document.getElementById("btn-cancel-ap-edit").onclick = resetAirportForm;

  document.getElementById("form-route").onsubmit = (e) => {
    e.preventDefault();
    if (!isEditorUnlocked()) return openPasswordModal();
    const origin = document.getElementById("route-origin").value;
    const destination = document.getElementById("route-dest").value;
    if (origin === destination) {
      alert("Origin and destination must differ.");
      return;
    }
    const editId = document.getElementById("edit-route-id").value;
    const item = {
      id: editId || "r-" + Date.now(),
      origin,
      destination,
      aircraft: document.getElementById("route-aircraft").value,
      category: document.getElementById("route-category").value,
      color: document.getElementById("route-color").value,
      status: document.getElementById("route-status").value,
      weight: parseFloat(document.getElementById("route-weight").value) || 2.2,
      opacity: parseFloat(document.getElementById("route-opacity").value) || 0.92,
      notes: document.getElementById("route-notes").value.trim(),
      visible: document.getElementById("route-visible").checked
    };

    if (editId) {
      const idx = networkData.routes.findIndex(r => r.id === editId);
      if (idx !== -1) networkData.routes[idx] = item;
      showToast("Route updated.");
    } else {
      networkData.routes.unshift(item);
      showToast("Route added.");
    }
    saveNetworkData();
    resetRouteForm();
    renderEditorTables();
    renderNetwork();
  };

  document.getElementById("form-airport").onsubmit = (e) => {
    e.preventDefault();
    if (!isEditorUnlocked()) return openPasswordModal();
    const origIcao = document.getElementById("edit-airport-original-icao").value;
    const newIcao = document.getElementById("ap-icao").value.trim().toUpperCase();
    if (newIcao.length < 3 || newIcao.length > 4) {
      alert("ICAO code must be 3–4 letters.");
      return;
    }
    const item = {
      icao: newIcao,
      name: document.getElementById("ap-name").value.trim(),
      city: document.getElementById("ap-city").value.trim(),
      country: document.getElementById("ap-country").value.trim(),
      continent: document.getElementById("ap-continent").value,
      lat: parseFloat(document.getElementById("ap-lat").value),
      lng: parseFloat(document.getElementById("ap-lng").value),
      isHub: document.getElementById("ap-hub").checked
    };
    if (origIcao) {
      const idx = networkData.airports.findIndex(a => a.icao === origIcao);
      if (idx !== -1) networkData.airports[idx] = item;
      if (origIcao !== newIcao) {
        networkData.routes.forEach(r => {
          if (r.origin === origIcao) r.origin = newIcao;
          if (r.destination === origIcao) r.destination = newIcao;
        });
      }
      showToast(`Airport ${newIcao} updated.`);
    } else {
      if (networkData.airports.some(a => a.icao === newIcao)) {
        alert(`Airport ${newIcao} already exists.`);
        return;
      }
      networkData.airports.push(item);
      showToast(`Airport ${newIcao} added.`);
    }
    saveNetworkData();
    resetAirportForm();
    populateEditorDropdowns();
    rebuildFilterUI();
    renderEditorTables();
    renderNetwork();
  };

  document.getElementById("form-aircraft").onsubmit = (e) => {
    e.preventDefault();
    if (!isEditorUnlocked()) return openPasswordModal();
    const type = document.getElementById("ac-type").value.trim();
    if (!type) return;
    if (networkData.aircraft.some(a => a.type.toLowerCase() === type.toLowerCase())) {
      alert("Aircraft type already exists.");
      return;
    }
    networkData.aircraft.push({
      type,
      family: document.getElementById("ac-family").value.trim(),
      rangeKm: parseInt(document.getElementById("ac-range").value, 10) || null,
      color: document.getElementById("ac-color").value
    });
    document.getElementById("form-aircraft").reset();
    saveNetworkData();
    populateEditorDropdowns();
    rebuildFilterUI();
    renderEditorTables();
    showToast(`Aircraft ${type} added.`);
  };

  document.getElementById("btn-save-settings").onclick = () => {
    if (!isEditorUnlocked()) return openPasswordModal();
    networkData.settings.airlineName = document.getElementById("setting-airline-name").value.trim() || "DEAT";
    networkData.settings.networkSubtitle = document.getElementById("setting-network-subtitle").value.trim() || "global passenger network";
    networkData.settings.brandColor = document.getElementById("setting-brand-color").value;
    saveNetworkData();
    applyBrandTheme();
    renderNetwork();
    showToast("Branding updated.");
  };

  // JSON Export (allowed for backup)
  document.getElementById("btn-export-json").onclick = () => {
    const blob = new Blob([JSON.stringify(networkData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${networkData.settings.airlineName}_Network_Backup.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("JSON backup downloaded.");
  };

  // JSON Import (protected)
  document.getElementById("input-import-json").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    requireUnlocked(() => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = JSON.parse(ev.target.result);
          if (!Array.isArray(parsed.airports) || !Array.isArray(parsed.routes)) {
            throw new Error("Missing airports or routes array.");
          }
          networkData = parsed;
          saveNetworkData();
          applyBrandTheme();
          populateEditorDropdowns();
          rebuildFilterUI();
          renderEditorTables();
          renderNetwork();
          showToast("Network JSON imported.");
        } catch (err) {
          alert("Invalid JSON file: " + err.message);
        }
      };
      reader.readAsText(file);
    });
    e.target.value = "";
  };

  // Reset to ./data/network.json factory dataset (protected)
  document.getElementById("btn-reset-sample").onclick = () => {
    requireUnlocked(async () => {
      if (!confirm("Reset local edits and reload factory ./data/network.json?")) return;
      localStorage.removeItem(STORAGE_KEY);
      networkData = await loadInitialData();
      saveNetworkData();
      applyBrandTheme();
      populateEditorDropdowns();
      rebuildFilterUI();
      renderEditorTables();
      clearSelection();
      renderNetwork();
      showToast("Factory network restored.");
    });
  };
});
