# 연구 방법론 인터랙티브 시각화 HTML 생성 지시문 (타입 기반)

너는 이 논문의 "연구 방법론" 탭에 들어갈 **독립 실행형 HTML 시각화 파일 1개**를 만든다.
결과물은 `method_viz_html`로 저장되어 서비스의 방법론 패널에 iframe으로 삽입된다.

## 절대 규칙 (권위 있는 사양)

**제작 규칙 전체는 `prompts/method_viz_refs/viz_guideline.md`에 있다. 먼저 그 문서를 Read로
정독하라.** 아래는 그 지침을 이 파이프라인에서 실행하는 방법이다. 지침과 아래가 충돌하면
지침이 우선한다. 단 산출 방식·검증 루프·출력 경로는 아래를 따른다.

## 수행 절차 (순서 고정)

1. **타입 판정 (§1)**: 논문을 읽고 T1~T9 중 하나로 분류한다. abstract의 "we propose"
   문장이 기여의 중심을 정한다. **9개에 딱 맞지 않으면 §5 폴백** — 최근접 타입 골격을
   빌리고(예: 여러 컴포넌트 파이프라인→T7, 어댑터/파인튜닝→T2, 최적화기법→T3),
   타입 배지 옆에 `9개 타입 외 · {빌린타입} 골격 차용(폴백)`을 명시한다. 폴백 처리의
   골든 샘플은 §5.1(CLIP 편향제거 2411.12785 → T7 골격 차용) — `clip_debias_c.html`을 본다.

2. **참조 정독**: 판정한 타입의 참조 구현을 Read한다 —
   `prompts/method_viz_refs/t{N}_*.html` (T1=t1_transformer, T2=t2_senet, T3=t3_simclr,
   T4=t4_fairgrape, T5=t5_mixup, T6=t6_ddpm, T7=t7_rag, T8=t8_grokking, T9=t9_bold).
   **이 파일이 그 타입의 정답지다.** 구조·CSS 변수·헬퍼 함수(cuboid/slabStack/betaPath 등)·
   스테퍼/입자/실험실 패턴·2단계 애니메이션·baseline 성장 규칙을 그대로 맞춘다.
   폴백이면 최근접 타입 참조 + `prompts/method_viz_refs/clip_debias_c.html`(§5.1 폴백
   골든 샘플: 9개 외 논문을 T7 골격 + overview figure 위상 + 폴백 배지로 처리한 예)를 함께 본다.

3. **설계 기반 추출 — overview figure 위상 우선 (§6.1·§6.2, 정직성 §7)**:
   `pdfs/<hash>.pdf`에서 아래를 추출한다.
   - **(a) 실제 수치**: 차원·층수·하이퍼파라미터 기본값·스케줄 상수·데이터셋 규모·대표 결과. Read로 읽어라.
   - **(b) overview figure 위상 = 설계의 뼈대 (§6.2)**: Figure 캡션을 전부 뽑아
     (`Overview`/`pipeline`/`framework`/`architecture`/`our approach`/`our method` 든 캡션 우선)
     overview figure를 찾는다. 찾으면 **Bash로 그 페이지를 이미지 렌더해 직접 본다**:
     `pdftoppm -f <페이지> -l <페이지> -r 150 -png pdfs/<hash>.pdf /tmp/ovfig` → 생성된 PNG를
     **Read로 열어** 위상을 확인 → figure의 블록/화살표를 구조도 존·흐름선으로 옮긴다.
     저자 figure를 따르는 게 논문을 읽고 재구성하는 것보다 정확하다. **단 픽셀 복사가 아니라
     위상(무엇→무엇)만 취한다** — 추상적 figure(수식 기호 나열·graphical model)는 위상만
     가져오고 시각 표현은 초심자 눈높이로 새로 만든다. 이미지 확인이 불가능하면 그 사실을
     `viz_report.unconfirmed`에 남긴다.
     - **타입별 figure 적합도**: T1·T2·T3·T7 = figure 위상 **거의 그대로** / T4·T5·T6 = figure
       기반이되 **초심자용 재구성** / T8·T9 = figure 대신 **타입 고유 방식**(현상 차트·평가 파이프라인).
     - "왜 되는가"류 그림(결정경계·비교·효과)을 발견하면 해당 패널을 추가한다.
   - **(c) 정직성 (§7, 타협 불가)**: 논문에서 확인한 값만 실수치로. 확인 못 한 값은
     지어내지 말고 `(예시)` 명시하거나 생략 — 창작은 실격이다. 시각화용 값(예시 임베딩·정성
     곡선)은 값 옆 `(예시)` + note에 "정성적 예시, 실제 측정값 아님" 명시. 계산 가능한 것
     (Beta PDF·ᾱ=∏(1-β)·정량 경계)은 논문 정의식으로 **실제 계산**. note 3요소(무엇이 예시 /
     논문 실제 정의·수치·arXiv 번호 / 정량은 논문 어디). 관통 예시(§7-1)는 논문 실제 예문 하나로.

4. **구현 (§2 공통 템플릿 + §3 타입 스펙)**: 6블록으로 작성. 헤더(제목+타입배지+lead 3~4문장)
   · 좌 구조도 SVG · 우 데이터 여정 패널 · 스테퍼 · 하단 실험실 · 정직성 note.
   - **드릴인 전면 금지** (§0). 구조는 처음부터 전부 펼쳐지고 스테퍼가 현재 존만 강조.
   - **리사이즈 호환 필수 (§2.8)**: 모든 SVG는 `width:100%`+`viewBox`(고정 px 폭 금지).
     좌표는 viewBox 논리좌표로. flexbox 비율 레이아웃. 컨테이너에 고정 width/height 금지.
   - **막대류 `display:block` + 2단계 애니메이션**(0→rAF→최종값). baseline 고정·위로 성장.
   - 등급(A/B/C)에 맞는 입체 적용. 값 비교 막대는 항상 2D.
   - **2.5D figure 함정 (§4·§9-13)**: overview figure가 모듈을 3D 박스(큐보이드)로 그렸어도,
     **데이터에 실재하는 3번째 축이 없으면 입체 금지.** 판별 기준 하나 — "그 깊이가 데이터의
     실제 차원인가?" figure가 3D로 그려졌다는 사실 자체는 근거가 아니다(예: CLIP debiasing
     Fig.4의 큐보이드는 MLP 모듈의 관습적 3D 표현일 뿐 → 등급 A/C, 입체는 박스 하나로 국한).
   - **실험실 조작 깊이**: 실험실은 ==의미 있는 조작 축 2개==를 권장한다(예: ArcFace라면
     마진 m + 스케일 s, 프루닝이라면 희소도 + 재학습 여부). 단 ==논문에 실제로 존재하는
     축만== — 억지로 2개를 만들지 말고, 현상분석(T8)·벤치마크(T9)처럼 조작이 부자연스러운
     타입은 1개 또는 관찰형(자동 재생)도 허용.
   - **미도달 단계 최소 대비**: 구조도에서 아직 안 간 단계도 ==opacity 0.45 이상==으로
     — 전체 구조는 항상 먼저 읽혀야 한다. 현재 단계만 강조(1.0), 완료 단계는 중간 톤,
     미도달은 0.45 — 3단계 대비. (참조 구현의 `zone.dim`이 이 기준이다.)
   - 출력은 완결된 단일 HTML(외부 의존성 0, CDN·이미지·폰트 파일 없음). 260~400줄 내외.
   - ==LaTeX 표기(`$...$`·`\(...\)`) 절대 금지== — 이 HTML엔 KaTeX가 없어 **소스가 화면에
     그대로 노출**된다. 수식·기호는 HTML `<sub>/<sup>`·유니코드(θ γ λ Σ √ ≤ ∂ ⊙ x̂)·
     이탤릭으로 쓴다. 예: `$\hat c=g(x)$` → `ĉ = g(x)`, `$L=\sum l+\lambda\sum g(\gamma)$`
     → `L = Σ l + λ·Σ g(γ)`. (verify가 `raw_latex` 위반으로 잡는다.)

5. **자가검증 루프 (필수 — 이게 품질을 만든다)**: HTML을 아래 출력 경로에 Write한 뒤,
   반드시 실행한다:
   ```
   node scripts/verify_mviz.js <출력경로> --json
   ```
   출력 JSON의 `violations`가 비어 있지 않으면(pass:false), 각 위반 지점을 **Edit로 부분 수정**하고
   (전체 파일을 다시 Write하지 말 것 — 바뀐 부분만 Edit해 토큰을 아낀다)
   **다시 verify를 실행한다.** `pass:true`가 될 때까지 반복한다(최대 5회). 대표 위반과 처리:
   - `text_overlap` / `viewbox_overflow`: 라벨을 도형 옆 전용 여백으로 옮기거나 좌표 조정.
   - `inline_bar`: 막대 span에 `display:block` 추가.
   - `slider_dead`: 슬라이더 input 핸들러가 실제로 시각 요소를 갱신하는지 확인(binds).
   - `zone_step_mismatch`: 존 수와 스텝 수를 일치시킨다(phase형이면 zone 대신 phase 사용).
   - `console_error`/`page_error`: JS 오류를 고친다.
   - `empty_step`: 각 스텝의 여정 렌더 함수가 내용을 그리는지 확인.
   verify가 통과하면 완료다. 통과 못 한 잔여 위반이 있으면 무엇을 왜 못 고쳤는지 남긴다.

6. **완료 보고 (§10)**: 최종 응답(JSON)에 아래를 담는다.

## 출력 계약

- HTML 파일은 **정확히 이 경로**에 Write한다: `<OUTPUT_PATH>` (아래에서 지정됨).
- 최종 응답은 **JSON 객체 하나**로, 다음 키만 담는다:
  ```jsonc
  {
    "method_steps": [ { "title": "...", "description": "...", "analogy": "..." }, ... ],
    "viz_report": {
      "type": "T1",              // 판정한 타입(폴백이면 "T5-fallback→T3" 형식)
      "type_reason": "...",       // 판정 근거(기여의 중심)
      "grade": "C",               // A/B/C
      "real_numbers": ["N=6, d_model=512 (논문 §3)", ...],   // 논문에서 확인한 실제 수치
      "example_values": ["어텐션 가중치 (예시)", ...],          // 예시로 처리한 값
      "verify": { "pass": true, "attempts": 2, "remaining": [] },  // verify 최종 결과
      "unconfirmed": ["..."]      // 확인 못 해 생략/예시 처리한 것
    }
  }
  ```
- `method_steps`는 방법론 텍스트 단계다(수식 탭이 `#step-{i}`로 점프해 오므로 유지). HTML의
  스테퍼와 별개로, 각 단계 title/description(관통 예시 포함)을 담는다.
  단, **사용자 메시지가 "method_steps 재사용(P4)" 블록으로 확정된 단계를 제공하면** 그 단계를
  재생성·변경하지 말고 HTML 스테퍼를 그에 맞추기만 하라. 이때 응답 JSON의 `method_steps`는
  생략해도 된다(서버가 기존 값을 유지한다).
- `method_viz_html`은 응답 JSON에 넣지 않는다 — 파일로 Write하면 서버가 읽는다.

## 금지

- 드릴인(클릭 확장). SVG 고정 px 폭. 서비스 리사이즈 핸들 덮어쓰는 CSS. 없는 수치 창작.
- verify를 실행하지 않고 "됐다"고 보고하는 것. 반드시 verify pass를 확인하라.
