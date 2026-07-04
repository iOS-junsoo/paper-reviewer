# 골든 셋 — 렌더러 회귀 감시

렌더러(`public/app.js`의 `buildMethodViz`) 수정 시 화면 품질이 나빠지지 않았는지
자동으로 감시하기 위한 고정 스펙 모음과 QA 리포트 diff 도구.

## 구조

```
golden/
  T4/  *.json      # 공정성 프루닝 골든 셋 8편(현재 전부 T4)
  T1/  attention.json           # 아키텍처
  T7/  chain_of_retrieval.json  # 시스템·파이프라인
  T9/  bold.json                # 벤치마크·평가
  reports/
    baseline.json  # 비교 기준 QA 리포트 묶음
  diff_reports.js  # 리포트 diff 도구(Node 단일 파일)
  README.md
```

유형별 하위 폴더 구조 — 관리자가 T2·T3, 폴백 유형(T5·T6·T8) 논문을 추가해 12편 안팎으로
확장할 때 유형 폴더에 스펙 JSON을 넣으면 된다.

## QA 리포트란

각 렌더 시 렌더러가 산출하는 자가진단 결과(`window.__vizQA`):
- `spec_validation`: §9 검증기의 강등 내역(잘못된 detail_viz type, control 제거 등).
- `invariants`: 기하 불변식 8종(INV-1~8) 위반과 자동 복구 내역·해결 여부.
- `layout_metrics`: scale·모듈/엣지/단계 수·hidden_labels·serpentine·text_overflow_count.

## 워크플로 (렌더러 수정할 때마다)

1. **골든 스펙 → 서빙 파일 갱신** (골든 JSON을 브라우저에서 읽을 수 있게):
   ```
   node -e 'const fs=require("fs");const d="golden/T4";const s={};fs.readdirSync(d).filter(f=>f.endsWith(".json")).sort().forEach(f=>s[f.replace(".json","")]=JSON.parse(fs.readFileSync(d+"/"+f)));fs.writeFileSync("public/golden_specs.js","window.GOLDEN="+JSON.stringify(s)+";")'
   ```
2. **리포트 수집** (getBBox/텍스트 실측이 필요해 브라우저에서 실행):
   - 정적 서버로 `public/`을 열고 `golden_collect.html` 접속 → **[전수 렌더 + 리포트 수집]** →
     JSON을 복사하거나 **[JSON 다운로드]** → `golden/reports/<날짜>.json` 로 저장.
   - (정적 서버 예: `node .claude/static-server.js` → http://localhost:4173/golden_collect.html)
3. **diff**:
   ```
   node golden/diff_reports.js golden/reports/<날짜>.json
   ```
   - baseline(`golden/reports/baseline.json`)과 비교해 논문별 위반 증감·레이아웃 변화를 출력.
   - **회귀**(위반↑·미해결↑·scale 0.05↑ 급감·hidden_labels↑·text_overflow↑·강등↑·모듈/엣지 수 변화)가
     하나라도 있으면 종료 코드 1 — 수정을 되돌리고 원인을 보라.
4. **의도된 개선이면 baseline 승격**:
   ```
   node golden/diff_reports.js golden/reports/<날짜>.json --set-baseline
   ```

## 개발 모드 배지

`localStorage.setItem("mvizDev","1")` (또는 `window.MVIZ_DEV=true`) 이면 파이프라인 우상단에
`QA: 위반 n / 미해결 m · 강등 k` 배지가 뜨고, 클릭하면 리포트 JSON을 콘솔에 출력한다.
일반 사용자 모드에서는 배지가 숨겨지되 리포트 생성(`window.__vizQA`)은 유지된다.
