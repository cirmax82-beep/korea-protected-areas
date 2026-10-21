// 보호구역 종합포털 — 지도, 구역 목록, 구역 상세, 내려받기
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n, d = 0) => Number(n || 0).toLocaleString("ko-KR", { maximumFractionDigits: d });
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const RELEASE = "https://github.com/cirmax82-beep/korea-protected-areas/releases/download/data-latest/";
  const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  const DEFAULT_ON = ["wildlife", "wetland", "wetland-coast", "park-national", "park-province", "park-county", "baekdu"];
  // 모든 레이어를 캔버스 하나에 그림(묶음마다 캔버스를 따로 두면 맨 위 캔버스가 마우스를 가로채 아래 구역이 안 눌림).
  // 겹칠 때 위에 올 순서: 넓게 퍼진 구역은 아래, 작은 구역은 위
  const STACK = ["coast-conserve", "greenbelt", "natenv", "forest", "baekdu", "park-national", "park-province", "park-county",
    "urbanpark", "water", "heritage", "protect-district", "air", "temple", "wetland-coast", "wetland", "wildlife"];
  const FIELDS = [["구역id", "AREA_ID"], ["이름", "NAME"], ["종류", "TYPE"], ["세부구분", "SUBTYPE"], ["시도", "SIDO"], ["시군구", "SIGUNGU"],
    ["고시", "NOTICE"], ["비고", "REMARK"], ["면적_ha", "AREA_HA"], ["근거법령", "LAW"], ["출처", "SOURCE"]];

  const S = { groups: {}, layers: [], areas: [], byId: new Map(), on: new Set(DEFAULT_ON), geo: {}, featLayer: new Map(), sido: "", at: null };
  let map, areaMap, renderer;

  const toast = (msg, ms = 2600) => {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, ms);
  };
  const saveBlob = (blob, name) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };
  const haText = (ha) => (ha >= 100 ? `${fmt(ha / 100, 2)} ㎢` : `${fmt(ha, 2)} ha`);
  const layerOf = (a) => S.layers[a.li];
  const typeBadge = (l) => `<span class="badge"><i style="background:${l.color}"></i>${esc(l.name)}</span>`;

  // ---------- 자료 ----------
  const loadIndex = async () => {
    const res = await fetch("data/index.json", { cache: "no-cache" });
    const d = await res.json();
    S.groups = d.groups;
    S.at = d.generatedAt;
    S.layers = d.layers.map((l, i) => ({ ...l, i }));
    const layerIdx = new Map(S.layers.map((l) => [l.id, l.i]));
    // 구역 행: [id, layer, name, sub, sido, sigg, notice, area_ha, bbox, remark]
    // 구역 id는 '<레이어 id>-<해시>' 꼴이라 레이어는 id에서 찾음(빠진 레이어가 있어도 번호가 어긋나지 않게)
    S.areas = d.areas.map((r, idx) => ({
      idx, id: r[0], li: layerIdx.get(r[0].slice(0, r[0].lastIndexOf("-"))), name: r[2], sub: r[3], sido: r[4], sigg: r[5],
      notice: r[6], ha: r[7], bbox: r[8], remark: r[9] || "",
    }));
    S.byId = new Map(S.areas.map((a) => [a.id, a]));
  };

  // ---------- 지도 ----------
  const initMap = () => {
    map = L.map("map", { preferCanvas: true, minZoom: 6, maxZoom: 18, zoomSnap: 0.5, maxBounds: [[30.5, 121], [40.5, 134.5]] }).setView([36.1, 127.8], 7);
    const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
    const base = {
      "밝은 지도": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osmAttr, className: "tiles-muted" }),
      "일반 지도": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osmAttr }),
      "위성 영상": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19, attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics" }),
    };
    base["밝은 지도"].addTo(map);
    L.control.layers(base, null, { position: "topright" }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
    map.attributionControl.addAttribution('경계: <a href="https://www.vworld.kr" target="_blank" rel="noopener">국토교통부 브이월드</a>');
    renderer = L.canvas({ padding: 0.3, tolerance: 2 });
    map.on("moveend", debounce(() => updateDetail(), 250));
  };

  const popupHtml = (a) => {
    const l = layerOf(a);
    return `<div class="pop-title">${esc(a.name)}</div>
      <div class="pop-type"><i style="background:${l.color}"></i>${esc(l.name)}${a.sub && a.sub !== l.name ? ` · ${esc(a.sub)}` : ""}</div>
      <dl class="pop-dl">
        ${a.sido || a.sigg ? `<dt>위치</dt><dd>${esc([a.sido, a.sigg].filter(Boolean).join(" "))}</dd>` : ""}
        ${a.notice ? `<dt>고시</dt><dd>${esc(a.notice)}</dd>` : ""}
        <dt>면적</dt><dd>${haText(a.ha)}</dd>
        ${a.remark ? `<dt>비고</dt><dd>${esc(a.remark)}</dd>` : ""}
      </dl>
      <div class="pop-actions">
        <a class="btn btn-primary btn-sm" href="#area/${encodeURIComponent(a.id)}">상세</a>
        <button class="btn btn-light btn-sm" data-dl="shp" data-id="${esc(a.id)}">SHP</button>
        <button class="btn btn-light btn-sm" data-dl="geojson" data-id="${esc(a.id)}">GeoJSON</button>
        <button class="btn btn-light btn-sm" data-dl="kml" data-id="${esc(a.id)}">KML</button>
      </div>`;
  };

  const visible = (a) => !S.sido || a.sido === S.sido;

  const styleOf = (color) => ({ color, weight: 1, opacity: 0.9, fillColor: color, fillOpacity: 0.3 });
  const HIDDEN = { opacity: 0, fillOpacity: 0 };
  const bindArea = (layer, a) => {
    layer.bindTooltip(esc(a.name), { sticky: true, direction: "top" });
    layer.on("click", (e) => L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent(popupHtml(a)).openOn(map));
  };

  const buildLayer = (l) => L.geoJSON(S.geo[l.id], {
    renderer,
    filter: (f) => visible(S.areas[f.properties.i]),
    style: () => styleOf(l.color),
    onEachFeature: (f, layer) => {
      const a = S.areas[f.properties.i];
      S.featLayer.set(a.id, layer);
      bindArea(layer, a);
    },
  });

  // ---------- 확대하면 원본 해상도 경계로 ----------
  // 멀리서 볼 때는 가볍게 줄인 경계(data/map)를 쓰고, DETAIL_ZOOM 이상에서는 화면에 보이는 구역만
  // 원본 경계(data/area — 내려받는 파일과 같은 것)를 불러와 그 위에 그리고, 줄인 경계는 숨김
  const DETAIL_ZOOM = 14;
  const DETAIL_MAX = 400;          // 한 화면에서 원본으로 바꿀 최대 구역 수
  const detailCache = new Map();   // 구역 id → GeoJSON(받은 것)
  const detailShown = new Map();   // 구역 id → 지도에 올린 원본 레이어
  let detailSeq = 0;

  const hideSimple = (id, hide) => {
    const fl = S.featLayer.get(id);
    if (!fl) return;
    const a = S.byId.get(id);
    fl.setStyle(hide ? HIDDEN : styleOf(layerOf(a).color));
    fl.options.interactive = !hide;
  };
  const dropDetail = (id) => {
    const dl = detailShown.get(id);
    if (dl) { const l = layerOf(S.byId.get(id)); l.detail && l.detail.removeLayer(dl); }
    detailShown.delete(id);
    hideSimple(id, false);
  };
  const updateDetail = async () => {
    const seq = ++detailSeq;
    const want = new Set();
    if (map.getZoom() >= DETAIL_ZOOM) {
      const b = map.getBounds();
      const [w, so, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      for (const a of S.areas) {
        const l = layerOf(a);
        if (!S.on.has(l.id) || !l.leaflet || !visible(a)) continue;
        const [x0, y0, x1, y1] = a.bbox;
        if (x1 < w || x0 > e || y1 < so || y0 > n) continue;
        want.add(a.id);
        if (want.size >= DETAIL_MAX) break;
      }
    }
    [...detailShown.keys()].forEach((id) => { if (!want.has(id)) dropDetail(id); });
    const todo = [...want].filter((id) => !detailShown.has(id));
    for (let i = 0; i < todo.length; i += 8) {
      await Promise.all(todo.slice(i, i + 8).map(async (id) => {
        if (!detailCache.has(id)) {
          try { detailCache.set(id, await (await fetch(`data/area/${encodeURIComponent(id)}.json`)).json()); } catch (_) { return; }
        }
      }));
      if (seq !== detailSeq) return;   // 그사이 지도를 옮겼으면 새 요청에 맡김
      todo.slice(i, i + 8).forEach((id) => {
        const a = S.byId.get(id), l = layerOf(a);
        if (!detailCache.has(id) || detailShown.has(id) || !l.detail || !S.on.has(l.id)) return;
        const g = L.geoJSON(detailCache.get(id), { renderer, style: () => styleOf(l.color) });
        g.eachLayer((x) => bindArea(x, a));
        l.detail.addLayer(g);
        detailShown.set(id, g);
        hideSimple(id, true);
      });
    }
    restack();
  };

  const showLayer = async (l, on) => {
    if (!on) {
      if (l.leaflet) map.removeLayer(l.leaflet);
      if (l.detail) { map.removeLayer(l.detail); }
      [...detailShown.keys()].forEach((id) => { if (layerOf(S.byId.get(id)) === l) dropDetail(id); });
      return;
    }
    if (!S.geo[l.id]) {
      const item = $(`.layer-item[data-layer="${l.id}"]`);
      item && item.classList.add("loading");
      $("#loading").hidden = false;
      try {
        S.geo[l.id] = await (await fetch(`data/map/${l.id}.json`)).json();
      } finally {
        item && item.classList.remove("loading");
        $("#loading").hidden = true;
      }
    }
    if (!S.on.has(l.id)) return;   // 받는 사이 꺼졌으면
    if (!l.leaflet) l.leaflet = buildLayer(l);
    if (!l.detail) l.detail = L.featureGroup();
    l.leaflet.addTo(map);
    l.detail.addTo(map);
    restack();
    updateDetail();
  };

  // 켜진 레이어를 STACK 순서대로 다시 쌓음(나중에 켠 큰 레이어가 작은 구역을 덮지 않게). 원본 경계는 제 레이어 바로 위
  const restack = () => {
    const rank = (l) => { const i = STACK.indexOf(l.id); return i < 0 ? STACK.length : i; };
    S.layers.filter((l) => l.leaflet && map.hasLayer(l.leaflet)).sort((a, b) => rank(a) - rank(b)).forEach((l) => {
      l.leaflet.bringToFront();
      if (l.detail) l.detail.bringToFront();
    });
  };

  const refreshLayers = () => {
    [...detailShown.keys()].forEach(dropDetail);
    S.layers.forEach((l) => {
      if (l.leaflet) { map.removeLayer(l.leaflet); l.leaflet = null; }
      if (l.detail) { map.removeLayer(l.detail); l.detail = null; }
    });
    S.featLayer.clear();
    S.layers.forEach((l) => { if (S.on.has(l.id)) showLayer(l, true); });
  };

  const renderLayerList = () => {
    const counts = new Map();
    S.areas.forEach((a) => { if (visible(a)) counts.set(a.li, (counts.get(a.li) || 0) + 1); });
    $("#layer-list").innerHTML = Object.entries(S.groups).map(([g, label]) => {
      const items = S.layers.filter((l) => l.group === g);
      if (!items.length) return "";
      return `<div class="layer-group-title">${esc(label)}</div>` + items.map((l) => `
        <label class="layer-item" data-layer="${l.id}" title="${esc(l.law)}">
          <input type="checkbox" ${S.on.has(l.id) ? "checked" : ""}>
          <span class="swatch" style="background:${l.color}"></span>
          <span>${esc(l.name)}</span>
          <span class="count">${fmt(counts.get(l.i) || 0)}</span>
        </label>`).join("");
    }).join("");
  };

  const focusArea = async (a) => {
    const l = layerOf(a);
    if (!S.on.has(l.id)) {
      S.on.add(l.id);
      renderLayerList();
      await showLayer(l, true);
    }
    if (S.sido && a.sido !== S.sido) { S.sido = ""; $("#sido").value = ""; refreshLayers(); renderLayerList(); }
    const [x0, y0, x1, y1] = a.bbox;
    map.fitBounds([[y0, x0], [y1, x1]], { padding: [40, 40], maxZoom: 15 });
    const fl = S.featLayer.get(a.id);
    const at = fl && fl.getBounds ? fl.getBounds().getCenter() : L.latLng((y0 + y1) / 2, (x0 + x1) / 2);
    L.popup({ maxWidth: 320 }).setLatLng(at).setContent(popupHtml(a)).openOn(map);
  };

  const search = (q, limit = 40) => {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/);
    const out = [];
    for (const a of S.areas) {
      const hay = `${a.name} ${a.sido} ${a.sigg} ${a.sub} ${a.remark} ${layerOf(a).name}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) { out.push(a); if (out.length >= limit) break; }
    }
    return out;
  };

  const bindMap = () => {
    $("#layer-list").addEventListener("change", (e) => {
      const item = e.target.closest(".layer-item");
      if (!item) return;
      const l = S.layers.find((x) => x.id === item.dataset.layer);
      if (e.target.checked) S.on.add(l.id); else S.on.delete(l.id);
      showLayer(l, e.target.checked);
    });
    $("#layers-default").onclick = () => { S.on = new Set(DEFAULT_ON); refreshLayers(); renderLayerList(); };
    $("#layers-none").onclick = () => { S.on.clear(); refreshLayers(); renderLayerList(); };
    $("#sido").addEventListener("change", (e) => {
      S.sido = e.target.value;
      refreshLayers();
      renderLayerList();
      if (S.sido) {
        const b = S.areas.filter((a) => a.sido === S.sido).map((a) => a.bbox);
        if (b.length) map.fitBounds([[Math.min(...b.map((x) => x[1])), Math.min(...b.map((x) => x[0]))], [Math.max(...b.map((x) => x[3])), Math.max(...b.map((x) => x[2]))]], { padding: [20, 20] });
      }
    });
    $("#q").addEventListener("input", debounce(() => {
      const res = search($("#q").value);
      const box = $("#search-results");
      box.hidden = !$("#q").value.trim();
      box.innerHTML = res.length ? res.map((a) => `<button data-id="${esc(a.id)}">${esc(a.name)}<small>${esc(layerOf(a).name)} · ${esc([a.sido, a.sigg].filter(Boolean).join(" "))}</small></button>`).join("")
        : `<p class="muted small" style="padding:8px 10px;margin:0">검색 결과가 없습니다.</p>`;
    }, 150));
    $("#search-results").addEventListener("click", (e) => {
      const b = e.target.closest("[data-id]");
      if (!b) return;
      $("#sidebar").classList.remove("open");
      focusArea(S.byId.get(b.dataset.id));
    });
    $("#side-open").onclick = () => $("#sidebar").classList.add("open");
    $("#side-close").onclick = () => $("#sidebar").classList.remove("open");
    const sidos = new Map();
    S.areas.forEach((a) => { if (a.sido) sidos.set(a.sido, (sidos.get(a.sido) || 0) + 1); });
    const sidoOpts = [...sidos.keys()].sort((a, b) => a.localeCompare(b, "ko")).map((s) => `<option>${esc(s)}</option>`).join("");
    $("#sido").insertAdjacentHTML("beforeend", sidoOpts);
    $("#list-sido").insertAdjacentHTML("beforeend", sidoOpts);
  };

  // ---------- 구역별 내려받기 ----------
  let jszipP = null;
  const loadJSZip = () => jszipP || (jszipP = new Promise((resolve, reject) => {
    if (window.JSZip) return resolve();
    const s = document.createElement("script");
    s.src = JSZIP_URL;
    s.onload = resolve;
    s.onerror = () => { jszipP = null; reject(new Error("압축 도구를 불러오지 못했습니다.")); };
    document.head.appendChild(s);
  }));
  const areaGeo = async (id) => (await fetch(`data/area/${encodeURIComponent(id)}.json`)).json();
  const fileName = (a) => `${a.name}_${a.id}`.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80);

  const downloadArea = async (id, kind) => {
    const a = S.byId.get(id);
    if (!a) return;
    try {
      toast("파일을 만드는 중…", 1500);
      const fc = await areaGeo(id);
      const name = fileName(a);
      if (kind === "geojson") saveBlob(new Blob([JSON.stringify(fc)], { type: "application/geo+json" }), `${name}.geojson`);
      else if (kind === "kml") saveBlob(new Blob([ShpWrite.kml(fc.features, "이름")], { type: "application/vnd.google-earth.kml+xml" }), `${name}.kml`);
      else {
        await loadJSZip();
        saveBlob(await ShpWrite.zip(fc.features, FIELDS, name), `${name}_shp.zip`);
      }
    } catch (err) {
      console.warn(err);
      toast(err.message || "파일을 만들지 못했습니다.", 4000);
    }
  };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dl]");
    if (b) downloadArea(b.dataset.id, b.dataset.dl);
  });

  // ---------- 구역 목록 ----------
  const LS = { q: "", layer: "", sido: "", sort: "name", dir: 1, page: 0 };
  const PAGE = 100;
  const COLS = [["name", "이름"], ["type", "종류"], ["sub", "세부 구분"], ["sido", "시도"], ["sigg", "시군구"], ["notice", "고시"], ["ha", "면적"]];
  const renderList = () => {
    let rows = LS.q ? search(LS.q, 1e9) : S.areas.slice();
    if (LS.layer) rows = rows.filter((a) => layerOf(a).id === LS.layer);
    if (LS.sido) rows = rows.filter((a) => a.sido === LS.sido);
    const key = (a) => (LS.sort === "type" ? layerOf(a).name : LS.sort === "ha" ? a.ha : a[LS.sort] || "");
    rows.sort((x, y) => {
      const a = key(x), b = key(y);
      return (typeof a === "number" ? a - b : String(a).localeCompare(String(b), "ko")) * LS.dir;
    });
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    LS.page = Math.min(LS.page, pages - 1);
    const view = rows.slice(LS.page * PAGE, LS.page * PAGE + PAGE);
    $("#list-count").textContent = `${fmt(rows.length)}곳`;
    $("#list-table").innerHTML = `<thead><tr>${COLS.map(([k, t]) => `<th data-sort="${k}" class="${k === "ha" ? "num" : ""}">${t}${LS.sort === k ? (LS.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}<th>내려받기</th></tr></thead>
      <tbody>${view.map((a) => `<tr data-id="${esc(a.id)}">
        <td class="wrap">${esc(a.name)}</td><td>${typeBadge(layerOf(a))}</td><td>${esc(a.sub)}</td><td>${esc(a.sido)}</td><td>${esc(a.sigg)}</td>
        <td>${esc(a.notice)}</td><td class="num">${haText(a.ha)}</td>
        <td><button class="btn btn-light btn-sm" data-dl="shp" data-id="${esc(a.id)}">SHP</button> <button class="btn btn-light btn-sm" data-dl="geojson" data-id="${esc(a.id)}">GeoJSON</button></td></tr>`).join("")}</tbody>`;
    $("#list-pager").innerHTML = pages > 1 ? `
      <button class="btn btn-light btn-sm" data-page="${LS.page - 1}" ${LS.page ? "" : "disabled"}>이전</button>
      <span class="muted">${LS.page + 1} / ${pages}</span>
      <button class="btn btn-light btn-sm" data-page="${LS.page + 1}" ${LS.page < pages - 1 ? "" : "disabled"}>다음</button>` : "";
  };
  const bindList = () => {
    $("#list-layer").insertAdjacentHTML("beforeend", S.layers.map((l) => `<option value="${l.id}">${esc(l.name)} (${fmt(l.count)})</option>`).join(""));
    $("#list-q").addEventListener("input", debounce((e) => { LS.q = e.target.value; LS.page = 0; renderList(); }, 200));
    $("#list-layer").addEventListener("change", (e) => { LS.layer = e.target.value; LS.page = 0; renderList(); });
    $("#list-sido").addEventListener("change", (e) => { LS.sido = e.target.value; LS.page = 0; renderList(); });
    $("#list-table").addEventListener("click", (e) => {
      if (e.target.closest("[data-dl]")) return;
      const th = e.target.closest("th[data-sort]");
      if (th) { LS.dir = LS.sort === th.dataset.sort ? -LS.dir : 1; LS.sort = th.dataset.sort; renderList(); return; }
      const tr = e.target.closest("tr[data-id]");
      if (tr) location.hash = `#area/${encodeURIComponent(tr.dataset.id)}`;
    });
    $("#list-pager").addEventListener("click", (e) => {
      const b = e.target.closest("[data-page]");
      if (b) { LS.page = Number(b.dataset.page); renderList(); $("#view-list").scrollTop = 0; }
    });
  };

  // ---------- 구역 상세 ----------
  const renderArea = async (id) => {
    const a = S.byId.get(id);
    const body = $("#area-body");
    if (!a) { body.innerHTML = `<p class="muted">구역을 찾지 못했습니다.</p>`; return; }
    const l = layerOf(a);
    document.title = `${a.name} · 보호구역 종합포털`;
    body.innerHTML = `
      <div class="area-head">
        <div><h1 style="margin-bottom:6px">${esc(a.name)}</h1>${typeBadge(l)}</div>
        <a class="btn btn-light" href="#map/${encodeURIComponent(a.id)}">큰 지도에서 보기</a>
      </div>
      <div class="area-grid">
        <div id="area-map"></div>
        <div class="panel" style="margin:0">
          <dl class="info">
            <dt>종류</dt><dd>${esc(l.name)}</dd>
            ${a.sub ? `<dt>세부 구분</dt><dd>${esc(a.sub)}</dd>` : ""}
            ${a.sido || a.sigg ? `<dt>위치</dt><dd>${esc([a.sido, a.sigg].filter(Boolean).join(" "))}</dd>` : ""}
            ${a.notice ? `<dt>고시</dt><dd>${esc(a.notice)}</dd>` : ""}
            <dt>면적</dt><dd>${haText(a.ha)} <span class="muted small">(경계로 계산)</span></dd>
            ${a.remark ? `<dt>비고</dt><dd>${esc(a.remark)}</dd>` : ""}
            <dt>근거 법령</dt><dd>${esc(l.law)}</dd>
            <dt>구역 id</dt><dd><code>${esc(a.id)}</code></dd>
            <dt>출처</dt><dd>국토교통부 브이월드(${esc(l.data)})</dd>
          </dl>
          <div class="dl-buttons">
            <button class="btn btn-primary" data-dl="shp" data-id="${esc(a.id)}">SHP 내려받기</button>
            <button class="btn btn-light" data-dl="geojson" data-id="${esc(a.id)}">GeoJSON</button>
            <button class="btn btn-light" data-dl="kml" data-id="${esc(a.id)}">KML(구글 어스)</button>
          </div>
          <p class="muted small" style="margin:10px 0 0">경계는 참고 자료이며 법적 효력이 없습니다. 정확한 범위는 고시 도면을 확인하세요.</p>
        </div>
      </div>`;
    if (areaMap) { areaMap.remove(); areaMap = null; }
    areaMap = L.map("area-map", { zoomSnap: 0.5 });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(areaMap);
    const [x0, y0, x1, y1] = a.bbox;
    areaMap.fitBounds([[y0, x0], [y1, x1]], { padding: [20, 20] });
    try {
      const fc = await areaGeo(a.id);
      const g = L.geoJSON(fc, { style: { color: l.color, weight: 2, fillColor: l.color, fillOpacity: 0.3 } }).addTo(areaMap);
      areaMap.fitBounds(g.getBounds(), { padding: [20, 20] });
    } catch (err) { console.warn(err); }
  };

  // ---------- 내려받기·안내 ----------
  const renderDownload = () => {
    const rows = S.layers.map((l) => `<tr>
      <td>${typeBadge(l)}</td><td>${esc(S.groups[l.group])}</td><td class="num">${fmt(l.count)}곳</td><td class="num">${haText(l.area_ha)}</td>
      <td><a class="btn btn-light btn-sm" href="${RELEASE}${l.id}-shp.zip">SHP (${l.shp_mb} MB)</a></td>
      <td><a class="btn btn-light btn-sm" href="${RELEASE}${l.id}-geojson.zip">GeoJSON (${l.geojson_mb} MB)</a></td></tr>`).join("");
    $("#dl-table").innerHTML = `<thead><tr><th>종류</th><th>묶음</th><th class="num">구역</th><th class="num">총면적</th><th>SHP</th><th>GeoJSON</th></tr></thead>
      <tbody>${rows}<tr><td colspan="4"><b>모든 종류</b> — GeoPackage 한 파일(종류별 레이어)</td>
      <td colspan="2"><a class="btn btn-primary btn-sm" href="${RELEASE}protected-areas-gpkg.zip">GeoPackage(zip)</a></td></tr></tbody>`;
  };
  const renderAbout = () => {
    const total = S.areas.length;
    $("#about-status").innerHTML = `<h3>지금 들어 있는 자료</h3>
      <p style="margin:0">${S.layers.length}종 · 구역 ${fmt(total)}곳 · 자료 기준 ${S.at ? new Date(S.at).toLocaleString("ko-KR") : "-"}</p>`;
  };

  // ---------- 화면 전환 ----------
  const route = () => {
    const h = decodeURIComponent(location.hash.slice(1));
    const [view, arg] = [h.split("/")[0] || "map", h.split("/").slice(1).join("/")];
    const name = ["map", "list", "area", "download", "about"].includes(view) ? view : "map";
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === (name === "area" ? "list" : name)));
    if (name !== "area") document.title = "보호구역 종합포털";
    if (name === "map") {
      setTimeout(() => map.invalidateSize(), 30);
      if (arg && S.byId.has(arg)) setTimeout(() => focusArea(S.byId.get(arg)), 60);
      // #map/@위도,경도,확대 — 특정 위치를 바로 여는 링크
      const at = /^@(-?[\d.]+),(-?[\d.]+),(\d+(?:\.\d+)?)$/.exec(arg || "");
      if (at) setTimeout(() => map.setView([+at[1], +at[2]], +at[3]), 60);
    }
    if (name === "list") renderList();
    if (name === "area") renderArea(arg);
    if (name === "download") renderDownload();
    if (name === "about") renderAbout();
  };

  const boot = async () => {
    initMap();
    try {
      await loadIndex();
    } catch (err) {
      console.warn(err);
      toast("자료를 불러오지 못했습니다.", 5000);
      return;
    }
    renderLayerList();
    bindMap();
    bindList();
    S.layers.forEach((l) => { if (S.on.has(l.id)) showLayer(l, true); });
    window.addEventListener("hashchange", route);
    route();
  };
  boot();
})();
