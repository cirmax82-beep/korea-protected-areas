"""보호구역 레이어 목록 — 기준 자료 순서
1) 국립생태원 생태·자연도 별도관리지역(ecozone) — 그 종류가 있으면 먼저 씀
2) 브이월드(국토교통부 디지털트윈국토) 2D 데이터 API(data) — 생태·자연도가 있는 종류는 생태·자연도에 없는 부분만 채움
3) 한국보호지역 통합DB(KDPA, kdpa) — 위 두 자료에 없는 구역을 더함(같은 종류도). 기존 구역과 절반 넘게 겹치거나
   고유 이름이 같으면 같은 구역으로 보고 빼며, 고유 이름 없이 시도·전국을 통째로 묶은 옛 자료도 뺌

data: 브이월드 레이어, ecozone: 생태·자연도 별도관리지역의 종류 열, kdpa: KDPA 지정 유형(DESIG),
group: 지도 필터 묶음, color: 지도 색, law: 근거 법령(안내용), keep: 남길 세부 구분(uname)만,
filter: 받을 때 브이월드에서 미리 거를 조건(attrFilter),
kdpa_pick: {KDPA 지정 유형: [이름, …]} — kdpa 목록 없이 특정 구역만 KDPA에서 골라 넣을 때
raw: 다른 레이어가 받은 브이월드 자료를 같이 씀(그 레이어 id), carve_by: 이 레이어들의 구역 자리는 잘라 냄(먼저 만든 레이어)
"""

GROUPS = {
    "nature": "자연·생태 보호구역",
    "env": "물·환경 규제지역",
    "heritage": "국가유산",
    "marine": "해양·연안",
}

# 소재 시도·시군구를 붙일 때 쓰는 행정경계(지도에는 안 그림)
ADMIN = {"id": "admin-sigg", "data": "LT_C_ADSIGG_INFO", "name": "시군구 경계"}

LAYERS = [
    # 자연·생태 보호구역
    # 브이월드 야생생물보호구역 자료 중 특별보호구역만 따로(진양호 수달서식지 등)
    {"id": "wildlife-special", "data": "LT_C_UM221", "raw": "wildlife", "name": "야생생물특별보호구역", "group": "nature", "color": "#8f1d1d",
     "law": "야생생물 보호 및 관리에 관한 법률 제27조", "keep": ["야생생물특별보호구역"], "kdpa": ["야생생물특별보호구역"],
     "merge_kdpa": True},   # 지정 현황(KDPA)과 겹치는 것만 특별보호구역으로 보고(build.py SPECIAL_OK), 같은 보호지역 조각은 한 구역으로
    {"id": "wildlife", "data": "LT_C_UM221", "ecozone": "야생동식물", "name": "야생생물보호구역", "group": "nature", "color": "#c92a2a",
     "law": "야생생물 보호 및 관리에 관한 법률 제33조", "keep": ["야생생물보호구역", "시·도 야생생물보호구역", "야생생물보호구역(미분류)"],
     "carve_by": ["wildlife-special"], "kdpa": ["야생생물보호구역"]},
    # 브이월드 ‘습지보호구역’(LT_C_WGISARWET)에는 내륙 습지보호지역도 함께 들어 있어, KDPA 구분으로 갯벌(연안)만 남김(build.py prepare)
    {"id": "wetland-coast", "data": "LT_C_WGISARWET", "name": "연안습지보호지역", "group": "nature", "color": "#1971c2",
     "law": "습지보전법 제8조(해양수산부)", "kdpa": ["습지보호지역-갯벌", "습지보호지역-시도"]},
    {"id": "wetland", "data": "LT_C_UM901", "ecozone": "습지보호", "name": "습지보호지역", "group": "nature", "color": "#1c7ed6",
     "law": "습지보전법 제8조", "carve_by": ["wetland-coast"], "kdpa": ["습지보호지역", "시_도습지보호지역"]},
    {"id": "eco-landscape", "data": None, "ecozone": "생태경관", "name": "생태·경관보전지역", "group": "nature", "color": "#ae3ec9",
     "law": "자연환경보전법 제12조·제23조", "kdpa": ["생태경관보전지역", "시_도생태경관보전지역"]},
    {"id": "special-island", "data": None, "name": "특정도서", "group": "nature", "color": "#fd7e14",
     "law": "독도 등 도서지역의 생태계보전에 관한 특별법 제4조", "kdpa": ["특정도서"]},
    {"id": "park-national", "data": "LT_C_WGISNPGUG", "ecozone": "국립공원", "name": "국립공원", "group": "nature", "color": "#2b8a3e",
     "law": "자연공원법 제4조", "kdpa": ["국립공원"]},   # 금정산(2026-03-03 지정)은 KDPA로 들어옴
    {"id": "park-province", "data": "LT_C_WGISNPDO", "ecozone": "도립공원", "name": "도립공원", "group": "nature", "color": "#40c057",
     "law": "자연공원법 제4조의2", "kdpa": ["도립공원"]},
    {"id": "park-county", "data": "LT_C_WGISNPGUN", "ecozone": "군립공원", "name": "군립공원", "group": "nature", "color": "#69db7c",
     "law": "자연공원법 제4조의3", "kdpa": ["군립공원"]},
    {"id": "forest", "data": "LT_C_UF151", "ecozone": "산림보호", "name": "산림보호구역", "group": "nature", "color": "#5c940d",
     "law": "산림보호법 제7조", "kdpa": ["경관보호구역", "수원함양보호구역", "재해방지보호구역", "산림유전자원보호구역", "생활환경보호구역"]},
    # 산림보호구역 중 산림유전자원보호구역만 따로 보기(산림보호구역 레이어는 그대로 — 같은 자리가 두 레이어에 다 있음)
    {"id": "forest-genetic", "data": "LT_C_UF151", "raw": "forest", "name": "산림보호구역(산림유전자원보호림)", "group": "nature",
     "color": "#3d5a1e", "law": "산림보호법 제7조(산림유전자원보호구역)", "keep": ["산림유전자원보호림"]},
    {"id": "baekdu", "data": "LT_C_UF901", "ecozone": "백두대간", "name": "백두대간보호지역", "group": "nature", "color": "#7048e8",
     "law": "백두대간 보호에 관한 법률 제6조", "kdpa": ["백두대간보호지역"]},
    # 자연휴양림·수목원 등 법정 보호구역은 아니지만 KDPA가 보호지역·자연공존지역(OECM)으로 올린 곳
    {"id": "kdpa-other", "data": None, "name": "기타 보전지역", "group": "nature", "color": "#a9e34b",
     "law": "산림문화·휴양에 관한 법률, 수목원·정원의 조성 및 진흥에 관한 법률 등(KDPA 보호지역·OECM)",
     "kdpa": ["자연휴양림", "수목원", "학술림", "생태공원", "보전재산", "댐 홍수터", "하천구역(특별보전구역)"]},
    # 물·환경 규제지역
    {"id": "water", "data": "LT_C_UM710", "name": "상수원보호구역", "group": "env", "color": "#0c8599",
     "law": "수도법 제7조", "kdpa": ["상수원보호구역"]},
    {"id": "riparian", "data": None, "name": "수변구역", "group": "env", "color": "#74c0fc",
     "law": "한강·낙동강·금강·영산강·섬진강 수계 물관리 및 주민지원 등에 관한 법률", "kdpa": ["수변구역"]},
    {"id": "special-measure", "data": None, "name": "수질보전 특별대책지역", "group": "env", "color": "#a61e4d",
     "law": "환경정책기본법 제38조", "kdpa": ["특별대책지역"]},
    {"id": "natenv", "data": "LT_C_UQ114", "name": "자연환경보전지역", "group": "env", "color": "#087f5b",
     "law": "국토의 계획 및 이용에 관한 법률 제36조", "kdpa": ["자연환경보전지역"]},
    # 이 레이어에는 어린이공원·완충녹지 등 도시공원·녹지 34종이 함께 들어 있어 도시자연공원(구역)만 남김
    {"id": "urbanpark", "data": "LT_C_UQ162", "name": "도시자연공원구역", "group": "env", "color": "#94d82d",
     "law": "도시공원 및 녹지 등에 관한 법률 제26조", "keep": ["도시자연공원구역", "도시자연공원"], "kdpa": ["도시자연공원구역"]},
    {"id": "protect-district", "data": "LT_C_UQ126", "name": "보호지구", "group": "env", "color": "#e8590c",
     "law": "국토의 계획 및 이용에 관한 법률 제37조(역사문화환경·중요시설물·생태계보호지구)"},
    # 경관지구 중 자연경관지구만(산지·구릉지 등 자연경관 보호)
    {"id": "landscape", "data": "LT_C_UQ121", "name": "자연경관지구", "group": "env", "color": "#e64980",
     "law": "국토의 계획 및 이용에 관한 법률 제37조", "filter": "uname:=:자연경관지구"},
    {"id": "greenbelt", "data": "LT_C_UD801", "name": "개발제한구역", "group": "env", "color": "#868e96",
     "law": "개발제한구역의 지정 및 관리에 관한 특별조치법 제3조"},
    {"id": "air", "data": "LT_C_UM301", "name": "대기환경규제지역", "group": "env", "color": "#adb5bd",
     "law": "대기환경보전법 제18조"},
    # 국가유산
    {"id": "heritage", "data": "LT_C_UO301", "name": "국가유산 보호구역", "group": "heritage", "color": "#a0522d",
     "law": "국가유산기본법·문화유산법·자연유산법"},
    # 브이월드 국가유산 보호구역에는 종류 구분이 없어, 천연기념물(천연보호구역 포함) 지정 범위는 생태·자연도로 따로 둠(일부 겹침)
    {"id": "natural-heritage", "data": None, "ecozone": "천연기념물", "name": "천연기념물", "group": "heritage", "color": "#6f4e37",
     "law": "자연유산의 보존 및 활용에 관한 법률", "kdpa": ["천연기념물", "천연보호구역"]},
    {"id": "scenic", "data": None, "name": "명승", "group": "heritage", "color": "#b5835a",
     "law": "자연유산의 보존 및 활용에 관한 법률", "kdpa": ["명승"]},
    {"id": "temple", "data": "LT_C_UO501", "name": "전통사찰보존구역", "group": "heritage", "color": "#d4a017",
     "law": "전통사찰의 보존 및 지원에 관한 법률 제6조"},
    # 해양·연안
    {"id": "coast-conserve", "data": "LT_C_WGISPL2ABS", "name": "보전연안해역", "group": "marine", "color": "#1864ab",
     "law": "연안관리법 제6조"},
    # 브이월드 자료는 해양수산부 2018-11-30 기준
    {"id": "marine-mpa", "data": "LT_C_TFISMPA", "name": "해양보호구역", "group": "marine", "color": "#4263eb",
     "law": "해양생태계의 보전 및 관리에 관한 법률 제25조", "kdpa": ["해양보호구역", "해양보호구역(해양생물)", "해양보호구역(경관)"]},
    {"id": "env-sea", "data": None, "name": "환경보전해역", "group": "marine", "color": "#748ffc",
     "law": "해양환경관리법 제15조", "kdpa": ["환경보전해역"]},
    # 국토계획구역 레이어(8만여 개)에서 수산자원보호구역만. 생태·자연도에는 육지·갯벌 쪽만 있어 바다 쪽은 브이월드로 채움
    {"id": "fishery", "data": "LT_C_UQ141", "ecozone": "수산자원", "name": "수산자원보호구역", "group": "marine", "color": "#3bc9db",
     "law": "국토의 계획 및 이용에 관한 법률 제40조", "filter": "uname:=:수산자원보호구역", "kdpa": ["수산자원보호구역"]},
]
