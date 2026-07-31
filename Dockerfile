# Paper Reviewer — 서버 배포용 이미지
#
# 런타임 외부 의존:
#  · poppler-utils : pdftoppm / pdftotext / pdftohtml — 그림 크롭·텍스트 추출의 핵심
#  · chromium      : scripts/verify_mviz.js 가 시각화 자가검증에 headless로 띄운다
#                    (server.js가 method 시각화 생성 루프에서 실제로 spawn한다 — 없으면 검증이 전부 실패)
#  · claude CLI    : 별도 설치 불필요. @anthropic-ai/claude-agent-sdk가 플랫폼별 바이너리를
#                    optionalDependencies로 동봉하므로 npm ci가 linux 빌드를 알아서 받는다.
#                    (glibc 이미지 → -linux-x64 / -linux-arm64. musl(alpine) 쓰면 다른 패키지가 필요)
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      chromium \
      ca-certificates \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# 의존성 레이어를 소스와 분리 — 코드만 바뀌면 npm 설치를 건너뛴다
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# DATA_DIR: 업로드 PDF·크롭 캐시·ETA 통계가 쌓이는 곳. 볼륨으로 빼야 재배포해도 논문이 남는다.
# CHROME_PATH: verify_mviz.js가 읽는 변수(기본값은 macOS 경로라 반드시 덮어써야 한다)
ENV DATA_DIR=/data \
    CHROME_PATH=/usr/bin/chromium \
    PORT=3000 \
    HOST=0.0.0.0

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

# 인증 없이 통과시키는 유일한 경로 — 컨테이너 오케스트레이터가 살아있는지 확인한다
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
