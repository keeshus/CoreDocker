FROM alpine:latest
RUN apk add --no-cache keepalived iproute2
ENTRYPOINT ["keepalived", "--dont-fork", "--log-console"]
