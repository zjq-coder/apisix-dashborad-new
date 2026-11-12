ARG APISIX_IMAGE=apache/apisix:3.19.0-debian
FROM ${APISIX_IMAGE} AS gateway

# git applies the contextual patch at build time; no build tools enter the gateway.
FROM golang:1.27.3-bookworm AS patcher
WORKDIR /overlay
COPY cold-worker.patch SHA256SUMS /fix/
RUN --mount=from=gateway,source=/usr/local/apisix,target=/base \
    set -eu; \
    if grep -Eq 'VERSION[[:space:]]*=[[:space:]]*"3\.19\.0"' /base/apisix/core/version.lua; then \
        (cd /base && sha256sum -c /fix/SHA256SUMS); \
        awk '{print $2}' /fix/SHA256SUMS | while read -r file; do \
            mkdir -p "$(dirname "$file")"; cp "/base/$file" "$file"; \
        done; \
        git apply /fix/cold-worker.patch; \
    fi

FROM gateway
COPY --from=patcher /overlay/ /usr/local/apisix/
