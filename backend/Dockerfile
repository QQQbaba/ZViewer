FROM node:20-alpine

WORKDIR /app

# better-sqlite3 是原生模块，需要在容器内重新编译
# 安装 Python、make、g++ 等构建工具
# ffmpeg：B站视频下载 DASH 模式合并 m4s 流需要（可选，未安装时仅支持 MP4 1080P 下载）
RUN apk add --no-cache python3 make g++ sqlite ffmpeg

# 先复制依赖清单并安装依赖（利用缓存层）
COPY package*.json ./
RUN npm ci

# 复制源码并编译
COPY . .
RUN npm run build

# 创建数据持久化目录（与 docker-compose.yml 中的 volume 挂载点一致）
# 所有用户数据（数据库、上传文件、头像、NMS 媒体）统一存放于此
RUN mkdir -p /app/config

EXPOSE 3333

CMD ["node", "dist/index.js"]
