FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY app.js engine.js runtime.js repository-adapter.js python-examples.js index.html server.js styles.css worker.js ./
COPY bin ./bin
COPY docs ./docs
COPY examples ./examples
COPY helm ./helm
COPY migrations ./migrations
COPY patchproof.yml ./
COPY saas ./saas
COPY sandbox ./sandbox
COPY LICENSE README.md SECURITY.md CHANGELOG.md action.yml ./

RUN useradd --system --create-home --uid 10001 patchproof \
  && chown -R patchproof:patchproof /app

USER patchproof
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
