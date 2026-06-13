FROM python:3.11-slim
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ ./server/
RUN mkdir -p /data/storage
ENV CROWSYNC_PORT=8001
ENV CROWSYNC_STORAGE_ROOT=/data/storage
ENV CROWSYNC_DB_PATH=/data/crowsync.db
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')"
CMD ["python", "-m", "server.main"]
