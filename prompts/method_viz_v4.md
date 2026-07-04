# 연구 방법론 시각화 생성 지시문 v4 (판정 → 라우팅 → 생성)

> 이 문서는 v3 지시문을 대체하는 **완전한 단일 지시문**이다. 너(생성 모델)는 논문을 읽고
> ① 기여 유형을 판정하고, ② 판정 결과에 따라 출력 형식을 라우팅하고, ③ 해당 형식의
> 스펙을 생성한다. SVG/HTML 코드를 직접 작성하지 않는다 — 렌더링은 앱이 담당한다.

---

## §0. 전체 구조 — 네가 수행할 3단계

```
논문 → [1단계: 유형 판정 §1]  9유형 중 primary 1개 (+선택적 secondary 1개)
     → [2단계: 라우팅 §2]     primary가 지원 유형(T1·T2·T3·T4·T7·T9)이면
                              → method_visualization 생성 (§3~§8)
                              primary가 미지원 유형(T5·T6·T8)이면
                              → 기존 flow 형식으로 폴백 (§10)
     → [3단계: 스펙 생성]     유형별 가이드(§6)에 따라 스키마(§3)를 채움
```

핵심 원칙 세 가지:
1. **판정은 항상 9유형 전체를 대상으로 한다.** 폴백 경로로 가더라도 판정 결과는 출력한다.
2. **생성은 렌더러 계약(§12)이 보장하는 것만 요구한다.** 계약 밖의 표현을 스펙에 넣으면
   검증(§9)에서 잘려나가 결과만 나빠진다. 화려한 스펙이 아니라 정확한 스펙이 목표다.
3. **미지원 유형을 지원 유형으로 억지 분류하지 마라.** 폴백은 실패가 아니라 정상 경로다.
   v3 프레임이 더 화려하다는 이유로 유형 6 논문을 유형 4처럼 판정하는 것은 오분류이며,
   판정 근거 문장에서 드러난다.

---

## §1. 유형 판정 체계 (1단계)

### 1-1. 판정 절차

1. 논문의 제목, 초록, Introduction의 기여 요약(보통 "we propose / our contributions" 문단),
   그리고 방법 그림(Fig.1 등)을 근거로 아래 9유형 중 **primary 1개**를 고른다.
2. 뚜렷한 부차 기여가 있으면 **secondary 1개**를 추가로 고른다 (없으면 생략, 2개 이상 금지).
3. `paper_type_reason`에 판정 근거를 **한 문장**으로 쓴다. 근거 문장에는 논문에서 관찰한
   구체적 신호(아래 표의 "판정 신호" 중 무엇이 보였는지)가 포함되어야 한다.
4. 판정이 두 유형 사이에서 갈리면 §1-3의 경계 규칙을 적용한다.

### 1-2. 9유형 정의와 판정 신호

**T1. 아키텍처 제안** — 새로운 네트워크 전체 구조가 기여.
- 판정 신호: 구조에 고유 이름을 붙이고(예: "우리는 ○○Net을 제안한다") 그 구조 하나로
  여러 태스크를 실험. Fig.1이 네트워크 전체 구조도. ablation이 구조 구성요소 제거 실험.
- 예: Transformer, MobileNetV2, U-Net.

**T2. 모듈·블록 제안** — 기존 백본은 유지하고 특정 구성 블록의 교체가 기여.
- 판정 신호: "drop-in replacement", "기존 ○○ 블록을 대체" 서술. 여러 백본에 끼워 넣어
  일반성 검증. Fig.1이 블록 내부 확대도.
- 예: 새로운 어텐션 변형, 정규화 기법, conv 블록.

**T3. 손실·목적함수 제안** — 아키텍처 변경 없이 새 손실 항/학습 신호가 기여.
- 판정 신호: L = L_task + λ·L_new 형태의 수식이 방법의 중심. ablation이 λ 스윕.
  아키텍처 그림은 기존 망 재사용.
- 예: contrastive loss 변형, 공정성 정규화 항, margin 기반 손실.

**T4. 압축·경량화 기법** — 파라미터/연산량 감소 자체가 목적.
- 판정 신호: sparsity·rank·bit 축의 실험. "성능 유지하며 n% 축소" 주장.
  프루닝/양자화/증류/LoRA 계열 키워드.
- 예: FairGRAPE, Fair Scratch Tickets, LoRA, 지식 증류.

**T5. 데이터 중심 기법** — 모델·손실은 고정, 데이터의 생성·변형·선별이 기여. **[미지원→폴백]**
- 판정 신호: 증강 정책, 리샘플링, 큐레이션, 합성/반사실 데이터 생성이 방법의 중심.
  같은 모델을 다른 데이터로 학습해 비교.

**T6. 학습 절차·최적화 제안** — "무엇을 언제 어떤 순서로 갱신하는가"가 기여. **[미지원→폴백]**
- 판정 신호: 스케줄, 커리큘럼, 교대 최적화, EM, 셀프 트레이닝 루프. 방법 그림에
  시간축이나 반복 루프가 등장. Algorithm 의사코드가 단계 순서 중심.

**T7. 시스템·파이프라인 제안** — 다수 컴포넌트의 조립·연결 방식이 기여.
- 판정 신호: 컴포넌트 각각은 기존 기술이고 연결 구조가 새로움. 방법 그림에 3개 이상의
  독립 컴포넌트와 데이터 흐름. 검색기+생성기, 다단계 처리 등.
- 예: RAG 계열, 다단계 검출 파이프라인, 에이전트 시스템.

**T8. 이론·분석** — 정리·증명·법칙·실증 분석이 기여, 새 방법 제안 없음. **[미지원→폴백]**
- 판정 신호: Theorem/Lemma/Proposition이 본문의 중심. 또는 기존 방법들의 거동을
  체계적으로 측정·설명하는 실증 연구.

**T9. 벤치마크·평가 제안** — 데이터셋·평가 프로토콜·지표의 제안이 기여.
- 판정 신호: 새 데이터셋/프로토콜을 만들고 다수의 기존 모델을 그 위에서 평가.
  기여 요약에 "we introduce a benchmark/dataset/metric".

### 1-3. 경계 규칙 (판정이 갈릴 때)

- **T1 vs T2**: 제안 구조가 단독으로 완결된 망이면 T1, 기존 망에 꽂는 부품이면 T2.
  여러 백본에 이식하는 실험이 있으면 T2로 기운다.
- **T3 vs T4**: 손실을 새로 설계했더라도 그 목적이 압축(무엇을 남길지 결정)이면 T4가
  primary, T3가 secondary다. FairGRAPE가 이 경우다.
- **T3 vs T6**: 새 손실 항이면 T3, 손실은 기존 것이고 적용 순서·시점이 새로우면 T6.
- **T7 vs T1**: 구성요소가 end-to-end로 함께 학습되는 단일 망이면 T1, 독립적으로
  동작·학습되는 컴포넌트의 연결이면 T7.
- **T9 vs T8**: 평가 도구를 만들어 공개하면 T9, 측정 결과의 해석이 중심이면 T8.
- 그래도 갈리면: **논문 제목이 가리키는 쪽**을 primary로 한다.

## §2. 라우팅 규칙 (2단계)

| primary 유형 | 출력 형식 |
|---|---|
| T1, T2, T3, T4, T7, T9 | `method_visualization` 생성 (§3 스키마, §6 유형별 가이드) |
| T5, T6, T8 | `method_visualization` 생성 **금지**. 기존 flow 형식으로 폴백 (§10) |

- 라우팅은 **primary만으로** 결정한다. secondary가 지원 유형이어도 primary가 미지원이면
  폴백한다 (프레임은 primary가 결정하고, secondary는 그 프레임 안의 조연이다).
- 폴백 시에도 `paper_type_primary` / `paper_type_secondary` / `paper_type_reason` 필드는
  출력에 포함한다 (§10 참조).
- 미지원 유형 판정을 회피하려고 primary를 왜곡하지 마라. 판정 근거 문장이 신호와
  맞지 않으면 검수에서 걸린다.

## §3. 출력 스키마 (method_visualization)

```jsonc
{
  "method_visualization": {
    "paper_type_primary": "T1|T2|T3|T4|T7|T9",
    "paper_type_secondary": "T1~T9 또는 생략",
    "paper_type_reason": "판정 신호가 포함된 한 문장",
    "section_ref": "재구성한 Section/Figure (예: 'Fig.2, §4.2~4.3')",

    "example": {            // 전체를 관통하는 예시 하나 (§7-1)
      "dataset": "CelebA",
      "sample": "얼굴 이미지 한 장",
      "task": "Smiling 이진 분류",
      "group": "gender"     // 해당 없으면 생략
    },

    "modules": [            // 4~7개. 배열 순서 = 대체적 데이터 흐름 순서
      {
        "id": "dense",                  // 영문 소문자 스네이크, 고유
        "name": "Frozen Dense Net f(θ)", // 한글 기준 10자·라틴 18자 이내
        "name_short": "동결 망",         // 축소 배율이 낮을 때 대체 표기 (필수)
        "sub": "가중치 동결",            // 8자 이내
        "primitive": "iso_stack",       // §4 사전에서 선택
        "primitive_spec": { },          // §4의 프리미티브별 필수 필드
        "lane_hint": "top|middle|bottom", // 선택. 병렬 배치 교정용, 병렬일 때만
        "role": "이 모듈이 하는 일 한 문장",
        "data_state": "통과 후 데이터 형태 한 문장 (실제 차원 수치를 여기 병기)"
      }
    ],

    "groups": [             // 선택. 점선 박스로 모듈들을 묶음 (논문 그림의 점선 영역)
      { "id": "bias_align", "label": "Bias Alignment", "members": ["align"], "style": "dashed" }
    ],

    "edges": [
      { "from": "input", "to": "dense", "kind": "forward" },
      // kind: "forward" 실선 | "gradient" 버건디 점선(역방향 허용, label 권장)
      //       "frozen" 회색 점선 | "alternating" 스위치 분기(반드시 같은 from에서 2개 쌍)
      { "from": "loss", "to": "score", "kind": "gradient", "label": "∂ℓ/∂r" }
      // label: 한글 6자·라틴 10자 이내. 짧은 edge에서는 렌더러가 자동으로 숨긴다
    ],

    "control": {            // 정확히 1개
      "param": "eta", "symbol": "η", "label": "sparsity η",
      "min": 10, "max": 90, "default": 50, "step": 5, "unit": "%",
      "mode": "mask | coeff | text",   // §3-1 참조
      "direction": "keep_top | remove_top",  // mode=mask일 때만, 필수
      "affects": ["mask", "sparse"],   // 조작 시 시각 변화가 있는 모듈 id
      "semantics": "이 파라미터가 논문에서 의미하는 바 한 문장"
    },

    "sim": {
      "state": "시뮬레이션이 유지하는 상태 서술 (예: 채널별 점수 배열 r)",
      "update_rule": "학습 1회 반복 시 상태가 어떻게 변하는지 정성 서술",
      "qualitative_trends": ["반복에 따라 관찰되어야 할 경향 2~3개"],
      "readouts": [          // 하단 리드아웃. 정의한 것만 표시된다
        { "id": "iter", "label": "학습 반복", "source": "iter" },
        { "id": "active", "label": "활성 채널", "source": "mask_count" }  // mode=mask일 때만
      ],
      "disclaimer": "정성적 시뮬레이션·예시값 고지 문구 (필수)"
    },

    "steps": [              // 5~8개
      {
        "module": "dense",   // modules의 id와 정확히 일치
        "title": "동결 네트워크 통과",
        "desc": "무엇을+왜 2~3문장. 관통 예시가 이 단계에서 어떤 형태인지 반드시 언급",
        "detail_viz": {
          "type": "activation_bars",  // §5 사전에서 선택
          "binds": ["example"],       // §5의 유형별 필수 binds
          "caption": "패널 하단 한 줄. 예시값이면 '(예시)' 표기"
        }
      }
    ]
  }
}
```

### §3-1. control.mode — 조작이 화면에 반영되는 방식

렌더러는 세 가지 모드만 지원한다. **논문의 파라미터 성격에 맞는 모드를 고르되,
모드가 지원하지 않는 시각 효과를 기대하고 스펙을 짜지 마라.**

- `"mask"` — 파라미터가 유지/제거 비율(sparsity, top-k, rank). iso_stack 슬래브가
  실시간으로 켜지고 꺼지며, sorted_threshold의 임계선이 이동한다. `direction` 필수:
  파라미터가 커질 때 **남기는** 양이 커지면 keep_top, **제거하는** 양이 커지면 remove_top.
  (예: FST의 η=유지 비율 → keep_top, FASP의 α=pruning ratio → remove_top)
- `"coeff"` — 파라미터가 강도·계수(λ, temperature, margin, 혼합 비율). 시뮬레이션의
  수렴 속도·분포 접근 속도·큐 유입 리듬에 반영되고, convergence_curve와 dual_dist의
  거동이 변한다. 구조는 변하지 않는다.
- `"text"` — 위 둘로 표현 불가한 구조 파라미터(depth, patch size 등). 모듈 부제·배지·
  data_state 텍스트와 리드아웃만 갱신된다. 시각 효과가 가장 약하므로 mask/coeff로
  표현 가능한 파라미터가 있으면 그쪽을 우선하라.

## §4. 입체 프리미티브 사전 (modules[].primitive)

성격에 맞는 것을 고르고, **같은 프리미티브를 3개 이상의 모듈에 쓰지 마라.**

| primitive | 언제 쓰나 | primitive_spec 필수 필드 |
|---|---|---|
| `io_cube` | 입력/출력 샘플 (이미지·텍스트) | `{ "glyph": "face \| text \| none" }` |
| `iso_stack` | 네트워크 백본. 채널 슬래브가 낱장으로 세어지는 2.5D 스택 | `{ "layers": [{"ch":4,"h":118},...], "frozen": true\|false }` |
| `card_stack` | 벡터·점수·임베딩 집합 (비스듬한 카드 더미) | `{ "count": 6, "label": "r₁…r_C", "color": "purple\|tan" }` |
| `queue_bank` | 큐·버퍼·메모리 (가로로 눕힌 카드 열, sim 반복 시 카드 유입) | `{ "count": 6, "label": "Q_t", "grow": true\|false }` |
| `op_box` | 연산·선택·집계 모듈 (마스크, 게이트, 풀링, 지표 계산) | `{ "dynamic_sub": true\|false }` |
| `switch_box` | 교대 라우팅 모듈. 나가는 edge 2개가 alternating일 때 사용 | `{ }` |
| `dual_dist_box` | 두 집단·두 분포를 비교하는 손실/지표 모듈 | `{ "labels": ["집단 A","집단 B"] }` |
| `loop_badge` | N회 반복 표시. 모듈이 아니라 edge에 붙는 배지 | `{ "text": "N×" }` — edges에 `"badge"` 필드로 첨부 |

`iso_stack` 작성 규칙:
- `layers`는 논문의 실제 백본을 **3~5개 레이어로 비례 축약**한다. `ch`(슬래브 수) 4~8,
  `h`(높이) 50~130. 실제 채널 수(예: 1280)는 그리지 말고 `data_state`에 텍스트로 병기한다.
- 공간 해상도가 줄면 `h` 감소, 채널이 늘면 `ch` 증가. U-Net처럼 단조가 깨지는 구조는
  실제 구조를 따른다 (인코더 감소 → 디코더 증가).
- 반복 블록(×N)은 레이어를 반복해서 그리지 말고 loop_badge로 표시한다.
- 마스킹/프루닝 대상 스택은 반드시 `control.affects`에 포함한다 (mode=mask일 때).

## §5. detail_viz 사전 (steps[].detail_viz.type)

내부 시각화는 **반드시 상태에 바인딩**된다. binds에 적은 상태가 바뀌면 패널이 다시
그려진다. 바인딩 없는 순수 장식 그림은 금지이며, **이 사전에 없는 type을 발명하지 마라**
(렌더러에 드로어가 없으면 transform으로 강제 대체된다).

| type | 무엇을 그리나 | 필수 binds | 규칙 |
|---|---|---|---|
| `pixel_grid` | 입력 샘플의 픽셀/토큰 격자 | `["example"]` | 입력 단계 전용, 문서당 1회 |
| `activation_bars` | 레이어·그룹별 활성 막대. `groups` 스펙으로 층 구분선 표시 가능 | `["example"]` | 캡션에 "(예시)" 필수. 축약했으면 축약 방식 명시 ("층별 합산") |
| `histogram` | 상태 배열의 현재 분포 | `["sim.state"]` | 학습 반복 시 분포 변화가 보여야 함 |
| `sorted_threshold` | 상태 배열 정렬 + control 임계선 | `["sim.state","control"]` | mode=mask 전용. direction에 따라 임계선 좌우 의미가 바뀜 |
| `slab_mask` | 채널 슬래브 행, 마스크=0은 점선 소멸 | `["sim.state","control"]` | mode=mask 전용. iso_stack 모듈과 짝 |
| `dual_dist` | 두 집단/두 모델의 분포 대비, coeff에 따라 접근 속도 변화 | `["sim.state"]` (coeff면 `"control"` 추가) | dual_dist_box 모듈과 짝 |
| `convergence_curve` | 정성 수렴 곡선 + 현재 반복 위치 점 | `["sim.iter"]` | 캡션에 "예시 곡선" 필수 |
| `transform` | 형태 변화만 있는 모듈 (reshape, concat, ⊕) | `["example"]` | from/to/op 표기. 볼 수치 없는 모듈의 기본값 |
| `summary_rows` | 현재 상태 요약 행 (활성 수, 반복 수, 결론) | `["sim.state","control","sim.iter"]` | 마지막 단계 전용 |

선택 규칙:
- **같은 type을 두 단계 이상 반복하지 마라.** 데이터가 "샘플 → 활성 → 점수 → 선택 →
  결과 → 지표"로 변해가는 흐름이 type의 나열 자체에서 읽혀야 한다.
- control이 영향을 주는 모듈의 단계에는 binds에 `"control"`이 포함된 type을 배정한다.
  사용자가 그 단계에 머문 채 슬라이더를 움직이는 경험이 이 시각화의 핵심이다.
- 억지로 화려한 type을 고르지 마라. 볼 수치가 없으면 transform이 정답이다.

## §6. 유형별 생성 가이드 (지원 6유형)

각 유형마다 (a) 주인공, (b) 골격 템플릿, (c) control 선정, (d) detail_viz 배정,
(e) 스테퍼 구성, (f) 흔한 함정을 정의한다. **primary 유형의 가이드를 따르고,
secondary는 특정 모듈/단계 1~2개에서만 등장시킨다.**

### T1. 아키텍처 제안
- (a) 주인공: 텐서가 각 스테이지를 지나며 형태(shape)가 변하는 과정.
- (b) 골격: `io_cube → iso_stack(제안 구조를 스테이지 단위로 축약) → op_box(head) → 출력`.
  분기·스킵·합류는 edges로 표현하고 (스킵 = 별도 forward edge, 합류 = ⊕ op_box),
  반복 블록은 loop_badge. **레이어 하나하나를 모듈로 만들지 말고 스테이지 단위로 묶어라.**
- (c) control: `mode: "text"`가 기본 (depth·width·patch size는 구조 파라미터라 실시간
  구조 변형이 미지원). 논문에 유지/제거 성격 파라미터가 있으면 그때만 mask.
- (d) detail_viz: transform을 중심축으로 (스테이지마다 shape 변화), 입력 pixel_grid,
  중간 activation_bars 1회, 마지막 summary_rows.
- (e) 스테퍼: 입력 → 스테이지별 통과(2~4단계) → head → 출력 요약. 각 desc에 해당
  스테이지 통과 후의 실제 텐서 차원을 쓴다 (논문에서 확인한 수치만).
- (f) 함정: 층 전부 그리기(과밀), 실제 채널 수를 슬래브 수로 옮기기, control을 억지로
  mask로 지정하기.

### T2. 모듈·블록 제안
- (a) 주인공: 제안 블록의 **내부** 연산 순서. 전체 망은 무대일 뿐이다.
- (b) 골격: 전체 망은 `iso_stack` 1개로 최소화하고, 제안 블록의 내부 연산을 **별도
  모듈 3~4개로 분해**한 뒤 `groups`(점선 박스, label="제안 블록 내부")로 묶는다.
  블록이 백본 어디에 꽂히는지 iso_stack에서 groups로 들어가는 edge로 표시한다.
- (c) control: 블록 내부 하이퍼파라미터. 헤드 수·그룹 수처럼 개수 성격이면 mask
  (keep_top), 온도·스케일 성격이면 coeff.
- (d) detail_viz: 블록 내부 단계들에 histogram/transform을 배정하고, 블록 밖(백본)
  단계는 최대 1개로 제한.
- (e) 스테퍼: 백본 진입(1단계) → 블록 내부 연산 순서(3~4단계) → 블록 출력이 백본으로
  복귀(1단계).
- (f) 함정: 백본을 자세히 그려서 시선 분산. 블록 내부를 모듈 1개로 뭉뚱그려 T1처럼
  그리기 — 그러면 이 유형을 고른 의미가 없다.

### T3. 손실·목적함수 제안
- (a) 주인공: 새 손실 항이 표현·예측에 가하는 **당기고 미는 힘**과 그 결과로 좁혀지는
  분포 격차. 수식이 아니라 힘의 기하를 보여야 한다.
- (b) 골격: `io_cube(들, 필요 시 병렬 lane) → iso_stack(기존 망, frozen 여부는 논문대로)
  → card_stack(임베딩/로짓) → dual_dist_box(새 손실 항)`. gradient edge가 손실에서
  학습 대상(망 또는 임베딩)으로 회귀. 손실이 두 항 이상이면 dual_dist_box는 새 항에만
  쓰고 기존 항(ℓ_task)은 op_box로 구분한다.
- (c) control: `mode: "coeff"`, 파라미터는 λ·temperature·margin 중 논문이 스윕한 것.
  affects는 dual_dist_box(+ convergence 단계). min/max는 논문의 ablation 범위.
- (d) detail_viz: dual_dist(binds에 control 포함 — λ가 크면 분포가 빨리 접근)를 핵심으로,
  histogram(임베딩 거리 분포), convergence_curve, transform.
- (e) 스테퍼: 입력 쌍/삼중항 → 임베딩 생성 → **새 손실 항이 작동하는 단계**(가장 공들일
  것, dual_dist 배정) → 기존 항과의 결합 → 수렴 경향.
- (f) 함정: 손실 수식을 desc에 통째로 옮겨 적기(항의 역할을 말로 풀 것), 산점도
  애니메이션 같은 사전에 없는 type 요구, 망 구조를 주인공처럼 크게 그리기.

### T4. 압축·경량화 기법
- (a) 주인공: **무엇이 제거·추가·복사되는가** — 원본과 변형의 대비.
- (b) 골격, 하위 계열별:
  - 프루닝/마스킹: `io_cube → iso_stack(원본) → card_stack(점수/중요도) → op_box(선택,
    dynamic_sub) → iso_stack(마스크 반영, affects) → 손실` + gradient 회귀.
  - 증류: 교사 `iso_stack(frozen, lane_hint: top)`과 학생 `iso_stack(lane_hint: bottom)`을
    병렬 배치, 두 출력이 dual_dist_box(로짓 정합)로 합류, gradient는 학생에게만.
  - LoRA/어댑터: 본체 `iso_stack(frozen)` + 곁가지 `card_stack(A·B)`, ⊕ op_box 합류,
    gradient는 곁가지로만.
- (c) control: `mode: "mask"` (sparsity/rank), **direction 판정이 이 유형의 최우선
  주의사항**이다. 논문에서 파라미터 정의를 확인하라: 값이 클수록 더 많이 **남기면**
  keep_top(FST의 η), 더 많이 **제거하면** remove_top(pruning ratio류). semantics에
  논문의 원문 정의를 요약해 적는다.
- (d) detail_viz: sorted_threshold + slab_mask 조합이 핵심 (둘 다 control 바인딩).
  histogram(점수 분포), convergence_curve 또는 dual_dist(공정성 계열), summary_rows.
- (e) 스테퍼: 원본 통과 → 중요도/점수 산출 → 선택(임계선) → 제거 반영 → 손실/회귀 →
  결과 요약.
- (f) 함정: direction 반전(치명적 — 반드시 원문 확인), 증류인데 교사·학생을 직렬로
  잇기, LoRA 곁가지를 iso_stack으로 그리기(카드 더미가 저계수 표현에 맞음).

### T7. 시스템·파이프라인 제안
- (a) 주인공: 관통 예시(질의 한 건, 이미지 한 장)가 각 컴포넌트에서 **다른 형태로
  변해가는 여정**. 컴포넌트 자체가 아니라 흐름이 주인공이다.
- (b) 골격: rank/lane 배치를 전면 활용한다. 병렬 컴포넌트는 lane_hint로 나란히,
  조건 분기는 switch_box + alternating, 버퍼·메모리는 queue_bank(grow: true),
  논문 그림의 점선 영역은 groups로 옮긴다. **논문 Figure의 위상(분기·합류·회귀)을
  edges로 그대로 옮기는 것이 최우선 과제다.**
- (c) control: 라우팅 임계값이나 컴포넌트 강도 → coeff. 개수 성격(top-k 검색 수) →
  mask(keep_top). 마땅한 것이 없으면 text로 스테이지 파라미터 하나.
- (d) detail_viz: **스테이지마다 다른 type** — 이 유형에서 반복 금지 규칙이 가장
  중요하다. 입력 pixel_grid, 변환 transform, 선택 sorted_threshold, 축적 histogram,
  집계 summary_rows처럼 스테이지 성격에 맞춰 배분한다.
- (e) 스테퍼: 컴포넌트당 1단계, 각 desc에 관통 예시의 현재 형태를 명시
  ("질의 문장이 top-5 문서 목록이 된다").
- (f) 함정: 모듈 수 폭발 — 7개 상한. 보조 컴포넌트(전처리, 캐시)는 인접 모듈에 흡수
  하거나 sub에 언급만. 컴포넌트 내부 구조까지 그리려는 시도(그건 T1·T2의 일이다).

### T9. 벤치마크·평가 제안
- (a) 주인공: 케이스 하나가 채점되는 **절차**. 평가 프로토콜은 방법이므로 재구성
  대상이지만, 결과 리더보드는 결과이므로 금지 — 이 경계를 명심하라.
- (b) 골격: `io_cube(평가 케이스) → op_box(판정 단계)들 → op_box(지표 집계) →
  summary`. 케이스 유형이 여럿이면 병렬 lane. 다수 모델을 평가하는 구조면 피평가
  모델은 iso_stack 1개(frozen, 내부는 그리지 않음)로 무대만 세운다.
- (c) control: 지표 임계값·판정 기준 → coeff, 케이스 난이도/카테고리 필터 → text.
- (d) detail_viz: transform(케이스 → 판정 결과), dual_dist(모델 간·집단 간 분포 비교),
  summary_rows(집계). 채점 규칙이 수치면 sorted_threshold도 가능.
- (e) 스테퍼: 케이스 입력 → 판정 단계들 → 지표 계산 → 집계 요약.
- (f) 함정: 특정 모델들의 실제 점수를 표로 재구성(금지 — 결과다), 프로토콜과 무관한
  데이터셋 통계 나열.

## §7. 공통 생성 규칙

**7-1. 관통 예시** — §3의 example 하나가 모든 모듈과 스테퍼 단계를 관통한다. 논문에
데이터셋이 명시되어 있으면 반드시 그 데이터셋의 샘플로 한다. 모듈마다 다른 예시 금지.

**7-2. 수치 정직성** — 값은 논문에서 읽은 실제 수치만. 없으면 정성 패턴을 반영한
예시값을 쓰되 캡션·desc에 "(예시)"를 명시한다. control의 min/max/default는 논문의
실험 설정 범위에서 가져온다. 확인 못 한 수치를 확인한 것처럼 쓰면 실격이다.

**7-3. 작성 전 검색** — 스펙을 채우기 전 해당 기법의 유명 해설 자료를 1~2회 웹검색해
통용되는 시각 관례를 참고한다. 스스로 발명한 은유는 desc에서 은유임을 밝힌다.

**7-4. 텍스트 길이** — name 한글 10자·라틴 18자, name_short 한글 5자, sub 8자,
edge label 한글 6자 이내. 초과분은 렌더러가 말줄임하므로 처음부터 짧게 써라.

**7-5. 입자·색·간격은 스펙 대상이 아니다** — 렌더러 고정 규칙이다(§12). 모델이
관여할 수 있는 것은 edges의 kind와 badge뿐이다.

## §8. 금지사항

1. 성능/실험 결과 그림·표 재구성 금지. T9에서도 리더보드는 금지.
2. SVG/HTML 코드 직접 출력 금지. 스키마 밖 자유 형식 금지.
3. §5 사전에 없는 detail_viz type 발명 금지.
4. 같은 primitive 3개 이상, 같은 detail_viz type 2개 이상 반복 금지.
5. control 2개 이상 금지. mode=mask인데 direction 누락 금지.
6. 미지원 유형(T5·T6·T8)에 method_visualization 생성 금지 — §10으로 폴백.
7. 수치를 확인 못 했는데 figure를 억지로 만드는 것 금지 — 그 figure를 빼는 것이 낫다.

## §9. 검증 표 (렌더러가 수행 — 전부 통과가 목표)

| 검사 | 실패 시 |
|---|---|
| primary가 T5·T6·T8인데 method_visualization 존재 | 전체 무시, §10 폴백 처리 |
| modules 4~7개, id 고유, name_short 존재 | 전체 폴백 |
| steps[].module이 modules에 존재 | 해당 step 제거, 3개 미만이면 전체 폴백 |
| control.mode 유효 + (mask면 direction 존재) | control 제거 (정적 모드) |
| control.affects의 id가 modules에 존재하고 mode에 맞는 시각 효과 대상임 | control 제거 |
| iso_stack layers 1개 이상, ch 4~8·h 50~130 | 범위 밖은 클램프 |
| detail_viz type이 §5 사전에 존재 + 필수 binds 충족 | 해당 패널 transform 대체 |
| edges from/to 존재, alternating은 같은 from에서 정확히 2개 | 위반 edge 제거 |
| groups.members가 modules에 존재 | 해당 group 제거 |
| sim.readouts source 유효 (iter, mask_count, sim_metric) | 해당 readout 제거 |

## §10. 폴백 출력 형식 (primary가 T5·T6·T8일 때)

method_visualization 대신 기존 flow 형식을 출력한다:
- `paper_type_primary` / `paper_type_secondary` / `paper_type_reason`은 동일하게 포함.
- `figures` 1개: 기존 규칙대로 `flow[]`(블록 순서 = 데이터 흐름, 블록별 role·data_state·
  inner_viz) + 방법 그림의 SVG 재현. 기존 지시문의 figures 규칙(배선 템플릿, inner_viz
  7유형, data-block 매핑)을 그대로 따른다.
- 판정 유형에 맞게 서술 초점을 조정한다: T5는 데이터 변형 전후를, T6은 갱신 순서와
  루프를, T8은 가정→결론 사슬을 flow 블록과 method_steps 서술의 중심에 둔다.
- T8에서 방법 그림 자체가 없으면 figures를 생략한다 (억지 재구성 금지).

## §11. 완성 예시

**예시 A — T4 (Fair Scratch Tickets, 프루닝·마스킹)**: 모듈 6개
`input(io_cube) → dense(iso_stack, frozen, layers 4개) → score(card_stack, purple)
→ mask(op_box, dynamic_sub) → sparse(iso_stack, affects) → loss(dual_dist_box)`,
edges에 frozen(dense→sparse)·gradient(loss→score, "∂ℓ/∂r"), control은
`{param:"eta", mode:"mask", direction:"keep_top", affects:["mask","sparse"]}`,
steps 6개의 detail_viz는 pixel_grid → activation_bars → histogram → sorted_threshold
→ slab_mask → convergence_curve 순 (전부 다른 type, control 단계 2개가 바인딩됨).

**예시 B — T7 (CLIP 반사실 디바이어싱, 시스템)**: 모듈 8개, 병렬 입력 3개
(`t·t2·v`, io_cube, lane_hint로 3-lane) → `clip(iso_stack, frozen)` → `enc(iso_stack,
frozen: false)` → `sw(switch_box)` → `qv·qt(queue_bank, grow: true, lane 상하)` +
`align(dual_dist_box)`을 groups("Bias Alignment", dashed)로 묶음. edges에
alternating 쌍(sw→qv, sw→qt), gradient(align→enc, "L_cd"). control은
`{param:"alpha", mode:"coeff", affects:["align"]}` — λ가 클수록 dual_dist의 두 분포가
빠르게 접근. steps는 컴포넌트당 1단계, detail_viz는 스테이지마다 상이.

## §12. 렌더러 계약 (검증 통과 스펙에 대한 보장)

- 배치: edges의 forward 관계로 rank(x)·lane(y)을 자동 계산하는 계층 배치.
  lane_hint는 배치 교정 힌트로만 쓰인다. groups는 점선 라운드 박스.
- fit-to-view: 어떤 패널 크기에서도 스크롤 없이 전체가 보이도록 자동 축소.
  축소가 심하면 sub·edge label을 숨기고 name_short로 대체, 그래도 부족하면 2단
  serpentine 재배치. **모듈이 많을수록 작게 그려진다 — 모듈 수 절제가 곧 가독성이다.**
- 텍스트: 실측 기반 2줄 랩핑 → 말줄임, hover 시 전문 표시.
- control: mode별 §3-1의 시각 효과. 리드아웃은 sim.readouts에 정의된 것만.
- 입자: 순전파 3~5개가 8~12초에 전체 경로 1회 주행 후 페이드아웃, gradient edge에
  역방향 1~2개. alternating edge는 1초 간격 교대 활성.
- 스테퍼: 단계 이동 시 해당 모듈 하이라이트 + 나머지 디밍, detail 패널은 binds 상태
  변경 시 재드로잉. prefers-reduced-motion 시 애니메이션 자동 비활성.
