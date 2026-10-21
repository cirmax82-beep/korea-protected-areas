"""브이월드 2D 데이터 API에서 보호구역 경계를 전국 단위로 받습니다(원본 해상도, EPSG:4326).

    VWORLD_KEY=인증키 python tools/fetch_vworld.py            # 전체
    VWORLD_KEY=인증키 python tools/fetch_vworld.py wildlife water  # 일부 레이어만

- 인증키는 환경 변수 VWORLD_KEY 또는 이 컴퓨터의 work/vworld_key.txt(tools/save-key.ps1로 저장, 저장소에 올라가지 않음)에서 읽습니다.
- 브이월드는 해외 IP 접속을 막으므로 GitHub 서버(미국)에서는 받을 수 없고, 국내 컴퓨터에서 실행해야 합니다.
- 인증키 발급 때 넣은 서비스 URL을 VWORLD_DOMAIN으로 함께 보냅니다(서버에서 부를 때 필요).
- 한 번에 1,000건까지라 페이지를 넘겨 받고, 검색 상자가 너무 크다고 거절하면 상자를 4등분해 다시 받습니다.
- 결과: work/raw/<레이어 id>.geojson, work/raw/summary.json
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layers import ADMIN, LAYERS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.vworld.kr/req/data"
KOREA = (124.0, 33.0, 132.0, 39.0)
SIZE = 1000
OUT = ROOT / "work" / "raw"


def call(key, domain, data, box, page, attr=None):
    params = {
        "service": "data", "version": "2.0", "request": "GetFeature", "key": key, "domain": domain,
        "format": "json", "errorFormat": "json", "size": SIZE, "page": page, "data": data,
        "geomFilter": "BOX({},{},{},{})".format(*box), "geometry": "true", "attribute": "true", "crs": "EPSG:4326",
    }
    if attr:   # 예: uname:=:수산자원보호구역
        params["attrFilter"] = attr
    url = f"{API}?{urllib.parse.urlencode(params)}"
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"Referer": domain}), timeout=120) as r:
                return json.load(r)["response"]
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
            if attempt == 5:
                raise RuntimeError(f"{data} {box} p{page}: {e}") from e
            time.sleep(3 * (attempt + 1))


def fetch_box(key, domain, data, box, depth=0, attr=None):
    """상자 하나의 모든 페이지. 거절(범위 초과 등)되면 4등분."""
    first = call(key, domain, data, box, 1, attr)
    status = first.get("status")
    if status == "NOT_FOUND":
        return []
    if status != "OK":
        err = first.get("error") or {}
        code = err.get("code", "")
        if code in ("INVALID_KEY", "INCORRECT_KEY", "UNAVAILABLE_KEY", "OVER_REQUEST_LIMIT") or depth >= 6:
            raise RuntimeError(f"{data}: {code} {err.get('text', '')}")
        x0, y0, x1, y1 = box
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        print(f"    {data} 상자 나눔({code}) 깊이 {depth + 1}", flush=True)
        out = []
        for b in ((x0, y0, mx, my), (mx, y0, x1, my), (x0, my, mx, y1), (mx, my, x1, y1)):
            out += fetch_box(key, domain, data, b, depth + 1, attr)
        return out
    feats = list(first["result"]["featureCollection"]["features"])
    pages = int(first["page"]["total"])
    for p in range(2, pages + 1):
        r = call(key, domain, data, box, p, attr)
        if r.get("status") == "OK":
            feats += r["result"]["featureCollection"]["features"]
        time.sleep(0.2)
    return feats


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    key = os.environ.get("VWORLD_KEY")
    key_file = ROOT / "work" / "vworld_key.txt"   # tools/save-key.ps1 로 저장(저장소에 올라가지 않음)
    if not key and key_file.exists():
        key = key_file.read_text(encoding="utf-8").strip()
    if not key:
        raise SystemExit("브이월드 인증키가 없습니다. tools/save-key.ps1 로 저장하거나 VWORLD_KEY를 지정하세요.")
    domain = os.environ.get("VWORLD_DOMAIN", "https://protect.biogrideia.com")
    only = set(sys.argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    summary_path = OUT / "summary.json"   # 일부 레이어만 받을 때는 나머지 기록을 남겨 둠
    summary = json.loads(summary_path.read_text(encoding="utf-8")) if only and summary_path.exists() else {}
    for layer in LAYERS + [ADMIN]:   # 행정경계는 생태·자연도 구역의 소재지를 붙일 때 씀
        if (only and layer["id"] not in only) or not layer.get("data"):   # data가 없으면 KDPA만 쓰는 종류
            continue
        t = time.time()
        feats = fetch_box(key, domain, layer["data"], KOREA, attr=layer.get("filter"))
        uniq = {}
        for f in feats:   # 상자를 나눠 받으면 경계에 걸친 도형이 겹쳐 들어오므로 id로 한 번만
            uniq[f.get("id") or json.dumps(f["properties"], sort_keys=True, ensure_ascii=False)] = f
        feats = list(uniq.values())
        path = OUT / f"{layer['id']}.geojson"
        path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False), encoding="utf-8")
        keys = sorted({k for f in feats[:200] for k in (f.get("properties") or {})})
        summary[layer["id"]] = {"data": layer["data"], "name": layer["name"], "features": len(feats),
                                "mb": round(path.stat().st_size / 1e6, 2), "properties": keys,
                                "sample": (feats[0].get("properties") if feats else None)}
        print(f"  {layer['name']}({layer['data']}): {len(feats):,}개 · {summary[layer['id']]['mb']} MB · {time.time() - t:.0f}초", flush=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
