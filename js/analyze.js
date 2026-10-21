// 사업지 분석 — 사업지(주소·좌표·그리기·파일)에서 반경 안 보호구역까지의 최단 이격거리·방향·겹침을 계산해
// 지도·표로 보여 주고, 반경 안 보호구역 경계를 SHP(zip)·GeoJSON·KML·CSV로 한 번에 내려받게 함
(() => {
  const P = window.Portal;
  const { S, $, $$, esc, fmt, toast, saveBlob, layerOf } = P;
  const LIB = {
    turf: "https://cdn.jsdelivr.net/npm/@turf/turf@7.1.0/turf.min.js",
    shp: "https://cdn.jsdelivr.net/npm/shpjs@4.0.4/dist/shp.min.js",
    proj4: "https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.js",
  };
  const PRESETS = [0.5, 1, 2, 3, 5, 10, 20];
  const MAX_KM = 20;
  const BANDS = [0.5, 1, 2, 5, 10, 20];
  const NOT_IN = "보호구역으로 지정되지 않은 생태 우수 지역";
  const DIRS = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
  const RAD = Math.PI / 180;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const inKorea = ([x, y]) => x > 123 && x < 133 && y > 32 && y < 40;

  // ---------- 좌표계 ----------
  const BESSEL = "+ellps=bessel +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43";
  const tm = (lon0, y0, datum = "+ellps=GRS80") => `+proj=tmerc +lat_0=38 +lon_0=${lon0} +k=1 +x_0=200000 +y_0=${y0} ${datum} +units=m +no_defs`;
  const CRS = [
    { id: "4326", name: "WGS84 경위도 (위도, 경도)" },
    { id: "5186", name: "EPSG:5186 중부원점 (GRS80)", def: tm(127, 600000) },
    { id: "5185", name: "EPSG:5185 서부원점 (GRS80)", def: tm(125, 600000) },
    { id: "5187", name: "EPSG:5187 동부원점 (GRS80)", def: tm(129, 600000) },
    { id: "5188", name: "EPSG:5188 동해원점 (GRS80)", def: tm(131, 600000) },
    { id: "5179", name: "EPSG:5179 UTM-K (GRS80)", def: "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs" },
    { id: "5181", name: "EPSG:5181 중부원점 (GRS80, Y 500000)", def: tm(127, 500000) },
    { id: "5174", name: "EPSG:5174 보정 중부원점 (Bessel, 옛 지적)", def: tm(127.0028902777778, 500000, BESSEL) },
    { id: "2097", name: "EPSG:2097 중부원점 (Bessel)", def: tm(127, 500000, BESSEL) },
    { id: "32652", name: "EPSG:32652 UTM 52N (WGS84)", def: "+proj=utm +zone=52 +datum=WGS84 +units=m +no_defs" },
  ];
  const crsDef = (id) => (CRS.find((c) => c.id === id) || {}).def;
  const GCS_KOREA = 'GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const prjTM = (name, lon0, k, x0, y0) => `PROJCS["${name}",${GCS_KOREA},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",${x0}],` +
    `PARAMETER["False_Northing",${y0}],PARAMETER["Central_Meridian",${lon0}],PARAMETER["Scale_Factor",${k}],PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]`;
  const OUT_CRS = [
    { id: "4326", name: "WGS84 경위도 (EPSG:4326)" },
    { id: "5186", name: "EPSG:5186 중부원점", prj: prjTM("Korea_2000_Korea_Central_Belt_2010", "127.0", "1.0", "200000.0", "600000.0") },
    { id: "5179", name: "EPSG:5179 UTM-K", prj: prjTM("Korea_2000_Korea_Unified_Coordinate_System", "127.5", "0.9996", "1000000.0", "2000000.0") },
    { id: "5185", name: "EPSG:5185 서부원점", prj: prjTM("Korea_2000_Korea_West_Belt_2010", "125.0", "1.0", "200000.0", "600000.0") },
    { id: "5187", name: "EPSG:5187 동부원점", prj: prjTM("Korea_2000_Korea_East_Belt_2010", "129.0", "1.0", "200000.0", "600000.0") },
    { id: "5188", name: "EPSG:5188 동해원점", prj: prjTM("Korea_2000_Korea_East_Sea_Belt_2010", "131.0", "1.0", "200000.0", "600000.0") },
  ];
  OUT_CRS.forEach((c) => { if (c.id !== "4326") c.def = crsDef(c.id); });

  // .prj(WKT)에서 proj4 정의 만들기. 횡메르카토르는 직접 풀어 Bessel(옛 한국 측지계)이면 좌표 이동값을 붙임
  // (.prj에는 이동값이 없어 그대로 쓰면 수백 m 어긋남)
  const fromPrj = (wkt) => {
    if (!wkt || !wkt.trim()) return null;
    const sph = /SPHEROID\s*\[\s*"[^"]*"\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(wkt);
    const a = sph ? parseFloat(sph[1]) : 6378137;
    const rf = sph ? parseFloat(sph[2]) : 298.257222101;
    const bessel = Math.abs(a - 6377397.155) < 1;
    const datum = bessel ? BESSEL : `+a=${a} +rf=${rf}`;
    if (!/PROJCS/i.test(wkt)) return bessel ? `+proj=longlat ${BESSEL} +no_defs` : "geo";
    if (!/Transverse_Mercator/i.test(wkt)) return wkt;   // 그 밖의 투영은 proj4가 WKT를 직접 읽게 함
    const p = (name, d) => {
      const m = new RegExp(`PARAMETER\\s*\\[\\s*"${name}"\\s*,\\s*(-?[\\d.eE+-]+)`, "i").exec(wkt);
      return m ? parseFloat(m[1]) : d;
    };
    return `+proj=tmerc +lat_0=${p("Latitude_Of_Origin", 0)} +lon_0=${p("Central_Meridian", 0)} +k=${p("Scale_Factor", 1)} ` +
      `+x_0=${p("False_Easting", 0)} +y_0=${p("False_Northing", 0)} ${datum} +units=m +no_defs`;
  };

  // ---------- 도형 도구 ----------
  // 위도 φ(라디안)에서 경도·위도 1도의 길이(m) — 타원체 기준 급수
  const KX = (φ) => 111412.84 * Math.cos(φ) - 93.5 * Math.cos(3 * φ) + 0.118 * Math.cos(5 * φ);
  const KY = (φ) => 111132.92 - 559.82 * Math.cos(2 * φ) + 1.175 * Math.cos(4 * φ) - 0.0023 * Math.cos(6 * φ);
  // 사업지 중심 기준 국지 평면(m). 반경 20 km 안에서는 오차가 아주 작음
  const projAt = (lng0, lat0) => ({ lng0, lat0, kx: KX(lat0 * RAD), ky: KY(lat0 * RAD) });
  const unproj = (x, y, o) => [x / o.kx + o.lng0, y / o.ky + o.lat0];
  // 두 경위도 점 사이 거리(m) — 중간 위도의 1도 길이로 계산(수십 km 안에서 cm 수준)
  const geoDist = (a, b) => {
    const φ = ((a[1] + b[1]) / 2) * RAD;
    return Math.hypot((b[0] - a[0]) * KX(φ), (b[1] - a[1]) * KY(φ));
  };
  const feat = (geometry, properties = {}) => ({ type: "Feature", properties, geometry });
  const mapCoords = (c, fn) => (typeof c[0] === "number" ? fn(c) : c.map((x) => mapCoords(x, fn)));
  const mapGeom = (g, fn) => ({ type: g.type, coordinates: mapCoords(g.coordinates, fn) });
  const kindOf = (g) => (/Point/.test(g.type) ? "point" : /LineString/.test(g.type) ? "line" : "polygon");
  const eachXY = (c, fn) => { if (typeof c[0] === "number") fn(c); else c.forEach((x) => eachXY(x, fn)); };
  const bboxOf = (features) => {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    features.forEach((f) => eachXY(f.geometry.coordinates, ([x, y]) => {
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
    }));
    return b;
  };
  // 면 넓이(㎡) — 국지 평면은 경위도에 대한 일차 변환이라 경위도 넓이 × kx × ky
  const polyArea = (g, o) => {
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    let s = 0;
    polys.forEach((p) => p.forEach((r, k) => {
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
      s += (k ? -1 : 1) * Math.abs(a / 2);
    }));
    return s * o.kx * o.ky;
  };
  const lineLen = (g) => {
    const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    let s = 0;
    lines.forEach((l) => { for (let i = 1; i < l.length; i++) s += geoDist(l[i - 1], l[i]); });
    return s;
  };

  // 사업지 도형 다듬기: 높이(Z) 버림, 잘못된 좌표 버림, 면 고리 닫기, 묶음(GeometryCollection) 풀기
  const normalize = (features) => {
    const out = [];
    const ok = (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);
    const pts = (cs) => (cs || []).filter(ok).map((c) => [c[0], c[1]]);
    const ring = (cs) => {
      const r = pts(cs);
      if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0].slice());
      return r.length >= 4 ? r : null;
    };
    const poly = (p) => { const rs = (p || []).map(ring); return rs[0] ? rs.filter(Boolean) : null; };
    const add = (g, props) => {
      if (!g) return;
      const c = g.coordinates;
      if (g.type === "GeometryCollection") return g.geometries.forEach((x) => add(x, props));
      if (g.type === "Point" && ok(c)) out.push(feat({ type: "Point", coordinates: [c[0], c[1]] }, props));
      if (g.type === "MultiPoint") pts(c).forEach((p) => out.push(feat({ type: "Point", coordinates: p }, props)));
      if (g.type === "LineString") { const l = pts(c); if (l.length >= 2) out.push(feat({ type: "LineString", coordinates: l }, props)); }
      if (g.type === "MultiLineString") { const ls = c.map(pts).filter((l) => l.length >= 2); if (ls.length) out.push(feat({ type: "MultiLineString", coordinates: ls }, props)); }
      if (g.type === "Polygon") { const p = poly(c); if (p) out.push(feat({ type: "Polygon", coordinates: p }, props)); }
      if (g.type === "MultiPolygon") { const ps = c.map(poly).filter(Boolean); if (ps.length) out.push(feat({ type: "MultiPolygon", coordinates: ps }, props)); }
    };
    features.forEach((f) => add(f.geometry, f.properties || {}));
    return out;
  };

  // ---------- 거리 계산(국지 평면) ----------
  // 도형을 꼭짓점 배열(Float64Array)로 바꾸고, 선분 32개씩 묶어 범위 상자를 둠(먼 묶음은 건너뛰기)
  const CH = 32;
  const prep = (geoms, o) => {
    const { lng0, lat0, kx, ky } = o;
    const paths = [], comps = [];
    let hasPoly = false, hasLine = false, onlyPoints = true;
    const lines = [];
    const path = (cs, ring) => {
      if (!cs.length) return null;
      if (cs.length === 1) cs = [cs[0], cs[0]];
      const a = new Float64Array(cs.length * 2);
      for (let i = 0; i < cs.length; i++) { a[2 * i] = (cs[i][0] - lng0) * kx; a[2 * i + 1] = (cs[i][1] - lat0) * ky; }
      paths.push({ a, ring });
      return a;
    };
    const first = (a) => a && comps.push([a[0], a[1]]);
    const polygon = (p) => { hasPoly = true; onlyPoints = false; p.forEach((r, k) => { const a = path(r, true); if (!k) first(a); }); };
    const line = (l) => { hasLine = true; onlyPoints = false; const a = path(l, false); if (a) { lines.push(a); first(a); } };
    const add = (g) => {
      if (!g) return;
      const c = g.coordinates;
      if (g.type === "Point") first(path([c], false));
      else if (g.type === "MultiPoint") c.forEach((p) => first(path([p], false)));
      else if (g.type === "LineString") line(c);
      else if (g.type === "MultiLineString") c.forEach(line);
      else if (g.type === "Polygon") polygon(c);
      else if (g.type === "MultiPolygon") c.forEach(polygon);
      else if (g.type === "GeometryCollection") g.geometries.forEach(add);
    };
    geoms.forEach(add);
    const chunks = [];
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const { a, ring } of paths) {
      const nv = a.length / 2;
      for (let s = 0; s < nv - 1; s += CH) {
        const e = Math.min(nv - 1, s + CH);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = s; i <= e; i++) {
          const x = a[2 * i], y = a[2 * i + 1];
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        chunks.push({ a, s, e, ring, x0, y0, x1, y1 });
        if (x0 < box.x0) box.x0 = x0; if (y0 < box.y0) box.y0 = y0; if (x1 > box.x1) box.x1 = x1; if (y1 > box.y1) box.y1 = y1;
      }
    }
    return { ...box, chunks, comps, lines, hasPoly, hasLine, onlyPoints };
  };
  const boxD2 = (p, q) => {
    const dx = Math.max(0, p.x0 - q.x1, q.x0 - p.x1), dy = Math.max(0, p.y0 - q.y1, q.y0 - p.y1);
    return dx * dx + dy * dy;
  };

  // 점과 선분 사이 거리² — 가장 가까운 점은 QX, QY
  let QX = 0, QY = 0;
  const ptSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    QX = ax + t * dx; QY = ay + t * dy;
    return (px - QX) * (px - QX) + (py - QY) * (py - QY);
  };
  // 선분 AB와 CD 사이 거리²(교차하면 0) — 가장 가까운 두 점은 (AX, AY)·(BX, BY)
  let AX = 0, AY = 0, BX = 0, BY = 0;
  const segSeg = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      const t = d1 / (d1 - d2);
      AX = BX = ax + t * (bx - ax); AY = BY = ay + t * (by - ay);
      return 0;
    }
    let best = ptSeg(ax, ay, cx, cy, dx, dy); AX = ax; AY = ay; BX = QX; BY = QY;
    let d = ptSeg(bx, by, cx, cy, dx, dy);
    if (d < best) { best = d; AX = bx; AY = by; BX = QX; BY = QY; }
    d = ptSeg(cx, cy, ax, ay, bx, by);
    if (d < best) { best = d; AX = QX; AY = QY; BX = cx; BY = cy; }
    d = ptSeg(dx, dy, ax, ay, bx, by);
    if (d < best) { best = d; AX = QX; AY = QY; BX = dx; BY = dy; }
    return best;
  };
  // 두 도형 경계 사이 최단 거리. cutoff(m)보다 멀면 null
  const minDist = (A, B, cutoff) => {
    let best = cutoff * cutoff, hit = null;
    const order = [];
    for (const q of B.chunks) { const d = boxD2(q, A); if (d < best) order.push([d, q]); }
    order.sort((u, v) => u[0] - v[0]);
    for (const [dq, q] of order) {
      if (dq >= best) break;
      const b = q.a;
      for (const p of A.chunks) {
        if (boxD2(p, q) >= best) continue;
        const a = p.a;
        for (let i = p.s; i < p.e; i++) {
          const x1 = a[2 * i], y1 = a[2 * i + 1], x2 = a[2 * i + 2], y2 = a[2 * i + 3];
          for (let j = q.s; j < q.e; j++) {
            const d = segSeg(x1, y1, x2, y2, b[2 * j], b[2 * j + 1], b[2 * j + 2], b[2 * j + 3]);
            if (d < best) {
              best = d;
              hit = { d: Math.sqrt(d), ax: AX, ay: AY, bx: BX, by: BY };
              if (d === 0) return hit;
            }
          }
        }
      }
    }
    return hit;
  };
  // 점이 면 안에 있는지 — 모든 고리를 한꺼번에 짝홀 규칙으로(구멍 포함). 오른쪽으로 쏜 반직선만 보므로 왼쪽 묶음은 건너뜀
  const inside = (x, y, B) => {
    let c = false;
    for (const q of B.chunks) {
      if (!q.ring || q.y0 > y || q.y1 < y || q.x1 < x) continue;
      const a = q.a;
      for (let i = q.s; i < q.e; i++) {
        const xi = a[2 * i], yi = a[2 * i + 1], xj = a[2 * i + 2], yj = a[2 * i + 3];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
    }
    return c;
  };
  // 선형 사업지가 구역 안을 지나는 길이(m)
  const insideLen = (SP, B) => {
    let sum = 0;
    for (const a of SP.lines) {
      for (let i = 0; i < a.length / 2 - 1; i++) {
        const x1 = a[2 * i], y1 = a[2 * i + 1], x2 = a[2 * i + 2], y2 = a[2 * i + 3];
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (!len) continue;
        const sx0 = Math.min(x1, x2), sx1 = Math.max(x1, x2), sy0 = Math.min(y1, y2), sy1 = Math.max(y1, y2);
        const ts = [0, 1];
        const rx = x2 - x1, ry = y2 - y1;
        for (const q of B.chunks) {
          if (!q.ring || q.x1 < sx0 || q.x0 > sx1 || q.y1 < sy0 || q.y0 > sy1) continue;
          const b = q.a;
          for (let j = q.s; j < q.e; j++) {
            const cx = b[2 * j], cy = b[2 * j + 1], ux = b[2 * j + 2] - cx, uy = b[2 * j + 3] - cy;
            const den = rx * uy - ry * ux;
            if (!den) continue;
            const t = ((cx - x1) * uy - (cy - y1) * ux) / den, u = ((cx - x1) * ry - (cy - y1) * rx) / den;
            if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
          }
        }
        ts.sort((p, q) => p - q);
        for (let k = 0; k + 1 < ts.length; k++) {
          const dt = ts[k + 1] - ts[k];
          if (dt <= 0) continue;
          const m = (ts[k] + ts[k + 1]) / 2;
          if (inside(x1 + m * rx, y1 + m * ry, B)) sum += dt * len;
        }
      }
    }
    return sum;
  };

  // ---------- turf(겹침 넓이·반경 버퍼·잘라내기) ----------
  const areaFeature = (fc) => {
    const polys = [];
    fc.features.forEach((f) => {
      const g = f.geometry;
      if (g && g.type === "Polygon") polys.push(g.coordinates);
      if (g && g.type === "MultiPolygon") polys.push(...g.coordinates);
    });
    return feat({ type: "MultiPolygon", coordinates: polys });
  };
  // 큰 구역은 먼저 상자로 잘라 계산을 가볍게 함
  const clipBox = (f, bb) => {
    const c = turf.bboxClip(f, bb).geometry;
    const polys = (c.type === "Polygon" ? [c.coordinates] : c.coordinates)
      .map((p) => p.filter((r) => r.length >= 4)).filter((p) => p.length);
    return polys.length ? feat({ type: "MultiPolygon", coordinates: polys }) : null;
  };
  const padBox = (b, d = 1e-4) => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
  const overlapHa = (fc, sitePolys, o) => {
    const area = areaFeature(fc);
    let sum = 0;
    try {
      for (const sp of sitePolys) {
        const c = clipBox(area, padBox(bboxOf([sp])));
        if (!c) continue;
        const x = turf.intersect(turf.featureCollection([sp, c]));
        if (x) sum += polyArea(x.geometry, o);
      }
    } catch (err) {
      console.warn(err);
      return null;
    }
    return sum / 1e4;
  };
  const makeBuffer = (features, km) => {
    const bufs = features.map((f) => turf.buffer(f, km, { units: "kilometers", steps: 32 })).filter(Boolean);
    if (bufs.length === 1) return feat(bufs[0].geometry);
    const u = turf.union(turf.featureCollection(bufs));
    return feat(u.geometry);
  };

  // ---------- 상태 ----------
  const A = {
    inited: false, map: null, renderer: null, site: null, raw: null, result: null, running: false,
    sort: { key: "dist", dir: 1 }, sel: -1,
  };
  const siteName = () => $("#an-name").value.trim() || "사업지";
  const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "사업지";
  const distText = (m) => (m >= 1000 ? `${fmt(m / 1000, 2)} km` : `${fmt(m)} m`);

  // ---------- 지도 ----------
  const SITE_STYLE = { color: "#111", weight: 3, opacity: 1, fillColor: "#ffd43b", fillOpacity: 0.35 };
  const initMap = () => {
    A.map = L.map("an-map", { zoomSnap: 0.5, minZoom: 5, maxZoom: 19 }).setView([36.1, 127.8], 7);
    const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
    const base = {
      "밝은 지도": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osmAttr, className: "tiles-muted" }),
      "일반 지도": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osmAttr }),
      "위성 영상": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19, attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics" }),
    };
    base["밝은 지도"].addTo(A.map);
    L.control.layers(base, null, { position: "topright" }).addTo(A.map);
    L.control.scale({ imperial: false, position: "bottomright" }).addTo(A.map);
    A.map.attributionControl.addAttribution('경계: <a href="https://www.vworld.kr" target="_blank" rel="noopener">국토교통부 브이월드</a>');
    // 모든 도형을 캔버스 하나에(겹친 구역도 눌리게)
    A.renderer = L.canvas({ padding: 0.3, tolerance: 3 });
    A.bufLayer = L.featureGroup().addTo(A.map);
    A.resLayer = L.featureGroup().addTo(A.map);
    A.siteLayer = L.featureGroup().addTo(A.map);
    A.hiLayer = L.featureGroup().addTo(A.map);
    A.drawLayer = L.featureGroup().addTo(A.map);
    A.map.on("click", onMapClick);
    A.map.on("dblclick", () => { if (D.mode === "line" || D.mode === "polygon") finishDraw(); });
  };
  const toFront = () => { A.siteLayer.bringToFront(); A.hiLayer.bringToFront(); A.drawLayer.bringToFront(); };

  const drawSite = () => {
    A.siteLayer.clearLayers();
    if (!A.site) return;
    const g = L.geoJSON({ type: "FeatureCollection", features: A.site.features }, {
      renderer: A.renderer, interactive: false, style: () => SITE_STYLE,
      pointToLayer: (f, ll) => L.circleMarker(ll, { renderer: A.renderer, interactive: false, radius: 7, color: "#111", weight: 2, fillColor: "#ffd43b", fillOpacity: 1 }),
    });
    A.siteLayer.addLayer(g);
    toFront();
    const b = g.getBounds();
    if (b.isValid()) {
      if (b.getNorthEast().equals(b.getSouthWest())) A.map.setView(b.getCenter(), Math.max(A.map.getZoom(), 14));
      else A.map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
    }
  };

  // ---------- 사업지 정하기 ----------
  // raw: 파일에서 읽은 원래 도형(좌표계·DXF 레이어를 바꿀 때 다시 씀)
  const setSite = (features, label, raw = null) => {
    features = normalize(features);
    if (!features.length) { toast("사업지로 쓸 점·선·면을 찾지 못했습니다.", 4000); return false; }
    A.site = { features, label };
    A.raw = raw;
    clearResult();
    drawSite();
    renderSite();
    const b = bboxOf(features);
    if (!inKorea([b[0], b[1]]) || !inKorea([b[2], b[3]])) toast("사업지가 한반도 밖에 있습니다. 좌표나 좌표계를 확인하세요.", 6000);
    return true;
  };
  const renderSite = () => {
    const box = $("#an-site");
    if (!A.site) { box.hidden = true; box.innerHTML = ""; return; }
    const fs = A.site.features;
    const b = bboxOf(fs);
    const o = projAt((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    const n = { point: 0, line: 0, polygon: 0 };
    let ha = 0, km = 0;
    fs.forEach((f) => {
      const k = kindOf(f.geometry);
      n[k]++;
      if (k === "polygon") ha += polyArea(f.geometry, o) / 1e4;
      if (k === "line") km += lineLen(f.geometry) / 1000;
    });
    const parts = [];
    if (n.polygon) parts.push(`면 ${fmt(n.polygon)}개 · ${fmt(ha, 2)} ha`);
    if (n.line) parts.push(`선 ${fmt(n.line)}개 · ${fmt(km, 3)} km`);
    if (n.point) parts.push(`점 ${fmt(n.point)}개`);
    const dxf = A.raw && A.raw.dxf && A.raw.dxf.layers.size > 1 ? A.raw.dxf : null;
    box.hidden = false;
    box.innerHTML = `
      <div class="an-site-head"><b>정한 사업지</b><button class="link" id="an-site-clear">지우기</button></div>
      <div>${esc(parts.join(" / "))}</div>
      <div class="muted small">중심 ${((b[1] + b[3]) / 2).toFixed(5)}, ${((b[0] + b[2]) / 2).toFixed(5)} · ${esc(A.site.label)}</div>
      ${dxf ? `<label class="small">DXF 레이어 <select id="an-dxf-layer" class="input">
        <option value="*" ${dxf.pick === "*" ? "selected" : ""}>모든 레이어</option>
        ${[...dxf.layers].map(([name, v]) => `<option value="${esc(name)}" ${dxf.pick === name ? "selected" : ""}>${esc(name)} (면 ${v.polygons.length} · 선 ${v.lines.length})</option>`).join("")}
      </select></label>` : ""}
      ${A.site.swap ? `<div class="small">TM 좌표를 ${A.site.swap === "en" ? "X=동쪽, Y=북쪽" : "X=북쪽, Y=동쪽"}으로 읽었습니다. 위치가 틀리면 <button class="link" id="an-swap">X·Y 바꿔 읽기</button></div>` : ""}`;
    const swap = $("#an-swap");
    if (swap) swap.onclick = () => { $("#an-order").value = A.site.swap === "en" ? "ne" : "en"; useCoords(); };
    $("#an-site-clear").onclick = () => { A.site = null; A.raw = null; drawSite(); renderSite(); clearResult(); };
    const sel = $("#an-dxf-layer");
    if (sel) sel.onchange = () => { A.raw.dxf.pick = sel.value; buildFromRaw(); };
  };

  // 주소·장소 찾기 — 국토교통부 브이월드 검색(도로명·지번·장소)을 먼저 쓰고, 못 찾으면 오픈스트리트맵 Nominatim
  // 브이월드 인증키는 배포할 때 저장소 비밀값(VWORLD_KEY)에서 js/config.js로 넣음. 버튼을 누를 때만 보냄
  const VW_KEY = (window.PORTAL_CONFIG || {}).vworldKey || "";
  const VW_DOMAIN = "https://protect.biogrideia.com";   // 인증키에 등록한 서비스 주소
  // 브이월드는 CORS를 열어 두지 않아 JSONP(callback)로 받음
  let jsonpSeq = 0;
  const jsonp = (url, ms = 8000) => new Promise((resolve, reject) => {
    const cb = `__vw${++jsonpSeq}_${Date.now().toString(36)}`;
    const s = document.createElement("script");
    const t = setTimeout(() => done(new Error("검색 서버가 응답하지 않습니다.")), ms);
    function done(err, data) {
      clearTimeout(t);
      window[cb] = () => {};   // 늦게 온 응답은 버림
      s.remove();
      if (err) reject(err); else resolve(data);
    }
    window[cb] = (data) => done(null, data);
    s.onerror = () => done(new Error("검색 서버에 연결하지 못했습니다."));
    s.src = `${url}&callback=${cb}`;
    document.head.appendChild(s);
  });
  const vworld = async (q, type, category) => {
    const p = new URLSearchParams({ service: "search", request: "search", version: "2.0", crs: "EPSG:4326", size: "10", page: "1",
      query: q, type, format: "json", errorformat: "json", key: VW_KEY, domain: VW_DOMAIN });
    if (category) p.set("category", category);
    const d = (await jsonp(`https://api.vworld.kr/req/search?${p}`)).response || {};
    if (d.status === "ERROR") throw new Error((d.error && d.error.text) || "브이월드 검색 오류");
    return ((d.result && d.result.items) || []).map((it) => {
      const a = it.address || {};
      if (type === "place") return { name: it.title || "", sub: a.road || a.parcel || "", lon: +it.point.x, lat: +it.point.y, kind: "장소" };
      if (category === "road") return { name: a.road || "", sub: a.parcel ? `지번 ${a.parcel}` : "", lon: +it.point.x, lat: +it.point.y, kind: "도로명" };
      return { name: a.parcel || "", sub: a.road ? `도로명 ${a.road}` : "", lon: +it.point.x, lat: +it.point.y, kind: "지번" };
    });
  };
  const nominatim = async (q) => {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=kr&accept-language=ko&limit=8&q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(res.status);
    // 도로명 주소를 찾으면 그 도로가 아닌 엉뚱한 곳을 돌려줄 때가 많아 걸러 냄
    const road = (/([가-힣A-Za-z0-9]+(?:로|길))\s*\d+(?:-\d+)?\s*$/.exec(q) || [])[1];
    return (await res.json()).filter((x) => !road || x.display_name.replace(/\s/g, "").includes(road))
      .map((x) => ({ name: x.name || x.display_name.split(",")[0], sub: x.display_name, lon: +x.lon, lat: +x.lat, kind: "OSM" }));
  };
  let addrList = [];
  const searchAddr = async (q) => {
    const box = $("#an-addr-res");
    box.hidden = false;
    box.innerHTML = `<p class="muted small pad">찾는 중…</p>`;
    q = q.replace(/(로|길)(\d+(?:-\d+)?)\s*$/, "$1 $2");   // ‘남부10길3’ → ‘남부10길 3’
    let list = [], failed = false;
    if (VW_KEY) {
      try {
        const [road, parcel] = await Promise.all([vworld(q, "address", "road"), vworld(q, "address", "parcel")]);
        list = [...road, ...parcel];
        if (list.length < 3) list.push(...(await vworld(q, "place")));
      } catch (err) {
        console.warn(err);
        failed = true;
      }
    }
    if (!list.length) {
      try { list = await nominatim(q); failed = false; } catch (err) { console.warn(err); failed = true; }
    }
    const seen = new Set();
    addrList = list.filter((x) => x.name && Number.isFinite(x.lon) && Number.isFinite(x.lat)).filter((x) => {
      const k = `${x.name}|${x.sub}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 12);
    box.innerHTML = addrList.length ? addrList.map((x, i) => `<button data-i="${i}">${esc(x.name)} <span class="kind">${esc(x.kind)}</span>${x.sub ? `<small>${esc(x.sub)}</small>` : ""}</button>`).join("")
      : `<p class="muted small pad">${failed ? "주소 검색 서버에 연결하지 못했습니다. 잠시 뒤 다시 하거나 ‘지도에 그리기’에서 점을 찍으세요."
        : "찾지 못했습니다. 시·군 이름을 붙이거나(예: 양산시 남부10길 3) 지번 주소·장소 이름으로 다시 찾거나, ‘지도에 그리기’에서 점을 찍으세요."}</p>`;
  };

  // 좌표 글 읽기 — 한 줄에 한 점. 숫자 둘(또는 번호 + 둘), 한 줄에 여러 쌍도 됨. 도·분·초는 십진수로 바꿈
  const DMS = /(\d+(?:\.\d+)?)\s*[°˚도]\s*(?:(\d+(?:\.\d+)?)\s*['′’분])?\s*(?:(\d+(?:\.\d+)?)\s*(?:["″”초]|''))?\s*([NSEWnsew북남동서])?/g;
  const parseCoordText = (text) => {
    const rows = [];
    text.split(/\r?\n/).forEach((line) => {
      const s = line.replace(DMS, (_, d, m, sec, h) => {
        let v = +d + (+m || 0) / 60 + (+sec || 0) / 3600;
        if (h && /[SWsw남서]/.test(h)) v = -v;
        return ` ${v} `;
      });
      const nums = (s.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      if (nums.length < 2) return;
      if (nums.length % 2) nums.shift();   // 앞의 점 번호
      for (let i = 0; i < nums.length; i += 2) rows.push([nums[i], nums[i + 1]]);
    });
    return rows;
  };
  const shapeOf = (pts, want) => {
    const kind = want !== "auto" ? want : pts.length === 1 ? "point" : pts.length === 2 ? "line" : "polygon";
    if (kind === "point") return pts.map((p) => feat({ type: "Point", coordinates: p }));
    if (kind === "line") return pts.length >= 2 ? [feat({ type: "LineString", coordinates: pts })] : [];
    return pts.length >= 3 ? [feat({ type: "Polygon", coordinates: [[...pts, pts[0]]] })] : [];
  };
  const useCoords = async () => {
    const rows = parseCoordText($("#an-coord").value);
    if (!rows.length) { toast("좌표를 읽지 못했습니다. 한 줄에 ‘위도, 경도’ 또는 ‘X, Y’로 적어 주세요.", 4500); return; }
    const crs = $("#an-crs").value;
    const want = $("#an-shape").value;
    let pts, used = "";
    if (crs === "4326") {
      pts = rows.map(([a, b]) => (a >= 32 && a <= 40 && b >= 123 && b <= 133 ? [b, a] : b >= 32 && b <= 40 && a >= 123 && a <= 133 ? [a, b] : null));
      if (pts.some((p) => !p)) { toast("한반도 범위의 위도·경도가 아닙니다. TM 좌표라면 좌표계를 바꿔 주세요.", 5000); return; }
    } else {
      await P.loadScript(LIB.proj4, "proj4");
      const tr = proj4(crsDef(crs), "WGS84");
      const en = rows.map(([a, b]) => tr.forward([a, b]));
      const ne = rows.map(([a, b]) => tr.forward([b, a]));
      const order = $("#an-order").value;
      const okEn = en.every(inKorea), okNe = ne.every(inKorea);
      if (order === "en" || order === "ne") used = order;
      else if (okEn) { used = "en"; if (okNe) toast("X·Y 순서가 애매해 X=동쪽으로 읽었습니다. 위치가 틀리면 ‘X·Y 바꿔 읽기’를 누르세요.", 6000); }
      else if (okNe) { used = "ne"; toast("X=북쪽(측량 성과표 순서)으로 읽었습니다.", 3500); }
      else used = "en";
      pts = used === "ne" ? ne : en;
    }
    const orderName = { en: "X=동쪽", ne: "X=북쪽" }[used];
    if (setSite(shapeOf(pts, want), `좌표 ${rows.length}개 (${CRS.find((c) => c.id === crs).name}${orderName ? `, ${orderName}` : ""})`) && used) {
      A.site.swap = used;
      renderSite();
    }
  };

  // ---------- 그리기 ----------
  const D = { mode: null, pts: [] };
  const drawMsg = () => {
    const need = D.mode === "polygon" ? 3 : 2;
    $("#an-draw-msg").textContent = `${D.mode === "polygon" ? "구역" : "선"} 꼭짓점 ${D.pts.length}개${D.pts.length < need ? ` — ${need}개 이상 찍으세요` : ""}`;
  };
  const redrawTmp = () => {
    A.drawLayer.clearLayers();
    const ll = D.pts.map(([x, y]) => [y, x]);
    if (ll.length >= 2) L.polyline(ll, { renderer: A.renderer, interactive: false, color: "#e8590c", weight: 2.5 }).addTo(A.drawLayer);
    if (D.mode === "polygon" && ll.length >= 3) L.polyline([ll[ll.length - 1], ll[0]], { renderer: A.renderer, interactive: false, color: "#e8590c", weight: 1.5, dashArray: "5 5" }).addTo(A.drawLayer);
    ll.forEach((p) => L.circleMarker(p, { renderer: A.renderer, interactive: false, radius: 4, color: "#e8590c", weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(A.drawLayer));
    A.drawLayer.bringToFront();
    drawMsg();
  };
  const startDraw = (mode) => {
    stopDraw();
    D.mode = mode;
    A.map.doubleClickZoom.disable();
    $("#an-map").classList.add("drawing");
    $$("[data-draw]").forEach((b) => b.classList.toggle("on", b.dataset.draw === mode));
    $("#an-draw-bar").hidden = mode === "point";
    if (mode === "point") toast("지도에서 사업지 위치를 누르세요.");
    else drawMsg();
  };
  const stopDraw = () => {
    D.mode = null;
    D.pts = [];
    if (!A.map) return;
    A.drawLayer.clearLayers();
    A.map.doubleClickZoom.enable();
    $("#an-map").classList.remove("drawing");
    $$("[data-draw]").forEach((b) => b.classList.remove("on"));
    $("#an-draw-bar").hidden = true;
  };
  const finishDraw = () => {
    const { mode, pts } = D;
    if (mode === "polygon" && pts.length < 3) return toast("구역은 꼭짓점이 3개 이상 있어야 합니다.");
    if (mode === "line" && pts.length < 2) return toast("선은 꼭짓점이 2개 이상 있어야 합니다.");
    stopDraw();
    setSite(shapeOf(pts, mode), mode === "polygon" ? "지도에 그린 구역" : "지도에 그린 선");
  };
  const onMapClick = (e) => {
    if (!D.mode) return;
    const p = [e.latlng.lng, e.latlng.lat];
    if (D.mode === "point") {
      stopDraw();
      setSite([feat({ type: "Point", coordinates: p })], "지도에 찍은 점");
      return;
    }
    const last = D.pts[D.pts.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) return;   // 두 번 누를 때 겹친 점
    D.pts.push(p);
    redrawTmp();
  };

  // ---------- 파일 읽기 ----------
  const ext = (name) => (/\.([^.]+)$/.exec(name.toLowerCase()) || [])[1] || "";
  const stem = (name) => name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const decode = (buf) => {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch (_) { return new TextDecoder("euc-kr").decode(buf); }
  };
  const fromGeoJSON = (text) => {
    const j = JSON.parse(text);
    const fs = j.type === "FeatureCollection" ? j.features : j.type === "Feature" ? [j] : j.type ? [feat(j)] : [];
    const crsName = j.crs && j.crs.properties && j.crs.properties.name;
    const m = crsName && /EPSG:+(\d+)/i.exec(crsName);
    const def = m ? (m[1] === "4326" ? "geo" : crsDef(m[1]) || null) : crsName && /CRS84/i.test(crsName) ? "geo" : null;
    return { features: fs.filter((f) => f && f.geometry), def };
  };
  const fromKml = (text) => {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("KML 파일을 읽지 못했습니다.");
    const tag = (el, name) => (el ? Array.from(el.getElementsByTagNameNS("*", name)) : []);
    const cs = (el) => (el ? el.textContent.trim().split(/\s+/).map((t) => t.split(",").map(Number))
      .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[0], c[1]]) : []);
    const fs = [];
    tag(doc, "Placemark").forEach((pm) => {
      const props = { name: (tag(pm, "name")[0] || {}).textContent || "" };
      tag(pm, "Point").forEach((g) => { const c = cs(tag(g, "coordinates")[0]); if (c.length) fs.push(feat({ type: "Point", coordinates: c[0] }, props)); });
      tag(pm, "LineString").forEach((g) => fs.push(feat({ type: "LineString", coordinates: cs(tag(g, "coordinates")[0]) }, props)));
      tag(pm, "Polygon").forEach((g) => {
        const outer = cs(tag(tag(g, "outerBoundaryIs")[0], "coordinates")[0]);
        const holes = tag(g, "innerBoundaryIs").map((h) => cs(tag(h, "coordinates")[0]));
        fs.push(feat({ type: "Polygon", coordinates: [outer, ...holes] }, props));
      });
    });
    return { features: fs, def: "geo" };
  };
  // DXF(ASCII) — ENTITIES 구역의 LWPOLYLINE·POLYLINE·LINE을 레이어별로 모음. 닫힌 선은 면으로, 끝이 이어진 선 조각도 이어 붙여 봄
  const fromDxf = (text) => {
    const L2 = text.split(/\r?\n/);
    const layers = new Map();
    const layer = (name) => { if (!layers.has(name)) layers.set(name, { polygons: [], lines: [] }); return layers.get(name); };
    const pieces = new Map();   // 레이어 → 열린 선 조각
    let inEnt = false, ent = null;
    const flush = () => {
      if (!ent) return;
      const pts = ent.pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      const name = ent.layer || "0";
      if ((ent.type === "LWPOLYLINE" || ent.type === "POLYLINE") && pts.length >= 2) {
        const closed = ent.closed || (pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]);
        if (closed && pts.length >= 3) layer(name).polygons.push(pts);
        else { if (!pieces.has(name)) pieces.set(name, []); pieces.get(name).push(pts); }
      } else if (ent.type === "LINE" && pts.length === 2) {
        if (!pieces.has(name)) pieces.set(name, []);
        pieces.get(name).push(pts);
      }
      ent = null;
    };
    for (let i = 0; i + 1 < L2.length; i += 2) {
      const code = parseInt(L2[i], 10), v = L2[i + 1].trim();
      if (code === 2 && v === "ENTITIES") { inEnt = true; continue; }
      if (!inEnt) continue;
      if (code === 0) {
        if (v === "ENDSEC") { flush(); break; }
        if (ent && ent.type === "POLYLINE" && v === "VERTEX") { ent.vertex = true; continue; }
        flush();
        ent = { type: v, pts: [], closed: false, layer: "", vertex: false };
        continue;
      }
      if (!ent) continue;
      if (code === 8 && !ent.vertex) ent.layer = v;
      if (ent.type === "LWPOLYLINE") {
        if (code === 10) ent.pts.push([+v, NaN]);
        else if (code === 20 && ent.pts.length) ent.pts[ent.pts.length - 1][1] = +v;
        else if (code === 70) ent.closed = (parseInt(v, 10) & 1) === 1;
      } else if (ent.type === "POLYLINE") {
        if (code === 70 && !ent.vertex) ent.closed = (parseInt(v, 10) & 1) === 1;
        else if (ent.vertex && code === 10) ent.pts.push([+v, NaN]);
        else if (ent.vertex && code === 20 && ent.pts.length) ent.pts[ent.pts.length - 1][1] = +v;
      } else if (ent.type === "LINE") {
        if (code === 10) ent.pts[0] = [+v, NaN];
        else if (code === 20 && ent.pts[0]) ent.pts[0][1] = +v;
        else if (code === 11) ent.pts[1] = [+v, NaN];
        else if (code === 21 && ent.pts[1]) ent.pts[1][1] = +v;
      }
    }
    flush();
    // 열린 조각 잇기(끝점이 거의 같은 조각끼리)
    pieces.forEach((list, name) => {
      const geo = list.every((p) => p.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90));
      const tol = geo ? 1e-8 : 1e-3;
      const near = (a, b) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
      const left = list.length <= 5000 ? list.map((p) => p.slice()) : [];
      const out = layer(name);
      if (!left.length) list.forEach((p) => out.lines.push(p));
      while (left.length) {
        let cur = left.pop();
        for (let grown = true; grown;) {
          grown = false;
          for (let i = 0; i < left.length; i++) {
            const p = left[i], h = cur[0], t = cur[cur.length - 1];
            if (near(t, p[0])) cur = cur.concat(p.slice(1));
            else if (near(t, p[p.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
            else if (near(h, p[p.length - 1])) cur = p.slice(0, -1).concat(cur);
            else if (near(h, p[0])) cur = p.slice(1).reverse().concat(cur);
            else continue;
            left.splice(i, 1);
            grown = true;
            break;
          }
        }
        if (cur.length >= 4 && near(cur[0], cur[cur.length - 1])) out.polygons.push(cur);
        else out.lines.push(cur);
      }
    });
    [...layers].forEach(([k, v]) => { if (!v.polygons.length && !v.lines.length) layers.delete(k); });
    if (!layers.size) throw new Error("DXF에서 폴리선·선을 찾지 못했습니다(블록 안 도형은 읽지 않습니다).");
    // 기본 레이어: 이름에 구역·경계·사업 등이 들어간 면 레이어 → 면이 가장 적은 레이어 → 첫 레이어
    const named = [...layers].find(([k, v]) => v.polygons.length && /구역|경계|사업|계획|부지|편입|boundary|site|area/i.test(k));
    const fewest = [...layers].filter(([, v]) => v.polygons.length).sort((a, b) => a[1].polygons.length - b[1].polygons.length)[0];
    const pick = layers.size === 1 ? [...layers.keys()][0] : (named || fewest || [...layers][0])[0];
    return { layers, pick };
  };
  const dxfFeatures = (dxf) => {
    const fs = [];
    dxf.layers.forEach((v, name) => {
      if (dxf.pick !== "*" && dxf.pick !== name) return;
      v.polygons.forEach((p) => fs.push(feat({ type: "Polygon", coordinates: [p] }, { layer: name })));
      v.lines.forEach((l) => fs.push(feat({ type: "LineString", coordinates: l }, { layer: name })));
    });
    return fs;
  };

  const readFiles = async (fileList) => {
    const files = [...fileList];
    if (!files.length) return;
    const sources = [];
    let dxf = null;
    const label = files.map((f) => f.name).join(", ");
    try {
      toast("파일을 읽는 중…", 1500);
      // zip(SHP 묶음·KMZ)은 풀어서 같은 목록에 넣음
      const items = [];
      for (const f of files) {
        if (["zip", "kmz"].includes(ext(f.name))) {
          await P.loadJSZip();
          const z = await JSZip.loadAsync(f);
          for (const e of Object.values(z.files)) {
            if (e.dir || /(^|\/)__MACOSX\//.test(e.name)) continue;
            items.push({ name: e.name, buf: () => e.async("arraybuffer") });
          }
        } else items.push({ name: f.name, buf: () => f.arrayBuffer() });
      }
      const find = (base, x) => items.find((it) => ext(it.name) === x && stem(it.name).toLowerCase() === base.toLowerCase());
      for (const it of items) {
        const x = ext(it.name);
        if (x === "shp") {
          await P.loadScript(LIB.shp, "shp");
          const prjItem = find(stem(it.name), "prj");
          const prj = prjItem ? decode(await prjItem.buf()) : "";
          const geoms = await shp.parseShp(await it.buf());   // 좌표는 그대로 받고 좌표계는 아래에서 직접 바꿈
          sources.push({ features: geoms.filter(Boolean).map((g) => feat(g)), def: fromPrj(prj) });
        } else if (x === "geojson" || x === "json") sources.push(fromGeoJSON(decode(await it.buf())));
        else if (x === "kml") sources.push(fromKml(decode(await it.buf())));
        else if (x === "dxf") dxf = fromDxf(decode(await it.buf()));
      }
    } catch (err) {
      console.warn(err);
      toast(err.message || "파일을 읽지 못했습니다.", 5000);
      return;
    }
    if (!sources.length && !dxf) { toast("읽을 수 있는 파일이 없습니다. SHP(.shp, 또는 zip)·GeoJSON·KML·DXF를 올려 주세요.", 5000); return; }
    if (!$("#an-name").value.trim()) $("#an-name").value = stem(files[0].name).slice(0, 40);
    buildFromRaw({ sources, dxf, label: `파일: ${label}` });
  };
  const looksProjected = (features) => {
    let p = false;
    features.forEach((f) => f.geometry && eachXY(f.geometry.coordinates, ([x, y]) => { if (Math.abs(x) > 180 || Math.abs(y) > 90) p = true; }));
    return p;
  };
  const reproject = async (features, def) => {
    await P.loadScript(LIB.proj4, "proj4");
    const tr = proj4(def, "WGS84");
    return normalize(features).map((f) => feat(mapGeom(f.geometry, (c) => tr.forward([c[0], c[1]])), f.properties));
  };
  // 파일에서 읽은 도형을 경위도로 바꿔 사업지로(좌표계 선택을 바꾸면 다시 부름)
  const buildFromRaw = async (R = A.raw) => {
    if (!R) return;
    const all = [];
    const groups = [...R.sources];
    if (R.dxf) groups.push({ features: dxfFeatures(R.dxf), def: null });
    let guessed = false;
    try {
      for (const g of groups) {
        let def = g.def;
        if (!def && looksProjected(g.features)) { def = crsDef($("#an-file-crs").value); guessed = true; }
        all.push(...(def && def !== "geo" ? await reproject(g.features, def) : g.features));
      }
    } catch (err) {
      console.warn(err);
      toast("좌표계를 바꾸지 못했습니다. ‘좌표계 정보가 없으면’에서 맞는 좌표계를 골라 주세요.", 6000);
      return;
    }
    const crsName = CRS.find((c) => c.id === $("#an-file-crs").value).name;
    setSite(all, guessed ? `${R.label} · ${crsName}로 읽음` : R.label, R);
  };

  // ---------- 분석 ----------
  const readRadius = () => {
    const v = parseFloat($("#an-radius").value);
    if (!Number.isFinite(v) || v <= 0) { toast("반경을 km로 적어 주세요."); return null; }
    return Math.min(MAX_KM, Math.max(0.1, Math.round(v * 100) / 100));
  };
  const progress = (f, msg) => {
    const el = $("#an-progress");
    el.hidden = false;
    $("i", el).style.width = `${Math.round(f * 100)}%`;
    $("span", el).textContent = msg;
  };

  const measure = (a, fc, SP, o, R) => {
    const B = prep(fc.features.map((f) => f.geometry), o);
    const md = minDist(SP, B, R);
    const row = { a, l: layerOf(a), fc, dist: 0, dir: "", rel: "떨어짐", contact: false, pa: null, pb: null, ovHa: null, ovKm: null, B };
    if (md && md.d === 0) {
      row.contact = true;
      row.pa = row.pb = unproj(md.ax, md.ay, o);
      return row;
    }
    // 경계가 닿지 않아도 한쪽이 다른 쪽 안에 있을 수 있음
    const inCount = SP.comps.filter(([x, y]) => inside(x, y, B)).length;
    if (inCount) {
      row.rel = SP.onlyPoints ? "구역 안" : inCount === SP.comps.length ? "사업지가 구역 안" : "사업지 일부가 구역 안";
      return row;
    }
    if (SP.hasPoly && B.comps.some(([x, y]) => inside(x, y, SP))) { row.rel = "구역이 사업지 안"; return row; }
    if (!md) return null;   // 반경 밖
    row.pa = unproj(md.ax, md.ay, o);
    row.pb = unproj(md.bx, md.by, o);
    row.dist = geoDist(row.pa, row.pb);
    const deg = ((Math.atan2(md.bx - md.ax, md.by - md.ay) / RAD) + 360) % 360;
    row.dir = DIRS[Math.round(deg / 45) % 8];
    return row;
  };

  const run = async () => {
    if (A.running) return;
    stopDraw();
    if (!A.site) { toast("먼저 사업지를 정하세요."); return; }
    const km = readRadius();
    if (!km) return;
    $("#an-radius").value = km;
    const types = new Set($$("#an-types input:checked").map((i) => i.value));
    if (!types.size) { toast("볼 보호구역을 하나 이상 고르세요."); return; }
    A.running = true;
    $("#an-run").disabled = true;
    progress(0.02, "계산 도구를 불러오는 중…");
    try {
      await P.loadScript(LIB.turf, "turf");
      const site = A.site;
      const feats = site.features;
      const bb = bboxOf(feats);
      const o = projAt((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
      const R = km * 1000;
      const SP = prep(feats.map((f) => f.geometry), o);
      // 후보: 구역 범위 상자가 사업지 범위에서 R 안에 드는 것
      const cands = S.areas.filter((a) => {
        if (!types.has(layerOf(a).id)) return false;
        const [x0, y0, x1, y1] = a.bbox;
        return boxD2({ x0: (x0 - o.lng0) * o.kx, y0: (y0 - o.lat0) * o.ky, x1: (x1 - o.lng0) * o.kx, y1: (y1 - o.lat0) * o.ky }, SP) <= R * R;
      });
      let k = 0, done = 0;
      const failed = new Set();
      const worker = async () => {
        while (k < cands.length) {
          const a = cands[k++];
          try { await P.areaGeo(a.id); } catch (_) { failed.add(a.id); }
          done++;
          progress(0.05 + (0.55 * done) / cands.length, `경계 받는 중 ${fmt(done)} / ${fmt(cands.length)}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(10, cands.length) }, worker));
      const rows = [];
      let t = performance.now();
      for (let i = 0; i < cands.length; i++) {
        const a = cands[i];
        if (failed.has(a.id)) continue;
        const r = measure(a, await P.areaGeo(a.id), SP, o, R);
        if (r) rows.push(r);
        if (performance.now() - t > 40) {
          progress(0.6 + (0.3 * (i + 1)) / cands.length, `거리 계산 중 ${fmt(i + 1)} / ${fmt(cands.length)}`);
          await tick();
          t = performance.now();
        }
      }
      progress(0.92, "겹침 넓이와 반경을 계산하는 중…");
      await tick();
      const sitePolys = feats.filter((f) => kindOf(f.geometry) === "polygon");
      const siteHa = sitePolys.reduce((s, f) => s + polyArea(f.geometry, o), 0) / 1e4;
      rows.forEach((r) => {
        if (r.dist === 0) {
          if (SP.hasLine) r.ovKm = insideLen(SP, r.B) / 1000;
          if (SP.hasPoly) r.ovHa = overlapHa(r.fc, sitePolys, o);
          if (r.contact) {
            if (SP.hasPoly && (r.ovHa === null || r.ovHa > 1e-4)) r.rel = "겹침";
            else if (SP.hasLine && r.ovKm > 1e-6) r.rel = "통과";
            else r.rel = SP.onlyPoints ? "경계 위" : "맞닿음";
          }
          // 구역의 구멍(제외지)이 사업지 안에 있으면 경계가 안 닿아도 ‘구역 안’이 아님
          if (r.rel === "사업지가 구역 안" && SP.hasPoly && r.ovHa !== null && r.ovHa < siteHa * 0.9999) r.rel = "겹침";
        }
        delete r.B;
      });
      let buffer = null;
      try { buffer = makeBuffer(feats, km); } catch (err) { console.warn(err); }
      A.result = { at: new Date(), km, R, o, types: [...types], rows, buffer, failed: failed.size, site, name: siteName(), hasPoly: SP.hasPoly, hasLine: SP.hasLine, clip: new Map() };
      A.sort = { key: "dist", dir: 1 };
      A.sel = -1;
      renderResult();
    } catch (err) {
      console.error(err);
      toast(err.message || "분석하지 못했습니다.", 5000);
    } finally {
      A.running = false;
      $("#an-run").disabled = false;
      $("#an-progress").hidden = true;
    }
  };

  // ---------- 결과 ----------
  const HIT = new Set(["겹침", "통과", "구역 안", "사업지가 구역 안", "사업지 일부가 구역 안", "구역이 사업지 안", "경계 위", "맞닿음"]);
  const relBadge = (rel) => `<span class="rel ${HIT.has(rel) ? "rel-hit" : ""}">${esc(rel)}</span>`;
  const ovText = (r) => {
    const out = [];
    if (r.ovHa !== null) out.push(r.ovHa > 0 ? `${fmt(r.ovHa, r.ovHa < 1 ? 4 : 2)} ha` : "0 ha");
    if (r.ovKm !== null) out.push(`${fmt(r.ovKm, 3)} km`);
    if (r.dist === 0 && A.result.hasPoly && r.ovHa === null) out.push("계산 안 됨");
    return out.join(" · ") || "";
  };
  const distCell = (r) => (r.dist > 0 ? fmt(r.dist) : "0");
  const clearResult = () => {
    A.result = null;
    A.sel = -1;
    if (!A.map) return;
    A.resLayer.clearLayers();
    A.bufLayer.clearLayers();
    A.hiLayer.clearLayers();
    A.map.closePopup();
    $("#an-result").innerHTML = `<div class="an-empty muted"><p><b>분석하기</b>를 누르면 반경 안 보호구역과의 최단 이격거리·방향·겹침 넓이를 표로 보여 주고, 경계 SHP를 한 번에 내려받을 수 있습니다.</p></div>`;
  };

  const sortedRows = () => {
    const { key, dir } = A.sort;
    const val = (r) => (key === "dist" ? r.dist : key === "type" ? P.STACK.indexOf(r.l.id) : key === "ov" ? (r.ovHa || 0) + (r.ovKm || 0)
      : key === "ha" ? r.a.ha : key === "name" ? r.a.name : key === "sigg" ? `${r.a.sido} ${r.a.sigg}` : r.dist);
    return A.result.rows.map((r, i) => ({ r, i })).sort((x, y) => {
      const a = val(x.r), b = val(y.r);
      const c = typeof a === "number" ? a - b : String(a).localeCompare(String(b), "ko");
      return c * dir || x.r.dist - y.r.dist || x.r.a.name.localeCompare(y.r.a.name, "ko");
    });
  };

  // 거리 구간은 겹치지 않게 나눔: 겹침·포함(0 m) / 0.5 km 이내 / 0.5~1 km / … / 반경까지 — 다 더하면 구역 수
  const summary = (r) => {
    const edges = [0, ...BANDS.filter((b) => b < r.km), r.km];
    const bands = edges.slice(1).map((hi, i) => ({ lo: edges[i], hi, label: i ? `${fmt(edges[i], 1)}~${fmt(hi, 1)} km` : `${fmt(hi, 1)} km 이내` }));
    const by = new Map();
    r.rows.forEach((x) => { if (!by.has(x.l.id)) by.set(x.l.id, []); by.get(x.l.id).push(x); });
    const layers = S.layers.filter((l) => r.types.includes(l.id));
    return { bands, rows: layers.map((l) => {
      const list = (by.get(l.id) || []).slice().sort((a, b) => a.dist - b.dist);
      const near = list.find((x) => x.dist > 0);
      return { l, n: list.length, hit: list.filter((x) => x.dist === 0).length,
        bands: bands.map((b) => list.filter((x) => x.dist > b.lo * 1000 && x.dist <= b.hi * 1000).length),
        first: list[0], near };
    }) };
  };

  const renderResult = () => {
    const r = A.result;
    // 지도
    A.resLayer.clearLayers();
    A.bufLayer.clearLayers();
    A.hiLayer.clearLayers();
    A.map.closePopup();
    if (r.buffer) L.geoJSON(r.buffer, { renderer: A.renderer, interactive: false, style: { color: "#1c7ed6", weight: 2, dashArray: "8 6", fill: false } }).addTo(A.bufLayer);
    const rank = (l) => { const i = P.STACK.indexOf(l.id); return i < 0 ? 99 : i; };
    r.rows.map((x, i) => ({ x, i })).sort((p, q) => rank(p.x.l) - rank(q.x.l)).forEach(({ x, i }) => {
      const g = L.geoJSON(x.fc, { renderer: A.renderer, style: () => ({ color: x.l.color, weight: 1.2, opacity: 0.95, fillColor: x.l.color, fillOpacity: 0.3 }) });
      g.eachLayer((ly) => {
        ly.bindTooltip(`${esc(x.a.name)} · ${x.dist > 0 ? distText(x.dist) : esc(x.rel)}`, { sticky: true, direction: "top" });
        ly.on("click", (e) => select(i, e.latlng));
      });
      x.layer = g;
      A.resLayer.addLayer(g);
    });
    toFront();
    if (r.buffer) A.map.fitBounds(L.geoJSON(r.buffer).getBounds(), { padding: [20, 20] });

    // 표
    const sm = summary(r);
    const hits = r.rows.filter((x) => x.dist === 0);
    const near = r.rows.filter((x) => x.dist > 0).sort((a, b) => a.dist - b.dist)[0];
    const kinds = new Set(r.rows.map((x) => x.l.id)).size;
    const ovHead = r.hasPoly && r.hasLine ? "겹침 넓이·통과 길이" : r.hasPoly ? "겹침 넓이" : r.hasLine ? "통과 길이" : "";
    $("#an-result").innerHTML = `
      <div class="an-head">
        <div>
          <h2>${esc(r.name)} — 반경 ${fmt(r.km, 2)} km 보호구역 분석</h2>
          <p class="muted small">${esc(r.site.label)} · 분석 ${r.at.toLocaleString("ko-KR")} · 자료 기준 ${S.at ? new Date(S.at).toLocaleDateString("ko-KR") : "-"}</p>
        </div>
      </div>
      <div class="an-cards">
        <div class="an-card"><b>${fmt(r.rows.length)}곳</b><span>반경 ${fmt(r.km, 2)} km 안 보호구역 (${kinds}종)</span></div>
        <div class="an-card ${hits.length ? "warn" : ""}"><b>${fmt(hits.length)}곳</b><span>사업지와 겹치거나 맞닿거나 안에 든 구역</span></div>
        <div class="an-card"><b>${near ? distText(near.dist) : "-"}</b><span>${near ? `가장 가까운 떨어진 구역 — ${esc(near.a.name)} (${esc(near.l.name)}, ${near.dir}쪽)` : "떨어진 구역 없음"}</span></div>
      </div>
      ${r.failed ? `<p class="note">경계 파일 ${fmt(r.failed)}개를 받지 못해 빠졌습니다. 다시 분석해 보세요.</p>` : ""}
      <div class="panel an-dl">
        <div class="row">
          <button class="btn btn-primary" data-an-dl="shp">SHP 한 번에 받기 (zip)</button>
          <button class="btn btn-light" data-an-dl="geojson">GeoJSON</button>
          <button class="btn btn-light" data-an-dl="kml">KML</button>
          <button class="btn btn-light" data-an-dl="csv">결과표 CSV</button>
        </div>
        <div class="row small">
          <label class="check"><input type="checkbox" id="an-clip"> 반경 경계에서 잘라 담기</label>
          <label class="check"><input type="checkbox" id="an-merge"> 모든 종류를 한 파일로</label>
          <label class="check">SHP 좌표계 <select id="an-out-crs" class="input">${OUT_CRS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
        </div>
        <p class="muted small" style="margin:0">zip에는 종류별 보호구역 SHP(이격거리·방향·관계 속성 포함), 사업지·반경 SHP, 결과표·종류별 요약 CSV, 읽어보기가 들어 있습니다.</p>
      </div>
      <h3>종류별 요약</h3>
      <div class="table-wrap"><table class="table an-sum">
        <thead><tr><th>종류</th><th class="num">구역</th><th class="num">겹침·포함</th>${sm.bands.map((b) => `<th class="num">${b.label}</th>`).join("")}<th class="num">최단 이격거리</th><th>가장 가까운 떨어진 구역</th></tr></thead>
        <tbody>${sm.rows.filter((s) => s.n).map((s) => `<tr>
          <td>${P.typeBadge(s.l)}</td><td class="num">${s.n ? fmt(s.n) : "없음"}</td><td class="num">${s.hit ? `<b class="hit">${fmt(s.hit)}</b>` : s.n ? "0" : ""}</td>
          ${s.bands.map((b) => `<td class="num">${s.n ? fmt(b) : ""}</td>`).join("")}
          <td class="num">${s.first ? (s.first.dist > 0 ? distText(s.first.dist) : `0 m <span class="muted small">(${esc(s.first.rel)})</span>`) : ""}</td>
          <td class="wrap">${s.near ? `${esc(s.near.a.name)} <span class="muted">(${distText(s.near.dist)}, ${s.near.dir}쪽)</span>` : ""}</td></tr>`).join("")
          || `<tr><td colspan="${sm.bands.length + 5}" class="muted">반경 안에 보호구역이 없습니다.</td></tr>`}</tbody>
      </table></div>
      ${sm.rows.some((s) => !s.n) ? `<p class="muted small">반경 안에 없음: ${sm.rows.filter((s) => !s.n).map((s) => esc(s.l.name)).join(", ")}</p>` : ""}
      <h3>구역별 이격거리 <span class="muted small">(${fmt(r.rows.length)}곳 · 줄을 누르면 지도에서 보여 줍니다)</span></h3>
      <div class="table-wrap an-rows-wrap"><table class="table" id="an-table"></table></div>
      <div class="panel">
        <h3>계산 방법과 유의할 점</h3>
        <ul class="plain small">
          <li>이격거리는 사업지 경계(점·선·면)와 보호구역 경계 사이의 최단 거리입니다. 겹치거나 맞닿거나 한쪽이 다른 쪽 안에 있으면 0 m로 적었습니다.</li>
          <li>방향은 사업지에서 보호구역의 가장 가까운 지점을 바라본 8방위입니다.${ovHead ? ` ${ovHead}는 사업지와 보호구역이 겹친 부분입니다.` : ""}</li>
          <li>거리·넓이는 사업지 중심 기준 평면(타원체 보정)으로 계산했으며 원본 해상도 경계를 썼습니다. 측량 성과와는 1 m 안팎 차이가 날 수 있습니다.</li>
          <li>경계는 국토교통부 브이월드 자료를 쓰고, 브이월드에 없는 종류만 한국보호지역 통합DB(KDPA)로 채웠습니다(구역마다 출처 표시). 법적 효력이 없으니 인허가·평가에는 지정 고시와 도면을 확인하세요.</li>
          <li>${esc(NOT_IN)}은 분석하지 못했습니다. 환경공간정보서비스 등에서 따로 확인하세요.</li>
        </ul>
      </div>`;
    renderTable();
    $("#an-out-crs").value = "4326";
  };

  const renderTable = () => {
    const r = A.result;
    const cols = [["dist", "이격거리(m)", "num"], ["dir", "방향", ""], ["rel", "관계", ""], ["type", "종류", ""], ["name", "이름", ""], ["sigg", "위치", ""],
      ["notice", "고시", ""], ...(r.hasPoly || r.hasLine ? [["ov", r.hasPoly ? "겹침" : "통과", "num"]] : []), ["ha", "구역 면적", "num"]];
    const sortable = new Set(["dist", "type", "name", "sigg", "ov", "ha"]);
    $("#an-table").innerHTML = `<thead><tr><th class="num">#</th>${cols.map(([k, t, c]) => `<th ${sortable.has(k) ? `data-sort="${k}"` : ""} class="${c}">${t}${A.sort.key === k ? (A.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
      <tbody id="an-rows">${sortedRows().map(({ r: x, i }, n) => `<tr data-i="${i}" class="${i === A.sel ? "sel" : ""}">
        <td class="num muted">${n + 1}</td>
        <td class="num"><b>${distCell(x)}</b></td><td>${esc(x.dir)}</td><td>${relBadge(x.rel)}</td><td>${P.typeBadge(x.l)}</td>
        <td class="wrap">${esc(x.a.name)}${x.a.sub && x.a.sub !== x.l.name ? `<small class="muted"> · ${esc(x.a.sub)}</small>` : ""}</td>
        <td>${esc([x.a.sido, x.a.sigg].filter(Boolean).join(" "))}</td><td>${esc(x.a.notice)}</td>
        ${r.hasPoly || r.hasLine ? `<td class="num">${ovText(x)}</td>` : ""}
        <td class="num">${P.haText(x.a.ha)}</td></tr>`).join("") || `<tr><td colspan="${cols.length + 1}" class="muted">반경 안에 보호구역이 없습니다.</td></tr>`}</tbody>`;
  };

  const popupOf = (x) => `<div class="pop-dist">${x.dist > 0 ? `이격거리 ${fmt(x.dist)} m · ${esc(x.dir)}쪽` : esc(x.rel)}${ovText(x) ? ` · ${esc(ovText(x))}` : ""}</div>${P.popupHtml(x.a)}`;
  const select = (i, latlng) => {
    const x = A.result.rows[i];
    if (!x) return;
    A.sel = i;
    A.hiLayer.clearLayers();
    L.geoJSON(x.fc, { renderer: A.renderer, interactive: false, style: { color: "#111", weight: 2.5, fill: false } }).addTo(A.hiLayer);
    const siteB = A.siteLayer.getBounds();
    let fit = siteB.isValid() ? L.latLngBounds(siteB.getSouthWest(), siteB.getNorthEast()) : null;
    if (x.dist > 0) {
      const ll = [[x.pa[1], x.pa[0]], [x.pb[1], x.pb[0]]];
      L.polyline(ll, { renderer: A.renderer, interactive: false, color: "#c2255c", weight: 2.5, dashArray: "6 5" }).addTo(A.hiLayer);
      ll.forEach((p) => L.circleMarker(p, { renderer: A.renderer, interactive: false, radius: 4, color: "#c2255c", weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(A.hiLayer));
      L.tooltip({ permanent: true, direction: "center", className: "dist-tip", interactive: false })
        .setLatLng([(ll[0][0] + ll[1][0]) / 2, (ll[0][1] + ll[1][1]) / 2]).setContent(distText(x.dist)).addTo(A.hiLayer);
      fit = fit ? fit.extend(ll[1]) : L.latLngBounds(ll);
    } else if (!fit) fit = x.layer.getBounds();
    toFront();
    if (!latlng) {
      A.map.fitBounds(fit, { padding: [40, 40], maxZoom: 16 });
      $(".an-map-wrap").scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    const at = latlng || (x.pb ? L.latLng(x.pb[1], x.pb[0]) : fit.getCenter());
    L.popup({ maxWidth: 340 }).setLatLng(at).setContent(popupOf(x)).openOn(A.map);
    $$("#an-rows tr").forEach((tr) => tr.classList.toggle("sel", Number(tr.dataset.i) === i));
    if (latlng) { const tr = $(`#an-rows tr[data-i="${i}"]`); tr && tr.scrollIntoView({ block: "nearest" }); }
  };

  // ---------- 내려받기 ----------
  const csvCell = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCsv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const round = (v, d) => (v === null || v === undefined ? "" : Number(v.toFixed(d)));
  const resultCsv = (r) => {
    const head = ["순번", "이격거리_m", "방향", "관계", ...(r.hasPoly ? ["겹침면적_ha"] : []), ...(r.hasLine ? ["통과길이_km"] : []),
      "종류", "이름", "세부구분", "시도", "시군구", "고시", "구역면적_ha", "근거법령", "구역id", "비고"];
    const rows = r.rows.slice().sort((a, b) => a.dist - b.dist || P.STACK.indexOf(a.l.id) - P.STACK.indexOf(b.l.id)).map((x, n) => [
      n + 1, Math.round(x.dist), x.dir, x.rel, ...(r.hasPoly ? [round(x.ovHa, 4)] : []), ...(r.hasLine ? [round(x.ovKm, 3)] : []),
      x.l.name, x.a.name, x.a.sub, x.a.sido, x.a.sigg, x.a.notice, x.a.ha, x.l.law, x.a.id, x.a.remark]);
    return toCsv([head, ...rows]);
  };
  const summaryCsv = (r) => {
    const sm = summary(r);
    const head = ["종류", "구역_수", "겹침·포함", ...sm.bands.map((b) => b.label.replace(/ /g, "_")), "최단_이격거리_m", "가장_가까운_떨어진_구역", "그_거리_m", "근거법령"];
    return toCsv([head, ...sm.rows.map((s) => [s.l.name, s.n, s.hit, ...s.bands, s.first ? Math.round(s.first.dist) : "", s.near ? s.near.a.name : "",
      s.near ? Math.round(s.near.dist) : "", s.l.law])]);
  };
  const areaProps = (r, x, inHa) => ({
    구역id: x.a.id, 이름: x.a.name, 종류: x.l.name, 세부구분: x.a.sub, 시도: x.a.sido, 시군구: x.a.sigg, 고시: x.a.notice, 비고: x.a.remark,
    면적_ha: x.a.ha, 이격거리_m: Math.round(x.dist), 방향: x.dir, 관계: x.rel,
    ...(r.hasPoly ? { 겹침면적_ha: x.ovHa === null ? null : round(x.ovHa, 4) } : {}),
    ...(r.hasLine ? { 통과길이_km: x.ovKm === null ? null : round(x.ovKm, 3) } : {}),
    ...(inHa !== undefined ? { 반경안면적_ha: inHa === null ? null : round(inHa, 4) } : {}),
    근거법령: x.l.law, 출처: ((x.fc.features[0] || {}).properties || {}).출처 || "국토교통부 브이월드(디지털트윈국토) 2D 데이터 API",
  });
  const areaFields = (r, clip) => [["구역id", "AREA_ID"], ["이름", "NAME"], ["종류", "TYPE"], ["세부구분", "SUBTYPE"], ["시도", "SIDO"], ["시군구", "SIGUNGU"],
    ["고시", "NOTICE"], ["비고", "REMARK"], ["면적_ha", "AREA_HA", "N", 14, 2], ["이격거리_m", "DIST_M", "N", 10, 0], ["방향", "DIRECTION"], ["관계", "RELATION"],
    ...(r.hasPoly ? [["겹침면적_ha", "OVLP_HA", "N", 14, 4]] : []), ...(r.hasLine ? [["통과길이_km", "OVLP_KM", "N", 10, 3]] : []),
    ...(clip ? [["반경안면적_ha", "IN_R_HA", "N", 14, 4]] : []), ["근거법령", "LAW"], ["출처", "SOURCE"]];
  // 보호구역 도형(필요하면 반경 경계에서 잘라 냄 — 한 번 자른 것은 기억)
  const areaFeatures = async (r, clip) => {
    const out = [];
    const bb = clip && r.buffer ? padBox(bboxOf([r.buffer]), 1e-3) : null;
    let t = performance.now();
    for (const x of r.rows) {
      let geom = areaFeature(x.fc).geometry, inHa;
      if (clip && r.buffer) {
        if (!r.clip.has(x.a.id)) {
          let g = null;
          try {
            const c = clipBox(feat(geom), bb);
            const y = c && turf.intersect(turf.featureCollection([c, r.buffer]));
            g = y ? y.geometry : null;
          } catch (err) { console.warn(err); g = undefined; }
          r.clip.set(x.a.id, g);
        }
        const g = r.clip.get(x.a.id);
        if (g === null) continue;   // 반경 밖(잘라 낸 뒤 남은 것이 없음)
        if (g) { geom = g; inHa = polyArea(g, r.o) / 1e4; } else inHa = null;   // 자르기에 실패하면 통째로
        if (performance.now() - t > 40) { await tick(); t = performance.now(); }
      }
      out.push(feat(geom, areaProps(r, x, clip ? inHa : undefined)));
    }
    return out;
  };
  const siteFeatures = (r) => {
    const name = r.name;
    return r.site.features.map((f, i) => {
      const k = kindOf(f.geometry);
      return feat(f.geometry, {
        이름: r.site.features.length > 1 ? `${name} ${i + 1}` : name, 모양: { point: "점", line: "선", polygon: "면" }[k],
        면적_ha: k === "polygon" ? round(polyArea(f.geometry, r.o) / 1e4, 4) : null, 길이_km: k === "line" ? round(lineLen(f.geometry) / 1000, 3) : null,
      });
    });
  };
  const SITE_FIELDS = [["이름", "NAME"], ["모양", "SHAPE"], ["면적_ha", "AREA_HA", "N", 14, 4], ["길이_km", "LEN_KM", "N", 10, 3]];
  const BUF_FIELDS = [["이름", "NAME"], ["반경_km", "RADIUS_KM", "N", 6, 2]];
  const readme = (r, clip, merge, out) => {
    const sm = summary(r);
    const site = siteFeatures(r);
    const lines = [
      "보호구역 이격거리 분석 결과",
      "=".repeat(30),
      `사업지: ${r.name} (${r.site.label})`,
      `사업지 도형: ${site.map((f) => `${f.properties.모양}${f.properties.면적_ha ? ` ${f.properties.면적_ha} ha` : ""}${f.properties.길이_km ? ` ${f.properties.길이_km} km` : ""}`).join(", ")}`,
      `반경: ${r.km} km`,
      `분석 일시: ${r.at.toLocaleString("ko-KR")}`,
      `경계 자료 기준: ${S.at ? new Date(S.at).toLocaleString("ko-KR") : "-"}`,
      `대상 보호구역: ${S.layers.filter((l) => r.types.includes(l.id)).map((l) => l.name).join(", ")}`,
      "",
      "[결과 요약]",
      `반경 안 보호구역 ${r.rows.length}곳, 그중 겹침·맞닿음·포함 ${r.rows.filter((x) => x.dist === 0).length}곳`,
      ...sm.rows.filter((s) => s.n).map((s) => `- ${s.l.name}: ${s.n}곳${s.hit ? ` (겹침·포함 ${s.hit}곳)` : ""}, 최단 ${s.first.dist > 0 ? `${Math.round(s.first.dist)} m` : `0 m(${s.first.rel})`}`),
      "",
      "[파일]",
      merge ? "- 보호구역_전체.shp: 반경 안 모든 보호구역" : "- <보호구역 종류>.shp: 반경 안 보호구역(종류별 한 파일)",
      `  속성: AREA_ID 구역 id, NAME 이름, TYPE 종류, SUBTYPE 세부 구분, SIDO 시도, SIGUNGU 시군구, NOTICE 고시, REMARK 비고, AREA_HA 구역 면적(ha),`,
      `        DIST_M 이격거리(m), DIRECTION 방향(8방위), RELATION 관계${r.hasPoly ? ", OVLP_HA 겹침 넓이(ha)" : ""}${r.hasLine ? ", OVLP_KM 통과 길이(km)" : ""}${clip ? ", IN_R_HA 반경 안 넓이(ha)" : ""}, LAW 근거 법령, SOURCE 출처`,
      clip ? "  보호구역 경계는 반경 경계에서 잘라 담았습니다(AREA_HA는 자르기 전 구역 전체 면적)." : "  보호구역 경계는 자르지 않고 구역 전체를 담았습니다.",
      "- 사업지*.shp: 사업지 도형, 반경_*.shp: 사업지에서 반경만큼 넓힌 범위",
      "- 이격거리_결과표.csv, 종류별_요약.csv: 엑셀에서 바로 열립니다(UTF-8).",
      `- 좌표계: ${out.name}. 한글 속성은 UTF-8(.cpg)입니다.`,
      "",
      "[계산 방법]",
      "- 이격거리: 사업지 경계(점·선·면)와 보호구역 경계 사이의 최단 거리. 겹치거나 맞닿거나 한쪽이 다른 쪽 안에 있으면 0 m.",
      "- 방향: 사업지에서 보호구역의 가장 가까운 지점을 바라본 8방위.",
      "- 거리·넓이는 사업지 중심 기준 평면(타원체 보정)으로 원본 해상도 경계를 써서 계산했으며, 측량 성과와 1 m 안팎 차이가 날 수 있습니다.",
      "",
      "[출처와 유의할 점]",
      "- 경계 출처: 국토교통부 브이월드(디지털트윈국토). 브이월드에 없는 종류만 한국보호지역 통합DB(KDPA, kdpa.kr)로 채웠습니다(구역마다 SOURCE 속성). 쓸 때 출처를 밝혀 주세요.",
      "- 이 경계는 참고 자료이며 법적 효력이 없습니다. 인허가·평가에는 지정 고시와 도면을 확인하세요.",
      `- ${NOT_IN}은 분석하지 못했습니다.`,
      "- 보호구역 종합포털 https://protect.biogrideia.com/#analyze",
    ];
    return "﻿" + lines.join("\r\n");
  };

  const download = async (kind) => {
    const r = A.result;
    if (!r) return;
    const clip = $("#an-clip").checked, merge = $("#an-merge").checked;
    const out = OUT_CRS.find((c) => c.id === $("#an-out-crs").value) || OUT_CRS[0];
    const base = `보호구역_이격거리_${safeName(r.name)}_${String(r.km).replace(".", "_")}km`;
    const btns = $$("[data-an-dl]");
    btns.forEach((b) => { b.disabled = true; });
    try {
      if (kind === "csv") { saveBlob(new Blob([resultCsv(r)], { type: "text/csv" }), `${base}_결과표.csv`); return; }
      toast(clip ? "반경 경계에서 잘라 파일을 만드는 중…" : "파일을 만드는 중…", 2500);
      await P.loadScript(LIB.turf, "turf");
      const areas = await areaFeatures(r, clip);
      const site = siteFeatures(r);
      const buf = r.buffer ? [feat(r.buffer.geometry, { 이름: `반경 ${r.km} km`, 반경_km: r.km })] : [];
      if (kind === "geojson") {
        const tag = (fs, what) => fs.map((f) => feat(f.geometry, { 구분: what, ...f.properties }));
        const fc = { type: "FeatureCollection", features: [...tag(site, "사업지"), ...tag(buf, "반경"), ...tag(areas, "보호구역")] };
        saveBlob(new Blob([JSON.stringify(fc)], { type: "application/geo+json" }), `${base}.geojson`);
        return;
      }
      if (kind === "kml") {
        const fs = [...site, ...buf, ...areas];
        saveBlob(new Blob([ShpWrite.kml(fs, "이름")], { type: "application/vnd.google-earth.kml+xml" }), `${base}.kml`);
        return;
      }
      await P.loadJSZip();
      let tf = (fs) => fs;
      if (out.def) {
        await P.loadScript(LIB.proj4, "proj4");
        const tr = proj4("WGS84", out.def);
        tf = (fs) => fs.map((f) => feat(mapGeom(f.geometry, (c) => tr.forward([c[0], c[1]])), f.properties));
      }
      const z = new JSZip();
      const dir = z.folder(base);
      const fields = areaFields(r, clip);
      if (merge) { if (areas.length) ShpWrite.addTo(dir, "보호구역_전체", tf(areas), fields, out.prj); }
      else {
        const by = new Map();
        areas.forEach((f) => { const k = f.properties.종류; if (!by.has(k)) by.set(k, []); by.get(k).push(f); });
        by.forEach((fs, k) => ShpWrite.addTo(dir, safeName(k), tf(fs), fields, out.prj));
      }
      // 사업지는 점·선·면을 따로(SHP 한 파일에는 한 가지 모양만)
      const kinds = { point: [], line: [], polygon: [] };
      site.forEach((f) => kinds[kindOf(f.geometry)].push(f));
      const used = Object.entries(kinds).filter(([, fs]) => fs.length);
      used.forEach(([k, fs]) => ShpWrite.addTo(dir, used.length > 1 ? `사업지_${{ point: "점", line: "선", polygon: "면" }[k]}` : "사업지", tf(fs), SITE_FIELDS, out.prj));
      if (buf.length) ShpWrite.addTo(dir, `반경_${String(r.km).replace(".", "_")}km`, tf(buf), BUF_FIELDS, out.prj);
      dir.file("이격거리_결과표.csv", resultCsv(r));
      dir.file("종류별_요약.csv", summaryCsv(r));
      dir.file("읽어보기.txt", readme(r, clip, merge, out));
      saveBlob(await z.generateAsync({ type: "blob", compression: "DEFLATE" }), `${base}.zip`);
    } catch (err) {
      console.error(err);
      toast(err.message || "파일을 만들지 못했습니다.", 5000);
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  };

  // ---------- 화면 ----------
  const bindUI = () => {
    if (!VW_KEY) $("#an-addr-note").textContent = "오픈스트리트맵(Nominatim)으로 찾으며 검색어가 그 서버로 갑니다. 한국 주소는 못 찾는 경우가 많으니 장소 이름으로 찾거나 ‘지도에 그리기’에서 점을 찍으세요.";
    const crsOpts = (list) => list.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("#an-crs").innerHTML = crsOpts(CRS);
    $("#an-file-crs").innerHTML = crsOpts(CRS.filter((c) => c.def));
    $("#an-file-crs").value = "5186";
    $("#an-crs").onchange = () => { $("#an-order-row").hidden = $("#an-crs").value === "4326"; };
    // 입력 방법 고르기
    $("#an-src").addEventListener("click", (e) => {
      const b = e.target.closest("[data-src]");
      if (!b) return;
      $$("#an-src button").forEach((x) => x.classList.toggle("on", x === b));
      $$(".an-pane").forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.src; });
      if (b.dataset.src !== "draw") stopDraw();
    });
    $("#an-addr-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = $("#an-addr").value.trim();
      if (!q) return;
      const btn = $("#an-addr-form button");
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 1100);   // 검색 서버 이용 규칙(초당 1번)
      searchAddr(q);
    });
    $("#an-addr-res").addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (!b) return;
      const x = addrList[Number(b.dataset.i)];
      if (!$("#an-name").value.trim()) $("#an-name").value = x.name.slice(0, 40);
      setSite([feat({ type: "Point", coordinates: [x.lon, x.lat] })], `주소 검색(${x.kind}): ${x.name}${x.sub ? ` · ${x.sub}` : ""}`);
      $("#an-addr-res").hidden = true;
    });
    $("#an-coord-go").onclick = useCoords;
    $$("[data-draw]").forEach((b) => { b.onclick = () => startDraw(b.dataset.draw); });
    $("#an-draw-done").onclick = finishDraw;
    $("#an-draw-undo").onclick = () => { D.pts.pop(); redrawTmp(); };
    $("#an-draw-cancel").onclick = stopDraw;
    // 파일
    $("#an-file").addEventListener("change", (e) => { readFiles(e.target.files); e.target.value = ""; });
    const drop = $("#an-drop");
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
    drop.addEventListener("drop", (e) => { e.preventDefault(); readFiles(e.dataTransfer.files); });
    $("#an-file-crs").onchange = () => { if (A.raw) buildFromRaw(); };
    // 반경
    $("#an-chips").innerHTML = PRESETS.map((k) => `<button class="chip" data-km="${k}">${k} km</button>`).join("");
    const syncChips = () => { const v = parseFloat($("#an-radius").value); $$("#an-chips .chip").forEach((c) => c.classList.toggle("on", Number(c.dataset.km) === v)); };
    $("#an-chips").addEventListener("click", (e) => { const c = e.target.closest("[data-km]"); if (!c) return; $("#an-radius").value = c.dataset.km; syncChips(); });
    $("#an-radius").addEventListener("input", syncChips);
    syncChips();
    // 보호구역 종류
    $("#an-types").innerHTML = Object.entries(S.groups).map(([g, label]) => {
      const items = S.layers.filter((l) => l.group === g);
      return items.length ? `<div class="layer-group-title">${esc(label)}</div>` + items.map((l) => `<label title="${esc(l.law)}"><input type="checkbox" value="${l.id}" checked>
        <span class="swatch" style="background:${l.color}"></span>${esc(l.name)}</label>`).join("") : "";
    }).join("");
    $("#an-types-all").onclick = () => $$("#an-types input").forEach((i) => { i.checked = true; });
    $("#an-types-none").onclick = () => $$("#an-types input").forEach((i) => { i.checked = false; });
    $("#an-run").onclick = run;
    // 결과
    $("#an-result").addEventListener("click", (e) => {
      const d = e.target.closest("[data-an-dl]");
      if (d) { download(d.dataset.anDl); return; }
      const th = e.target.closest("#an-table th[data-sort]");
      if (th) {
        A.sort = { key: th.dataset.sort, dir: A.sort.key === th.dataset.sort ? -A.sort.dir : 1 };
        renderTable();
        return;
      }
      const tr = e.target.closest("#an-rows tr[data-i]");
      if (tr) select(Number(tr.dataset.i));
    });
  };

  const show = () => {
    if (!A.inited) {
      A.inited = true;
      initMap();
      bindUI();
    }
    setTimeout(() => A.map.invalidateSize(), 30);
  };
  window.Analyze = { show };
})();
