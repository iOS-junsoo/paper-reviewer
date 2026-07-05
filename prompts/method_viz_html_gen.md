# 연구 방법론 인터랙티브 시각화 HTML 생성 지시문 (타입 기반)

너는 이 논문의 "연구 방법론" 탭에 들어갈 **독립 실행형 HTML 시각화 파일 1개**를 만든다.
결과물은 `method_viz_html`로 저장되어 서비스의 방법론 패널에 iframe으로 삽입된다.

## 절대 규칙 (권위 있는 사양)

**제작 규칙 전체는 `prompts/method_viz_refs/viz_guideline.md`에 있다. 먼저 그 문서를 Read로
정독하라.** 아래는 그 지침을 이 파이프라인에서 실행하는 방법이다. 지침과 아래가 충돌하면
지침이 우선한다. 단 산출 방식·검증 루프·출력 경로는 아래를 따른다.

## 수행 절차 (순서 고정)

1. **타입 판정 (§1)**: 논문을 읽고 T1~T9 중 하나로 분류한다. 9개에 없으면 §5 폴백
   (최근접 매핑 → 범용 골격). abstract의 "we propose" 문장이 기여의 중심을 정한다.

2. **참조 정독**: 판정한 타입의 참조 구현을 Read한다 —
   `prompts/method_viz_refs/t{N}_*.html` (T1=t1_transformer, T2=t2_senet, T3=t3_simclr,
   T4=t4_fairgrape, T5=t5_mixup, T6=t6_ddpm, T7=t7_rag, T8=t8_grokking, T9=t9_bold).
   **이 파일이 그 타입의 정답지다.** 구조·CSS 변수·헬퍼 함수(cuboid/slabStack/betaPath 등)·
   스테퍼/입자/실험실 패턴·2단계 애니메이션·baseline 성장 규칙을 그대로 맞춘다.
   폴백이면 최근접 타입 참조를 빌린다.

3. **수치·Figure 추출 (§6.1·§6.2, 정직성 최우선 — §7)**:
   `pdfs/<hash>.pdf`를 Read로 읽어 방법의 **실제 수치**(차원·층수·하이퍼파라미터 기본값·
   스케줄 상수·데이터셋 규모·대표 결과)와 **Figure 캡션**을 추출한다.
   - **논문에서 확인한 값만 실제 수치로 쓴다.** 확인하지 못한 값은 지어내지 말고
     `(예시)`로 명시하거나 생략한다. 이것은 타협 불가다 — 없는 수치를 그럴듯하게
     만들어내면 실격이다(§7-1·§7-4). 시각화용으로 만든 값(예시 임베딩·정성 곡선·
     가상 가중치)은 개별 값 옆 `(예시)` + note 캡션에 "정성적 예시이며 실제 측정값이
     아니다" 명시.
   - 계산 가능한 것(Beta PDF, ᾱ=∏(1-β), 정량 경계)은 논문 정의식으로 **실제 계산**해 그린다.
   - note 캡션 3요소 필수: ① 무엇이 예시인지 ② 무엇이 논문의 실제 정의/수치인지(arXiv 번호)
     ③ 정량 결과는 논문 어디를 보라는 안내.
   - 관통 예시(§7-1): 논문의 실제 예문/샘플 하나가 모든 스텝을 관통하게 한다.

4. **구현 (§2 공통 템플릿 + §3 타입 스펙)**: 6블록으로 작성. 헤더(제목+타입배지+lead 3~4문장)
   · 좌 구조도 SVG · 우 데이터 여정 패널 · 스테퍼 · 하단 실험실 · 정직성 note.
   - **드릴인 전면 금지** (§0). 구조는 처음부터 전부 펼쳐지고 스테퍼가 현재 존만 강조.
   - **리사이즈 호환 필수 (§2.8)**: 모든 SVG는 `width:100%`+`viewBox`(고정 px 폭 금지).
     좌표는 viewBox 논리좌표로. flexbox 비율 레이아웃. 컨테이너에 고정 width/height 금지.
   - **막대류 `display:block` + 2단계 애니메이션**(0→rAF→최종값). baseline 고정·위로 성장.
   - 등급(A/B/C)에 맞는 입체 적용. 값 비교 막대는 항상 2D.
   - 출력은 완결된 단일 HTML(외부 의존성 0, CDN·이미지·폰트 파일 없음). 260~400줄 내외.

5. **자가검증 루프 (필수 — 이게 품질을 만든다)**: HTML을 아래 출력 경로에 Write한 뒤,
   반드시 실행한다:
   ```
   node scripts/verify_mviz.js <출력경로> --json
   ```
   출력 JSON의 `violations`가 비어 있지 않으면(pass:false), 각 위반을 고쳐 다시 Write하고
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
- `method_viz_html`은 응답 JSON에 넣지 않는다 — 파일로 Write하면 서버가 읽는다.

## 금지

- 드릴인(클릭 확장). SVG 고정 px 폭. 서비스 리사이즈 핸들 덮어쓰는 CSS. 없는 수치 창작.
- verify를 실행하지 않고 "됐다"고 보고하는 것. 반드시 verify pass를 확인하라.
