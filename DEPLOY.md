# 서버 배포 가이드

이 맥이 꺼져 있어도 다른 기기(맥·아이패드·폰)에서 접속해 쓰기 위한 배포 절차다.

---

## 0. 먼저 알아둘 것

**계정 전환 기능은 서버에서 동작하지 않는다.**
계정 전환은 서버 머신에 브라우저 OAuth 창을 띄우고 macOS 키체인을 바꾸는 방식이다.
Linux 서버에는 화면도 키체인도 없다. 서버에서는 `CLAUDE_CODE_OAUTH_TOKEN` 하나로만 인증하며,
설정 화면은 전환 UI 대신 안내 문구를 보여준다. 계정을 바꾸려면 새 토큰을 발급해 `.env`를
교체하고 재시작해야 한다.

**구독 세션 한도는 서버에서도 그대로다.**
서버를 24시간 켜둔다고 분석을 더 돌릴 수 있는 게 아니다. Max 구독의 세션 한도는 계정 단위라
한도에 걸리면 리셋될 때까지 기다려야 하는 건 지금과 같다.

**공개 노출에는 비밀번호가 반드시 필요하다.**
`APP_PASSWORD`를 비워두면 서버는 로컬(127.0.0.1) 요청만 받고 외부 요청은 전부 503으로 막는다.
이건 안전장치이지 버그가 아니다. 이 값이 없으면 아무나 이 서버의 Claude 구독으로 분석을 돌릴 수 있다.

---

## 1. 서버 고르기

이 앱은 LLM 응답을 기다리는 시간이 대부분이라 CPU를 많이 쓰지 않는다.
다만 PDF 크롭(pdftoppm)과 시각화 검증(headless Chromium)이 순간적으로 메모리를 쓴다.

| 항목 | 최소 | 권장 |
|---|---|---|
| RAM | 2GB | **4GB** (Chromium + Node 동시 실행 여유) |
| vCPU | 1 | 2 |
| 디스크 | 25GB | **60GB** (현재 PDF 472MB + Docker 이미지 ~1.5GB + 증가분) |
| 아키텍처 | x86_64 / ARM64 둘 다 가능 | — |

접속 지연은 중요하지 않다(분석에 수 분이 걸리므로 200ms 차이는 체감되지 않는다).
비용 위주로 골라도 무방하며, 한국 리전이 있는 곳을 원하면 Vultr·AWS Lightsail 서울 리전이 있다.

**필요한 것 하나 더**: 도메인. HTTPS 인증서 자동 발급에 쓰인다.
DNS A 레코드가 서버 IP를 가리키도록 미리 설정해 둔다.

---

## 2. 내 Mac에서: 토큰 발급

서버에는 브라우저가 없으므로 토큰은 여기서 만든다.

```bash
claude setup-token
```

출력된 `sk-ant-oat01-...` 값을 복사해 둔다. 3단계 `.env`에 넣는다.

> 이 토큰은 구독 계정 자격증명이다. 서버에 넣는 순간 그 서버를 신뢰하는 것이므로,
> 남과 공유하는 머신에는 두지 않는다.

---

## 3. 서버에서: 설치

### 3-1. Docker 설치

```bash
curl -fsSL https://get.docker.com | sh
```

### 3-2. 코드 올리기

내 Mac에서 rsync로 보낸다. (GitHub에 올리지 않아도 된다)

```bash
rsync -avz --exclude node_modules --exclude pdfs --exclude .git \
  --exclude .env --exclude serviceAccountKey.json \
  ~/Desktop/PAPER_REVIEWER/ 서버주소:~/paper-reviewer/
```

### 3-3. `.env` 작성

서버에서:

```bash
cd ~/paper-reviewer
cp .env.example .env
nano .env
```

최소한 이 네 개를 채운다:

| 변수 | 값 |
|---|---|
| `APP_PASSWORD` | `openssl rand -base64 24`로 만든 값 |
| `CLAUDE_CODE_OAUTH_TOKEN` | 2단계에서 복사한 토큰 |
| `DOMAIN` | 준비한 도메인 (예: `paper.example.com`) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | `serviceAccountKey.json` 내용 전체를 작은따옴표로 감싸 한 줄로 |

Firestore 키를 한 줄로 만들려면 내 Mac에서:

```bash
python3 -c "import json;print(\"FIREBASE_SERVICE_ACCOUNT_JSON='\"+json.dumps(json.load(open('serviceAccountKey.json')))+\"'\")"
```

출력된 줄을 통째로 서버 `.env`에 붙여넣는다.

### 3-4. 실행

```bash
docker compose up -d --build
```

첫 빌드는 몇 분 걸린다(Chromium 설치 포함). 이후 `https://내도메인`으로 접속하면 로그인 화면이 뜬다.

---

## 4. 기존 논문 원본 옮기기

분석 결과·폴더·메모·채팅은 **Firestore에 있어 자동으로 따라온다**. 옮길 것은 PDF 원본뿐이다.
이걸 옮기지 않으면 기존 논문의 뷰어·그림 크롭·재분석이 동작하지 않는다.

```bash
# 내 Mac에서 — 서버의 임시 위치로 전송 (472MB)
rsync -avz --progress ~/Desktop/PAPER_REVIEWER/pdfs/ 서버주소:~/pdfs-transfer/
```

```bash
# 서버에서 — 컨테이너 볼륨(/data)으로 복사
docker compose cp ~/pdfs-transfer/. app:/data/pdfs/
docker compose restart app
rm -rf ~/pdfs-transfer
```

---

## 5. 확인

```bash
docker compose ps                    # 두 컨테이너 모두 running / healthy
docker compose logs -f app           # "Paper Reviewer 실행 중 ... 인증: 비밀번호"
curl -s https://내도메인/healthz     # ok
```

브라우저에서 접속 → 비밀번호 입력 → 히스토리에 기존 논문들이 보이면 성공.
논문 하나를 열어 그림 해설 탭까지 확인하면 PDF 이전까지 검증된 것이다.

---

## 6. 운영

**코드 업데이트** — 내 Mac에서 rsync 후 서버에서:

```bash
docker compose up -d --build
```

**로그 보기**

```bash
docker compose logs -f app
```

**백업** — Firestore는 구글이 보관하므로 PDF 볼륨만 챙기면 된다.

```bash
docker run --rm -v paper-reviewer_paper_data:/data -v $(pwd):/backup \
  alpine tar czf /backup/pdfs-$(date +%F).tar.gz -C /data pdfs
```

**Claude 토큰 교체** (만료되거나 계정을 바꿀 때)

```bash
# 내 Mac에서 claude setup-token → 새 토큰 복사
nano .env                # CLAUDE_CODE_OAUTH_TOKEN 교체
docker compose up -d     # 재시작
```

---

## 7. Docker 없이 돌리는 경우

systemd로 직접 띄우려면 서버에 다음이 필요하다.

```bash
sudo apt install -y nodejs npm poppler-utils chromium fonts-noto-cjk
```

그리고 `.env`에 아래를 추가한다. (Docker 이미지는 이 값들을 이미 설정해 둔다)

```
DATA_DIR=/var/lib/paper-reviewer
CHROME_PATH=/usr/bin/chromium
TRUST_PROXY=1
```

`poppler-utils`가 없으면 그림 크롭이, `chromium`이 없으면 방법론 시각화 자가검증이 조용히 실패한다.
