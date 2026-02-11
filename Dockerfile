FROM --platform=$BUILDPLATFORM node:jod-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY index.js ./

# Prune dev dependencies
RUN npm prune --omit=dev

# Runtime stage
FROM node:jod-alpine

# Build arguments
ARG BUILD_ARCH=amd64
ARG S6_OVERLAY_VERSION=3.2.0.0
ARG BASHIO_VERSION=0.16.2

# Environment
ENV LANG=C.UTF-8
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2
ENV S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0

# Install base packages
RUN apk add --no-cache \
    bash \
    curl \
    jq \
    mosquitto-clients \
    tzdata \
    && rm -rf /var/cache/apk/*

# Install s6-overlay
RUN case "${BUILD_ARCH}" in \
        amd64)   S6_ARCH="x86_64" ;; \
        aarch64) S6_ARCH="aarch64" ;; \
        armv7)   S6_ARCH="arm" ;; \
        armhf)   S6_ARCH="armhf" ;; \
        i386)    S6_ARCH="i686" ;; \
        *)       echo "Unsupported architecture: ${BUILD_ARCH}"; exit 1 ;; \
    esac \
    && curl -L -s "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" | tar Jxpf - -C / \
    && curl -L -s "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" | tar Jxpf - -C /

# Install bashio
RUN curl -L -s "https://github.com/hassio-addons/bashio/archive/v${BASHIO_VERSION}.tar.gz" | tar -xzf - \
    && mv "bashio-${BASHIO_VERSION}/lib" /usr/lib/bashio \
    && ln -s /usr/lib/bashio/bashio /usr/bin/bashio \
    && rm -rf "bashio-${BASHIO_VERSION}"

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/index.js ./

# Copy init scripts (strip Windows CRLF line endings as safety net)
COPY init/services.d/ /etc/services.d/
RUN find /etc/services.d/ -type f -exec sed -i 's/\r$//' {} + \
    && chmod +x /etc/services.d/*/run /etc/services.d/*/finish

# Labels
LABEL \
    io.hass.name="Acura EV MQTT" \
    io.hass.description="Acura EV vehicle data to MQTT bridge" \
    io.hass.type="addon" \
    io.hass.version="1.0.2" \
    org.opencontainers.image.title="Acura EV MQTT" \
    org.opencontainers.image.description="Bridges Acura EV vehicle data to MQTT" \
    org.opencontainers.image.source="https://github.com/tsightler/acura-ev" \
    org.opencontainers.image.licenses="MIT"

# s6-overlay entrypoint
ENTRYPOINT ["/init"]
