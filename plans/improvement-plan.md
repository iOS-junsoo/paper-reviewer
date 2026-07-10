# Paper Reviewer 개선 계획서 (구현용 인수인계 문서)

> 상태: **계획만 확정 — 구현 전.** 작성일 2026-07-10.
> 이 문서는 다른 세션에서 코드 수정을 진행할 수 있도록 자립적으로 작성됨.

---

## 0. 프로젝트 공통 컨텍스트 (구현 전 필독)

- **구조**: Node.js/Express 단일 서버(`server.js`, ~1,450줄) + 바닐라 JS 프론트(`public/app.js`,
  `public/index.html`, `public/style.css`). Firestore 캐시. launchd 서비스
  `com.kimjunsu.paper-reviewer`(port 3000) — 코드 수정 후
  `launchctl kickstart -k gui/$(id -u)/com.kimjunsu.paper-reviewer`로 재기동.
- **LLM 호출은 반드시 Claude Agent SDK**(`@anthropic-ai/claude-agent-sdk`의 `query()`) +
  `CLAUDE_CODE_OAUTH_TOKEN` 경로. 유료 Messages API 금지(Max 구독만 있음, API 크레딧 없음).
  Max 구독엔 세션 한도가 있으므로 실측 검증은 최소 횟수로.
- **시스템 프롬프트 3종**(server.js ~L229-395):
  - `SYSTEM_PROMPT` — 원본(V4 시각화 지침 포함, ~17.4K tok)
  - `SYSTEM_PROMPT_CORE` — V4·method_visualization 제거판(~5.7K tok). 전체 분석·섹션 재생성에 사용 중
  - `SYSTEM_PROMPT_MINI` — HTML 시각화 생성 전용(143 tok)
- **ETA 시스템(최근 구현 완료, 이 계획의 기반)**:
  - `.stats/durations.json`에 성공 실행의 `{pages, analysis_ms, viz_ms}` 롤링 적재(최대 40개)
  - `predictDurations(pages)`(server.js ~L240-270): 히스토리 3회↑면 중앙값, 아니면 시드
    (`fixedA 30s + 15s/페이지 + viz 330s`)
  - 서버가 SSE `{type:"eta", phase:"analysis"|"viz", estMs, estTotalMs}` 전송
    (분석 시작·시각화 전환·재시도 시)
  - 프론트 `startEta/tickEta/etaOnProgress/stopEta`(app.js ~L188-300)가 시간 기반으로
    바를 채우고 "약 M분 S초 남음" 표시
- **분석 파이프라인**: `POST /api/analyze`(멀티파트 업로드, SSE 응답) →
  `runAnalysisJob` → `runAnalysisJobInner`(server.js ~L574): ① `runAnalysis`(전체 분석,
  CORE 프롬프트) → ② `generateMethodVizHtml`(방법론 인터랙티브 HTML 시각화, MINI 프롬프트,
  자가검증 루프 — 약 5.5분) → ③ Firestore 저장 → SSE `result`.
- **검증 습관**: 수정 후 `node --check server.js && node --check public/app.js`, 프론트는
  `.claude/launch.json`의 `static-preview`(port 4173)로 preview_* 도구 검증 가능.
- **커밋 규칙**: 사용자가 요청할 때만 커밋. `.env`·`serviceAccountKey.json`·`pdfs/`·`.stats/`·
  `.mviz_gen/`·`.claude/`는 gitignore — 절대 커밋 금지.

---

# 계획 1 — 그림 해설 캡처(크롭) 개선

## 1.1 현재 방식 (요약)

그림 해설 탭의 피규어/테이블 이미지는 3단계로 만들어진다.

1. **모델 bbox**: 전체 분석 때 LLM이 비전으로 PDF를 읽으며 `figure_guide[].bbox`에
   `[x0,y0,x1,y1]` 정규화 좌표를 "추정"해 찍음 (server.js ~L385 프롬프트 지시).
2. **캡션 앵커 보정** `captionAnchoredBox()` (server.js ~L850-1024):
   `pdftotext -bbox`로 텍스트 레이어 단어 좌표를 얻어 `Table N:`/`Figure N:` 캡션을 찾고,
   캡션 기준 **텍스트 줄(row) 간격 스캔**으로 본체의 위/아래 경계를 추정.
3. **크롭**: `pdftoppm -x -y -W -H`로 해당 영역을 150DPI PNG로 잘라 디스크 캐시
   (`GET /api/figure/:hash`, server.js ~L1028-1092. 캐시 디렉터리 `pdfs/crops/`,
   캐시 키 버전 문자열 `v9` 포함).

프론트 사용처: app.js ~L961-974 — `figure_guide[].bbox`가 유효하면
`/api/figure/${hash}?page&box&label` URL을 `img.dataset.src`에 설정(lazy load).

## 1.2 무엇이 왜 실패하는가 (문제 분석)

핵심 원인: **2단계 보정이 "텍스트 레이어"만 본다.** 그림의 실체(래스터 이미지·벡터 드로잉)는
한 번도 실측하지 않고, 텍스트 줄 간격이라는 간접 신호로 경계를 "추론"만 한다.

| # | 실패 모드 | 원인 (코드 근거) |
|---|---|---|
| F1 | **텍스트 없는 순수 이미지 그림**에서 위/아래가 잘리거나 과확장 | 경계 스캔이 텍스트 row 기반. 그림 내부에 단어가 없으면 `imageGap` 휴리스틱 하나에 의존(~L962) — 캡션 바로 옆 빈칸만 보고 멈춰 **본체 대부분을 놓침** |
| F2 | **축 라벨·범례 텍스트가 흩어진 그래프**에서 중간이 잘림 | 그림 내부 텍스트 덩어리 사이의 큰 간격을 `stopBoundary`(~L965-971)가 "본체 끝"으로 오판 |
| F3 | 모델 bbox가 엉뚱한 컬럼/위치를 찍으면 연쇄 실패 | 컬럼 판정(`modelBox[2]-modelBox[0] < 0.55`, ~L897)·방향 판정(`extendsAbove/Below`, ~L947-956)·가로 폭 폴백(~L1016)이 모두 모델 bbox를 신뢰 |
| F4 | 캡션 미검출 시(비표준 표기, 사이드 캡션, score<3) **부정확한 모델 bbox가 그대로** 사용 | ~L890 `return null` → 원본 bbox 폴백 |
| F5 | 서브피규어 격자(a/b/c), 전면(full-page) 그림, 눕힌(landscape) 표 | 단일 캡션-단일 블록 가정. 격자·회전 케이스 처리 없음 |
| F6 | **나쁜 크롭도 캐시에 영구 저장·서빙** | 결과 검증 없음 — 백지·조각 크롭이어도 `v9` 키로 캐시(~L1046) |

## 1.3 개선 방향 — "추론"에서 "실측"으로

그림의 실체를 두 가지 방법으로 **직접 측정**하고, 기존 텍스트 스캔은 표(text-heavy) 전용
+ 최종 폴백으로 강등. 모델 bbox는 **힌트(방향·컬럼 후보)로만** 사용.

### Layer 1 — 임베디드 이미지 실측 (래스터 그림, 신규)

`pdftohtml -xml`이 페이지 안 **모든 임베디드 이미지의 정확한 위치**를 준다.
(로컬 poppler 26.06에서 검증 완료 — Deep Image Prior 1~3p에서 14개 이미지의
`top/left/width/height` 추출 확인. `/opt/homebrew/bin/pdftohtml` 존재. mutool은 없음.)

```xml
<page number="1" height="1262" width="892">
<image top="455" left="368" width="524" height="348" src="..."/>
```

- 절차: 해당 페이지의 `<image>` bbox들을 얻고 → **캡션 블록과 세로로 인접·가로로 겹치는
  이미지들을 클러스터로 병합**(서브피규어 대응) → 클러스터 외접 사각형 ∪ 캡션 블록 = 크롭.
- 주의: `pdftohtml`은 이미지 파일을 디스크에 덤프함 → scratch 디렉터리에 쓰고 즉시 삭제,
  XML만 파싱. 페이지당 1회 실행, 결과는 페이지 단위 캐시.
- 좌표계: `<page>` 태그의 width/height로 나눠 0~1 정규화하면 기존 좌표계와 호환.

### Layer 2 — 잉크 밀도 실측 (벡터 그림, 신규)

matplotlib 등 **벡터로 그려진 그래프**는 Layer 1에 안 잡힘. 이미 쓰는 도구만으로 실측:

1. `pdftoppm -gray -r 50`으로 페이지를 **저해상도 PGM** 렌더 (PGM=P5 헤더+원시 바이트,
   외부 의존성 없이 Node로 파싱 가능).
2. `pdftotext -bbox`로 아는 **모든 단어 영역을 마스킹**(본문 텍스트 제거).
3. 남은 잉크의 **행(row)별 밀도 프로파일**에서, 캡션에 인접한 연속 잉크 밴드 = 그림 본체.
   컬럼 구분은 기존 거터 로직 재사용.
- 표에는 부적합(표=텍스트+선 → 마스킹하면 선만 남음). **Figure 라벨일 때만** 시도.

### Layer 3 — 기존 캡션 앵커 텍스트 스캔 (표 전용 + 폴백)

표는 본체가 곧 텍스트라 현행 방식이 잘 맞음. `Table` 라벨은 지금 로직 유지,
`Figure` 라벨은 Layer 1→2 실패 시에만 진입.

### 통합 라우팅

```
label 파싱 (Table/Figure)
├─ Table  → Layer 3 (현행 텍스트 스캔) → 실패 시 모델 bbox
└─ Figure → Layer 1 (임베디드 이미지 실측)
            → 없음/불일치 → Layer 2 (잉크 밀도)
            → 실패 → Layer 3 → 실패 → 모델 bbox
공통: 이웃 캡션 블록 차단(기존 foreignBlocks 로직 재사용) + 캡션 블록 포함
```

### Layer 4 — 결과 검증 + 캐시 무효화 (신규)

크롭 후 서빙 전에 값싼 sanity check (Layer 2의 PGM 파서 재사용):

- **백지 검사**: 크롭 영역 잉크 비율 < 1% → 실패 처리, 컬럼 전체 밴드(캡션 위/아래
  컬럼 폭 × 이웃 캡션까지)로 **넓은 폴백** 크롭.
- **가장자리 절단 검사**: 크롭 경계 4변에 잉크가 맞닿아 있으면(변 픽셀 잉크율 > 15%)
  잘린 것 → 해당 방향으로 5%씩 확장 재시도(최대 2회).
- 캐시 키 버전 `v9 → v10`으로 올려 기존의 나쁜 크롭 캐시를 자연 무효화(~L1046).

## 1.4 구현 단계 (예상 규모)

| 단계 | 내용 | 규모 |
|---|---|---|
| 1 | `pdftohtml -xml` 파서 + 이미지 클러스터링 → `imageAnchoredBox()` 신설 | ~80줄 |
| 2 | PGM 파서 + 단어 마스킹 + 행 밀도 프로파일 → `inkAnchoredBox()` 신설 | ~100줄 |
| 3 | `/api/figure` 라우팅 통합(Table/Figure 분기 + 폴백 체인) + 캐시 v10 | ~40줄 수정 |
| 4 | Layer 4 검증(백지·절단) + 넓은 폴백 | ~60줄 |
| 5 | **회귀 하니스**: 보유 논문 32편 × figure_guide 전체 크롭 일괄 생성 → 잉크율·절단 지표 before/after 리포트 (scripts/에 커밋, LLM 호출 없음 = 무료) | ~80줄 |

검증: 단계 5 하니스로 정량 비교(백지율·절단율 감소) + 대표 실패 사례(순수 이미지
그림·벡터 그래프·2단 표) 스크린샷 대조. **LLM 비용 변화 없음**(모델 bbox는 이미 생성 중).

## 1.5 리스크·주의

- 스캔 논문(전체가 한 장의 이미지): Layer 1이 "페이지 전체 이미지 1개"를 돌려줌 →
  이미지가 페이지의 90%+ 면적이면 Layer 1 건너뜀(Layer 2/3로).
- 워터마크·로고 같은 작은 장식 이미지 → 면적 하한(페이지의 0.5% 미만 무시)으로 필터.
- 성능: 페이지당 pdftohtml+pdftoppm 각 1회 추가지만 모두 디스크 캐시 → 첫 조회만 ~1초대.

---

# 계획 2 — 간단 분석 / 정밀 분석 모드 분리

## 2.1 목표

논문 업로드 시 사용자가 **두 모드 중 선택**한다. 선택지에 **모드별 예상 소요 시간**을 함께 표시.

| 모드 | 생성 섹션 | 생략 | 예상 시간(20p, 시드) |
|---|---|---|---|
| **간단 분석** | 연구 배경(+타임라인) · 해결하려는 것 · 연구 방법론(단계 텍스트) · 수식 정리(+수식 흐름) | 세미나 정리, 핵심 기여, 실험·결과, 그림 해설, 예상 Q&A, 용어집, 관련 논문, **방법론 HTML 시각화(전체 생략)**, WebSearch | **약 3~4분** |
| **정밀 분석** | 전체(현행 그대로) | — | **약 11분** |

간단 모드가 빠른 이유: (a) HTML 시각화 파이프라인 생략(−약 5.5분), (b) 출력 섹션 축소로
출력 토큰 대폭 감소, (c) WebSearch 생략. 부수 효과: **구독 세션 사용량 크게 절약**.

## 2.2 UI 흐름

### 모드 선택 다이얼로그

현재: PDF 드롭 → `analyzeFile()`(app.js ~L145)이 즉시 `POST /api/analyze`.
변경: 드롭 → **선택 오버레이** → 선택 후 분석 시작.

```
┌──────────────────────────────────────────────┐
│  「Attention Is All You Need.pdf」 · 15페이지   │
│                                              │
│  ┌─────────────────┐  ┌─────────────────┐   │
│  │  ⚡ 간단 분석      │  │  🔬 정밀 분석     │   │
│  │  약 3분           │  │  약 11분          │   │
│  │  배경·문제·방법론  │  │  전체 7개 섹션 +   │   │
│  │  ·수식 4개 섹션    │  │  인터랙티브 시각화 │   │
│  └─────────────────┘  └─────────────────┘   │
│                                   [취소]      │
└──────────────────────────────────────────────┘
```

- **페이지 수**: 서버 왕복 없이 클라 계산 — 뷰어용 pdf.js가 이미 로드됨(app.js ~L1017,
  `pdfjsLib`) → `pdfjsLib.getDocument(arrayBuffer)` → `numPages`. 실패 시 페이지 수 없이
  "수 분"으로 폴백.
- **예상 시간**: 신규 `GET /api/eta?pages=N`이 모드별 예측 반환(§2.3.3).
- 단축키 1/2, 마지막 선택을 localStorage에 기억해 기본 포커스.
- 이미 분석된 논문(캐시 히트)은 다이얼로그 없이 바로 결과(현행 유지). 단, **간단 기록에
  정밀 요청** 시 §2.3.4 업그레이드 흐름.

### 결과 화면

- 간단 결과: 탭 4개만 활성(배경/문제/방법론/수식). 나머지 탭은 **비활성 + "정밀 분석에서
  제공"** 툴팁. 헤더에 `간단 분석` 배지 + **[정밀 분석으로 업그레이드]** 버튼. 히스토리
  목록에도 `간단` 배지. (탭 순서 상수 `TAB_ORDER`는 app.js ~L4915, 탭 클릭은 ~L4105.)
- 방법론 탭: method_steps 텍스트 스테퍼만(HTML/JSON 시각화 없음). 시각화 부재 시 기존
  안내문을 "정밀 분석에서 인터랙티브 시각화 제공"으로 조정.

## 2.3 서버 변경

### 2.3.1 시스템 프롬프트 — `SYSTEM_PROMPT_LITE`

`SYSTEM_PROMPT_CORE`에서 파생(동일한 `.replace()` 방식, server.js ~L378 인근):
- **유지 스키마**: `title, one_liner, venue, year`(헤더·히스토리 필수) + `background,
  timeline, problem, method_steps, equations, equation_flow`
- **제거 스키마**: `contributions, experiments, figure_guide, seminar,
  suggested_questions, glossary, related_papers, method_visualization`
- 검증: CORE 때처럼 스탠드얼론 node 스크립트로 replace가 실제 매칭되는지·토큰 수·잔존
  스키마를 확인 후 적용(정규식 매칭 실패 시 silent no-op이 되므로 반드시 확인).

### 2.3.2 분석 파이프라인

- `runAnalysis(pdfPath, pageCount, onProgress, ac, mode)`: mode에 따라 systemPrompt
  LITE/CORE 선택, LITE면 `allowedTools: ["Read"]`(WebSearch 제거), 유저 프롬프트도
  "4개 섹션만" 버전으로 분기. `logUsage` 태그 `전체분석:간단`/`전체분석:정밀`.
- `runAnalysisJobInner`(server.js ~L574): `mode==="simple"`이면 **방법론 HTML 시각화
  블록 전체 생략**(generateMethodVizHtml 호출 안 함). 저장 레코드에
  `analysis_mode: "simple"|"full"` 필드 추가.
- `/api/analyze`: 멀티파트 필드 `mode` 수신(기본 `"full"` — 하위호환). 캐시 로직:
  캐시 히트 시 `cached.analysis_mode`가 `full`이거나 요청 모드와 같으면 즉시 반환,
  **캐시=simple & 요청=full이면 정밀 분석 실행 후 덮어쓰기**(createdAt 유지).

### 2.3.3 ETA 연동 (기존 시스템 확장)

- `.stats/durations.json` 레코드에 `mode` 필드 추가.
- `predictDurations(pages, mode)`: 모드별 히스토리만 골라 중앙값. 시드:
  - simple: `fixedA 25s + 9s/페이지`, viz 없음 → 20p ≈ 3.4분
  - full: 현행 시드 그대로(`30s + 15s/페이지 + viz 330s` → 20p ≈ 11분)
- simple의 SSE `eta`는 analysis 구간 하나만(`estTotalMs = analysisMs`) — 프론트 티커는
  변경 없이 동작(바 밴드가 0→100%).
- 신규 `GET /api/eta?pages=N` → `{ simple: {totalMs}, full: {totalMs} }` (다이얼로그용).

### 2.3.4 업그레이드 경로 (간단 → 정밀)

v1은 **전체 재분석**으로 단순하게: `[정밀 분석으로 업그레이드]` 버튼 → 기존
`/api/reanalyze/:hash`(server.js ~L732)에 `mode:"full"` 전달 → 재분석 배너(ETA 포함) →
완료 시 교체. (부족 섹션만 채우는 증분 생성은 v2 옵션 — 섹션 재생성 6회 직렬이라
오히려 느리고 비쌀 수 있어 v1 제외.)

## 2.4 구현 단계 (예상 규모)

| 단계 | 내용 | 규모 |
|---|---|---|
| 1 | `SYSTEM_PROMPT_LITE` 구축 + 스탠드얼론 검증(스키마·토큰) | ~30줄 + 검증 |
| 2 | 서버: mode 배관(`/api/analyze`·`runAnalysis`·job) + 시각화 생략 + `analysis_mode` 저장 | ~60줄 |
| 3 | ETA: durations `mode` 필드 + `predictDurations(pages, mode)` + `GET /api/eta` | ~40줄 |
| 4 | 프론트: 선택 다이얼로그(pdf.js 페이지수 + ETA 표시) + `analyzeFile` 분기 | ~120줄 |
| 5 | 프론트: 간단 결과 렌더(탭 비활성·배지·업그레이드 버튼) + 히스토리 배지 | ~60줄 |
| 6 | 업그레이드 경로(`/api/reanalyze` mode 전달) + 캐시 simple→full 처리 | ~30줄 |
| 7 | 검증: 간단 분석 1회 실측(4섹션 정상·시각화 없음·ETA 표시), 업그레이드 1회 실측 (세션 한도 유의) | — |

## 2.5 엣지 케이스·리스크

- **동시성**: 같은 hash의 간단 분석 진행 중 정밀 요청 → 기존 `inFlight`/`hashBusy`가 이미
  차단(409). 변경 없음.
- **채팅(/api/ask)**: 컨텍스트가 분석 JSON 화이트리스트 기반이라 간단 기록에서도 동작 —
  없는 섹션 질문에 "정밀 분석 필요"라고 답하도록 컨텍스트에 `analysis_mode` 주입.
- **섹션 재생성**: 간단 기록에서 생략 섹션의 "이 섹션 다시 생성"은 그대로 동작(개별 생성
  가능) — 업그레이드의 부분적 대안으로 자연 제공됨.
- **마크다운 내보내기**: 없는 섹션은 이미 조건부 렌더라 안전. 내보내기에 `간단 분석` 표기 추가.
- **히스토리 하위호환**: 기존 32편 레코드는 `analysis_mode` 없음 → `full`로 간주.
- **Firestore 문서 크기**: 간단 레코드는 더 작음(문제 없음).

## 2.6 구현 전 결정 사항

1. 간단 분석에 **용어집(glossary)** 포함 여부(채팅 Q&A 품질용, 토큰 소폭 증가)
   → 현 계획: **미포함**(사용자 지정 4개 섹션 엄수).
2. "기억한 선택으로 다음부터 바로 시작" 체크박스 → 현 계획: 미제공(매번 선택). v2 옵션.

---

# 부록 — 권장 작업 순서 (두 계획 병행 시)

1. **계획 2부터** (사용자 체감 크고 서로 독립적) — 단계 1→7 순서대로.
2. **계획 1** — 단계 5(회귀 하니스)를 먼저 만들어 현재 실패율을 측정한 뒤 Layer 1~4 구현
   (before/after 증빙 확보).
3. 각 계획 완료 시 실제 논문 1편으로 라이브 확인 후 커밋(사용자 승인 필요).
