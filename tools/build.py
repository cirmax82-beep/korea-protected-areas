"""받은 경계(work/raw)를 구역 단위로 묶어 사이트용 파일과 내려받기 파일을 만듭니다.

    python tools/build.py

만드는 것
- data/index.json          : 레이어 목록과 구역 목록(이름·세부 구분·시도·시군구·고시·면적·범위)
- data/map/<레이어>.json    : 지도 표시용(간소화한 경계)
- data/area/<구역 id>.json  : 구역별 원본 해상도 경계 — 구역 상세 지도와 구역별 SHP·GeoJSON·KML 내려받기에 씀
- work/release/            : 종류별 SHP(zip)·GeoJSON(zip)과 전체 GeoPackage(zip) — GitHub 릴리스로 올림(저장소 밖)

구역 묶기
- 공원(park_name)·연안습지(name): 이름별
- 용도지역지구 레이어: 세부 구분(uname) + 시도 + 시군구 + 고시 연도·번호별
구역 id는 묶는 값으로 만든 해시라 다시 만들어도 같습니다(바뀌지 않은 구역은 파일도 그대로).
"""
import hashlib
import json
import re
import shutil
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
import shapely
from shapely.geometry import mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layers import GROUPS, LAYERS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "work" / "raw"
DATA = ROOT / "data"
REL = ROOT / "work" / "release"
SOURCE = "국토교통부 브이월드(디지털트윈국토) 2D 데이터 API"
SIMPLIFY = {"forest": 0.0004, "natenv": 0.0004, "greenbelt": 0.0004, "water": 0.0003, "protect-district": 0.0003}
SHORT_SIDO = {
    "서울특별시": "서울", "부산광역시": "부산", "대구광역시": "대구", "인천광역시": "인천", "광주광역시": "광주", "대전광역시": "대전",
    "울산광역시": "울산", "세종특별자치시": "세종", "경기도": "경기", "강원특별자치도": "강원", "강원도": "강원", "충청북도": "충북",
    "충청남도": "충남", "전북특별자치도": "전북", "전라북도": "전북", "전라남도": "전남", "전남광주통합특별시": "전남광주",
    "경상북도": "경북", "경상남도": "경남", "제주특별자치도": "제주",
}


def rnd(coords, nd):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], nd), round(coords[1], nd)]
    return [rnd(c, nd) for c in coords]


def geojson_geom(geom, nd):
    if geom is None or geom.is_empty:
        return None
    m = mapping(geom)
    if m["type"] == "Polygon":
        m = {"type": "MultiPolygon", "coordinates": [m["coordinates"]]}
    if m["type"] == "GeometryCollection":   # 고친 도형에 선·점이 섞이면 면만 남김
        polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        return geojson_geom(shapely.union_all(polys), nd) if polys else None
    return {"type": m["type"], "coordinates": rnd(m["coordinates"], nd)}


def clean(v):
    v = "" if v is None else str(v).strip()
    if v in ("0000", "None", "nan"):
        return ""
    # 원자료에서 가운뎃점(·)이 '?'로 깨진 경우가 있어 한글 사이의 '?'는 '·'로 되돌림
    return re.sub(r"(?<=[가-힣])\?(?=[가-힣])", "·", v)


def notice_text(year, num):
    year, num = clean(year), clean(num)
    if not year:
        return ""
    return f"{year}년 고시" + (f" 제{int(num)}호" if num.isdigit() and int(num) else "")


GENERIC = re.compile(r"(\d+\s*m|이내|영향|검토|보존지역|보호구역|문화재구역|^\d+구역$|^기타$)")


def heritage_hint(alias, remark):
    """국가유산 레이어: 별칭·비고에서 문화재 이름을 뽑음(‘삼척 죽서루(국보)’ → ‘삼척 죽서루’, ‘…:1구역’ → 앞부분)."""
    alias, remark = clean(alias), clean(remark)
    if re.search(r"(고시|개소|조정|변경)", alias):   # 별칭 자리에 고시 제목이 들어간 경우는 비고를 씀
        alias = ""
    for v in (alias, remark):
        if v.count("?") >= 2:
            continue
        v = re.sub(r"^(기념물|유형문화재|민속문화재|문화재자료|사적|명승|천연기념물|등록문화재)_", "", v)
        v = re.split(r"[:：]", v)[0]
        v = re.sub(r"\s*[\(\[](?:\d+구역|국보|보물[^)\]]*|사적[^)\]]*|명승[^)\]]*|천연기념물[^)\]]*)[\)\]]", "", v)
        v = re.sub(r"\s*\d+구역$", "", v).strip()
        if v and not GENERIC.search(v) and len(v) <= 40:
            return v
    return ""


def group_areas(layer, gdf):
    """레이어 하나 → 구역 목록 [(키 dict, 도형, 비고 목록)]"""
    cols = set(gdf.columns)
    gdf = gdf.copy()
    if layer.get("keep") and "uname" in cols:
        gdf = gdf[gdf["uname"].isin(layer["keep"])]
    if "park_name" in cols:
        keys = ["park_name"]
    elif "name" in cols:
        keys = ["name"]
    elif "project" in cols:
        keys = ["project"]
    else:
        keys = [k for k in ("uname", "sido_name", "sigg_name", "dyear", "dnum") if k in cols]
        if layer["id"] == "heritage":
            gdf["hint"] = [heritage_hint(a, r) for a, r in zip(gdf.get("alias", ""), gdf.get("remark", ""))]
            keys.append("hint")
    for k in keys:
        gdf[k] = gdf[k].fillna("").astype(str)
    out = []
    for vals, part in gdf.groupby(keys, sort=True):
        vals = vals if isinstance(vals, tuple) else (vals,)
        key = {k: (clean(v) if k in ("park_name", "name", "uname", "sigg_name", "sido_name", "project") else v) for k, v in zip(keys, vals)}
        remarks = sorted({clean(r) for r in part.get("remark", pd.Series([], dtype=str)).tolist() if clean(r)})[:5]
        aliases = sorted({clean(r) for r in part.get("alias", pd.Series([], dtype=str)).tolist() if clean(r)})[:5]
        geom = shapely.union_all(shapely.make_valid(part.geometry.values))
        out.append((key, geom, remarks + [a for a in aliases if a not in remarks]))
    return out


def area_name(layer, key, remarks):
    if "park_name" in key:
        return f"{key['park_name'] or '이름 미상'} {layer['name']}"
    if "name" in key:
        return key["name"]
    if "project" in key:
        return f"{key['project']} {layer['name']}"
    if key.get("hint"):
        return f"{key['hint']} ({key.get('uname') or layer['name']})"
    sub = key.get("uname", "").replace("·", "·")
    # 비고에 고유 이름이 적힌 경우(예: '철원 이길리 습지보호지역')
    named = [r for r in remarks if re.search(r"(습지|보호구역|보호지역|보전지역|공원)$", r) and len(r) <= 40]
    if named:
        return named[0]
    sido = SHORT_SIDO.get(key.get("sido_name", ""), key.get("sido_name", ""))
    return " ".join(x for x in (sido, key.get("sigg_name", ""), sub or layer["name"]) if x)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    started = time.time()
    (DATA / "map").mkdir(parents=True, exist_ok=True)
    area_dir = DATA / "area"
    if area_dir.exists():
        shutil.rmtree(area_dir)
    area_dir.mkdir(parents=True)
    if REL.exists():
        shutil.rmtree(REL)
    REL.mkdir(parents=True)

    layers_out, areas_out, gpkg_frames = [], [], []
    for li, layer in enumerate(LAYERS):
        src = RAW / f"{layer['id']}.geojson"
        if not src.exists():
            print(f"  {layer['name']}: 받은 자료 없음 — 건너뜀")
            continue
        gdf = gpd.read_file(src, engine="pyogrio")
        if gdf.empty:
            print(f"  {layer['name']}: 0개 — 건너뜀")
            continue
        gdf = gdf.set_crs(4326, allow_override=True)
        groups = group_areas(layer, gdf)
        tol = SIMPLIFY.get(layer["id"], 0.0002)
        rows, map_feats = [], []
        for key, geom, remarks in groups:
            if geom.is_empty:
                continue
            aid = layer["id"] + "-" + hashlib.sha1(json.dumps(key, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:8]
            name = area_name(layer, key, remarks)
            area_ha = round(gpd.GeoSeries([geom], crs=4326).to_crs(5179).area.iloc[0] / 1e4, 2)
            minx, miny, maxx, maxy = (round(v, 5) for v in geom.bounds)
            props = {
                "구역id": aid, "이름": name, "종류": layer["name"], "세부구분": key.get("uname", ""),
                "시도": key.get("sido_name", ""), "시군구": key.get("sigg_name", ""),
                "고시": notice_text(key.get("dyear"), key.get("dnum")), "비고": "; ".join(remarks)[:200],
                "면적_ha": area_ha, "근거법령": layer["law"], "출처": SOURCE,
            }
            # 소수점 6자리(약 10cm) 격자에 맞추면서 꼬임 없이 유효한 도형으로(반올림만 하면 드물게 꼬임)
            full = geojson_geom(shapely.set_precision(geom, 1e-6), 6) or geojson_geom(geom, 6)
            if not full:
                continue
            (area_dir / f"{aid}.json").write_text(json.dumps({"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": props, "geometry": full}]}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            idx = len(areas_out)
            areas_out.append([aid, li, name, key.get("uname", ""), key.get("sido_name", ""), key.get("sigg_name", ""),
                              notice_text(key.get("dyear"), key.get("dnum")), area_ha, [minx, miny, maxx, maxy], props["비고"]])
            # 줄인 경계는 조각끼리 겹치거나 꼬일 수 있어 1m 격자에 맞춰 바로잡음(지도에서 빈 삼각형처럼 보이는 것 방지)
            simple = (geojson_geom(shapely.set_precision(geom.simplify(tol, preserve_topology=True), 1e-5), 5)
                      or geojson_geom(shapely.set_precision(geom, 1e-6), 6))   # 아주 작은 구역은 줄이면 사라지므로 원본으로
            if simple:
                map_feats.append({"type": "Feature", "properties": {"i": idx}, "geometry": simple})
            rows.append({**props, "geometry": geom})
        (DATA / "map" / f"{layer['id']}.json").write_text(json.dumps({"type": "FeatureCollection", "features": map_feats},
                                                                      separators=(",", ":")), encoding="utf-8")
        # 종류별 전체 파일(릴리스용): SHP는 필드 이름 10자 제한이라 영문 약어로
        full_gdf = gpd.GeoDataFrame(rows, crs=4326)
        shp_gdf = full_gdf.rename(columns={"구역id": "AREA_ID", "이름": "NAME", "종류": "TYPE", "세부구분": "SUBTYPE", "시도": "SIDO",
                                           "시군구": "SIGUNGU", "고시": "NOTICE", "비고": "REMARK", "면적_ha": "AREA_HA",
                                           "근거법령": "LAW", "출처": "SOURCE"})
        shp_dir = REL / layer["id"]
        shp_dir.mkdir()
        shp_gdf.to_file(shp_dir / f"{layer['id']}.shp", engine="pyogrio", encoding="UTF-8")
        (shp_dir / f"{layer['id']}.cpg").write_text("UTF-8", encoding="ascii")
        with zipfile.ZipFile(REL / f"{layer['id']}-shp.zip", "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(shp_dir.iterdir()):
                z.write(f, f.name)
        shutil.rmtree(shp_dir)
        gj = REL / f"{layer['id']}.geojson"
        full_gdf.to_file(gj, driver="GeoJSON", engine="pyogrio", COORDINATE_PRECISION=6)
        with zipfile.ZipFile(REL / f"{layer['id']}-geojson.zip", "w", zipfile.ZIP_DEFLATED) as z:
            z.write(gj, gj.name)
        gj.unlink()
        gpkg_frames.append((layer["id"], full_gdf))
        total_ha = round(sum(r["면적_ha"] for r in rows), 1)
        layers_out.append({**layer, "count": len(rows), "area_ha": total_ha,
                           "shp_mb": round((REL / f"{layer['id']}-shp.zip").stat().st_size / 1e6, 2),
                           "geojson_mb": round((REL / f"{layer['id']}-geojson.zip").stat().st_size / 1e6, 2),
                           "map_mb": round((DATA / "map" / f"{layer['id']}.json").stat().st_size / 1e6, 2)})
        print(f"  {layer['name']}: 조각 {len(gdf):,} → 구역 {len(rows):,} · 지도 {layers_out[-1]['map_mb']} MB · SHP {layers_out[-1]['shp_mb']} MB", flush=True)

    # 전체를 한 GeoPackage로(레이어별 표)
    gpkg = REL / "protected-areas.gpkg"
    for lid, frame in gpkg_frames:
        frame.to_file(gpkg, layer=lid, driver="GPKG", engine="pyogrio")
    with zipfile.ZipFile(REL / "protected-areas-gpkg.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.write(gpkg, gpkg.name)
    gpkg.unlink()

    (DATA / "index.json").write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": SOURCE, "groups": GROUPS, "layers": layers_out,
        "columns": ["id", "layer", "name", "sub", "sido", "sigg", "notice", "area_ha", "bbox", "remark"],
        "areas": areas_out,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size = lambda p: sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / 1e6  # noqa: E731
    print(f"구역 {len(areas_out):,}곳 · data {size(DATA):.1f} MB(구역별 {size(area_dir):.1f} MB) · 릴리스 {size(REL):.1f} MB · {time.time() - started:.0f}초")


if __name__ == "__main__":
    main()
