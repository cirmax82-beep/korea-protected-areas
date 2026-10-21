#!/usr/bin/env bash
# 경계 갱신: 브이월드에서 받기 → 구역으로 가공 → 사이트 자료 올리기 → 종류별 전체 파일을 릴리스(data-latest)에 올리기
# 브이월드가 해외 IP를 막으므로 국내 컴퓨터에서 실행합니다. 인증키는 work/vworld_key.txt(tools/save-key.ps1로 저장).
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONIOENCODING=utf-8
python tools/fetch_vworld.py
python tools/fetch_kdpa.py   # 브이월드에 없는 종류·구역을 채울 한국보호지역 통합DB
python tools/build.py
git add data
if git diff --cached --quiet; then
  echo "바뀐 경계 없음"
else
  git commit -q -m "경계 자료 갱신 $(date +%Y-%m-%d)"
  git push -q
fi
gh release view data-latest >/dev/null 2>&1 || gh release create data-latest --title "보호구역 경계 자료(최신)" --notes "종류별 SHP·GeoJSON(zip)과 전체 GeoPackage. 출처: 국토교통부 브이월드(디지털트윈국토)."
gh release upload data-latest work/release/* --clobber
gh release edit data-latest --notes "종류별 SHP·GeoJSON(zip)과 전체 GeoPackage. 출처: 국토교통부 브이월드(디지털트윈국토)를 먼저 쓰고, 브이월드에 없는 종류·구역은 한국보호지역 통합DB(KDPA)로 채움(구역마다 SOURCE 속성). 갱신: $(date +%Y-%m-%d)"
echo "갱신 끝"
