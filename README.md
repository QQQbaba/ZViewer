# ZViewer

> 多人同步追番、观影与远程共享平台。

ZViewer 让一群人在不同地点也能像坐在一起一样看番、看电影。房主控制播放进度，观众实时跟随；支持 Bilibili、WebDAV、FTP、OpenList、MP4 直链等多种视频源，并内置屏幕共享、弹幕、评论等互动能力。

<p align="left">
  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/Zero-wyc/ZViewer?style=flat-square&logo=github&label=LICENSE&labelColor=333&color=orange" alt="GPL">
  </a>
  <img src="https://img.shields.io/github/stars/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Stars&labelColor=333&color=blue" alt="Stars">
  <a href="https://github.com/Zero-wyc/ZViewer/releases">
    <img src="https://img.shields.io/github/v/release/Zero-wyc/ZViewer?style=flat-square&logo=github&label=RELEASE&labelColor=333&color=green" alt="Release">
  </a>
  <img src="https://img.shields.io/github/contributors/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Contributors&labelColor=333&color=brightgreen" alt="Contributors">
  <img src="https://img.shields.io/github/repo-size/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Size&labelColor=333&color=yellow" alt="Repo Size">
  <img src="https://img.shields.io/github/last-commit/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Last%20Commit&labelColor=333&color=inactive" alt="Last Commit">
  <img src="https://img.shields.io/github/languages/top/Zero-wyc/ZViewer?style=flat-square&logo=typescript&labelColor=333&color=3178C6" alt="Top Language">
  <a href="https://t.me/Zero_251">
    <img src="https://img.shields.io/badge/Telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="Telegram">
  </a>
  <a href="https://qm.qq.com/q/jOQUoISESs">
    <img src="https://img.shields.io/badge/QQ-12B7F5?style=flat-square&logo=tencentqq&logoColor=white" alt="QQ">
  </a>
</p>

---

## 目录

- [功能特性](#功能特性)
- [整体架构](#整体架构)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [一键启动脚本](#一键启动脚本)
- [单文件 exe 版](#单文件-exe-版)
- [HTTPS 与证书](#https-与证书)
- [Docker 部署](#docker-部署)
- [GitHub Actions 自动构建](#github-actions-自动构建)
- [本地开发](#本地开发)
- [环境变量](#环境变量)
- [权限模型](#权限模型)
- [视频源](#视频源)
- [ZViewerCLI 本地代理](#zviewercli-本地代理)
- [常见问题](#常见问题)

---

| ![image-20260730001949027](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260730001949577.webp) | ![image-20260730002020513](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260730002021032.webp) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![image-20260730002033267](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260730002033753.webp) | ![image-20260730002058938](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260730002059371.webp) |

---

## 功能特性

### 一起看房间

- 创建或加入房间，与好友同步观看。
- 房主拥有播放控制权：播放、暂停、跳转、倍速。
- 观众可申请控制，房主确认后执行。
- 播放记忆：房主短暂断线后，由服务器继续广播当前状态。
- 房主离线超时自动关房（10 分钟），期间观众可自由控制（需关闭自动审批模式）。

### 多源视频解析

| 来源 | 说明 |
|---|---|
| **Bilibili** | 解析 BV 号或视频链接，支持 DASH 音视频合并、清晰度切换、大会员凭证 |
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
- 明暗主题切换、自定义背景、玻璃拟态 UI、精简动画模式。

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
│  │ Express API  │  │ Socket.IO    │  │ TypeORM + sql.js     │  │
│  │ 路由层        │  │ 事件处理器    │  │ （wasm SQLite）持久化 │  │
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
- TypeORM + sql.js（wasm SQLite）数据持久化
- node-media-server 流媒体推送
- JSON Web Token 鉴权

### 部署

- 一键启动脚本（源码版 PowerShell / Bash，含交互菜单）
- 单文件 exe 版（pkg 打包，Windows / Linux，零依赖）
- Docker 镜像（Linux 单文件版，自动构建推送到 Docker Hub）
- GitHub Actions 自动构建与发布

---

## 快速开始

### 默认管理员

系统首次启动时自动创建超级管理员账号：

- 用户名：`root`
- 密码：`root`

> 生产环境部署后请立即修改默认密码。

### 方式一：源码版一键启动（推荐）

项目根目录的 `start-prod` 脚本会自动检测并安装依赖、按需构建、启动服务。

**Windows**：双击 `start-prod.bat` 进入交互菜单，或使用命令：

```powershell
.\start-prod.bat              # 交互菜单（双击默认进入）
.\start-prod.bat start        # 启动（HTTP 前后端）
.\start-prod.bat backend      # 仅启动后端
.\start-prod.bat stop         # 停止服务
.\start-prod.bat status       # 查看状态
.\start-prod.bat cert         # 签发 SSL 证书（交互选择类型）
.\start-prod.bat https        # 签发证书 + HTTPS 启动
```

**Linux / macOS**：

```bash
./start-prod.sh               # 交互菜单
./start-prod.sh start
./start-prod.sh stop
./start-prod.sh status
```

启动后访问：

- 前端：http://localhost:4173
- HTTPS 模式：https://localhost:3333

### 方式二：单文件 exe 版

无需安装 Node.js / npm，直接下载 [Releases](https://github.com/Zero-wyc/ZViewer/releases) 中的压缩包，解压后运行：

```bash
# Windows
start.bat              # 交互菜单
start.bat start        # 启动服务

# Linux
./start.sh             # 交互菜单
./start.sh start       # 启动服务
```

### 方式三：Docker

```bash
docker pull zerowyc0721/zviewer:latest
docker run -d -p 3333:3333 -v zviewer-data:/app/config zerowyc0721/zviewer:latest
```

访问 `https://localhost:3333`。

---

## 一键启动脚本

源码版（`start-prod.*`）与单文件版（`packaging/start-*`）功能一致，均提供交互菜单与命令行两种模式。

### 交互菜单

无参数运行（或双击）进入交互菜单：

```text
========================================
  ZViewer 服务管理
========================================
  1) 启动服务 (HTTP)
  2) 仅启动后端（可选 HTTP / HTTPS）
  3) 停止服务
  4) 重启服务
  5) 查看状态
  6) 查看日志
  7) 一键签发 SSL 证书
  8) HTTPS 启动（自动签发证书）
  9) 构建前后端（源码版）
  0) 退出
```

### 命令

| 命令 | 说明 |
|---|---|
| `start` | 启动服务（HTTP 前后端；加 `-Https` 使用 HTTPS 单进程模式） |
| `backend` | 仅启动后端（可选 HTTP/HTTPS，启动时交互选择） |
| `cert [host]` | 签发 SSL 证书，host 缺省时交互选择类型 |
| `https [host]` | 签发证书后以 HTTPS 启动（仅后端，后端统一提供前端页面） |
| `stop` / `restart` | 停止 / 重启服务 |
| `status` | 查看运行状态（PID、端口监听、证书状态） |
| `logs [backend\|frontend]` | 查看日志（默认 backend） |
| `build` | 构建前后端（源码版） |
| `help` / `menu` | 帮助 / 交互菜单 |

### 端口

端口固定，不支持自定义：

| 服务 | 端口 | 说明 |
|---|---|---|
| 后端 | 3333 | HTTP / HTTPS API |
| 前端 | 4173 | HTTP 模式下的前端静态服务器 |
| RTMP 推流 | 3334 | OBS 推流端口 |
| HTTP-FLV 拉流 | 3335 | 直播流播放 |

### 进程管理

- 进程信息写入 `.prod.pids.json`，`stop` 按 PID 停止并兜底清理占用端口。
- 日志写入 `log/backend.log`、`log/frontend.log`（及 `.err.log`）。
- 启动后端后自动等待就绪（轮询端口），再启动前端，避免竞态。

---

## 单文件 exe 版

将前后端与证书工具编译为单个可执行文件，目标机器无需安装 Node.js。

### 编译

```bash
# 编译全部平台
npm run build:all

# 或指定平台
node build-all.js --win         # 仅 Windows
node build-all.js --linux        # 仅 Linux
```

产物输出到 `dist/`：

```text
dist/
├── win/                 # start.bat + start.ps1 + zviewer-backend.exe
│                        #   + zviewer-frontend.exe + zviewer-cert.exe
└── linux/               # start.sh + zviewer-backend + zviewer-frontend + zviewer-cert
```

### 使用

将对应平台目录整体拷贝到目标机器，运行：

- **Windows**：双击 `start.bat`（交互菜单）或 `start.bat start`
- **Linux**：`./start.sh`（交互菜单）或 `./start.sh start`

---

## HTTPS 与证书

### 签发类型

证书工具（`zviewer-cert`，源码为 `scripts/generate-cert.js`）按地址类型自动选择签发方式：

| 地址类型 | 证书 | 说明 |
|---|---|---|
| `localhost` | 自签证书 | SAN 含 `localhost`、`127.0.0.1`、`::1`，10 年有效 |
| 域名（如 `example.com`） | **Let's Encrypt 可信 CA 证书** | 通过内置 ACME 客户端自动申请，浏览器不报警告 |
| 公网 IP（如 `1.2.3.4`） | 自签证书 | SAN 写入 IP 条目（iPAddress） |

### 交互签发

菜单选择"一键签发 SSL 证书"后按提示操作：

```text
请选择证书签发类型：
  [1] localhost（本机访问，默认，自签证书）
  [2] 域名或公网 IP（如 example.com 或 1.2.3.4）
      - 域名将自动申请 Let's Encrypt 可信 CA 证书
        （需域名已解析到本机且 80 端口可访问）
      - 公网 IP 或内网地址使用自签证书
```

### 命令行签发

```bash
# 域名 → 自动申请 Let's Encrypt 可信证书
start.bat cert example.com
./start.sh cert example.com

# 公网 IP → 自签（SAN 含该 IP）
start.bat cert 1.2.3.4

# 强制重新签发 / 使用测试环境
start.bat cert example.com --force
./start.sh cert example.com --staging

# 域名强制使用自签（如内网域名）
./start.sh cert myhost.local --selfsigned
```

### HTTPS 启动

```bash
start.bat https example.com     # 签发证书后以 HTTPS 启动（仅后端）
start.bat start -Https          # 同上
start.bat backend -Https        # 仅后端 + HTTPS
```

HTTPS 模式下后端同时提供前端静态页面，访问 `https://localhost:3333`（证书签发为域名/IP 时按实际地址访问）。

### 域名申请 Let's Encrypt 证书的前置条件

1. 域名已解析到本机公网 IP；
2. 本机 **80 端口**空闲且防火墙/安全组放行（ACME HTTP-01 验证）；
3. 正式环境有速率限制（每域名每周 5 张），调试可用 `--staging` 测试环境。

证书文件位于 `config/ssl/`（`cert.pem` 证书链、`key.pem` 私钥、`acme-account.key` ACME 账号），HTTPS 启动时自动加载。

---

## Docker 部署

### 使用 Docker Hub 镜像

```bash
# 拉取镜像
docker pull zerowyc0721/zviewer:latest

# 启动容器
docker run -d \
  --name zviewer \
  -p 3333:3333 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

### 自行构建

```bash
# 使用项目根目录的 Dockerfile.linux-single
docker build -t zviewer -f Dockerfile.linux-single .

# 或使用 docker compose
docker compose -f docker-compose.linux-single.yml up -d
```

### 访问

- **HTTPS**：`https://localhost:3333`
- 首次启动自动签发 `localhost` 自签证书。

### 容器管理

```bash
# 查看日志
docker logs -f zviewer

# 进入容器
docker exec -it zviewer sh

# 查看运行状态
docker exec zviewer ./start.sh status

# 签发域名证书
docker exec zviewer ./zviewer-cert your-domain.com
```

### 数据持久化

`/app/config` 目录挂载 volume，包含：

| 路径 | 内容 |
|---|---|
| `/app/config/dev.sqlite` | 数据库 |
| `/app/config/ssl/` | SSL 证书（自签或 Let's Encrypt） |
| `/app/config/uploads/` | 用户上传文件 |

---

## GitHub Actions 自动构建

每次 push 到 `main` 分支或打 tag（`v*`）时，自动完成：

1. **构建 Linux 单文件版** → 上传 artifact + 推送到 Docker Hub（`zerowyc0721/zviewer`）
2. **构建 Windows 单文件版** → 上传 artifact

打 tag 时自动创建 GitHub Release，包含两个平台的压缩包。

### 手动触发

在 GitHub 仓库 → Actions → "Build Single-File (Windows + Linux)" → "Run workflow"。

### 构建产物

| 平台 | 压缩包 | 说明 |
|---|---|---|
| Linux | `zviewer-linux-x64.tar.gz` | 含 `zviewer-backend`、`zviewer-frontend`、`zviewer-cert`、`start.sh` |
| Windows | `zviewer-windows-x64.zip` | 含 `zviewer-backend.exe`、`zviewer-frontend.exe`、`zviewer-cert.exe`、`start.bat`、`start.ps1` |
| Docker | `zerowyc0721/zviewer:latest` | Linux 单文件版的 Docker 镜像，自动推送到 Docker Hub |

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

## 环境变量

### 后端

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 后端服务端口 | `3333` |
| `NODE_ENV` | 运行环境 | `production` |
| `DATABASE_URL` | SQLite 文件路径或 PostgreSQL 连接串 | `<config>/dev.sqlite` |
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

### 直链与挂载

- **MP4 直链**：直接输入可访问的 MP4 视频地址播放。
- **WebDAV / FTP / OpenList**：在挂载点管理中保存连接配置，浏览目录并播放视频文件。

---

## ZViewerCLI 本地代理

[ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) 是一个可选的本地代理客户端，用于解决浏览器端无法直接使用用户 Bilibili Cookie 与高画质地址的问题：

- 使用用户本地 Cookie 解析 Bilibili 视频，获取大会员等高画质地址。
- 在本地代理视频流请求，注入正确的 Referer/Origin/User-Agent，绕过 CDN 防盗链与 CORS 限制。
- 通过 WebSocket 向房间注册，前端自动检测并使用本地代理。

---

## 常见问题

### 自签证书浏览器提示"不安全"

`localhost` 与公网 IP 使用自签证书，浏览器会提示"证书颁发机构不受信任"。解决方法：

- 将 `config/ssl/cert.pem` 导入客户端"受信任的根证书颁发机构"；或
- 使用域名并通过 Let's Encrypt 申请可信证书。

自签证书与地址不匹配时，说明访问地址不在证书 SAN 中——请为实际访问的域名/IP 重新签发。

### 域名申请 Let's Encrypt 证书失败

依次检查：

- 域名是否已解析到本机公网 IP；
- 80 端口是否空闲、防火墙/安全组是否放行；
- 是否触发速率限制（可用 `--staging` 测试环境验证流程）。

### WebSocket 连接失败

确认反向代理（Nginx 等）已正确配置 WebSocket 升级头：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### WebRTC 无法建立连接

WebRTC 的 `getUserMedia` 要求 HTTPS 访问。生产环境请配置 SSL 证书。若双方处于严格 NAT 之后，可能需要部署 TURN 服务器（如 coturn）。

### 数据库说明

后端使用 TypeORM + sql.js（wasm 版 SQLite）持久化，纯 JS 实现、无原生模块——单文件 exe 版可在任意平台直接运行，无需编译。数据库文件为标准 SQLite 格式（`config/dev.sqlite`），可用常规 SQLite 工具查看。

### Bilibili 解析失败

- 检查后端是否正确携带 Referer 等请求头。
- 封面与视频地址通过后端代理获取，避免 CORS 与防盗链问题。
- 大会员专享内容需在后台配置有效的 Bilibili 登录凭证，或使用 ZViewerCLI 本地代理。