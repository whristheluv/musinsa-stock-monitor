# 무신사 재입고 모니터

무신사 상품 페이지를 주기적으로 확인하고, 이전 확인에서 품절이었던 상품/옵션이 구매 가능해질 때만 알림을 보냅니다.

기본 대상은 아래 상품입니다.

- https://www.musinsa.com/products/6990137

## 동작 방식

1. Playwright의 Chromium으로 상품 페이지를 엽니다.
2. 페이지의 옵션 UI, 내장 JSON/JSON-LD, 구매 버튼을 함께 확인합니다.
3. 첫 실행 결과를 `state.json`에 기준 상태로 저장합니다.
4. 이후 품절 → 구매 가능 변화가 발생했을 때만 Telegram 또는 Discord/Slack으로 알립니다.

첫 실행부터 이미 재고가 있을 때도 알림을 받고 싶으면 `.env`의 `NOTIFY_ON_FIRST_AVAILABLE=true`로 바꾸세요.

## 가장 간단한 실행 방법: Docker

필요한 것: Docker Desktop(Windows/macOS) 또는 Docker Engine(Linux)

```bash
cp .env.example .env
```

`.env`에 아래 알림 방식 중 하나를 설정한 뒤 실행합니다.

```bash
docker compose up -d --build
docker compose logs -f
```

중지/재시작:

```bash
docker compose stop
docker compose start
```

업데이트 후 다시 빌드:

```bash
docker compose up -d --build
```

## 완전 무료로 컴퓨터를 꺼도 실행: GitHub Actions

이 방식은 별도 서버와 Docker가 필요 없습니다. 공개 GitHub 저장소의 표준 Actions 실행은 무료이며, 최소 확인 주기는 5분입니다. 예약 실행은 혼잡할 때 지연될 수 있습니다.

1. GitHub에서 새 **Public** 저장소를 만듭니다. `Add a README` 등 초기화 옵션은 선택하지 않습니다.
2. 이 폴더의 **내용물 전체**(`.github` 숨김 폴더 포함)를 저장소에 업로드합니다. 압축파일 자체를 올리는 것이 아닙니다.
3. 저장소의 `Settings` → `Secrets and variables` → `Actions`로 이동합니다.
4. `New repository secret`을 눌러 다음 Secret을 만듭니다.

```text
Name: DISCORD_WEBHOOK_URL
Secret: Discord에서 복사한 웹후크 URL
```

5. 저장소의 `Actions` 탭 → `무신사 재입고 확인` → `Run workflow`를 눌러 최초 테스트를 실행합니다.
6. 초록색 체크가 뜨면 이후 약 5분 간격으로 자동 실행됩니다. 컴퓨터를 꺼도 계속 작동합니다.

첫 실행은 기준 상태만 저장하므로 테스트 메시지를 보내지 않습니다. Discord 웹후크 자체를 테스트하려면 Docker/로컬 실행의 `npm run test-notify`를 사용하거나 Discord의 웹후크 도구를 사용하세요.

주의:

- 웹후크 URL을 파일이나 공개 저장소에 직접 적지 말고 반드시 GitHub Secret에 넣으세요.
- 공개 저장소는 60일 동안 아무 활동이 없으면 예약 워크플로가 자동 중지될 수 있습니다. 그때 Actions 탭에서 다시 활성화하면 됩니다.
- 공개 저장소의 표준 러너는 무료지만, 비공개 저장소는 월별 무료 실행시간 한도가 적용됩니다.
- GitHub Actions는 정확히 5분마다 실행된다는 보장이 없으며 혼잡 시 늦어질 수 있습니다.

## 알림 설정

### Telegram

1. Telegram에서 `@BotFather`에게 `/newbot`을 보내 봇을 만들고 토큰을 받습니다.
2. 생성한 봇과 대화를 열고 아무 메시지나 한 번 보냅니다.
3. 브라우저에서 `https://api.telegram.org/bot<토큰>/getUpdates`를 열어 `chat.id` 값을 확인합니다.
4. `.env`에 입력합니다.

```dotenv
TELEGRAM_BOT_TOKEN=123456789:여기에_봇_토큰
TELEGRAM_CHAT_ID=123456789
```

토큰은 비밀번호처럼 취급하고 GitHub 등에 올리지 마세요.

### Discord

Discord 채널 설정 → 연동 → 웹후크 → 새 웹후크에서 URL을 복사합니다.

```dotenv
WEBHOOK_URL=https://discord.com/api/webhooks/...
WEBHOOK_KIND=discord
```

### Slack

Slack Incoming Webhook URL을 발급받아 입력합니다.

```dotenv
WEBHOOK_URL=https://hooks.slack.com/services/...
WEBHOOK_KIND=slack
```

설정이 없으면 재입고 내용을 콘솔에만 출력합니다.

## 알림 테스트

```bash
docker compose run --rm musinsa-stock-monitor npm run test-notify
```

## Docker 없이 실행

필요한 것: Node.js 20 이상

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm run test-notify
npm run once
npm start
```

`npm run once`는 한 번만 확인하고 종료합니다. `npm start`는 계속 실행합니다.

## 1분마다 확인하려면

`.env`에서 다음처럼 설정합니다.

```dotenv
INTERVAL_SECONDS=60
```

단, 짧은 간격은 무신사의 접근 제한을 유발할 수 있습니다. 처음에는 180~300초를 권장합니다. 접근 제한 오류가 반복되면 간격을 늘리세요. 이 스크립트는 CAPTCHA 우회나 차단 회피를 시도하지 않습니다.

## 서버에서 계속 돌리기

24시간 실행하려면 집 PC를 계속 켜 두거나, 저렴한 VPS/홈서버/NAS에서 Docker로 실행하세요. Docker Compose의 `restart: unless-stopped` 설정 때문에 서버가 재부팅되어도 자동으로 다시 시작합니다.

무료 GitHub Actions는 보통 1분 주기 감시에 적합하지 않습니다. 실행 지연과 최소 스케줄 간격이 있고, 상태 파일을 별도로 영속화해야 하기 때문입니다.

## 문제 해결

- `재고 상태를 판별하지 못했습니다`: 무신사 페이지 구조가 바뀌었거나 접근이 제한된 경우입니다. `HEADLESS=false`로 실행해 화면을 확인하고, `INTERVAL_SECONDS`를 늘려 보세요.
- `무신사가 자동화 접근을 제한했습니다`: 확인 주기를 늘리세요. 반복 재시도나 CAPTCHA 우회는 하지 마세요.
- 옵션이 표시되지 않음: `OPEN_OPTION_PANEL=true`인지 확인하세요.
- 알림이 오지 않음: 먼저 `npm run test-notify` 또는 Docker의 알림 테스트 명령을 실행하세요.
- 첫 실행 알림 없음: 기본 동작입니다. 첫 실행은 기준 상태만 저장합니다.

## 주의사항

- 무신사의 이용약관과 자동화 관련 정책을 확인하고 준수하세요.
- 너무 잦은 요청은 서비스에 부담을 주거나 접속 제한을 유발할 수 있습니다.
- 페이지 구조가 변경되면 `extractSnapshot()`의 선택자/판별 로직을 조정해야 할 수 있습니다.
- 자동 구매 기능은 포함하지 않았습니다.
