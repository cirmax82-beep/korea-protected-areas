"""보호구역 레이어 목록 — 브이월드(국토교통부 디지털트윈국토) 2D 데이터 API를 먼저 쓰고,
브이월드에 없는 것은 한국보호지역 통합DB(KDPA)로 채웁니다.

data: 브이월드 레이어(없으면 KDPA만 씀), group: 지도 필터 묶음, color: 지도 색, law: 근거 법령(안내용),
keep: 남길 세부 구분(uname)만 — 없으면 전부, filter: 받을 때 브이월드에서 미리 거를 조건(attrFilter),
kdpa: 이 종류로 넣을 KDPA 지정 유형(DESIG). 브이월드 레이어가 있으면 브이월드 구역과 절반 넘게 겹치는 KDPA 구역은 빼고
      브이월드에 빠진 구역만 더함(브이월드 우선). 브이월드 레이어가 없으면 KDPA 구역을 전부 씀.
"""

GROUPS = {
    "nature": "자연·생태 보호구역",
    "env": "물·환경 규제지역",
    "heritage": "국가유산",
    "marine": "해양·연안",
}

LAYERS = [
    # 자연·생태 보호구역
    {"id": "wildlife", "data": "LT_C_UM221", "name": "야생생물보호구역", "group": "nature", "color": "#c92a2a",
     "law": "야생생물 보호 및 관리에 관한 법률 제27조·제33조", "kdpa": ["야생생물보호구역", "야생생물특별보호구역"]},
    {"id": "wetland", "data": "LT_C_UM901", "name": "습지보호지역", "group": "nature", "color": "#1c7ed6",
     "law": "습지보전법 제8조", "kdpa": ["습지보호지역", "시_도습지보호지역", "습지보호지역-시도"]},
    {"id": "wetland-coast", "data": "LT_C_WGISARWET", "name": "연안습지보호지역", "group": "nature", "color": "#1971c2",
     "law": "습지보전법 제8조(해양수산부)", "kdpa": ["습지보호지역-갯벌"]},
    {"id": "eco-landscape", "data": None, "name": "생태·경관보전지역", "group": "nature", "color": "#ae3ec9",
     "law": "자연환경보전법 제12조·제23조", "kdpa": ["생태경관보전지역", "시_도생태경관보전지역"]},
    {"id": "special-island", "data": None, "name": "특정도서", "group": "nature", "color": "#fd7e14",
     "law": "독도 등 도서지역의 생태계보전에 관한 특별법 제4조", "kdpa": ["특정도서"]},
    {"id": "park-national", "data": "LT_C_WGISNPGUG", "name": "국립공원", "group": "nature", "color": "#2b8a3e",
     "law": "자연공원법 제4조", "kdpa": ["국립공원"]},
    {"id": "park-province", "data": "LT_C_WGISNPDO", "name": "도립공원", "group": "nature", "color": "#40c057",
     "law": "자연공원법 제4조의2", "kdpa": ["도립공원"]},
    {"id": "park-county", "data": "LT_C_WGISNPGUN", "name": "군립공원", "group": "nature", "color": "#69db7c",
     "law": "자연공원법 제4조의3", "kdpa": ["군립공원"]},
    {"id": "forest", "data": "LT_C_UF151", "name": "산림보호구역", "group": "nature", "color": "#5c940d",
     "law": "산림보호법 제7조", "kdpa": ["경관보호구역", "수원함양보호구역", "재해방지보호구역", "산림유전자원보호구역", "생활환경보호구역"]},
    {"id": "baekdu", "data": "LT_C_UF901", "name": "백두대간보호지역", "group": "nature", "color": "#7048e8",
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
     "law": "도시공원 및 녹지 등에 관한 법률 제26조", "keep": ["도시자연공원구역", "도시자연공원"]},   # KDPA는 2005년 시도 단위 묶음이라 안 씀
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
    # 브이월드 국가유산 보호구역에는 종류 구분이 없어, 자연유산(천연기념물·명승) 지정 범위는 KDPA로 따로 둠(일부 겹침)
    {"id": "natural-heritage", "data": None, "name": "천연기념물·명승", "group": "heritage", "color": "#6f4e37",
     "law": "자연유산의 보존 및 활용에 관한 법률", "kdpa": ["천연기념물", "명승", "천연보호구역"]},
    {"id": "temple", "data": "LT_C_UO501", "name": "전통사찰보존구역", "group": "heritage", "color": "#d4a017",
     "law": "전통사찰의 보존 및 지원에 관한 법률 제6조"},
    # 해양·연안
    {"id": "coast-conserve", "data": "LT_C_WGISPL2ABS", "name": "보전연안해역", "group": "marine", "color": "#1864ab",
     "law": "연안관리법 제6조"},
    # 브이월드 자료는 해양수산부 2018-11-30 기준 — 그 뒤 지정분은 KDPA로 채움
    {"id": "marine-mpa", "data": "LT_C_TFISMPA", "name": "해양보호구역", "group": "marine", "color": "#4263eb",
     "law": "해양생태계의 보전 및 관리에 관한 법률 제25조", "kdpa": ["해양보호구역", "해양보호구역(해양생물)", "해양보호구역(경관)"]},
    {"id": "env-sea", "data": None, "name": "환경보전해역", "group": "marine", "color": "#748ffc",
     "law": "해양환경관리법 제15조", "kdpa": ["환경보전해역"]},
    # 국토계획구역 레이어(8만여 개)에서 수산자원보호구역만
    {"id": "fishery", "data": "LT_C_UQ141", "name": "수산자원보호구역", "group": "marine", "color": "#3bc9db",
     "law": "국토의 계획 및 이용에 관한 법률 제40조", "filter": "uname:=:수산자원보호구역", "kdpa": ["수산자원보호구역"]},
]
