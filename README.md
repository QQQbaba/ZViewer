# ZViewer

> 多人同步追番、观影与远程共享平台。

ZViewer 让一群人在不同地点也能像坐在一起一样看番、看电影。房主控制播放进度，观众实时跟随；支持 Bilibili、WebDAV、FTP、OpenList、MP4 直链等多种视频源，并内置屏幕共享、弹幕、评论等互动能力。

---

## 目录

- [功能特性](#功能特性)
- [整体架构](#整体架构)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [本地开发](#本地开发)
- [生产部署](#生产部署)
- [环境变量](#环境变量)
- [权限模型](#权限模型)
- [视频源](#视频源)
- [ZViewerCLI 本地代理](#zviewercli-本地代理)
- [常见问题](#常见问题)

---

## 功能特性

### 一起看房间

- 创建或加入房间，与好友同步观看。
- 房主拥有播放控制权：播放、暂停、跳转、倍速。
- 观众可申请控制，房主确认后执行。
- 播放记忆：房主短暂断线后，由服务器继续广播当前状态。

### 多源视频解析

| 来源 | 说明 |
|---|---|
| **Bilibili** | 解析 BV 号或视频链接，支持 DASH 音视频合并、清晰度切换、大会员凭证 |
| **ani-subs 订阅** | 自定义 JSON 订阅源，聚合 web-selector 与 RSS 番剧资源 |
| **Kazumi 规则** | 导入 Kazumi 插件规则，使用 XPath/CSS 选择器解析第三方站点 |
| **MP4 直链** | 直接播放可访问的 MP4 视频地址 |
| **WebDAV** | 挂载 WebDAV 服务器，浏览并播放其中的视频文件 |
| **FTP** | 挂载 FTP 服务器，浏览并播放其中的视频文件 |
| **OpenList** | 挂载 OpenList 服务，浏览并播放其中的视频文件 |

### 实时互动

- 评论面板：房间内实时收发文字评论。
- 弹幕系统：支持 Bilibili 官方弹幕、DandanPlay 弹幕、自定义弹幕轨道。
- 播放状态同步：房主操作实时同步给所有观众。
- 观众申请：观众可申请跳转进度或暂停。

### 屏幕共享与推流

- 基于 WebRTC 的屏幕共享，分享端可共享屏幕或视频画面。
- OBS RTMP 推流支持，配合 Node Media Server 提供 HTTP-FLV 拉流。

### 主题系统

- Material You (Monet) 动态主题，从壁纸提取色彩生成完整色板。
- 明暗主题切换、自定义背景、玻璃拟态 UI、减少动效模式。

---

## 整体架构

```text
┌─────────────────────────────────────────────────────────────────┐
│                         用户浏览器                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  React 前端   │  │ Socket.IO    │  │  WebRTC 屏幕共享      │  │
│  │  播放器引擎   │  │ 实时状态同步  │  │  P2P 数据传输         │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
└─────────┼─────────────────┼─────────────────────┼──────────────┘
          │                 │                     │
          │ HTTP / WS       │ Socket.IO           │ Signaling
          ▼                 ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                         ZViewer 后端                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Express API  │  │ Socket.IO    │  │ TypeORM + better-    │  │
│  │ 路由层        │  │ 事件处理器    │  │ sqlite3 数据持久化    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                     │              │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌──────────▼───────────┐  │
│  │ Bilibili 解析 │  │ 房间/同步播放 │  │ 挂载源 (WebDAV/FTP/  │  │
│  │ 弹幕/评论    │  │ 观众管理     │  │ OpenList/ani-subs)   │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
          ▲
          │ WebSocket + HTTP API
          │
┌─────────────────────────────────────────────────────────────────┐
│                     ZViewerCLI（可选本地代理）                    │
│  本地 Go 服务，使用用户自己的 Bilibili Cookie 解析高画质地址，      │
│  并代理视频流请求，绕过浏览器 CORS 与 CDN 防盗链限制。             │
└─────────────────────────────────────────────────────────────────┘
```

核心数据流：

1. 房主在房间中选择视频源，后端解析出真实播放地址。
2. 房主播放器加载视频，并将播放状态通过 Socket.IO 广播到房间。
3. 观众前端收到状态后，同步加载相同视频，播放器根据房主心跳不断校准进度。
4. 若启用 ZViewerCLI，视频解析与流代理由本地 CLI 完成，后端仅做房间状态同步。

---

## 技术栈

### 前端

- React 18 + TypeScript
- Vite 8 构建工具
- Tailwind CSS 原子化样式
- Zustand 状态管理
- Socket.IO Client 实时通信
- React Router v6 路由
- Material Color Utilities 主题色彩生成
- dash.js / flv.js / hls.js / ArtPlayer 播放器引擎
- danmaku 弹幕引擎

### 后端

- Node.js + TypeScript
- Express 5 Web 框架
- Socket.IO 实时通信
- TypeORM + better-sqlite3 数据持久化（可选 PostgreSQL）
- node-media-server 流媒体推送
- bcryptjs 密码加密
- JSON Web Token 鉴权

### 部署

- Docker + Docker Compose
- Nginx 反向代理
- 跨平台一键启动脚本（PowerShell / Bash）

---

## 项目结构

```text
ZViewer/
├── frontend/                # 前端 (React + Vite)
│   ├── src/
│   │   ├── components/      # 通用 UI 组件
│   │   ├── modules/         # 业务模块
│   │   │   ├── room/        # 房间与一起看
│   │   │   ├── sync-playback/   # 同步播放核心
│   │   │   ├── player/      # 播放器引擎与缓冲
│   │   │   ├── bilibili/    # Bilibili 解析
│   │   │   ├── screen-sharing/  # 屏幕共享
│   │   │   ├── mounts/      # 挂载点管理
│   │   │   ├── webdav/      # WebDAV 浏览
│   │   │   ├── ftp/         # FTP 浏览
│   │   │   ├── openlist/    # OpenList 浏览
│   │   │   └── admin/       # 管理后台
│   │   ├── pages/           # 页面组件
│   │   ├── store/           # Zustand 状态
│   │   ├── hooks/           # 通用 Hooks
│   │   └── lib/             # 工具库
│   └── nginx.conf           # 生产 Nginx 配置
├── backend/                 # 后端 (Express + TypeORM)
│   ├── src/
│   │   ├── entities/        # 数据库实体
│   │   ├── routes/          # HTTP 路由
│   │   ├── services/        # 业务服务
│   │   ├── modules/         # Socket.IO 事件模块
│   │   ├── middleware/      # 中间件
│   │   └── utils/           # 工具
│   └── Dockerfile
├── docker-compose.yml       # 生产编排
├── start-prod.ps1           # Windows 一键启动脚本
├── start-prod.sh            # Linux/macOS 一键启动脚本
├── prepare-cli-build.ps1    # 准备 ZViewerCLI 构建源
└── package.json             # npm workspaces 根配置
```

---

## 快速开始

### 默认管理员

系统首次启动时自动创建超级管理员账号：

- 用户名：`root`
- 密码：`root`

> 生产环境部署后请立即修改默认密码。

### Docker 一键启动

```bash
# 1. 复制环境变量模板
cp .env.example .env

# 2. 修改 JWT 密钥（必须）
# 编辑 .env，将 JWT_ACCESS_SECRET 和 JWT_REFRESH_SECRET 替换为强随机字符串

# 3. 构建并启动
docker compose up -d --build

# 4. 查看日志
docker compose logs -f
```

启动后访问：

- 前端：http://localhost
- 后端 API：http://localhost/api
- 健康检查：http://localhost/health

停止服务：

```bash
docker compose down          # 保留数据
docker compose down -v       # 同时删除数据卷
```

---

## 本地开发

项目使用 npm workspaces，根目录统一安装依赖。

```bash
# 安装全部依赖
npm install

# 同时启动前后端开发服务
npm run dev

# 或分别启动
npm run dev:backend
npm run dev:frontend
```

开发端口：

- 前端：http://localhost:5174
- 后端：http://localhost:3333

前端开发时默认通过 Vite 代理连接后端，无需额外配置 `VITE_API_URL`。

---

## 生产部署

### 一键启动脚本（推荐）

项目根目录提供跨平台启动脚本，无需提前执行 `npm install` 或 `npm run build`，脚本会自动检测并按需安装依赖、构建产物、启动服务。

#### Windows (PowerShell)

```powershell
.\start-prod.ps1 start                # 一键启动（自动安装+构建+启动）
.\start-prod.ps1 stop                 # 停止
.\start-prod.ps1 restart              # 重启（跳过构建，加快重启）
.\start-prod.ps1 status               # 查看状态
.\start-prod.ps1 logs backend         # 查看后端日志
.\start-prod.ps1 logs frontend        # 查看前端日志
```

双击 `start-prod.bat` 可打开交互菜单。

#### Linux / macOS

```bash
./start-prod.sh start                 # 一键启动（自动安装+构建+启动）
./start-prod.sh stop                  # 停止
./start-prod.sh restart               # 重启（跳过构建，加快重启）
./start-prod.sh status                # 查看状态
./start-prod.sh logs backend          # 查看后端日志
./start-prod.sh logs frontend         # 查看前端日志
```

#### 常用选项

| 选项 | PowerShell | Bash | 说明 |
|---|---|---|---|
| 跳过构建 | `-SkipBuild` | `--skip-build` | 仅使用已有 `dist/` 产物启动 |
| 智能跳过 | 默认行为 | `--auto-build`（默认） | 源码未修改时自动跳过构建 |
| 强制构建 | — | `--no-auto-build` | 禁用智能跳过，强制构建 |
| 重装依赖 | `-ForceDeps` | `--force-deps` | 强制重新安装依赖 |
| 后端端口 | `-Port <int>` | `-p, --port <int>` | 默认 3333 |
| 前端端口 | `-FrontendPort <int>` | `--frontend-port <int>` | 默认 4173 |
| 数据库 | `-Database <url>` | `-d, --database <url>` | 覆盖 `DATABASE_URL` |

#### 启动流程

执行 `start` 时脚本自动完成：

1. 检查 Node.js / npm 环境。
2. 检查依赖：`node_modules` 缺失则自动安装；`-ForceDeps` 强制重装。
3. 智能构建：产物缺失或源码已更新时自动构建；源码未修改时跳过。
4. 校验后端产物与前端产物。
5. 后台启动后端 API 与前端静态服务。

PID 写入 `.prod.pids.json`，日志写入 `backend-prod.log` 与 `frontend-prod.log`。

#### 云服务器部署

1. 准备 Linux 云服务器（Ubuntu 22.04/24.04 推荐），开放端口 80、443。
2. 安装 Docker 与 Docker Compose。
3. 上传代码并配置 `.env`：

```bash
cp .env.example .env
# 至少修改 JWT_ACCESS_SECRET、JWT_REFRESH_SECRET、CORS_ORIGIN
```

4. 启动服务：

```bash
docker compose pull
docker compose up -d --build
```

5. 配置 SSL 证书（推荐 certbot + Let's Encrypt），修改 `frontend/nginx.conf` 增加 443 监听，并在 `docker-compose.yml` 中挂载证书目录。

> 详见原配置文件中 nginx 与 certbot 示例。

---

## 环境变量

### 后端

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 后端服务端口 | `3333` |
| `HOST` | 监听地址，`::` 表示 IPv4/IPv6 双栈 | `::` |
| `NODE_ENV` | 运行环境 | `production` |
| `DATABASE_URL` | SQLite 文件路径或 PostgreSQL 连接串 | `/app/data/dev.sqlite` |
| `CONFIG_DIR` | 数据根目录 | `<project-root>/config` |
| `CORS_ORIGIN` | CORS 允许来源，多个用逗号分隔 | `*` |
| `JWT_ACCESS_SECRET` | Access Token 密钥（生产必须修改） | — |
| `JWT_REFRESH_SECRET` | Refresh Token 密钥（生产必须修改） | — |
| `JWT_ACCESS_EXPIRES_IN` | Access Token 有效期 | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh Token 有效期 | `7d` |

### 前端

| 变量 | 说明 | 默认值 |
|---|---|---|
| `VITE_API_URL` | API / Socket.IO 基础地址，留空时使用 `window.location.origin` | — |
| `VITE_FLV_BASE_URL` | OBS 推流模式 HTTP-FLV 拉流基础地址 | — |

### 推流服务（可选）

| 变量 | 说明 | 默认值 |
|---|---|---|
| `RTMP_PORT` | RTMP 推流端口 | `3334` |
| `HTTP_FLV_PORT` | HTTP-FLV 拉流端口 | `3335` |

---

## 权限模型

系统采用四层权限模型：

| 角色 | 说明 | 权限 |
|---|---|---|
| `root` | 超级管理员 | 创建/控制/删除任意房间，审核用户，修改角色 |
| `admin` | 管理员 | 创建房间并完全控制自己的房间，不能删除他人房间 |
| `user` | 普通用户 | 加入房间观看、发送评论与弹幕，无法创建房间 |
| `guest` | 游客 | 加入房间观看、发送评论与弹幕，无法创建房间 |

### 注册审核

- 新用户注册后角色为 `guest`，状态为 `pending`。
- 仅 `root` 可在「权限管理」页面审核通过用户，通过后升级为 `user`。

---

## 视频源

### Bilibili

解析 BV 号或视频链接，支持 DASH 音视频合并播放、清晰度切换、大会员专享内容。可在管理后台配置 Bilibili 登录凭证以获取大会员清晰度。

### ani-subs 订阅

通过自定义 JSON 订阅源聚合番剧资源。在「权限管理 → 基础设置」中可在线浏览 GitHub 仓库并快速导入订阅源地址。

### Kazumi 规则

导入 Kazumi 插件规则，使用 XPath/CSS 选择器解析第三方站点资源。同样支持从 GitHub 仓库在线导入。

### 直链与挂载

- **MP4 直链**：直接输入可访问的 MP4 视频地址播放。
- **WebDAV / FTP / OpenList**：在挂载点管理中保存连接配置，浏览目录并播放视频文件。

### GitHub CDN 加速

内置 CDN 代理 `https://github.cdn.zero251.xyz/`，ani-subs 订阅、Kazumi 规则、一键更新等功能默认通过该 CDN 加速访问。

---

## ZViewerCLI 本地代理

ZViewerCLI 是一个可选的本地代理客户端，用于解决浏览器端无法直接使用用户 Bilibili Cookie 与高画质地址的问题：

- 使用用户本地 Cookie 解析 Bilibili 视频，获取大会员等高画质地址。
- 在本地代理视频流请求，注入正确的 Referer/Origin/User-Agent，绕过 CDN 防盗链与 CORS 限制。
- 通过 WebSocket 向房间注册，前端自动检测并使用本地代理。

### 使用方式

1. 在本地运行 ZViewerCLI（详见 [ZViewerCLI 项目](../ZViewerCLI)）。
2. 在房间中开启「CLI 本地高画质代理」开关。
3. 播放器将自动通过本地 CLI 加载视频。

---

## 常见问题

### better-sqlite3 编译失败

better-sqlite3 包含 C++ 扩展，必须在目标环境重新编译。后端 Dockerfile 已安装 `python3`、`make`、`g++` 等构建工具。本地开发时如遇编译失败，确认系统已安装构建工具链。

### WebSocket 连接失败

确认 Nginx 已正确配置 WebSocket 升级头：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### WebRTC 无法建立连接

WebRTC 的 `getUserMedia` 要求 HTTPS 访问。生产环境请配置 SSL 证书。若双方处于严格 NAT 之后，可能需要部署 TURN 服务器（如 coturn）。

### CORS 报错

生产环境将 `CORS_ORIGIN` 设置为实际前端域名而非 `*`，修改后重新构建后端：

```bash
docker compose up -d --build backend
```

### 数据库数据丢失

Docker 部署时 SQLite 位于 `/app/config/dev.sqlite`，通过 `backend-data` 命名卷持久化。检查卷是否正常挂载：

```bash
docker volume ls
docker inspect zcontrol_backend-data
```

### Bilibili 解析失败

- 检查后端是否正确携带 Referer 等请求头。
- 封面与视频地址通过后端代理获取，避免 CORS 与防盗链问题。
- 大会员专享内容需在后台配置有效的 Bilibili 登录凭证，或使用 ZViewerCLI 本地代理。
