// 브라우저에서 GeoJSON(폴리곤) → ESRI Shapefile(.shp/.shx/.dbf/.prj/.cpg) zip 만들기
// 좌표계는 WGS84(EPSG:4326). 속성은 UTF-8(.cpg)로 저장해 QGIS·ArcGIS에서 한글이 깨지지 않게 함.
window.ShpWrite = (() => {
  const PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const enc = new TextEncoder();

  // 고리 넓이(부호) — 양수면 반시계
  const signedArea = (ring) => {
    let s = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    return s / 2;
  };
  // Shapefile 규칙: 바깥 고리는 시계 방향, 구멍은 반시계 방향
  const orient = (ring, clockwise) => {
    const cw = signedArea(ring) < 0;
    return cw === clockwise ? ring : ring.slice().reverse();
  };
  const partsOf = (geom) => {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    const parts = [];
    polys.forEach((poly) => poly.forEach((ring, k) => parts.push(orient(ring, k === 0))));
    return parts;
  };

  const shpFiles = (features, fields) => {
    const recs = features.map((f) => {
      const parts = partsOf(f.geometry);
      const pts = parts.flat();
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const box = pts.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 0, 0];
      return { parts, n: pts.length, box };
    });
    const contentLen = recs.map((r) => 4 + 32 + 4 + 4 + 4 * r.parts.length + 16 * r.n);   // 바이트
    const shpLen = 100 + contentLen.reduce((a, c) => a + 8 + c, 0);
    const shp = new DataView(new ArrayBuffer(shpLen));
    const shx = new DataView(new ArrayBuffer(100 + 8 * recs.length));
    const all = recs.filter((r) => r.n).map((r) => r.box);
    const bbox = all.length ? [Math.min(...all.map((b) => b[0])), Math.min(...all.map((b) => b[1])), Math.max(...all.map((b) => b[2])), Math.max(...all.map((b) => b[3]))] : [0, 0, 0, 0];
    const header = (dv, lenBytes) => {
      dv.setInt32(0, 9994, false);
      dv.setInt32(24, lenBytes / 2, false);
      dv.setInt32(28, 1000, true);
      dv.setInt32(32, 5, true);   // Polygon
      bbox.forEach((v, i) => dv.setFloat64(36 + 8 * i, v, true));
    };
    header(shp, shpLen);
    header(shx, 100 + 8 * recs.length);
    let off = 100;
    recs.forEach((r, i) => {
      shx.setInt32(100 + 8 * i, off / 2, false);
      shx.setInt32(104 + 8 * i, contentLen[i] / 2, false);
      shp.setInt32(off, i + 1, false);
      shp.setInt32(off + 4, contentLen[i] / 2, false);
      let o = off + 8;
      shp.setInt32(o, 5, true); o += 4;
      r.box.forEach((v) => { shp.setFloat64(o, v, true); o += 8; });
      shp.setInt32(o, r.parts.length, true); o += 4;
      shp.setInt32(o, r.n, true); o += 4;
      let start = 0;
      r.parts.forEach((p) => { shp.setInt32(o, start, true); o += 4; start += p.length; });
      r.parts.forEach((p) => p.forEach(([x, y]) => { shp.setFloat64(o, x, true); shp.setFloat64(o + 8, y, true); o += 16; }));
      off += 8 + contentLen[i];
    });

    // dBase III — 모든 속성은 문자(C), 길이는 UTF-8 바이트 기준(최대 254)
    const vals = features.map((f) => fields.map(([k]) => enc.encode(String(f.properties[k] ?? ""))));
    const lens = fields.map((_, j) => Math.max(1, Math.min(254, ...vals.map((v) => v[j].length))));
    const recLen = 1 + lens.reduce((a, b) => a + b, 0);
    const hdrLen = 32 + 32 * fields.length + 1;
    const dbf = new Uint8Array(hdrLen + recLen * features.length + 1);
    const dv = new DataView(dbf.buffer);
    const now = new Date();
    dbf[0] = 3; dbf[1] = now.getFullYear() - 1900; dbf[2] = now.getMonth() + 1; dbf[3] = now.getDate();
    dv.setInt32(4, features.length, true);
    dv.setInt16(8, hdrLen, true);
    dv.setInt16(10, recLen, true);
    fields.forEach(([, name], j) => {
      const base = 32 + 32 * j;
      const nm = enc.encode(name).slice(0, 10);
      dbf.set(nm, base);
      dbf[base + 11] = 67;   // 'C'
      dbf[base + 16] = lens[j];
    });
    dbf[hdrLen - 1] = 0x0d;
    vals.forEach((row, i) => {
      let o = hdrLen + i * recLen;
      dbf[o++] = 0x20;
      row.forEach((b, j) => {
        const cut = b.slice(0, lens[j]);
        dbf.set(cut, o);
        dbf.fill(0x20, o + cut.length, o + lens[j]);
        o += lens[j];
      });
    });
    dbf[dbf.length - 1] = 0x1a;
    return { shp: shp.buffer, shx: shx.buffer, dbf, prj: PRJ, cpg: "UTF-8" };
  };

  // features: GeoJSON Feature 배열, fields: [[속성 키, dbf 필드 이름(영문 10자 이내)], …], name: 파일 이름(확장자 제외)
  const zip = async (features, fields, name) => {
    const files = shpFiles(features, fields);
    const z = new JSZip();
    ["shp", "shx", "dbf", "prj", "cpg"].forEach((ext) => z.file(`${name}.${ext}`, files[ext]));
    return z.generateAsync({ type: "blob", compression: "DEFLATE" });
  };

  const kml = (features, nameKey) => {
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const ring = (r) => `<LinearRing><coordinates>${r.map(([x, y]) => `${x},${y}`).join(" ")}</coordinates></LinearRing>`;
    const poly = (p) => `<Polygon><outerBoundaryIs>${ring(p[0])}</outerBoundaryIs>${p.slice(1).map((h) => `<innerBoundaryIs>${ring(h)}</innerBoundaryIs>`).join("")}</Polygon>`;
    const geom = (g) => (g.type === "Polygon" ? poly(g.coordinates) : `<MultiGeometry>${g.coordinates.map(poly).join("")}</MultiGeometry>`);
    const pm = features.map((f) => `<Placemark><name>${esc(f.properties[nameKey])}</name><ExtendedData>${Object.entries(f.properties)
      .map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`).join("")}</ExtendedData>${geom(f.geometry)}</Placemark>`).join("");
    return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${pm}</Document></kml>`;
  };

  return { zip, kml };
})();
