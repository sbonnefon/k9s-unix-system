FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /bin/k8s-unix-system ./cmd/

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=build /bin/k8s-unix-system /usr/local/bin/k8s-unix-system
EXPOSE 8080
ENTRYPOINT ["k8s-unix-system", "--no-browser"]
