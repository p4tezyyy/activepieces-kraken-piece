FROM node:22-bookworm-slim AS cli
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
ARG KRAKEN_CLI_VERSION=0.4.1
RUN set -eu; \
    cd /tmp; \
    curl -fsSLO https://github.com/krakenfx/kraken-cli/releases/download/v${KRAKEN_CLI_VERSION}/kraken-cli-x86_64-unknown-linux-gnu.tar.gz; \
    curl -fsSLO https://github.com/krakenfx/kraken-cli/releases/download/v${KRAKEN_CLI_VERSION}/kraken-cli-x86_64-unknown-linux-gnu.tar.gz.sha256; \
    sha256sum -c kraken-cli-x86_64-unknown-linux-gnu.tar.gz.sha256; \
    tar xzf kraken-cli-x86_64-unknown-linux-gnu.tar.gz; \
    install -m 0755 kraken-cli-x86_64-unknown-linux-gnu/kraken /usr/local/bin/kraken; \
    rm -rf /tmp/kraken-cli-x86_64-unknown-linux-gnu*; \
    kraken --version
WORKDIR /app
COPY work/test-lib/cli.js work/test-lib/client.js ./
COPY src/catalog.json ./
COPY docker/bridge.cjs ./
ENV KRAKEN_CLI_PATH=/usr/local/bin/kraken
ENV KRAKEN_PIECE_HOME=/var/lib/kraken-piece
CMD ["node", "bridge.cjs"]

FROM activepieces/activepieces@sha256:65ea85f5e7ea236416b342eef0d2dbade8da51247aaea495d191eb027095805a AS activepieces
COPY dist/package /opt/kraken-piece
