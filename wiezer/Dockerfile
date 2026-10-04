ARG BUILD_FROM
FROM $BUILD_FROM

# Python standard library only: no pip packages needed
RUN apk add --no-cache python3

COPY rootfs /
COPY app /app

HEALTHCHECK CMD wget -q -O /dev/null http://127.0.0.1:8099/healthz || exit 1
