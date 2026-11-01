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
기준 자료 순서: 생태·자연도 별도관리지역(work/raw/ecozone.gpkg) → 브이월드(생태·자연도에 없는 부분만) → KDPA(두 자료 모두에 없는 종류만)
- 생태·자연도: 이름이 있는 종류(공원·천연기념물·습지·생태경관)는 이름별, 이름 없는 종류(산림·야생생물·수산자원·백두대간)는 시군구별
- KDPA(work/raw/kdpa.gpkg): 보호지역 하나가 구역 하나
구역 id는 묶는 값으로 만든 해시라 다시 만들어도 같습니다(바뀌지 않은 구역은 파일도 그대로).
"""
import hashlib
import json
import math
import re
import shutil
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
from shapely import affinity
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


SPECIAL_OK = None   # KDPA 야생생물특별보호구역(지정 현황) — 브이월드의 ‘특별보호구역’ 표기가 맞는지 볼 때 씀(main에서 채움)
WET_KIND = None     # (KDPA 연안습지 도형, KDPA 내륙습지 도형) — 브이월드 습지보호구역 레이어에서 연안만 고를 때 씀(main에서 채움)


def prepare(layer, gdf):
    """레이어마다 다른 속성을 공통 이름(name·uname·sido_name·sigg_name·notice·remark)으로 맞춤"""
    if layer["id"] in ("wildlife", "wildlife-special") and "uname" in gdf.columns:   # 옛 이름(야생동·식물) → 지금 법률 용어(야생생물)
        gdf["uname"] = gdf["uname"].map(lambda u: {"야생동·식물보호구역": "야생생물보호구역", "시·도야생동·식물보호구역": "시·도 야생생물보호구역",
                                                   "야생동·식물특별보호구역": "야생생물특별보호구역",
                                                   "야생동·식물보호구역미분류": "야생생물보호구역(미분류)"}.get(clean(u), u))
        # 지자체가 일반 보호구역을 ‘특별보호구역’으로 잘못 입력한 경우가 있어, 지정 현황(KDPA 특별보호구역)과 겹치지 않으면 보호구역으로
        if SPECIAL_OK is not None:
            wrong = (gdf["uname"] == "야생생물특별보호구역") & ~gdf.geometry.intersects(SPECIAL_OK)
            gdf.loc[wrong, "uname"] = "야생생물보호구역"
    if layer["id"] == "forest-genetic" and "uname" in gdf.columns:   # 사용자가 쓰는 이름(산림유전자원보호림)으로
        gdf["uname"] = gdf["uname"].map(lambda u: "산림유전자원보호림" if clean(u) == "산림유전자원보호구역" else u)
    if layer["id"] == "wetland-coast" and "name" in gdf.columns:
        # 이 레이어에는 우포늪·한강하구 같은 내륙 습지보호지역도 들어 있음 — KDPA에서 더 많이 겹치는 쪽(갯벌·시도 연안 / 내륙)으로 가름
        coast, inland = WET_KIND or (None, None)
        keep = {}
        for nm, g in gdf.groupby("name"):
            geom = shapely.union_all(shapely.make_valid(g.geometry.values))
            a_c = geom.intersection(coast).area if coast is not None else 0
            a_i = geom.intersection(inland).area if inland is not None else 0
            keep[nm] = a_c > a_i if (a_c or a_i) else "갯벌" in str(nm)
        gdf = gdf[gdf["name"].map(keep).fillna(False).astype(bool)].copy()
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


SIDO_WORDS = re.compile("|".join(sorted({*SHORT_SIDO, *SHORT_SIDO.values(), *SIDO_NOW}, key=len, reverse=True)))


def core_name(name):
    return SIDO_WORDS.sub("", GENERIC_WORDS.sub("", re.sub(r"\(.*?\)", "", str(name or "")).replace(" ", "")))


def kdpa_name(r, desig, label):
    """KDPA 이름 다듬기 → (이름, 덧붙일 비고). ‘광주 북구 금곡동(광주광역시 … 산111외 64)’ → ‘광주 북구 금곡동 야생생물보호구역’"""
    raw = re.sub(r"^\d+_", "", clean(r["ORIG_NAME"])) or clean(r.get("NAME")) or label   # 특정도서 ‘49_납작도’ → ‘납작도’
    if desig in raw or label.replace("·", "") in raw.replace("·", ""):
        return raw, ""
    m = re.match(r"^([^()]+?)\s*\((.+)\)\s*$", raw)
    base, detail = (m.group(1).strip(), m.group(2).strip()) if m else (raw, "")
    return (base if NAME_END.search(base.replace(" ", "")) else f"{base} {label}"), detail


def uncovered_part(geom, tree, vw_geoms, whole=None):
    """KDPA 구역에서 다른 자료(브이월드·생태·자연도)가 덮지 못한 부분. 경계를 달리 그려 생기는 폭 40 m 안쪽 띠는 버리고,
    남은 부분이 구역(whole: 위치만 옮겨 있는 조각을 빼기 전 KDPA 구역 전체)의 10% 넘고 1 ha 넘을 때만 돌려줌(아니면 None)"""
    hit = [vw_geoms[i] for i in tree.query(geom, predicate="intersects")]
    if not hit:
        return geom
    rest = shapely.make_valid(geom.difference(shapely.union_all(shapely.make_valid(hit))))
    rest = shapely.make_valid(rest.buffer(-0.0002).buffer(0.0002).intersection(geom))   # 약 20 m 열고 닫기
    rest = polygonal(rest)
    if rest is None or rest.is_empty or not geom.area:
        return None
    ha = gpd.GeoSeries([rest], crs=4326).to_crs(5179).area.iloc[0] / 1e4
    return rest if rest.area / (whole if whole is not None else geom).area > 0.1 and ha > 1 else None


def shifted_twin(geom, tree, vw_geoms, reach=0.01):
    """KDPA 구역이 다른 자료(브이월드·생태·자연도)의 같은 구역을 위치만 옮겨 그린 것인지 봄(예: 경북 KDPA 야생생물보호구역 다수가
    브이월드보다 약 380 m 옮겨져 있어 같은 구역이 두 번 그려짐 — 구미 남통동 등). 1 km 안에서 한 번 옮겨(조각 하나와 넓이가 비슷한
    짝의 무게중심 차) 조각의 60% 넘게 다른 자료 조각에 덮이면 그 조각은 짝이 있는 것. 30 m 넘게 옮겨야 맞고 짝 있는 조각이 구역의
    절반 넘으면 짝 없는 조각만 돌려줌(모두 짝이 있으면 빈 도형). 그 밖(제자리 겹침은 아래 겹침 규칙이 다룸)은 geom 그대로"""
    try:
        parts = [q for q in getattr(geom, "geoms", [geom]) if q.area > 0]   # 섞여 든 선·점은 뺌
        if not geom.area or not parts:
            return geom
        cps = [kp for i in tree.query(geom.buffer(reach), predicate="intersects") for kp in getattr(vw_geoms[i], "geoms", [vw_geoms[i]])]
        cps = [kp for kp in cps if kp.area <= 2 * geom.area]   # 시군을 한 조각으로 묶은 큰 구역은 짝 후보가 아님
        if not cps:
            return geom
        ctree = shapely.STRtree(cps)
        best, best_left, best_shift, tried = 0.0, None, 0.0, set()
        for p in sorted(parts, key=lambda x: -x.area)[:5]:
            pc = p.centroid
            for kp in cps:
                if not 0.8 <= kp.area / p.area <= 1.25:
                    continue
                dx, dy = kp.centroid.x - pc.x, kp.centroid.y - pc.y
                if dx * dx + dy * dy > reach * reach or (round(dx, 5), round(dy, 5)) in tried:
                    continue
                tried.add((round(dx, 5), round(dy, 5)))
                matched, left = 0.0, []
                for q in parts:
                    t = affinity.translate(q, dx, dy)
                    hit = [cps[j] for j in ctree.query(t, predicate="intersects")]
                    if hit and shapely.union_all(hit).intersection(t).area / q.area >= 0.6:
                        matched += q.area
                    else:
                        left.append(q)
                if matched > best:
                    best, best_left, best_shift = matched, left, math.hypot(dx * 88800, dy * 111000)
        if best / geom.area <= 0.5 or best_shift < 30:
            return geom
        return shapely.union_all(best_left) if best_left else shapely.Polygon()
    except shapely.errors.GEOSException:
        return geom


def sigg_area(geoms, admin, atree):
    """시군구 번호(admin 행) → 그 안에 든 구역 넓이(ha, 위도로 어림)"""
    out = {}
    for g in geoms:
        k = 111320 * 111320 * math.cos(math.radians(g.centroid.y)) / 1e4
        for j in atree.query(g, predicate="intersects"):
            try:
                a = shapely.intersection(g, admin.geometry.values[j]).area * k
            except shapely.errors.GEOSException:
                continue
            out[int(j)] = out.get(int(j), 0) + a
    return out


def main_sigg(geom, admin, atree):
    """구역 안에 흩은 점이 가장 많이 든 시군구 번호(없으면 None)"""
    pts = sample_points(geom, 120)
    if not len(pts):
        return None
    idx = atree.query(shapely.points(pts), predicate="within")[1]
    return int(np.bincount(idx).argmax()) if len(idx) else None


def kdpa_groups(layer, kd, vw_geoms, vw_names=(), base=(), admin=None):
    """KDPA 구역 → group_areas와 같은 꼴(브이월드 우선).
    같은 종류의 브이월드 구역이 있으면 ① 절반 넘게 겹치거나 ② 고유 이름이 같은 브이월드 구역과 조금이라도 겹치거나
    ③ 이름 없이 전국을 한 조각으로 묶은 옛 자료(예: 2009년 ‘경관보호구역’)이면 이미 있는 것으로 봄.
    다만 ①·②라도 다른 자료가 덮지 못한 부분이 넓으면(예: 양산 하북면 1 야생생물보호구역은 브이월드 양산시 구역과 절반만 겹침,
    고창·무안 갯벌은 브이월드 연안습지가 일부만 덮음) 그 부분만 KDPA 이름으로 넣음 — 겹친 부분은 그대로 두어 두 번 칠하지 않음.
    같은 모양·넓이의 구역이 다른 자료에 위치만 옮겨져 있으면(shifted_twin) 다른 자료(브이월드 등)를 기준으로 보고 KDPA 쪽은 뺌.
    kdpa_fill: "sigg"인 종류(야생생물보호구역)는 브이월드·생태·자연도(base)에 구역이 있는(5 ha 넘게 든 — 이웃 시군 구역의 경계 자투리는
    빼고) 시군구에서는 KDPA를 하나도 넣지 않고,
    그 자료에 없는 시군구(예: 경남 합천·밀양)만 KDPA로 채움 — 2025.12 경남 지정 현황과 견주면 브이월드가 있는 시군은 브이월드가
    맞고(양산 4곳 1,177 ha ↔ 브이월드 1,156 ha, KDPA 3,149 ha), KDPA는 기간 만료(창원)나 옛 경계가 섞여 있음."""
    pick = layer.get("kdpa_pick")   # {지정 유형: [이름, …]} — 새로 지정돼 다른 자료에 아직 없는 구역만 골라 넣을 때
    if kd is None or not (layer.get("kdpa") or pick):
        return [], 0
    if layer.get("kdpa"):
        part = kd[kd["DESIG"].isin(layer["kdpa"])]
    else:
        names = kd["ORIG_NAME"].fillna("").map(clean)
        part = kd[[d in pick and n in pick[d] for d, n in zip(kd["DESIG"], names)]]
    part = part[part.geometry.notna() & ~part.geometry.is_empty & (shapely.area(part.geometry.values) > 0)]
    share = covered_share(list(part.geometry), vw_geoms)
    vw_cores = {c for c in map(core_name, vw_names) if len(c) >= 2}
    tree = shapely.STRtree(vw_geoms) if vw_geoms else None
    out, dup, twins, by_sigg = [], 0, [], []
    fill_sigg = layer.get("kdpa_fill") == "sigg" and admin is not None and len(base)
    if fill_sigg:
        atree = shapely.STRtree(admin.geometry.values)
        have = {j for j, a in sigg_area(base, admin, atree).items() if a >= 5}
    for (_, r), s in zip(part.iterrows(), share):
        geom = r.geometry
        desig = r["DESIG"]
        label = KDPA_LABEL.get(desig, desig)
        core = core_name(re.sub(r"^\d+_", "", clean(r["ORIG_NAME"])))
        rest_of = moved_of = None
        if tree is not None:
            left = shifted_twin(geom, tree, vw_geoms)
            if left is not geom:
                if left.is_empty:
                    dup += 1
                    twins.append(clean(r["ORIG_NAME"])[:30])
                    continue
                moved_of = gpd.GeoSeries([geom], crs=4326).to_crs(5179).area.iloc[0] / 1e4
                geom = left
                s = 1.0   # 짝 없는 조각도 아래 겹침 규칙(uncovered_part)으로 — 다른 자료가 덮지 못한 부분만 넣음
        if fill_sigg and main_sigg(geom, admin, atree) in have:
            dup += 1
            by_sigg.append(clean(r["ORIG_NAME"])[:30])
            continue
        if vw_geoms and (s >= 0.5 or (s > 0 and core in vw_cores) or not core):
            rest = uncovered_part(geom, tree, vw_geoms, whole=r.geometry) if core else None
            if rest is None:
                dup += 1   # 골라 넣은 구역도 브이월드 등에 들어오면 여기서 자동으로 빠짐
                continue
            rest_of = moved_of or gpd.GeoSeries([geom], crs=4326).to_crs(5179).area.iloc[0] / 1e4
            geom = rest
        name, detail = kdpa_name(r, desig, label)
        codes = [c for c in re.split(r"[;,]", str(r.get("SUB_LOC") or "")) if c]
        sido = KDPA_SIDO.get(codes[0], "") if len(codes) == 1 else ""
        yr = r.get("STATUS_YR")
        remarks = [x for x in (
            f"다른 자료(브이월드·생태·자연도)에 없는 부분만 — KDPA 전체 {rest_of:,.0f} ha" if rest_of else
            f"다른 자료에 위치만 옮겨 있는 조각은 뺌 — KDPA 전체 {moved_of:,.0f} ha" if moved_of else "",
            detail[:80],
            "관리 " + next((ko for en, ko in KDPA_AUTH if clean(r.get("MANG_AUTH")).lower().startswith(en.lower())), clean(r.get("MANG_AUTH")))
            if clean(r.get("MANG_AUTH")) else "",
            "새로 지정되어 브이월드에 아직 없는 구역(KDPA 경계)" if pick and not layer.get("kdpa") else "브이월드에 없어 KDPA로 보충 — 현행 여부 확인" if vw_geoms else "",
            "여러 시도에 걸침" if len(codes) > 1 else "",
            "자연공존지역(OECM)" if r.get("SITE_TYPE") == "oecm" else "",
            f"KDPA {r.get('version', '')} · WDPA {r['WDPAID']}",
        ) if x]
        key = {"kdpa": str(r["WDPAID"])}
        extra = {"name": name, "uname": label, "sido_name": sido, "sigg_name": "",
                 "notice": f"{int(yr)}년 지정" if pd.notna(yr) and yr else "", "source": KDPA_SOURCE, "src": "k"}
        out.append((key, geom, remarks, extra))
    if twins:
        print(f"    {layer.get('name', layer['id'])}: KDPA 중 다른 자료에 위치만 옮겨 있는 구역 {len(twins)}곳 뺌 — {', '.join(twins[:60])}")
    if by_sigg:
        print(f"    {layer.get('name', layer['id'])}: 브이월드·생태·자연도에 구역이 있는 시군구라 뺀 KDPA {len(by_sigg)}곳 — {', '.join(by_sigg[:80])}")
    return out, dup


# ---------- 생태·자연도 별도관리지역(1순위 기준) ----------
# 이름이 적힌 종류는 이름별로, 이름 없이 ‘산림보호구역’처럼 종류만 적힌 것은 시군구별로 묶음
ECO_NAMED = {"국립공원", "도립공원", "군립공원", "천연기념물", "습지보호", "생태경관"}


def load_ecozone():
    """tools/import_ecozone.py가 만든 work/raw/ecozone.gpkg → (GeoDataFrame 또는 None, 고시 정보)"""
    src = RAW / "ecozone.gpkg"
    if not src.exists():
        print("  생태·자연도 자료 없음 — 브이월드부터 씀(tools/import_ecozone.py로 가져오기)")
        return None, {}
    meta_path = RAW / "ecozone.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    return gpd.read_file(src, engine="pyogrio").set_crs(4326, allow_override=True), meta


def load_admin():
    """시군구 경계(브이월드 LT_C_ADSIGG_INFO) — 생태·자연도 구역의 소재지를 붙일 때 씀"""
    src = RAW / "admin-sigg.geojson"
    if not src.exists():
        return None
    a = gpd.read_file(src, engine="pyogrio").set_crs(4326, allow_override=True)
    words = a["full_nm"].fillna("").str.split(n=1)
    a["sido_name"] = [SIDO_NOW.get(w[0], w[0]) if w else "" for w in words]
    a["sigg_name"] = [w[1] if len(w) > 1 else "" for w in words]
    return a[["sig_cd", "sido_name", "sigg_name", "geometry"]].reset_index(drop=True)


def locate(geom, admin, tree):
    """구역 안에 흩은 점이 가장 많이 든 시군구 → (시도, 시군구, 그 비율)"""
    pts = sample_points(geom, 120)
    if not len(pts):
        return "", "", 0
    counts = {}
    for i in tree.query(geom):
        a = admin.geometry.values[i]
        shapely.prepare(a)
        n = int(shapely.contains_xy(a, pts[:, 0], pts[:, 1]).sum())
        if n:
            counts[i] = n
    if not counts:
        return "", "", 0
    i = max(counts, key=counts.get)
    return admin.at[i, "sido_name"], admin.at[i, "sigg_name"], counts[i] / len(pts)


def eco_name(value, label):
    v = value.strip()
    if v.endswith(label) and not v.endswith(" " + label):   # ‘속리산국립공원’ → ‘속리산 국립공원’
        return v[: -len(label)].strip() + " " + label
    return v if NAME_END.search(v.replace(" ", "")) or label == "천연기념물" else f"{v} {label}"


def ecozone_groups(layer, ez, meta, admin):
    """생태·자연도 별도관리지역 → group_areas와 같은 꼴"""
    col = layer.get("ecozone")
    if ez is None or not col:
        return []
    part = ez[ez[col] != ""]
    if part.empty:
        return []
    label = layer["name"]
    extra0 = {"uname": label, "source": ECO_SOURCE(meta), "src": "e", "notice": ""}
    out = []
    tree = shapely.STRtree(admin.geometry.values) if admin is not None else None
    if col in ECO_NAMED:
        for value, g in part.groupby(col):
            geom = shapely.union_all(g.geometry.values)
            sido, sigg, share = locate(geom, admin, tree) if tree is not None else ("", "", 0)
            out.append(({"ez": col, "name": value}, geom, ["여러 시군구에 걸침"] if share < 0.7 else [],
                        {**extra0, "name": eco_name(value, label), "sido_name": sido, "sigg_name": sigg if share >= 0.7 else ""}))
        return out
    # 이름 없는 종류: 시군구 경계로 잘라 시군구마다 한 구역
    if admin is None:
        geom = shapely.union_all(part.geometry.values)
        return [({"ez": col}, geom, [], {**extra0, "name": label, "sido_name": "", "sigg_name": ""})]
    cut = gpd.overlay(part[["geometry"]], admin, how="intersection", keep_geom_type=True)
    for sig, g in cut.groupby("sig_cd"):
        sido, sigg = g["sido_name"].iloc[0], g["sigg_name"].iloc[0]
        name = " ".join(x for x in (SHORT_SIDO.get(sido, sido), sigg, label) if x)
        out.append(({"ez": col, "sig": sig}, shapely.union_all(g.geometry.values), [],
                    {**extra0, "name": name, "sido_name": sido, "sigg_name": sigg}))
    return out


def ECO_SOURCE(meta):
    # 브이월드 공간정보 다운로드로도 제공되는 자료라 출처는 브이월드로 적음
    return "국토교통부 브이월드(디지털트윈국토)"


def vworld_rest(groups, eco):
    """생태·자연도가 있는 종류: 브이월드 구역에서 생태·자연도 구역을 뺀 나머지만 남김(생태·자연도 우선).
    두 자료 경계가 조금 어긋나 생기는 25 m 안팎의 가는 띠와 1 ha 미만 조각은 버림. 거의 다 덮이면 그 구역은 뺌."""
    if not groups or not eco:
        return groups, 0
    eg = shapely.make_valid(gpd.GeoSeries([g for _, g, _, _ in eco], crs=4326).to_crs(5179).values)   # 투영하면 드물게 꼬여서 다시 고침
    tree = shapely.STRtree(eg)
    vg = shapely.make_valid(gpd.GeoSeries([g for _, g, _, _ in groups], crs=4326).to_crs(5179).values)
    out, dropped = [], 0
    for (key, g4326, remarks, extra), g in zip(groups, vg):
        hits = tree.query(g)
        if not len(hits):
            out.append((key, g4326, remarks, extra))
            continue
        try:
            rest = shapely.difference(g, shapely.union_all(eg[hits]))
        except shapely.errors.GEOSException:   # 꼬임이 남아 있으면 0.1 m 격자에 맞춰 다시
            rest = shapely.difference(shapely.set_precision(g, 0.1), shapely.union_all(shapely.set_precision(eg[hits], 0.1)))
        rest = shapely.buffer(shapely.buffer(rest, -25), 25)
        parts = [p for p in shapely.get_parts(rest) if p.area >= 1e4]
        area = sum(p.area for p in parts)
        if not parts or area < max(1e4, 0.02 * g.area):
            dropped += 1
            continue
        geom = gpd.GeoSeries([shapely.union_all(parts)], crs=5179).to_crs(4326).iloc[0]
        cut = area < 0.98 * g.area
        out.append((key, geom, remarks, {**extra, "rest": cut}))
    return out, dropped


def merge_by_kdpa(layer, groups, kd):
    """같은 KDPA 보호지역에 걸친 브이월드 구역(예: 진양호 특별보호구역의 진주시·사천시 조각)을 한 구역으로 합치고 KDPA 이름을 붙임"""
    if kd is None or not groups:
        return groups
    merged, used = [], set()
    for _, r in kd[kd["DESIG"].isin(layer.get("kdpa", []))].iterrows():
        hit = [i for i, (_, g, _, _) in enumerate(groups) if i not in used and g.intersects(r.geometry)]
        if not hit:
            continue
        used |= set(hit)
        parts = [groups[i] for i in hit]
        siggs = sorted({k.get("sigg_name") for k, _, _, _ in parts if k.get("sigg_name")})
        sidos = sorted({k.get("sido_name") for k, _, _, _ in parts if k.get("sido_name")})
        notice = max((notice_text(k.get("dyear"), k.get("dnum")) for k, _, _, _ in parts), key=len, default="")   # 번호까지 있는 고시를 씀
        name, _ = kdpa_name(r, r["DESIG"], KDPA_LABEL.get(r["DESIG"], r["DESIG"]))
        merged.append(({"merge": str(r["WDPAID"])}, shapely.union_all([g for _, g, _, _ in parts]),
                       [f"{'·'.join(siggs)}에 걸침"] if len(siggs) > 1 else [],
                       {"name": name, "uname": parts[0][0].get("uname", ""), "notice": notice,
                        "sido_name": sidos[0] if len(sidos) == 1 else "", "sigg_name": siggs[0] if len(siggs) == 1 else ""}))
    return merged + [x for i, x in enumerate(groups) if i not in used]


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
    global SPECIAL_OK, WET_KIND
    if kd is not None and (kd["DESIG"] == "야생생물특별보호구역").any():
        SPECIAL_OK = shapely.union_all(kd[kd["DESIG"] == "야생생물특별보호구역"].geometry.values)
    if kd is not None:
        u = lambda ds: shapely.union_all(kd[kd["DESIG"].isin(ds)].geometry.values)  # noqa: E731
        WET_KIND = (u(["습지보호지역-갯벌", "습지보호지역-시도"]), u(["습지보호지역", "시_도습지보호지역"]))
    ez, ez_meta = load_ecozone()
    admin = load_admin()
    layers_out, areas_out, gpkg_frames = [], [], []
    done_geoms = {}   # 레이어 id → 만든 구역 도형(carve_by에서 씀)
    for li, layer in enumerate(LAYERS):
        # 1) 생태·자연도 별도관리지역
        eco = ecozone_groups(layer, ez, ez_meta, admin)
        # 2) 브이월드 — 생태·자연도가 있는 종류는 생태·자연도에 없는 부분만
        src = RAW / f"{layer.get('raw', layer['id'])}.geojson"
        groups, n_parts, vdrop = [], 0, 0
        if layer.get("data") and src.exists():
            gdf = gpd.read_file(src, engine="pyogrio")
            if not gdf.empty:
                n_parts = len(gdf)
                groups = group_areas(layer, gdf.set_crs(4326, allow_override=True))
                groups, vdrop = vworld_rest(groups, eco)
                if layer.get("merge_kdpa"):
                    groups = merge_by_kdpa(layer, groups, kd)
        # carve_by 레이어(예: 야생생물특별보호구역)가 차지한 자리는 이 레이어에서 잘라 냄
        cut = [(None, g, None, None) for lid in layer.get("carve_by", []) for g in done_geoms.get(lid, [])]
        if cut:
            keep = lambda before, after: [(k, g, r, next(e0 for k0, _, _, e0 in before if k0 == k)) for k, g, r, _ in after]  # noqa: E731
            eco = keep(eco, vworld_rest(eco, cut)[0])   # 잘라 낸 뒤에도 이름 꼬리표(일부)는 붙이지 않음
            groups = keep(groups, vworld_rest(groups, cut)[0])
        # 3) KDPA — 위 두 자료에 없는 구역(같은 종류도 보충)
        known = [(g, extra.get("name") or area_name(layer, key, remarks)) for key, g, remarks, extra in eco + groups if not g.is_empty]
        known += [(g, "") for _, g, _, _ in cut]   # 잘라 낸 자리(다른 레이어)에 겹치는 KDPA 구역도 넣지 않음
        kgroups, kdup = kdpa_groups(layer, kd, [g for g, _ in known], [n for _, n in known],
                                    base=[g for _, g, _, _ in eco + groups if not g.is_empty], admin=admin)
        if not eco and not groups and not kgroups:
            print(f"  {layer['name']}: 자료 없음 — 건너뜀")
            continue
        tol = SIMPLIFY.get(layer["id"], 0.0002)
        rows, map_feats = [], []
        for key, geom, remarks, extra in eco + groups + kgroups:
            geom = polygonal(geom)
            if geom is None or geom.is_empty:
                continue
            aid = layer["id"] + "-" + hashlib.sha1(json.dumps(key, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:8]
            name = extra.get("name") or area_name(layer, key, remarks)
            if extra.get("rest"):
                name = f"{name} (일부)"
            area_ha = round(gpd.GeoSeries([geom], crs=4326).to_crs(5179).area.iloc[0] / 1e4, 2)
            if extra.get("src") == "k" and area_ha < 1 and any("없는 부분만" in x for x in remarks):
                continue   # KDPA 남은 부분이 뒤 단계(잘라 내기 등)에서 1 ha 안 되는 자투리만 남은 것
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
                              notice, area_ha, [minx, miny, maxx, maxy], props["비고"], extra.get("src", "")])
            # 줄인 경계는 조각끼리 겹치거나 꼬일 수 있어 1m 격자에 맞춰 바로잡음(지도에서 빈 삼각형처럼 보이는 것 방지)
            simple = (geojson_geom(shapely.set_precision(geom.simplify(tol, preserve_topology=True), 1e-5), 5)
                      or geojson_geom(shapely.set_precision(geom, 1e-6), 6))   # 아주 작은 구역은 줄이면 사라지므로 원본으로
            if simple:
                map_feats.append({"type": "Feature", "properties": {"i": idx}, "geometry": simple})
            rows.append({**props, "geometry": geom})
        done_geoms[layer["id"]] = [r["geometry"] for r in rows]
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
        layers_out[-1].update({"eco_count": len(eco), "vworld_count": len(groups), "kdpa_count": len(kgroups)})
        info = []
        if eco:
            info.append(f"생태·자연도 {len(eco):,}")
        if n_parts:
            info.append(f"브이월드 {len(groups):,}(조각 {n_parts:,}" + (f", 생태·자연도와 겹쳐 뺀 구역 {vdrop:,}" if eco else "") + ")")
        if kgroups:
            info.append(f"KDPA {len(kgroups):,}")
        print(f"  {layer['name']}: 구역 {len(rows):,} = {' + '.join(info)} · 지도 {layers_out[-1]['map_mb']} MB · SHP {layers_out[-1]['shp_mb']} MB", flush=True)

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
        "ecoSource": ECO_SOURCE(ez_meta) if ez is not None else "",
        "groups": GROUPS, "layers": layers_out,
        # src: ‘e’ 생태·자연도, ‘k’ KDPA, 비어 있으면 브이월드
        "columns": ["id", "layer", "name", "sub", "sido", "sigg", "notice", "area_ha", "bbox", "remark", "src"],
        "areas": areas_out,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size = lambda p: sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / 1e6  # noqa: E731
    print(f"구역 {len(areas_out):,}곳 · data {size(DATA):.1f} MB(구역별 {size(area_dir):.1f} MB) · 릴리스 {size(REL):.1f} MB · {time.time() - started:.0f}초")


if __name__ == "__main__":
    main()
