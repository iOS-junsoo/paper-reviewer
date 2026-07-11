# 방법론 시각화 개선 인수인계 문서 (B→A→C→D·E)

> 다른 채팅 세션이 이 문서만 읽고 바로 구현할 수 있도록 자립적으로 작성됨. 작성: 2026-07-11.
> 근거: 7/6 이후 분석 11편의 method_viz_html 전수 실물 감사(스크린샷+DOM 프로브) 결과.
> 대상 저장소: `/Users/kimjunsu/Desktop/PAPER_REVIEWER`

---

## §0. 공통 컨텍스트 (필독)

- **시각화 파이프라인**: 새 논문 정밀 분석 시 `generateMethodVizHtml`(server.js)이
  `prompts/method_viz_html_gen.md` 지시문 + `prompts/method_viz_refs/t{1..9}_*.html`(타입별
  참조 구현 = 정답지)을 근거로 **독립 HTML**(외부 의존성 0)을 생성 →
  `scripts/verify_mviz.js`(puppeteer, §8.2 기하검사+§9 함정검사)를 자가 실행해 pass까지 수정 →
  서버가 최종 게이트로 verify 재실행 → 통과분만 `analysis.method_viz_html`로 저장.
  프론트는 iframe(srcdoc)으로 렌더(`buildMethodVizFrame`, app.js).
- **타입 체계**: T1 아키텍처(t1_transformer) · T2 모듈삽입(t2_senet) · T3 손실/학습기법(t3_simclr) ·
  T4 프루닝(t4_fairgrape) · T5 증강(t5_mixup) · T6 생성과정(t6_ddpm) · T7 파이프라인(t7_rag) ·
  T8 현상분석(t8_grokking) · T9 벤치마크(t9_bold). 9개 외 논문은 최근접 골격 차용 + "폴백" 배지(§5).
- **절대 규칙**: LLM 호출은 Claude Agent SDK(`query()`)+OAuth 토큰만(유료 API 금지, 세션 한도 유의).
  커밋은 사용자 요청 시만. 서버 재기동 전 진행 중 분석 없는지 로그 확인
  (`launchctl kickstart -k gui/$(id -u)/com.kimjunsu.paper-reviewer`, 로그
  `/Users/kimjunsu/Library/Logs/paper-reviewer.log`).
- **감사 방법 재현**: 히스토리 API에서 method_viz_html을 덤프해 임시 http 서버로 서빙 후
  브라우저 스크린샷. 섹션 재생성은 `POST /api/reanalyze-section/<hash>` body `{"section":"method"}`.

### 감사 요약 (왜 이 작업들인가)
- 타입 판정은 11/11 합리적(9편 최적) — **타입 체계 자체는 건드리지 않는다.**
- 발견된 실결함: ① raw LaTeX 노출 5/11편 ② 실험실 조작축 1개 고정(10/11) ③ 파이프라인
  미도달 단계 과희미 ④ 신경장(NeRF류) 전용 타입 부재(항상 폴백).

---

## 작업 B — raw LaTeX 노출 근절 (1순위 · 결함 수정) ✅ 완료 (2026-07-11)

> 완료 기록: B-1 지침 금지규칙 + B-2 verify `§7 raw_latex` 검사(오탐 방지: 금액 제외) 반영.
> B-3 참조 2건은 렌더 기준 검사 결과 **원래 깨끗**(정적 스캔의 스크립트 `$("...")` 오탐) — 무수정.
> B-4 재생성(~$7.5)은 **외과 패치로 대체(LLM 0원)**: 오염 5편(ArcFace·CBM·DIP·Slimming·NeRF)의
> 노출 20건을 유니코드/sub·sup로 치환해 Firestore analysisJson만 update(createdAt 등 보존),
> 재덤프 후 5편 전부 `pass:true · raw_latex:0` 확인. 남은 작업: A → C → D·E.

**문제**: 생성 HTML은 KaTeX가 없는 독립 파일인데 모델이 `$...$`를 쓰면 **LaTeX 소스가
화면에 그대로 보인다**. 실측: CBM 8건(`$\hat c=g(x)$` 노출), DIP 4건, Network Slimming 2건
(수식 통째 `$L=\sum l(f(x,W),y)+\lambda\sum g(\gamma)$`), NeRF 2건, ArcFace 2건.
참조 구현조차 t1_transformer 1건·t3_simclr 2건이 있어 **정답지가 나쁜 예를 가르치는 구조**.
`scripts/verify_mviz.js`는 이를 검사하지 않아 자가검증 루프가 못 잡는다.

**수정 방법**:
1. `prompts/method_viz_html_gen.md`에 금지 규칙 추가(§7 정직성 인근):
   "출력 HTML에 `$...$`/`\(...\)` LaTeX 표기 금지 — KaTeX가 없어 소스가 그대로 노출된다.
   수식은 HTML `<sub>/<sup>`·유니코드(θ·γ·Σ·√·≤)·이탤릭으로 표기(예: `x̂=g(x)`,
   `L = Σ l(f(x,W),y) + λΣ g(γ)`)."
2. `scripts/verify_mviz.js`에 검사 추가: 렌더된 페이지의 `document.body.innerText`에서
   `/\$[^$\n]{1,60}\$/` 매치 시 violation `raw_latex` (기존 violations 배열 형식에 맞춰).
   → 자가검증 루프가 자동으로 고치게 됨.
3. 참조 구현 정리: `prompts/method_viz_refs/t1_transformer.html`(1건)·`t3_simclr.html`(2건)의
   `$...$`를 유니코드/sub·sup로 치환. (수정 후 `node scripts/verify_mviz.js <파일> --json`으로
   두 파일 pass 확인 — raw_latex 검사가 참조 자신도 통과해야 함.)
4. 기존 오염 5편 재생성: `POST /api/reanalyze-section/<hash>` `{"section":"method"}` 순차 실행
   (편당 ~$1.5·5분). 대상 hash는 히스토리에서 제목으로 조회 — Concept Bottleneck Models /
   Deep Image Prior / Learning Efficient Convolutional Networks(=Network Slimming) / NeRF / ArcFace.
   ⚠️ 세션 한도 감안해 사용자에게 "지금 5편 재생성할지" 물어보고 진행.

**검증**: 신규 verify 검사를 오염 HTML(재생성 전 백업본)에 돌려 raw_latex 검출 확인 →
참조 2건 pass → 재생성 후 5편 `$` 노출 0건 스캔.

---

## 작업 A — 원문 overview figure 나란히 배치 (2순위 · 최대 임팩트) ✅ 완료 (2026-07-11)

> 완료 기록: `buildMethodOrigFigures`(app.js) — architecture/method kind 필터(+section_ref
> Figure 라벨 폴백, 최대 4장), 접이식 기본 접힘, 처음 펼칠 때만 크롭 로드, 클릭 시 원문 점프,
> 실패 시 안내문. CSS `.mviz-orig*`. static-preview로 필터·폴백·레이지·미생성 케이스 검증.
> 남은 작업: C → D·E.

**문제**: 생성 시각화는 "초심자용 재구성"이라 논문 원본 그림과의 연결 고리가 없다.
세미나 발표자는 결국 **논문의 실제 Figure**로 설명해야 하는데, 재구성↔원문을 오가며
대조할 수단이 없음. (마침 그림 크롭 파이프라인이 캡션 검출 수리로 정확해져 재료가 준비됨 —
`lib/figurebox.js` v12, `GET /api/figure/:hash?page&box&label`이 캡션 포함 크롭 PNG 반환.)

**수정 방법** (LLM 0원 — 프론트만):
1. `renderMethod`(app.js) 에서 시각화 iframe **위**에 접이식 블록 추가:
   `<details class="mviz-orig"><summary>📄 논문의 원본 그림과 대조</summary>…</details>`
2. 내용물: `analysis.figure_guide`에서 **방법 관련 그림만** 골라(`kind === "architecture" ||
   kind === "method"`, 없으면 method_visualization.section_ref가 가리키는 Figure 라벨 매칭)
   기존 그림 탭과 동일한 `/api/figure/…` img로 렌더(레이지 로드 패턴 재사용 —
   `img.dataset.src` + 그림 탭의 `loadFigureImages` 참고). 클릭 시 원문 점프
   (`jumpToPdfPageText(page, label)`).
3. 기본은 접힘(시각화가 주인공), summary에 그림 개수 표기("원본 그림 2장").
4. 방법 관련 그림이 없으면 블록 자체를 렌더하지 않음.

**검증**: static-preview에서 architecture kind 포함 가짜 figure_guide로 렌더 →
블록 존재·접기/펼치기·img src 형식 확인. 라이브에서 Transformer(방금 재생성된
figure_guide 보유)로 실물 확인.

---

## 작업 C — 스테퍼 ↔ 정밀 강독 연동 (3순위 · 시너지)

**문제**: 방법론 탭에 "단계 스테퍼(요약)"와 "정밀 강독(상세)"이 위아래로 있는데 서로
연결이 없다. 스테퍼에서 궁금해진 단계를 강독의 해당 절로 바로 점프할 수 없음.

**수정 방법** (LLM 0원 — 프론트 휴리스틱 매칭):
1. `renderMethod`의 스테퍼 각 항목(`li#step-N`)에, `analysis.method_deep`이 있으면
   `[🔬 강독에서 자세히]` 미니 링크 추가.
2. 매칭 휴리스틱: 단계 title의 핵심 토큰과 `method_deep.sections[].ref`+body 앞부분의
   토큰 겹침 최대인 섹션 선택(전부 실패 시 순서 기반 — i번째 단계→⌈i×섹션수/단계수⌉번째 절).
3. 클릭 → 해당 `details.mdeep-sec`을 `open=true` + scrollIntoView + 잠깐 하이라이트
   (`eq-flash` 클래스 재사용).
4. 역방향: 강독 각 절 summary 옆에 이미 있는 `p.N ↗`(원문 점프)와 나란히
   `[단계 보기]`는 **생략**(과밀 방지 — 정방향만).

**검증**: static-preview에서 method_steps 6개+method_deep 4개 가짜 데이터로 링크
존재·점프·하이라이트 확인.

---

## 작업 D — 실험실 조작 깊이 기준 (4순위 · 프롬프트 한 줄)

**문제**: 11편 중 10편이 실험실 슬라이더 1개 고정(RandAugment만 2개). "직접 조작"의
가치가 얕게 수렴 — 참조 구현들이 1축 패턴이라 모델이 그대로 따라함.

**수정 방법**:
1. `prompts/method_viz_html_gen.md`의 실험실 관련 절에 추가:
   "실험실은 ==의미 있는 조작 축 2개==를 권장한다(예: ArcFace라면 마진 m + 스케일 s,
   프루닝이라면 희소도 + 재학습 여부). 단 ==논문에 실제로 존재하는 축만== — 억지로
   2개를 만들지 말고, 현상분석(T8)·벤치마크(T9)처럼 조작이 부자연스러운 타입은 1개
   또는 관찰형(자동 재생)도 허용."
2. verify 강제는 하지 않음(억지 축 생성 부작용 방지) — 프롬프트 권장만.

**검증**: 다음 신규 분석 1편에서 축 2개(가능한 논문일 때) 생성되는지 관찰.

---

## 작업 E — 파이프라인 미도달 단계 최소 대비 (4순위 · 가독)

**문제**: 좌측 파이프라인에서 현재 스텝 이후 노드가 너무 옅어(스크린샷상 거의 백지)
전체 구조를 먼저 훑기 어렵다.

**수정 방법**:
1. `prompts/method_viz_html_gen.md` 렌더 규칙에 추가: "미도달 단계도 ==opacity 0.45
   이상==(구조는 항상 읽히게), 현재 단계만 강조·완료 단계는 중간 톤 — 3단계 대비."
2. 참조 구현들의 미도달 스타일이 이보다 옅으면(각 t*.html의 해당 CSS 확인) 같이 상향.
3. (선택) verify_mviz에 검사 추가는 과잉 — 프롬프트+참조만.

**검증**: 참조 수정 후 verify 통과 유지 + 다음 신규 생성물 스크린샷에서 하단 노드 가독 확인.

---

## 보류 (제안했으나 이번 범위 아님)

- **T10 신경장/암시적 표현 타입 신설**: NeRF류가 항상 T7 폴백. 그 분야 논문을 자주
  분석하게 되면 참조 구현 1개(t10)를 만들어 추가 — 참조 제작 비용이 커서 보류.
- Mask R-CNN의 T1↔T2 재판정: 현행 T1 산출물 품질이 좋아 재생성 가치 낮음.

## 권장 순서와 비용

| 순서 | 작업 | LLM 비용 |
|---|---|---|
| 1 | B(지침+verify+참조 정리) | 0 |
| 2 | B-4(오염 5편 재생성) | ~$7.5 — **사용자 확인 후** |
| 3 | A(원본 그림 대조) | 0 |
| 4 | C(강독 연동) | 0 |
| 5 | D·E(프롬프트/참조) | 0 |

각 작업 완료 시: `node --check` → 서버 재기동(진행 중 분석 확인!) → static-preview 검증 →
전체 끝나면 사용자 승인 받아 커밋.
