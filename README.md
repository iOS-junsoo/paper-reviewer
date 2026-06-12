# Paper Reviewer

논문 PDF를 드롭하면 Claude가 논문 전체를 비전으로 읽고 구조화해주는 로컬 웹앱.
세미나 발표 준비 / 논문 정독 전 빠른 구조화 이해 용도.

**API 크레딧 없이 Claude Max 구독만으로 동작합니다** (Claude Agent SDK + `claude setup-token` 인증).

## 주요 기능

- **4개 섹션 분석** — 연구 배경 / 해결하려는 것 / 연구 방법론 / 수식 정리. 핵심 용어 볼드, 결정적 문장 형광펜, 인라인 `$수식$` KaTeX 렌더링
- **원문 PDF 나란히 보기** — 좌측 PDF 뷰어 + 우측 분석 결과 (접기 가능)
- **방법론 시각화** — 원 논문 Figure를 같은 모양으로 재구성한 구조 다이어그램. ◀▶ 스테퍼/자동 재생으로 데이터 토큰이 블록 사이를 흐르고, 🔍 블록 클릭 시 내부 값 시각화(어텐션 히트맵·벡터·확률 분포, 행 클릭 인터랙션). 시각화 예시값은 분석 에이전트가 웹에서 해설 자료를 검색·참고해 생성
- **단계별 비유** — 방법론 각 단계와 수식마다 일상 비유(💡) 포함
- **수식 흐름도** — 수식들이 "왜 이 순서로 필요한지" 로드맵, 노드 클릭 시 해당 수식으로 점프, 원 논문 수식 번호(Eq. N) 병기, 변수별 쉬운 설명 표
- **질문하기(💬)** — 우하단 버튼으로 채팅 패널을 열어 논문에 후속 질문. 에이전트가 필요 시 원문 PDF를 직접 읽고 답변. 추천 질문 칩 제공, 대화는 Firestore에 저장되어 기기 간 공유
- **먼저 보면 좋은 논문** — 선행 논문 3~5편을 실제 arXiv 링크와 함께 추천
- **실시간 진행 표시** — 분석 중 "1-15페이지 읽는 중… / 해설 자료 검색 중…" 단계가 실시간 표시(SSE)
- **캐시 & 히스토리** — 같은 PDF(SHA-256)는 Firestore 캐시에서 즉시 반환. 히스토리에서 재열람·삭제(×)·최신 방식 재분석(🔄)

## 스택

Node.js + Express / 정적 HTML·CSS·JS / KaTeX(CDN) / Firebase Firestore(firebase-admin) / Claude Agent SDK

## 사전 준비

1. **Node.js 22+** (`brew install node@22`)
2. **Claude 인증 토큰** — 터미널에서 `claude setup-token` 실행 → 브라우저 승인 → 발급된 `sk-ant-oat01-...` 토큰을 `.env`의 `CLAUDE_CODE_OAUTH_TOKEN`에 입력. 사용량은 Max 구독 한도에서 차감
3. **poppler** (`brew install poppler`) — 에이전트가 PDF를 이미지로 렌더링해 읽는 데 필요
4. **Firebase 프로젝트 + Firestore**
   - [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성 → Build > Firestore Database > 데이터베이스 만들기
   - 프로젝트 설정(⚙️) > 서비스 계정 > **새 비공개 키 생성** → JSON을 프로젝트 루트에 `serviceAccountKey.json`으로 저장
   - (키가 없으면 메모리 캐시로 폴백 — 재시작 시 소실, 테스트용)

## 설치 및 실행

```bash
git clone https://github.com/iOS-junsoo/paper-reviewer.git
cd paper-reviewer
npm install

cp .env.example .env   # CLAUDE_CODE_OAUTH_TOKEN 입력
# serviceAccountKey.json 배치

npm start
# → http://localhost:3000
```

### .env 항목

| 변수 | 필수 | 설명 |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | ✅ | `claude setup-token`으로 발급한 토큰 |
| `MODEL` | — | 사용할 모델 (기본 `claude-opus-4-8`) |
| `FIREBASE_SERVICE_ACCOUNT` | — | 서비스 계정 키 경로 (기본 `./serviceAccountKey.json`) |
| `PORT` | — | 서버 포트 (기본 3000) |
| `ALLOWED_ORIGIN` | — | 프론트를 다른 도메인에서 서빙할 때만 CORS 허용 |

## 다른 기기에서 접속

서버 맥에서 `npm start` 후:

- **같은 와이파이**: `http://<서버맥 IP>:3000` (IP는 `ipconfig getifaddr en0`)
- **외부 네트워크**: 양쪽 기기에 [Tailscale](https://tailscale.com) 설치 + 같은 계정 로그인 → `http://<기기명>.<테일넷>.ts.net:3000`

분석 히스토리와 채팅 기록은 Firestore 공유라 어디서 접속해도 동일합니다.

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/api/analyze` | PDF 업로드(`pdf` 필드) → SSE 스트림 (progress → result) |
| `POST` | `/api/reanalyze/:hash` | 저장된 원문으로 재분석 → SSE 스트림 |
| `GET` | `/api/history` | 분석 목록 |
| `GET` | `/api/history/:hash` | 저장된 분석 재조회 |
| `DELETE` | `/api/history/:hash` | 분석 기록 삭제 |
| `GET` | `/api/pdf/:hash` | 원문 PDF 서빙 |
| `POST` | `/api/ask/:hash` | 후속 질문 `{question, history}` → `{answer}` |
| `GET` | `/api/chat/:hash` | 저장된 채팅 기록 |

같은 논문의 동시 분석 요청은 409로 거부됩니다 (구독 사용량 이중 소모 방지).

## 동작 구조

1. 업로드된 PDF는 `pdfs/<sha256>.pdf`로 저장 (뷰어·재분석·질문에 재사용, gitignore)
2. 캐시 미스 시 Claude Agent SDK가 헤드리스 Claude Code를 실행 — Read 도구로 PDF를 20페이지씩 비전 분석, WebSearch로 해설 자료 참고 → JSON 스키마로 응답
3. 응답은 방어적 파싱(펜스 제거, 1회 자동 재시도) 후 Firestore `analyses`에 저장 (중첩 배열 제약 때문에 JSON 문자열로 직렬화)
4. 분석 프롬프트(섹션 정의·시각화 스키마)는 [server.js](server.js)의 `SYSTEM_PROMPT`에 있음 — 수정 후 서버 재시작, 기존 논문에는 히스토리의 🔄 재분석으로 적용

## 업로드 제한

Anthropic API의 PDF 제한([공식 문서](https://platform.claude.com/docs/en/build-with-claude/pdf-support), 2026-06 확인)을 가드 기준으로 유지: **23MB / 600페이지**. 초과 시 업로드 단계에서 거부. 상수는 [server.js](server.js)의 `MAX_PDF_BYTES`, `MAX_PDF_PAGES`.

## 보안

- `CLAUDE_CODE_OAUTH_TOKEN`과 Firebase 서비스 계정 키는 `.env` / 로컬 JSON으로만 관리, 프론트에 노출되지 않음
- `.gitignore`: `.env`, `serviceAccountKey.json`, `pdfs/` — 커밋 금지
- 공개 인터넷에 직접 배포하지 말 것 (누구나 분석을 돌려 구독 사용량을 소모할 수 있음). 외부 접속은 Tailscale 사설 네트워크 권장
