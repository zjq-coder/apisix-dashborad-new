FROM node:24-bookworm-slim AS frontend
WORKDIR /src
COPY package*.json ./
COPY web/package*.json ./web/
RUN npm ci
COPY web ./web
RUN npm run build

FROM golang:1.27.3-bookworm AS backend
WORKDIR /src
COPY server/go.* ./
RUN go mod download
COPY server ./
RUN CGO_ENABLED=0 go build -trimpath -o /dashboard ./cmd/dashboard

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=backend /dashboard /app/dashboard
COPY --from=frontend /src/web/dist /app/web
ENV LISTEN_ADDR=0.0.0.0:8080 STATIC_DIR=/app/web
EXPOSE 8080
ENTRYPOINT ["/app/dashboard"]
