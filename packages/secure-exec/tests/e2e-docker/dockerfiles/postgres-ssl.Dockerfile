FROM postgres:16-alpine
# Generate self-signed certificate for SSL testing
RUN apk add --no-cache openssl \
 && openssl req -new -x509 -days 365 -nodes \
    -out /var/lib/postgresql/server.crt \
    -keyout /var/lib/postgresql/server.key \
    -subj "/CN=localhost" \
 && chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key \
 && chmod 600 /var/lib/postgresql/server.key
EXPOSE 5432
