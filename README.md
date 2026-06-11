# Paper Reviewer

논문 PDF를 드롭하면 Claude API(Opus)가 논문 전체를 비전으로 읽고 4개 섹션으로 구조화해 정리해주는 로컬 웹앱.
세미나 발표 전 / 논문 정독 전 빠른 구조화 이해 용도.

- **연구 배경** (background) — 분야 상황과 문제의 중요성
- **해결하려는 것** (problem) — 기존 방법의 한계와 논문의 타깃
- **연구 방법론** (method) — 접근 방식을 단계별로
- **수식 정리** (equations) — 핵심 수식 + 기호 설명 (KaTeX 렌더링)

같은 PDF(SHA-256 해시 기준)는 Firestore에 캐시되어 재업로드 시 API 호출 없이 즉시 반환됩니다.

## 스택

Node.js + Express / 정적 HTML·CSS·JS / KaTeX(CDN) / Firebase Firestore(firebase-admin) / Anthropic API

## 사전 준비

1. **Node.js 22+** — 이 머신에는 Homebrew로 설치되어 있습니다 (`node --version` → v22.x).
2. **Claude 인증 토큰** — LLM 호출은 Claude Agent SDK를 사용하므로 **API 크레딧 없이 Max 구독만으로 동작**합니다.
   터미널에서 `claude setup-token` 실행 → 브라우저에서 승인 → 발급된 `sk-ant-oat01-...` 토큰을 `.env`의 `CLAUDE_CODE_OAUTH_TOKEN`에 입력. 사용량은 구독 한도에서 차감됩니다.
3. **Firebase 프로젝트 + Firestore**
   - <https://console.firebase.google.com> 에서 프로젝트 생성
   - **Build > Firestore Database > 데이터베이스 만들기** (테스트 모드면 충분 — 접근은 서버의 admin SDK로만 함)
   - **프로젝트 설정(⚙️) > 서비스 계정 > 새 비공개 키 생성** → JSON 다운로드
   - 받은 JSON을 프로젝트 루트에 `serviceAccountKey.json`으로 저장
   - (키가 없으면 메모리 캐시로 폴백 동작 — 서버 재시작 시 결과가 사라지므로 테스트용으로만)

## 설치 및 실행

```bash
cd ~/Desktop/PAPER_REVIEWER

# 1. 의존성 설치 (이미 되어 있다면 생략 가능)
npm install

# 2. 환경변수 설정
cp .env.example .env
# .env를 열어 CLAUDE_CODE_OAUTH_TOKEN을 `claude setup-token`으로 발급한 토큰으로 교체

# 3. 실행
npm start
# → Paper Reviewer 실행 중: http://localhost:3000 (모델: claude-opus-4-8)
```

브라우저에서 <http://localhost:3000> 접속.

### .env 항목

| 변수 | 필수 | 설명 |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | ✅ | `claude setup-token`으로 발급한 토큰 (Max 구독 인증) |
| `MODEL` | — | 사용할 모델 (기본 `claude-opus-4-8`) |
| `FIREBASE_SERVICE_ACCOUNT` | — | 서비스 계정 키 경로 (기본 `./serviceAccountKey.json`, 없으면 메모리 캐시 폴백) |
| `PORT` | — | 서버 포트 (기본 3000) |

## End-to-End 테스트 방법

1. 테스트용 논문 PDF 하나를 내려받습니다. 예: Attention Is All You Need (15페이지, ~2MB)

   ```bash
   curl -L -o ~/Downloads/attention.pdf https://arxiv.org/pdf/1706.03762
   ```

2. `npm start`로 서버를 띄우고 <http://localhost:3000> 접속.
3. `attention.pdf`를 드롭존에 드래그(또는 "파일 선택").
   - 로딩 표시가 뜨고, Claude가 논문을 페이지 단위로 읽기 때문에 **1~5분** 걸릴 수 있습니다 (15페이지 기준 실측 약 4분 30초).
   - 완료되면 제목/한 줄 요약과 4개 탭(연구 배경 / 해결하려는 것 / 연구 방법론 / 수식 정리)이 표시됩니다.
   - **수식 정리** 탭에서 attention 수식 등이 KaTeX로 렌더링되는지 확인.
4. **캐시 확인**: 같은 PDF를 다시 드롭 → API 호출 없이 즉시 결과가 뜨고 "캐시에서 불러옴" 배지가 표시됩니다.
5. **히스토리 확인**: 하단 "분석 히스토리"에 논문이 나타나고, 클릭하면 저장된 결과가 다시 열립니다.
6. (선택) API를 직접 확인:

   ```bash
   curl -s http://localhost:3000/api/history | python3 -m json.tool
   ```

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/api/analyze` | multipart PDF 업로드(`pdf` 필드) → 분석 결과 JSON |
| `GET` | `/api/history` | 분석한 논문 목록 (제목, one_liner, 타임스탬프, 해시) |
| `GET` | `/api/history/:hash` | 저장된 분석 결과 재조회 |

## LLM 호출 방식

LLM 호출은 **Claude Agent SDK**(`@anthropic-ai/claude-agent-sdk`)를 사용합니다. 업로드된 PDF를 임시 파일로 저장하면 Claude가 Read 도구로 페이지 단위(최대 20페이지씩)로 비전 분석해 JSON을 반환합니다. Max 구독 인증으로 동작하므로 API 크레딧이 필요 없습니다.

> API 크레딧 방식(Messages API + document 블록)으로 되돌리려면: `@anthropic-ai/sdk`의 `messages.create`에 base64 document 블록을 넣는 구현으로 `runAnalysis()`를 교체하고 `.env`에 `ANTHROPIC_API_KEY`를 설정하면 됩니다 (이전 구현의 시스템 프롬프트와 방어적 파싱 로직은 그대로 재사용 가능).

## 업로드 제한

Anthropic API의 PDF 제한([공식 문서](https://platform.claude.com/docs/en/build-with-claude/pdf-support), 2026-06 확인)을 가드 기준으로 유지합니다:

- **파일 크기 23MB** — API 요청 전체 한도 32MB에서 base64 팽창(약 4/3)을 역산한 값
- **600페이지** — 1M 컨텍스트 모델 기준 (200K 컨텍스트 모델은 100페이지)

초과 시 업로드 단계에서 명확한 에러 메시지로 거부됩니다. 상수는 [server.js](server.js)의 `MAX_PDF_BYTES`, `MAX_PDF_PAGES`.

## 보안

- `CLAUDE_CODE_OAUTH_TOKEN`과 Firebase 서비스 계정 키는 `.env` / 로컬 JSON 파일로만 관리하며 프론트엔드에 절대 노출되지 않습니다 (모든 외부 호출은 백엔드에서 수행).
- `.gitignore`에 `.env`, `serviceAccountKey.json` 포함 — 커밋 금지.
