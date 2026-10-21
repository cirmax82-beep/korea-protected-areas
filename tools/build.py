"""받은 경계(work/raw)를 구역 단위로 묶어 사이트용 파일과 내려받기 파일을 만듭니다.

    python tools/build.py

만드는 것
- data/index.json          : 레이어 목록과 구역 목록(이름·세부 구분·시도·시군구·고시·면적·범위)
- data/map/<레이어>.json    : 지도 표시용(간소화한 경계)
- data/area/<구역 id>.json  : 구역별 원본 해상도 경계 — 구역 상세 지도와 구역별 SHP·GeoJSON·KML 내려받기에 씀
- work/release/            : 종류별 SHP(zip)·GeoJSON(zip)과 전체 GeoPackage(zip) — GitHub 릴리스로 올림(저장소 밖)

구역 묶기
- 공원(park_name)·연안습지(name)·해양보호구역(mpa_nam): 이름별
- 용도지역지구 레이어: 세부 구분(uname) + 시도 + 시군구 + 고시 연도·번호별
- KDPA(work/raw/kdpa.gpkg): 보호지역 하나가 구역 하나. 브이월드에 같은 종류가 있으면 브이월드 구역과 절반 넘게 겹치는 것은 빼고 더함
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
import numpy as np
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


# 옛 이름·줄임말을 다른 레이어가 쓰는 지금 시도 이름으로(해양보호구역의 위치 글에서 시도를 뽑을 때)
SIDO_NOW = {
    "부산": "부산광역시", "인천": "인천광역시", "경기": "경기도", "강원": "강원특별자치도", "강원도": "강원특별자치도",
    "충남": "충청남도", "전북": "전북특별자치도", "전라북도": "전북특별자치도", "전남": "전남광주통합특별시", "전라남도": "전남광주통합특별시",
    "경북": "경상북도", "경남": "경상남도", "제주": "제주특별자치도",
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


def polygonal(geom):
    """고친 도형(make_valid)에 선·점이 섞여 GeometryCollection이 되면 면만 남김"""
    if geom is not None and geom.geom_type == "GeometryCollection":
        polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        return shapely.union_all(polys) if polys else shapely.Polygon()
    return geom


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


def prepare(layer, gdf):
    """레이어마다 다른 속성을 공통 이름(name·uname·sido_name·sigg_name·notice·remark)으로 맞춤"""
    if layer["id"] == "marine-mpa":
        # 예: mpa_nam '보령소황사구해역 해양보호구역(경관)', gos_num '해양수산부고시제2018-135호', gos_dat '20181130', loc '충청남도 보령시 …'
        gdf["name"] = gdf["mpa_nam"].map(clean)
        # 이 자료에는 연안습지보호지역도 함께 들어 있는데, 이미 ‘연안습지보호지역’ 레이어에 있으므로 뺌
        gdf = gdf[~gdf["name"].str.contains("습지보호")].copy()
        kinds = []
        for n in gdf["name"]:
            m = re.search(r"(해양생태계|해양생물|해양경관)보호구역", n) or re.search(r"\((경관|해양생물|해양생태계)\)\s*$", n)
            k = m.group(1) if m else ""
            kinds.append(f"{k if k.startswith('해양') else '해양' + k}보호구역" if k else "")
        gdf["uname"] = kinds
        words = gdf["loc"].fillna("").map(clean).str.split()
        gdf["sido_name"] = [SIDO_NOW.get(w[0], w[0]) if w else "" for w in words]
        sigg = [re.sub(r"\(.*", "", w[1]) if len(w) > 1 else "" for w in words]   # ‘서귀포시(문섬,범섬,섶섬)’ → ‘서귀포시’
        gdf["sigg_name"] = [s if s[-1:] in ("시", "군", "구") else "" for s in sigg]
        day = gdf["gos_dat"].fillna("").astype(str)
        num = gdf["gos_num"].fillna("").map(lambda v: re.sub(r"부\s*고시\s*제", "부 고시 제", clean(v)))
        gdf["notice"] = [f"{n} ({d[:4]}-{d[4:6]}-{d[6:8]})" if len(d) == 8 else n for n, d in zip(num, day)]
        gdf["remark"] = [f"관리 {clean(m)} · {clean(l)}" if clean(m) else clean(l) for m, l in zip(gdf["mng_org"].fillna(""), gdf["loc"].fillna(""))]
    return gdf


def group_areas(layer, gdf):
    """레이어 하나 → 구역 목록 [(키 dict, 도형, 비고 목록, 묶음 밖 속성)]"""
    gdf = prepare(layer, gdf.copy())
    cols = set(gdf.columns)
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
        # 묶는 값이 아닌 속성(이름별로 묶은 레이어의 시도·고시 등)은 첫 값을 씀
        extra = {k: clean(part[k].iloc[0]) for k in ("uname", "sido_name", "sigg_name", "notice") if k in cols and k not in key}
        out.append((key, geom, remarks + [a for a in aliases if a not in remarks], extra))
    return out


KDPA_SOURCE = "한국보호지역 통합DB(KDPA, kdpa.kr)"
KDPA_SIDO = {
    "KR-11": "서울특별시", "KR-26": "부산광역시", "KR-27": "대구광역시", "KR-28": "인천광역시", "KR-29": "전남광주통합특별시",
    "KR-30": "대전광역시", "KR-31": "울산광역시", "KR-50": "세종특별자치시", "KR-41": "경기도", "KR-42": "강원특별자치도",
    "KR-51": "강원특별자치도", "KR-43": "충청북도", "KR-44": "충청남도", "KR-45": "전북특별자치도", "KR-52": "전북특별자치도",
    "KR-46": "전남광주통합특별시", "KR-47": "경상북도", "KR-48": "경상남도", "KR-49": "제주특별자치도",
}
KDPA_AUTH = [   # 관리 기관(영문) → 한글
    ("Ministry of Environment", "환경부"), ("Ministry of Oceans and Fisheries", "해양수산부"), ("Korea Heritage Service", "국가유산청"),
    ("Korea National Park Service", "국립공원공단"), ("Korea Forest Service", "산림청"), ("Korea Water Resources", "한국수자원공사"),
    ("National Nature Trust", "자연환경국민신탁"), ("Pusan National University", "부산대학교"), ("Local", "지방자치단체"),
]
KDPA_LABEL = {
    "시_도생태경관보전지역": "시·도 생태·경관보전지역", "생태경관보전지역": "생태·경관보전지역",
    "시_도습지보호지역": "시·도 습지보호지역", "습지보호지역-시도": "시·도 습지보호지역", "습지보호지역-갯벌": "연안습지보호지역",
    "해양보호구역(해양생물)": "해양생물보호구역", "해양보호구역(경관)": "해양경관보호구역",
}


def load_kdpa():
    """tools/fetch_kdpa.py가 만든 work/raw/kdpa.gpkg(없으면 None)"""
    src = RAW / "kdpa.gpkg"
    if not src.exists():
        print("  KDPA 자료 없음 — 브이월드만 씀(tools/fetch_kdpa.py로 받기)")
        return None
    kd = gpd.read_file(src, engine="pyogrio").set_crs(4326, allow_override=True)
    kd["DESIG"] = kd["DESIG"].fillna("")
    return kd


RNG = np.random.default_rng(20261022)   # 고정 씨앗 — 다시 만들어도 같은 결과


def sample_points(geom, n=300):
    """면 안에 고르게 흩은 점 n개(조각 넓이에 비례해 조각을 고르고, 조각의 범위 상자에서 뽑아 안에 든 것만 씀)"""
    parts = [p for p in shapely.get_parts(geom) if p.geom_type == "Polygon" and p.area > 0]
    if not parts:
        return np.empty((0, 2))
    areas = np.array([p.area for p in parts])
    pick = RNG.choice(len(parts), size=n, p=areas / areas.sum())
    out = []
    for i, k in zip(*np.unique(pick, return_counts=True)):
        p = parts[i]
        shapely.prepare(p)
        x0, y0, x1, y1 = p.bounds
        got = np.empty((0, 2))
        for _ in range(30):
            xy = np.column_stack([RNG.uniform(x0, x1, k * 4 + 16), RNG.uniform(y0, y1, k * 4 + 16)])
            got = np.vstack([got, xy[shapely.contains_xy(p, xy[:, 0], xy[:, 1])]])
            if len(got) >= k:
                break
        out.append(got[:k])
    return np.vstack(out)


def covered_share(geoms, vw_geoms):
    """KDPA 구역마다 브이월드 구역에 덮인 비율(흩은 점 가운데 브이월드 구역 안에 든 점의 비율).
    정확한 겹침 넓이는 전국을 한 조각으로 묶은 큰 구역에서 너무 오래 걸려 점으로 어림함(점 300개면 ±3%p 안팎)."""
    samples = [sample_points(g) for g in geoms]
    owner = np.concatenate([np.full(len(s), i) for i, s in enumerate(samples)]) if samples else np.empty(0, int)
    if not vw_geoms or not len(owner):
        return np.zeros(len(geoms))
    pts = shapely.points(np.vstack(samples))
    hit = np.zeros(len(pts), bool)
    # 점으로 나무를 만들고 브이월드 구역마다 ‘안에 든 점’을 찾음(큰 구역은 한 번만 준비해 빠름)
    hit[shapely.STRtree(pts).query(vw_geoms, predicate="contains")[1]] = True
    share = np.zeros(len(geoms))
    for i in range(len(geoms)):
        m = owner == i
        share[i] = hit[m].mean() if m.any() else 0
    return share


# 이름 맞춰 보기용: 지정 유형·흔한 말을 빼고 남는 고유 이름(예: ‘나무섬 주변해역 해양생태계보호구역’ → ‘나무섬’)
GENERIC_WORDS = re.compile(
    r"주변해역|일원해역|해역|해양생태계보호구역|해양생물보호구역|해양경관보호구역|해양보호구역|생태계보전지역|습지보호지역|습지보호구역|"
    r"갯벌|국립공원|도립공원|군립공원|자연공원|경관보호구역|수원함양보호구역|재해방지보호구역|산림유전자원보호구역|생활환경보호구역|"
    r"산림보호구역|백두대간보호지역|자연환경보전지역|도시자연공원구역|상수원보호구역|야생생물보호구역|수산자원보호구역|및|등")
NAME_END = re.compile(r"(보호구역|보전지역|보호지역|보전해역|공원|구역|지역|해역|도서|천연기념물|명승|휴양림|수목원|학술림|홍수터)$")


def core_name(name):
    return GENERIC_WORDS.sub("", re.sub(r"\(.*?\)", "", str(name or "")).replace(" ", ""))


def kdpa_name(r, desig, label):
    """KDPA 이름 다듬기 → (이름, 덧붙일 비고). ‘광주 북구 금곡동(광주광역시 … 산111외 64)’ → ‘광주 북구 금곡동 야생생물보호구역’"""
    raw = re.sub(r"^\d+_", "", clean(r["ORIG_NAME"])) or clean(r.get("NAME")) or label   # 특정도서 ‘49_납작도’ → ‘납작도’
    if desig in raw or label.replace("·", "") in raw.replace("·", ""):
        return raw, ""
    m = re.match(r"^([^()]+?)\s*\((.+)\)\s*$", raw)
    base, detail = (m.group(1).strip(), m.group(2).strip()) if m else (raw, "")
    return (base if NAME_END.search(base.replace(" ", "")) else f"{base} {label}"), detail


def kdpa_groups(layer, kd, vw_geoms, vw_names=()):
    """KDPA 구역 → group_areas와 같은 꼴(브이월드 우선).
    같은 종류의 브이월드 구역이 있으면 ① 절반 넘게 겹치거나 ② 고유 이름이 같은 브이월드 구역과 조금이라도 겹치거나
    ③ 이름 없이 전국을 한 조각으로 묶은 옛 자료(예: 2009년 ‘경관보호구역’)이면 이미 있는 것으로 보고 뺌."""
    if kd is None or not layer.get("kdpa"):
        return [], 0
    part = kd[kd["DESIG"].isin(layer["kdpa"])]
    part = part[part.geometry.notna() & ~part.geometry.is_empty & (shapely.area(part.geometry.values) > 0)]
    share = covered_share(list(part.geometry), vw_geoms)
    vw_cores = {c for c in map(core_name, vw_names) if len(c) >= 2}
    out, dup = [], 0
    for (_, r), s in zip(part.iterrows(), share):
        geom = r.geometry
        desig = r["DESIG"]
        label = KDPA_LABEL.get(desig, desig)
        core = core_name(re.sub(r"^\d+_", "", clean(r["ORIG_NAME"])))
        if vw_geoms and (s >= 0.5 or (s > 0 and core in vw_cores) or not core):
            dup += 1
            continue
        name, detail = kdpa_name(r, desig, label)
        codes = [c for c in str(r.get("SUB_LOC") or "").split(";") if c]
        sido = KDPA_SIDO.get(codes[0], "") if len(codes) == 1 else ""
        yr = r.get("STATUS_YR")
        remarks = [x for x in (
            detail[:80],
            "관리 " + next((ko for en, ko in KDPA_AUTH if clean(r.get("MANG_AUTH")).lower().startswith(en.lower())), clean(r.get("MANG_AUTH")))
            if clean(r.get("MANG_AUTH")) else "",
            "브이월드에 없어 KDPA로 보충 — 현행 여부 확인" if vw_geoms else "",
            "여러 시도에 걸침" if len(codes) > 1 else "",
            "자연공존지역(OECM)" if r.get("SITE_TYPE") == "oecm" else "",
            f"KDPA {r.get('version', '')} · WDPA {r['WDPAID']}",
        ) if x]
        key = {"kdpa": str(r["WDPAID"])}
        extra = {"name": name, "uname": label, "sido_name": sido, "sigg_name": "",
                 "notice": f"{int(yr)}년 지정" if pd.notna(yr) and yr else "", "source": KDPA_SOURCE}
        out.append((key, geom, remarks, extra))
    return out, dup


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

    kd = load_kdpa()
    layers_out, areas_out, gpkg_frames = [], [], []
    for li, layer in enumerate(LAYERS):
        # 브이월드 먼저
        src = RAW / f"{layer['id']}.geojson"
        groups, n_parts = [], 0
        if layer.get("data") and src.exists():
            gdf = gpd.read_file(src, engine="pyogrio")
            if not gdf.empty:
                n_parts = len(gdf)
                groups = group_areas(layer, gdf.set_crs(4326, allow_override=True))
        # 브이월드에 없는 종류·구역은 KDPA로
        vw = [(g, extra.get("name") or area_name(layer, key, remarks)) for key, g, remarks, extra in groups if not g.is_empty]
        kgroups, kdup = kdpa_groups(layer, kd, [g for g, _ in vw], [n for _, n in vw])
        if not groups and not kgroups:
            print(f"  {layer['name']}: 자료 없음 — 건너뜀")
            continue
        tol = SIMPLIFY.get(layer["id"], 0.0002)
        rows, map_feats = [], []
        for key, geom, remarks, extra in groups + kgroups:
            geom = polygonal(geom)
            if geom is None or geom.is_empty:
                continue
            aid = layer["id"] + "-" + hashlib.sha1(json.dumps(key, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:8]
            name = extra.get("name") or area_name(layer, key, remarks)
            area_ha = round(gpd.GeoSeries([geom], crs=4326).to_crs(5179).area.iloc[0] / 1e4, 2)
            minx, miny, maxx, maxy = (round(v, 5) for v in geom.bounds)
            got = {k: key.get(k) or extra.get(k, "") for k in ("uname", "sido_name", "sigg_name")}
            notice = notice_text(key.get("dyear"), key.get("dnum")) or extra.get("notice", "")
            props = {
                "구역id": aid, "이름": name, "종류": layer["name"], "세부구분": got["uname"],
                "시도": got["sido_name"], "시군구": got["sigg_name"],
                "고시": notice, "비고": "; ".join(remarks)[:200],
                "면적_ha": area_ha, "근거법령": layer["law"], "출처": extra.get("source") or SOURCE,
            }
            # 소수점 6자리(약 10cm) 격자에 맞추면서 꼬임 없이 유효한 도형으로(반올림만 하면 드물게 꼬임)
            full = geojson_geom(shapely.set_precision(geom, 1e-6), 6) or geojson_geom(geom, 6)
            if not full:
                continue
            (area_dir / f"{aid}.json").write_text(json.dumps({"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": props, "geometry": full}]}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            idx = len(areas_out)
            areas_out.append([aid, li, name, got["uname"], got["sido_name"], got["sigg_name"],
                              notice, area_ha, [minx, miny, maxx, maxy], props["비고"], "k" if extra.get("source") else ""])
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
        shp_gdf.to_file(shp_dir / f"{layer['id']}.shp", engine="pyogrio", encoding="UTF-8", promote_to_multi=True)
        (shp_dir / f"{layer['id']}.cpg").write_text("UTF-8", encoding="ascii")
        with zipfile.ZipFile(REL / f"{layer['id']}-shp.zip", "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(shp_dir.iterdir()):
                z.write(f, f.name)
        shutil.rmtree(shp_dir)
        gj = REL / f"{layer['id']}.geojson"
        full_gdf.to_file(gj, driver="GeoJSON", engine="pyogrio", COORDINATE_PRECISION=6, promote_to_multi=True)
        with zipfile.ZipFile(REL / f"{layer['id']}-geojson.zip", "w", zipfile.ZIP_DEFLATED) as z:
            z.write(gj, gj.name)
        gj.unlink()
        gpkg_frames.append((layer["id"], full_gdf))
        total_ha = round(sum(r["면적_ha"] for r in rows), 1)
        layers_out.append({**layer, "count": len(rows), "area_ha": total_ha,
                           "shp_mb": round((REL / f"{layer['id']}-shp.zip").stat().st_size / 1e6, 2),
                           "geojson_mb": round((REL / f"{layer['id']}-geojson.zip").stat().st_size / 1e6, 2),
                           "map_mb": round((DATA / "map" / f"{layer['id']}.json").stat().st_size / 1e6, 2)})
        layers_out[-1]["kdpa_count"] = len(kgroups)
        kinfo = f" · KDPA 보충 {len(kgroups):,}(겹쳐서 뺀 것 {kdup:,})" if layer.get("kdpa") and kd is not None else ""
        print(f"  {layer['name']}: 브이월드 조각 {n_parts:,} → 구역 {len(rows):,}{kinfo} · 지도 {layers_out[-1]['map_mb']} MB · SHP {layers_out[-1]['shp_mb']} MB", flush=True)

    # 전체를 한 GeoPackage로(레이어별 표)
    gpkg = REL / "protected-areas.gpkg"
    for lid, frame in gpkg_frames:
        frame.to_file(gpkg, layer=lid, driver="GPKG", engine="pyogrio", promote_to_multi=True)
    with zipfile.ZipFile(REL / "protected-areas-gpkg.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.write(gpkg, gpkg.name)
    gpkg.unlink()

    (DATA / "index.json").write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": SOURCE, "kdpaSource": KDPA_SOURCE, "kdpaVersion": (kd["version"].iloc[0] if kd is not None and len(kd) else ""),
        "groups": GROUPS, "layers": layers_out,
        # src: ‘k’면 KDPA에서 가져온 구역(비어 있으면 브이월드)
        "columns": ["id", "layer", "name", "sub", "sido", "sigg", "notice", "area_ha", "bbox", "remark", "src"],
        "areas": areas_out,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size = lambda p: sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / 1e6  # noqa: E731
    print(f"구역 {len(areas_out):,}곳 · data {size(DATA):.1f} MB(구역별 {size(area_dir):.1f} MB) · 릴리스 {size(REL):.1f} MB · {time.time() - started:.0f}초")


if __name__ == "__main__":
    main()
