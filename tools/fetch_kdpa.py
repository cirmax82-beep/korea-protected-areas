"""한국보호지역 통합DB(KDPA, https://www.kdpa.kr)의 전국 보호지역 SHP를 받아 사이트 가공용 GeoPackage로 바꿉니다.

    python tools/fetch_kdpa.py

- KDPA 누리집의 ‘SHP 다운로드’(getNewShpDownload)와 같은 파일을 받습니다(WDPA 등재 기준, 해마다 갱신).
- 원본은 work/kdpa/에 풀고, 속성 한글(CP949)을 바로잡아 work/raw/kdpa.gpkg(EPSG:4326)으로 저장합니다.
- 브이월드에 있는 종류는 브이월드를 쓰고, KDPA는 브이월드에 없는 종류와 브이월드에 빠진 구역을 채우는 데만 씁니다(build.py).
"""
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import geopandas as gpd
import shapely

ROOT = Path(__file__).resolve().parent.parent
URL = "https://www.kdpa.kr/getNewShpDownload"
WORK = ROOT / "work" / "kdpa"
OUT = ROOT / "work" / "raw" / "kdpa.gpkg"   # 아주 큰 보호지역이 있어 GeoJSON 대신 GeoPackage
KEEP = ["WDPAID", "ORIG_NAME", "NAME", "DESIG", "DESIG_ENG", "IUCN_CAT", "STATUS_YR", "MANG_AUTH", "SUB_LOC", "GIS_AREA", "SITE_TYPE", "MARINE"]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    WORK.mkdir(parents=True, exist_ok=True)
    zpath = WORK / "kdpa.zip"
    print("KDPA 전국 보호지역 SHP 받는 중…", flush=True)
    req = urllib.request.Request(URL, headers={"User-Agent": "protect.biogrideia.com data update"})
    with urllib.request.urlopen(req, timeout=600) as r:
        name = (r.headers.get_filename() or "kdpa.zip")
        zpath.write_bytes(r.read())
    print(f"  {name} · {zpath.stat().st_size / 1e6:.1f} MB", flush=True)
    dest = WORK / Path(name).stem
    with zipfile.ZipFile(zpath) as z:
        z.extractall(dest)
    shp = next(dest.rglob("*.shp"))
    # .cpg에 ‘949’라고만 적혀 있어 GDAL이 한글을 못 읽으므로, latin1로 읽은 뒤 CP949로 다시 풂
    gdf = gpd.read_file(shp, engine="pyogrio", encoding="latin1")
    gdf = gdf[[c for c in KEEP if c in gdf.columns] + ["geometry"]]
    for c in gdf.columns:
        if c != "geometry" and gdf[c].dtype == object:
            gdf[c] = gdf[c].map(lambda s: s.encode("latin1").decode("cp949", "replace").strip() if isinstance(s, str) else s)
    gdf = gdf.set_crs(4326, allow_override=True) if gdf.crs is None else gdf.to_crs(4326)
    gdf["geometry"] = shapely.make_valid(gdf.geometry.values)
    gdf = gdf[~gdf.geometry.is_empty]
    gdf["WDPAID"] = gdf["WDPAID"].astype("int64").astype(str)
    gdf["version"] = Path(name).stem
    OUT.unlink(missing_ok=True)
    gdf.to_file(OUT, driver="GPKG", engine="pyogrio")
    counts = gdf["DESIG"].value_counts()
    print(f"  {len(gdf):,}곳 → {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.1f} MB)")
    print("  " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    (WORK / "summary.json").write_text(json.dumps({"file": name, "count": len(gdf), "desig": counts.to_dict()}, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
