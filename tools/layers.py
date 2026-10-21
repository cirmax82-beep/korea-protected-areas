"""보호구역 레이어 목록 — 브이월드(국토교통부 디지털트윈국토) 2D 데이터 API 레이어.

group: 지도 필터 묶음, color: 지도 색, law: 근거 법령(안내용)
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
     "law": "야생생물 보호 및 관리에 관한 법률 제27조·제33조"},
    {"id": "wetland", "data": "LT_C_UM901", "name": "습지보호지역", "group": "nature", "color": "#1c7ed6",
     "law": "습지보전법 제8조"},
    {"id": "wetland-coast", "data": "LT_C_WGISARWET", "name": "연안습지보호지역", "group": "nature", "color": "#1971c2",
     "law": "습지보전법 제8조(해양수산부)"},
    {"id": "park-national", "data": "LT_C_WGISNPGUG", "name": "국립공원", "group": "nature", "color": "#2b8a3e",
     "law": "자연공원법 제4조"},
    {"id": "park-province", "data": "LT_C_WGISNPDO", "name": "도립공원", "group": "nature", "color": "#40c057",
     "law": "자연공원법 제4조의2"},
    {"id": "park-county", "data": "LT_C_WGISNPGUN", "name": "군립공원", "group": "nature", "color": "#69db7c",
     "law": "자연공원법 제4조의3"},
    {"id": "forest", "data": "LT_C_UF151", "name": "산림보호구역", "group": "nature", "color": "#5c940d",
     "law": "산림보호법 제7조"},
    {"id": "baekdu", "data": "LT_C_UF901", "name": "백두대간보호지역", "group": "nature", "color": "#7048e8",
     "law": "백두대간 보호에 관한 법률 제6조"},
    # 물·환경 규제지역
    {"id": "water", "data": "LT_C_UM710", "name": "상수원보호구역", "group": "env", "color": "#0c8599",
     "law": "수도법 제7조"},
    {"id": "natenv", "data": "LT_C_UQ114", "name": "자연환경보전지역", "group": "env", "color": "#087f5b",
     "law": "국토의 계획 및 이용에 관한 법률 제36조"},
    {"id": "urbanpark", "data": "LT_C_UQ162", "name": "도시자연공원구역", "group": "env", "color": "#94d82d",
     "law": "도시공원 및 녹지 등에 관한 법률 제26조"},
    {"id": "protect-district", "data": "LT_C_UQ126", "name": "보호지구", "group": "env", "color": "#e8590c",
     "law": "국토의 계획 및 이용에 관한 법률 제37조(역사문화환경·중요시설물·생태계보호지구)"},
    {"id": "greenbelt", "data": "LT_C_UD801", "name": "개발제한구역", "group": "env", "color": "#868e96",
     "law": "개발제한구역의 지정 및 관리에 관한 특별조치법 제3조"},
    {"id": "air", "data": "LT_C_UM301", "name": "대기환경규제지역", "group": "env", "color": "#adb5bd",
     "law": "대기환경보전법 제18조"},
    # 국가유산
    {"id": "heritage", "data": "LT_C_UO301", "name": "국가유산 보호구역", "group": "heritage", "color": "#a0522d",
     "law": "국가유산기본법·문화유산법·자연유산법"},
    {"id": "temple", "data": "LT_C_UO501", "name": "전통사찰보존구역", "group": "heritage", "color": "#d4a017",
     "law": "전통사찰의 보존 및 지원에 관한 법률 제6조"},
    # 해양·연안
    {"id": "coast-conserve", "data": "LT_C_WGISPL2ABS", "name": "보전연안해역", "group": "marine", "color": "#1864ab",
     "law": "연안관리법 제6조"},
]
