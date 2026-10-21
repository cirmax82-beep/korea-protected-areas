"""생태·자연도 정기고시 파일(File GDB)에서 별도관리지역 레이어를 꺼내 사이트 가공용 GeoPackage로 저장합니다.

    python tools/import_ecozone.py "…/2026년 생태자연도 정기고시(기후에너지환경부고시 제2026-128호).gdb"

- 생태·자연도는 해마다 정기고시되며(기후에너지환경부·국립생태원), 고시 첨부 파일이나 에코뱅크에서 받습니다.
  내려받기에 로그인·선택이 필요해 자동으로 받지 않고, 받아 둔 파일을 이 스크립트로 한 번 가져옵니다.
- F_별도관리지역_A 레이어만 씁니다. 조각마다 종류 열(산림보호·국립공원·…·생태경관)에 값이 있으면 그 종류입니다.
- 결과: work/raw/ecozone.gpkg(EPSG:4326, 2D), work/raw/ecozone.json(고시 정보)
"""
import json
import re
import sys
from pathlib import Path

import pyogrio
import shapely

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "work" / "raw" / "ecozone.gpkg"
LAYER = "F_별도관리지역_A"
KINDS = ["산림보호", "국립공원", "도립공원", "군립공원", "천연기념물", "야생동식물", "수산자원", "습지보호", "백두대간", "생태경관"]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        raise SystemExit("생태·자연도 정기고시 GDB 경로를 주세요.")
    src = Path(sys.argv[1])
    layers = [n for n, _ in pyogrio.list_layers(src)]
    if LAYER not in layers:
        raise SystemExit(f"{LAYER} 레이어가 없습니다: {layers}")
    gdf = pyogrio.read_dataframe(src, layer=LAYER)
    gdf["geometry"] = shapely.make_valid(shapely.force_2d(gdf.geometry.values))
    gdf = gdf[~gdf.geometry.is_empty].to_crs(4326)
    for k in KINDS:
        gdf[k] = gdf[k].fillna("").astype(str).str.strip()
    gdf = gdf[KINDS + ["비고", "INXNUM", "INXNAME", "geometry"]]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.unlink(missing_ok=True)
    gdf.to_file(OUT, driver="GPKG", engine="pyogrio")
    m = re.search(r"(\d{4})년.*?\((.*?고시\s*제?\s*[\d-]+호)\)", src.name)
    meta = {"file": src.name, "year": m.group(1) if m else "", "notice": m.group(2) if m else "", "count": len(gdf),
            "kinds": {k: int((gdf[k] != "").sum()) for k in KINDS}}
    (OUT.with_suffix(".json")).write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"별도관리지역 {len(gdf):,}조각 → {OUT.relative_to(ROOT)} · {meta['year']}년 {meta['notice']}")
    print("  " + ", ".join(f"{k} {v:,}" for k, v in meta["kinds"].items()))


if __name__ == "__main__":
    main()
