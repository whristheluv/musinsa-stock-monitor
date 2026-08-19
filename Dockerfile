FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY monitor.mjs ./

RUN mkdir -p /data
ENV STATE_FILE=/data/state.json \
    HEADLESS=true \
    INTERVAL_SECONDS=300

VOLUME ["/data"]
CMD ["npm", "start"]
