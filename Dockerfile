FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -trimpath -o /out/radar ./cmd/radar

FROM alpine:3.22
RUN apk add --no-cache ca-certificates openssh-client libvirt-client \
    && addgroup -S -g 10001 radar \
    && adduser -S -u 10001 -G radar radar
WORKDIR /app
COPY --from=server /out/radar /usr/local/bin/radar
COPY --from=web /src/web/dist /app/web/dist
USER radar
ENV RADAR_LISTEN=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["radar"]
CMD ["serve"]
