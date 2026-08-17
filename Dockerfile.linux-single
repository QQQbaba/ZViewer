FROM debian:bullseye-slim

# procps: 提供 pgrep，供 Docker 更新脚本在 pidfile 缺失时回退定位后端进程
# xz-utils: 提供 xz 解压支持，tar -xf *.tar.xz 需要 xz 命令
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    procps \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制单文件产物（统一端口：后端托管前端静态文件，无需前端 exe）
COPY dist/linux/zviewer-backend .
COPY dist/linux/zviewer-cert .
COPY dist/linux/start.sh .
COPY dist/linux/.env .
COPY dist/linux/package.json .
COPY dist/linux/frontend/dist ./frontend/dist/

# 创建运行时数据目录
RUN mkdir -p config/ssl config/uploads config/media log

# 暴露端口
# 3333: 统一端口 - 后端 REST API + WebSocket (Socket.IO) + 前端静态文件 + /live HTTP-FLV 代理
# 3334: RTMP 推流端口 (OBS 连接)
EXPOSE 3333 3334

# Entrypoint（HTTP 模式，仅启动后端，由后端统一提供 API + 前端静态文件）
COPY docker/entrypoint-linux-single.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]
