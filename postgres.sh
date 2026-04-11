 docker run -d \
    --name deepfeed-postgres-demo \
    -e POSTGRES_USER=deepfeedai \
    -e POSTGRES_PASSWORD=deepfeedai2026 \
    -e POSTGRES_DB=deepfeedai \
    -p 5001:5432 \
    postgres:16
