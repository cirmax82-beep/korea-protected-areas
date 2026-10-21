// 브라우저에서 GeoJSON → ESRI Shapefile(.shp/.shx/.dbf/.prj/.cpg) 만들기
// 면(Polygon·MultiPolygon), 선(LineString·MultiLineString), 점(Point)을 지원합니다. 기본 좌표계는 WGS84(EPSG:4326).
// 속성은 UTF-8(.cpg)로 저장해 QGIS·ArcGIS에서 한글이 깨지지 않게 함.
window.ShpWrite = (() => {
  const PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const enc = new TextEncoder();
  const LINE = new Set(["LineString", "MultiLineString"]);

  // 고리 넓이(부호) — 양수면 반시계
  const signedArea = (ring) => {
    let s = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    return s / 2;
  };
  // Shapefile 규칙: 바깥 고리는 시계 방향, 구멍은 반시계 방향
  const orient = (ring, clockwise) => ((signedArea(ring) < 0) === clockwise ? ring : ring.slice().reverse());
  const partsOf = (geom) => {
    if (geom.type === "LineString") return [geom.coordinates];
    if (geom.type === "MultiLineString") return geom.coordinates;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    const parts = [];
    polys.forEach((poly) => poly.forEach((ring, k) => parts.push(orient(ring, k === 0))));
    return parts;
  };

  // fields: [[속성 키, 필드 이름(영문 10자 이내)], …] — 문자(C). 숫자는 [키, 이름, "N", 길이, 소수 자리]
  const dbfOf = (features, fields) => {
    const isNum = (fd) => fd[2] === "N";
    const cell = (fd, f) => {
      const v = f.properties[fd[0]];
      if (!isNum(fd)) return enc.encode(String(v ?? ""));
      return enc.encode(v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "" : Number(v).toFixed(fd[4] || 0)).slice(0, fd[3]);
    };
    const vals = features.map((f) => fields.map((fd) => cell(fd, f)));
    const lens = fields.map((fd, j) => (isNum(fd) ? fd[3] : Math.min(254, vals.reduce((m, v) => Math.max(m, v[j].length), 1))));
    const recLen = 1 + lens.reduce((a, b) => a + b, 0);
    const hdrLen = 32 + 32 * fields.length + 1;
    const dbf = new Uint8Array(hdrLen + recLen * features.length + 1);
    const dv = new DataView(dbf.buffer);
    const now = new Date();
    dbf[0] = 3; dbf[1] = now.getFullYear() - 1900; dbf[2] = now.getMonth() + 1; dbf[3] = now.getDate();
    dv.setInt32(4, features.length, true);
    dv.setInt16(8, hdrLen, true);
    dv.setInt16(10, recLen, true);
    fields.forEach((fd, j) => {
      const base = 32 + 32 * j;
      dbf.set(enc.encode(fd[1]).slice(0, 10), base);
      dbf[base + 11] = isNum(fd) ? 78 : 67;   // 'N' 또는 'C'
      dbf[base + 16] = lens[j];
      dbf[base + 17] = isNum(fd) ? fd[4] || 0 : 0;
    });
    dbf[hdrLen - 1] = 0x0d;
    vals.forEach((row, i) => {
      let o = hdrLen + i * recLen;
      dbf[o++] = 0x20;
      row.forEach((b, j) => {
        const cut = b.slice(0, lens[j]);
        if (isNum(fields[j])) {   // 숫자는 오른쪽 맞춤
          dbf.fill(0x20, o, o + lens[j] - cut.length);
          dbf.set(cut, o + lens[j] - cut.length);
        } else {
          dbf.set(cut, o);
          dbf.fill(0x20, o + cut.length, o + lens[j]);
        }
        o += lens[j];
      });
    });
    dbf[dbf.length - 1] = 0x1a;
    return dbf;
  };

  const files = (features, fields, prj = PRJ) => {
    const kind = features.length && features.every((f) => f.geometry.type === "Point") ? 1
      : features.length && features.every((f) => LINE.has(f.geometry.type)) ? 3 : 5;
    const recs = features.map((f) => {
      if (kind === 1) {
        const [x, y] = f.geometry.coordinates;
        return { pt: [x, y], box: [x, y, x, y], len: 20 };
      }
      const parts = partsOf(f.geometry);
      // 꼭짓점이 아주 많은 구역도 있어 펼치기(...) 대신 반복문으로 범위를 구함
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      let n = 0;
      parts.forEach((p) => p.forEach(([x, y]) => {
        n++;
        if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y;
        if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
      }));
      return { parts, n, box: n ? box : [0, 0, 0, 0], len: 4 + 32 + 4 + 4 + 4 * parts.length + 16 * n };
    });
    const shpLen = 100 + recs.reduce((a, r) => a + 8 + r.len, 0);
    const shp = new DataView(new ArrayBuffer(shpLen));
    const shx = new DataView(new ArrayBuffer(100 + 8 * recs.length));
    const bbox = recs.length ? recs.reduce((b, r) => [Math.min(b[0], r.box[0]), Math.min(b[1], r.box[1]), Math.max(b[2], r.box[2]), Math.max(b[3], r.box[3])],
      [Infinity, Infinity, -Infinity, -Infinity]) : [0, 0, 0, 0];
    const header = (dv, lenBytes) => {
      dv.setInt32(0, 9994, false);
      dv.setInt32(24, lenBytes / 2, false);
      dv.setInt32(28, 1000, true);
      dv.setInt32(32, kind, true);
      bbox.forEach((v, i) => dv.setFloat64(36 + 8 * i, v, true));
    };
    header(shp, shpLen);
    header(shx, 100 + 8 * recs.length);
    let off = 100;
    recs.forEach((r, i) => {
      shx.setInt32(100 + 8 * i, off / 2, false);
      shx.setInt32(104 + 8 * i, r.len / 2, false);
      shp.setInt32(off, i + 1, false);
      shp.setInt32(off + 4, r.len / 2, false);
      let o = off + 8;
      if (kind === 1) {
        shp.setInt32(o, 1, true);
        shp.setFloat64(o + 4, r.pt[0], true);
        shp.setFloat64(o + 12, r.pt[1], true);
      } else {
        shp.setInt32(o, kind, true); o += 4;
        r.box.forEach((v) => { shp.setFloat64(o, v, true); o += 8; });
        shp.setInt32(o, r.parts.length, true); o += 4;
        shp.setInt32(o, r.n, true); o += 4;
        let start = 0;
        r.parts.forEach((p) => { shp.setInt32(o, start, true); o += 4; start += p.length; });
        r.parts.forEach((p) => p.forEach(([x, y]) => { shp.setFloat64(o, x, true); shp.setFloat64(o + 8, y, true); o += 16; }));
      }
      off += 8 + r.len;
    });
    return { shp: shp.buffer, shx: shx.buffer, dbf: dbfOf(features, fields), prj, cpg: "UTF-8" };
  };

  // 이미 만든 JSZip에 shapefile 한 벌(path.shp 등)을 넣음. prj를 주면 그 좌표계로 적음(좌표는 미리 바꿔 둘 것)
  const addTo = (zip, path, features, fields, prj) => {
    const f = files(features, fields, prj);
    ["shp", "shx", "dbf", "prj", "cpg"].forEach((ext) => zip.file(`${path}.${ext}`, f[ext]));
  };

  // features: GeoJSON Feature 배열, fields: [[속성 키, dbf 필드 이름(영문 10자 이내)], …], name: 파일 이름(확장자 제외)
  const zip = async (features, fields, name) => {
    const z = new JSZip();
    addTo(z, name, features, fields);
    return z.generateAsync({ type: "blob", compression: "DEFLATE" });
  };

  const kml = (features, nameKey) => {
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const xy = (cs) => cs.map(([x, y]) => `${x},${y}`).join(" ");
    const ring = (r) => `<LinearRing><coordinates>${xy(r)}</coordinates></LinearRing>`;
    const poly = (p) => `<Polygon><outerBoundaryIs>${ring(p[0])}</outerBoundaryIs>${p.slice(1).map((h) => `<innerBoundaryIs>${ring(h)}</innerBoundaryIs>`).join("")}</Polygon>`;
    const line = (l) => `<LineString><coordinates>${xy(l)}</coordinates></LineString>`;
    const point = (p) => `<Point><coordinates>${p[0]},${p[1]}</coordinates></Point>`;
    const geom = (g) => {
      switch (g.type) {
        case "Point": return point(g.coordinates);
        case "MultiPoint": return `<MultiGeometry>${g.coordinates.map(point).join("")}</MultiGeometry>`;
        case "LineString": return line(g.coordinates);
        case "MultiLineString": return `<MultiGeometry>${g.coordinates.map(line).join("")}</MultiGeometry>`;
        case "Polygon": return poly(g.coordinates);
        default: return `<MultiGeometry>${g.coordinates.map(poly).join("")}</MultiGeometry>`;
      }
    };
    const pm = features.map((f) => `<Placemark><name>${esc(f.properties[nameKey])}</name><ExtendedData>${Object.entries(f.properties)
      .map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`).join("")}</ExtendedData>${geom(f.geometry)}</Placemark>`).join("");
    return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${pm}</Document></kml>`;
  };

  return { zip, addTo, files, kml, PRJ };
})();
