# Paper Reviewer — 독자 경험 개선 인수인계 문서

> 다른 채팅 세션이 이 문서만 읽고 바로 이어서 구현할 수 있도록 자립적으로 작성됨.
> 작성 기준일: 2026-07-11. 대상: `/Users/kimjunsu/Desktop/PAPER_REVIEWER`

---

## §0. 프로젝트 공통 컨텍스트 (구현 전 필독)

**서비스 목적**: 사용자가 논문을 **빠르고·쉽고·직관적으로** 이해하고, **원하는 정보만 바로** 보게 하는 것. 아래 남은 작업은 전부 이 목적("읽기 경험") 관점의 개선이다.

**구조**
- Node.js/Express 단일 서버 `server.js`(~1,900줄) + 바닐라 JS 프론트 `public/app.js`(~6,000줄)·`public/index.html`·`public/style.css`. Firestore 캐시(없으면 메모리 폴백).
- launchd 서비스 `com.kimjunsu.paper-reviewer`(port 3000). **코드 수정 후 재기동**:
  `launchctl kickstart -k gui/$(id -u)/com.kimjunsu.paper-reviewer` → `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/`(200 확인).
  로그: `/Users/kimjunsu/Library/Logs/paper-reviewer.log`.
- **⚠️ 재기동 전 반드시** 로그로 진행 중 분석이 없는지 확인할 것 — 분석 중 재기동은 SSE 연결을 끊어 "네트워크 에러"를 유발한다(실제로 한 번 발생함).

**절대 규칙**
- LLM 호출은 **반드시** Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`의 `query()`) + `CLAUDE_CODE_OAUTH_TOKEN` 경로. 유료 Messages API 금지(Max 구독만, API 크레딧 없음). 세션 한도 있으니 실측 검증은 최소 횟수로.
- 커밋은 사용자가 요청할 때만. `.env`·`serviceAccountKey.json`·`pdfs/`·`.stats/`·`.mviz_gen/`·`.claude/`는 gitignore — 커밋 금지.
- 수정 후 항상 `node --check server.js && node --check public/app.js`.

**프론트 UI 검증 방법** (실분석 없이): `.claude/launch.json`의 `static-preview`(zero-dep 정적 서버, `public/` 서빙)를 preview MCP로 띄우고, 전역 함수를 `preview_eval`로 직접 호출해 렌더를 확인한다. 예: `renderResult(fakeData)` 후 DOM 검사. API가 필요한 흐름은 모의 `Response`(ReadableStream)로 SSE를 흉내낸다.

**⚠️ 미커밋 상태**: 현재 워킹트리에 **커밋되지 않은 대량 변경**이 있다(마지막 커밋 `612b0c0` 이후 로드맵 12건 + 독자경험 3건 = server.js·app.js·index.html·style.css 4파일). **이 문서의 작업을 시작하기 전에 사용자에게 현재까지 작업을 커밋할지 물어보라** — 안전한 베이스라인 확보 목적.

---

## §1. 이미 구현된 것 (재작성 금지 — 재사용하라)

이전 세션들에서 완료·검증된 기능. 새 기능은 이 인프라를 최대한 재사용한다.

### 분석/모드
- **간단⚡/정밀🔬 분석 모드**: 업로드 시 모드 선택 다이얼로그(`showModeDialog`, app.js). 간단=배경·문제·방법론·수식 4섹션(시각화·WebSearch 생략). `analysis.analysis_mode`로 구분. 간단→정밀 [업그레이드] 버튼(`upgradeToFull`→`reanalyzePaper(hash,title,{mode:"full"})`).
- **ETA 진행바**: `.stats/durations.json` 자가학습, SSE `{type:"eta",...}` + 프론트 시간 기반 티커(`startEta`/`tickEta`/`stopEta`, app.js). "약 M분 S초 남음" + 탭 타이틀 카운트다운 + 완료 데스크톱 알림(`notifyDone`).
- **P1 부분 선렌더**: 텍스트 분석 완료 시점에 서버가 선저장 + SSE `{type:"partial",data:{...,viz_pending:true}}` → 프론트가 즉시 `renderResult`, 시각화 배너 유지, 완료 시 보던 탭 유지하고 방법론만 교체(`analysisPartialShown` 플래그). `consumeAnalysisStream`(app.js) 참고.

### 파생 생성 인프라 (⭐ 남은 P8이 그대로 재사용)
- **서버** `server.js`:
  - `streamTextGen(res, ac, prompt, tag)` (L1249) — 도구 없는 1회 LLM 호출을 delta SSE로 스트리밍하고 최종 텍스트 반환. **`maxTurns: 4`** (1이면 JSON 출력 시 `error_max_turns` 발생 — 겪은 버그).
  - `genErrorReply(res, e, label)` (L1276) — 파생 라우트 공용 오류 응답(SSE 시작 전/후 모두 처리).
  - `analysisDigest(a, {withSeminar})` (L1286) — 분석 요약 JSON(PDF 재독 없이 컨텍스트용, 9K/15K 자 컷).
  - **`store.getExtra(key)` / `store.setExtra(key, data)`** (L102·L205) — 파생 산출물 캐시(`extras` 컬렉션/메모리 맵). key는 임의 문자열.
  - `sseInit(res)` (하트비트 포함 — 20초마다 `: ping`으로 유휴 끊김 방지), `sseSend(res, obj)`, `abortOnDisconnect(res, ac, label)`.
- **프론트** `public/app.js`:
  - **`openGenOverlay({title, filename, runFetch, renderData?, toMarkdown?})`** (L5304) — 파생 결과 공용 오버레이. `runFetch(force, signal)`가 SSE `Response` 반환. `renderData(el, data)`를 주면 구조화 모드(스트리밍 중엔 글자수만, 완료 시 전용 렌더러), 없으면 delta 타자기 렌더. 복사/.md/재생성/Esc 내장. **P8·향후 파생 기능은 이걸 그대로 쓰면 됨.**

### 현재 API 라우트 (server.js)
```
POST /api/analyze            업로드 분석(SSE: eta/progress/partial/result/error)
POST /api/analyze-url        arXiv URL 분석(화이트리스트)
POST /api/reanalyze/:hash    재분석·업그레이드(body {mode})
GET  /api/eta?pages=N        모드별 예상 소요
GET  /api/pdf/:hash          원문 PDF
GET  /api/figure/:hash       그림 크롭(lib/figurebox.js 실측 파이프라인)
POST /api/ask/:hash          채팅 질문(SSE: step/delta/result) — delta 스트리밍 있음
GET  /api/chat/:hash         채팅 기록
POST /api/compare            논문 비교(SSE, 구조화 JSON, extras 캐시 compare2:)
POST /api/script/:hash       발표 대본(SSE, extras 캐시 script:)
POST /api/method-deep/:hash  방법론 정밀 강독(SSE, analysis.method_deep 저장)
GET/PUT /api/notes/:hash     개인 메모+북마크 {notes, bookmarks}
GET/PUT /api/library         폴더+배정
POST /api/reanalyze-section/:hash  섹션만 재생성
GET/GET/DELETE /api/history…
```

### 기타 완료
- 비교 가독성 v2(축별 그리드 `buildCompareView`), 발표 대본 B3, 정밀 강독(방법론 탭 하단 `buildMethodDeepBlock` L2358/`generateMethodDeep` L2421), Firestore 1MB gzip 저장(C1), 채팅 delta 스트리밍(C2), PDF 내 검색(A4, `runPdfSearch`/`pdfPageTextOf`, 단축키 S), arXiv URL(A5), 큐 분석(A2), 히스토리 필터(A6), 복습 플래시카드(B2, `openFlashcards` L5241), 채팅 페이지 점프(`[[p7]]`), LaTeX 복사(A7).

### 재사용 핵심 헬퍼 앵커 (app.js)
- `renderResult(data)` L679 · `renderRich(el, text)` L675(마크업: `**볼드**` `==형광펜==` `$수식$` `## 소제목` `[[p7|구절]]` 페이지칩)
- `switchTab(name)` L4728 · `TAB_ORDER` L6004 · 탭 버튼 `[data-tab]`(index.html L150-156)
- 채팅: `openChat()` L5191 · `askQuestion(q)` L2065 · `appendChat(role, text)` L2010 · `refreshQuestionActions()` L2022 · `renderQaPrep(items)` L5152 · 드로어 `#chat-drawer`(index.html L213)·`#chat-messages` L219·`.chat-hint` L220·`#chat-input` L223
- 용어집: `renderGlossary(items)` L5207 · `paintGlossary(filter)` L5617 · `glossaryItems`(배열: `{term, latex, meaning}`)
- 원문 점프: `jumpToPdfPageText(page, anchor)` · `findTextPos` · PDF검색 `runPdfSearch`/`pdfPageTextOf`
- 메모: `loadNotes(hash)` L5851 · `saveNotes(hash, data)` L5884 · `notesState = {notes, bookmarks}`
- 딥링크: `updateHash()` L117 · `restoreFromHash()` L138(현재 `#p=<hash>&tab=<tab>`)
- 결과 도구 버튼 영역: `#result-tools`(index.html L142 부근, `.rtool` 클래스)

---

## §2. 남은 작업 (독자 경험 개선 P2–P10 + 운영 C3)

우선순위 로드맵에서 **1(정밀 강독)·2(P1 선렌더)는 완료**. 아래가 남은 3순위 이하 전부.
각 항목: 목적 / 설계 / 코드 위치 / 노력 / LLM 비용.

### 🟢 P5. 드래그 → 바로 질문 (3순위 · 노력 小~中 · LLM 0)
**목적**: 읽다 막힌 문장을 손으로 옮겨 적지 않고 즉시 질문. 읽기→질문 마찰 제거(가장 값싼 고임팩트).
**설계**:
- 결과 본문(`#result` 영역) 텍스트 선택 시 플로팅 버튼 **[💬 이 부분 질문]** 표시(선택 근처 위치). 클릭 → `openChat()` 후 `#chat-input`에 `"…선택 인용(120자 컷)…" 이 부분이 무슨 뜻이야?` 프리필(전송은 사용자가). 자동 전송 말 것 — 사용자가 다듬게.
- `document.addEventListener("selectionchange"…)` 또는 `mouseup`에서 `window.getSelection()`. **주의**: PDF 패널(`#pdf-scroll`)은 canvas 렌더라 선택 대상 아님 → 선택 anchorNode가 `#result` 하위일 때만 버튼 표시. 채팅 드로어 내부·입력창도 제외.
- 기존 참고: app.js L5906에 이미 `getSelection` 사용처(북마크 추가 `bm-add`)가 있으니 충돌 없게 확인.
**코드**: 순수 프론트. `openChat`·`#chat-input` 재사용. 서버 변경 0.

### 🟢 P7. 채팅 진입 추천 질문 칩 (3순위 · 노력 極小 · LLM 0)
**목적**: 채팅 열면 빈 화면 대신 바로 물을 거리 제시.
**설계**:
- `openChat()`에서 기록이 비어 있으면 `.chat-hint`(index.html L220) 아래에 `currentAnalysis.suggested_questions` 상위 3개를 **원클릭 칩**으로. 클릭 → `askQuestion(q)`.
- + "이 탭 관련" 맥락 칩 1개: `activeTab`에 따라(예: 수식 탭이면 "이 수식 유도 과정을 설명해줘", 방법론이면 "이 방법의 핵심 아이디어를 한 문장으로") → `askQuestion`.
- 첫 질문 전송되면 칩 제거.
**코드**: `openChat` L5191 · `renderQaPrep`가 쓰는 데이터(`suggested_questions`) 재사용 · `askQuestion` L2065.

### 🟡 P3. 통합 검색 (⌘K / Ctrl+K) (4순위 · 노력 中 · LLM 0)
**목적**: "원하는 정보 바로 접근"의 직격탄. 분석 결과 자체를 검색할 수단이 현재 없음(PDF 검색은 원문만).
**설계**:
- 커맨드 팔레트 오버레이(⌘K/Ctrl+K, 단축키 등록은 app.js 키보드 핸들러 — `TAB_ORDER` 근처 keydown). 입력 시 3개 그룹 동시 검색:
  1. **분석 섹션**: `currentAnalysis`의 각 탭 텍스트(seminar·background·problem·method_steps·experiments·equations·figure_guide 등)를 평문화해 매치 → 결과 클릭 시 `switchTab` + 해당 위치로 스크롤·하이라이트. **클라 메모리에 이미 있어 무료·즉시**.
  2. **용어집**: `glossaryItems` 매치 → 용어집 카드 열고 해당 항목.
  3. **원문 PDF**: 기존 `runPdfSearch` 재사용(A4) → p.N 결과.
- 각 그룹 헤더 + 키보드 상하 이동/Enter. 모달은 기존 `.mode-overlay` 딤 배경 스타일 재사용 가능.
**코드**: 신규 오버레이 함수 + 키 등록. 검색 소스는 전부 기존 데이터. PDF는 `pdfPageTextOf`/`runPdfSearch`.

### 🟡 P6. 본문 용어 자동 툴팁 (5순위 · 노력 中 · LLM 0)
**목적**: 용어집이 "있지만 안 보이는" 문제. 본문에서 바로 뜻 확인.
**설계**:
- `renderResult` 후처리로, 각 탭 패널의 텍스트노드를 스캔해 `glossaryItems`의 `term`이 나타나면 **점선 밑줄** 스팬으로 감싸고 hover/탭 시 `meaning` 툴팁 + "용어집에서 보기"(→ `paintGlossary`+카드).
- **주의**: `.katex`(수식)·`code`·이미 링크된 요소·채팅 내부는 스캔 제외. 한 용어는 탭당 첫 등장만(과도한 밑줄 방지). 대소문자·원어 병기(`term`이 "prior" 등 영어)와 한국어 혼용 매칭 규칙 신중히.
- 성능: 용어 13개 규모라 가볍지만, 텍스트노드 워커는 정규식 한 번으로.
**코드**: `renderRich` 이후 훅 or `renderResult` 말미. `glossaryItems`·`paintGlossary` L5617 재사용.

### 🟡 P2. 30초 오리엔테이션 카드 (5순위 · 노력 小 · LLM 0, 선택적 스키마 1필드)
**목적**: 첫 화면 "어디부터 읽지" 해소. 3칸만 읽으면 논문 파악.
**설계**:
- 제목/한줄 아래에 **문제 → 방법 → 결과** 3칸 카드(각 1~2문장). 데이터: `problem` 첫 문단 + `one_liner`/`method_steps[0]` + `experiments.takeaway`를 **재조합**(LLM 0). 각 칸 클릭 → 해당 탭 점프.
- 품질이 아쉬우면 분석 스키마에 `tldr3: {problem, method, result}` 짧은 필드 추가(토큰 미미). 하지만 **우선 재조합 버전으로** 시작.
**코드**: `renderResult` L679 상단(현재 one_liner/contributions 렌더 부근)에 카드 삽입. `switchTab` 연결.

### 🟡 P4. 긴 탭 미니 목차 (5순위 · 노력 小 · LLM 0)
**목적**: 세미나(최대 ~14섹션·31포인트)·정밀 강독 탭에서 길 잃음 방지.
**설계**: 세미나·강독 탭 우측(또는 상단)에 sticky 미니 TOC — 섹션 제목 목록, 현재 스크롤 위치 하이라이트(IntersectionObserver), 클릭 점프.
**코드**: `renderSeminar`(세미나) / `buildMethodDeepBlock` L2358(강독) 렌더 시 TOC 생성. 강독은 `method_deep.sections[].ref`가 이미 목차 구조.

### 🔵 P8. "더 쉽게" 재설명 (6순위 · 노력 中 · LLM 온디맨드 1회)
**목적**: 특정 섹션을 학부 신입생 수준으로(전제지식 최소, 비유 중심) 재설명.
**설계**:
- 각 탭(또는 방법론/배경 등 핵심 탭) 헤더에 **[🐣 더 쉽게]** 버튼. 클릭 → **`openGenOverlay`**(이미 있음!) 사용, `runFetch`는 신규 `POST /api/explain/:hash`(body `{section}`).
- 서버: `streamTextGen` + `analysisDigest` 재사용. 프롬프트 = "이 섹션 내용을 전공 안 한 학부생도 이해하게 비유 중심으로, 원문 근거 벗어나지 말고". 캐시 key `explain:<hash>:<section>` (`extras`).
- 비용: 섹션당 1회 ~$0.1~0.2, 캐시. **원문 대비 토글**(원래 섹션 ↔ 쉬운 버전).
**코드**: 서버 라우트는 `/api/compare`·`/api/script`와 동일 패턴(그 두 개를 템플릿으로). 프론트는 `openGenOverlay` 그대로.

### 🔵 P9. 읽던 자리 복원 + 읽음 표시 (6순위 · 노력 小 · LLM 0)
**목적**: 다시 열 때 이어 읽기.
**설계**: 논문별 마지막 `activeTab`+스크롤 위치를 localStorage(`read-pos:<hash>`)에 저장, 열 때 복원(현재 딥링크는 탭까지만). 방문한 탭에 읽음 점(`·`) 표시.
**코드**: `switchTab` L4728·스크롤 리스너에서 저장, `renderResult`/`restoreFromHash` L138에서 복원.

### 🔵 P10. 채팅 답변 → 메모 저장 (6순위 · 노력 極小 · LLM 0)
**목적**: 좋은 답변을 개인 메모로 스크랩.
**설계**: 채팅 답변 버블(`.chat-a`)에 **[📌 메모에 저장]** → 기존 메모(`notesState.notes`)에 append + `saveNotes`.
**코드**: `appendChat` L2010(답변 렌더 시 버튼) 또는 `refreshQuestionActions` L2022 패턴 참고. `saveNotes` L5884.

### ⚙️ C3. 운영 편의 (별도 · 노력 小 · LLM 0)
**목적**: 32편+ 자산 보호·디스크 관리.
**설계**:
- Firestore 전체 백업 스크립트 `scripts/backup.js`(analyses→JSON 덤프, LLM 0). `.stats`·`pdfs/crops` 크기 상한 정리. launchd 로그 회전(무한 성장 방지).
**코드**: 신규 `scripts/`.

---

## §3. 권장 구현 순서

| 순서 | 항목 | 근거 |
|---|---|---|
| 1 | **P5 드래그→질문 + P7 질문 칩** | 반나절, 질문 마찰 즉시 제거, LLM 0 |
| 2 | **P3 통합 검색 ⌘K** | "원하는 정보 바로"의 직격, LLM 0 |
| 3 | **P6 용어 툴팁 + P2 오리엔테이션 카드 + P4 미니 TOC** | 읽기 질 다듬기, LLM 0 |
| 4 | **P8 더 쉽게** | 유일한 LLM 비용($0.1~0.2/섹션, 캐시) |
| 5 | **P9 자리 복원 + P10 메모 저장** | 마무리, LLM 0 |
| 6 | **C3 운영** | 자산 보호 |

**LLM 비용이 드는 건 P8뿐**이고 나머지는 전부 기존 클라 데이터 재활용이라 0원.

## §4. 검증 방법 (각 항목 완료 시)
- `node --check` 양쪽 통과 → 서버 재기동(진행 중 분석 없는지 로그 확인) → `static-preview`로 `preview_eval` 렌더 검증(모의 데이터/모의 SSE) → 필요 시 스크린샷.
- LLM 실호출은 P8만, 캐시 확인까지 1회로.
- 완료 후 사용자 승인 받고 커밋.
