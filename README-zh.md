# ZViewer 异地一起看片（安卓版使用说明）

> 基于 [ZViewer](https://github.com/Zero-wyc/ZViewer)（v3.4.3）深度定制：**内置服务器 + 一键内网穿透 + 后台保活 + 屏幕共享 + 房间发现**，目标是让没有服务器的纯小白也能开箱即用。

---

## 📦 这是什么？

ZViewer 是一个"异地一起看片"平台：一个人当房主（播放片源），朋友们通过链接/房间号加入房间，**实时同步播放进度**，一起看、一起聊。

本分支在原作者基础上做了这些增强（全部在**原版基础上修**，不改变原版使用习惯）：

| 版本 | 新增能力 |
|---|---|
| **v11** | 安卓壳（App 内嵌 node 服务器）、后台保活（前台服务 + 通知栏常驻）、冷启动提速（7 秒就绪）、进房通知（观众进出弹提示） |
| **v11.2** | 屏幕共享（手机屏幕推流）、内网穿透 watchdog（断线自动重连） |
| **v11.3** | 房间发现（公告栏机制）：公开房间 + 发现公开房间 + 房间号加入修复 |

---

## 🚀 快速开始（小白版，3 分钟）

### 第一步：安装 App
1. 安装 `ZViewer.apk`（Android 8.0+，建议 12+）
2. 打开 App，**等 7~10 秒**（首次启动要解压内置服务器，之后会快）

### 第二步：当房主（让别人看你的）
1. 首页 → **新建房间**
2. 房间内打开「**公网邀请通道**」（内网穿透），等 10~20 秒出现链接
3. 把**邀请链接**发给朋友 → 朋友点开就能进房一起看

### 第三步：当观众（看别人的）
- 点房主发的**链接**直接进；或
- 打开 App → **输入房间号**加入；或（公告栏部署后）
- 首页 → **发现公开房间** → 搜索房主房间名 → 点进

---

## 🏠 房主完整流程

```
打开 App → 等服务就绪（7 秒） → 首页「新建房间」
```

1. **建房间**：首页 → 新建房间 → 选类型
   - **普通房间**：默认，大家看房主播放的片源
   - **投屏房间**（screen-share）：适合给别人看你的手机屏幕
2. **开隧道**：房间内打开「公网邀请通道」→ 出现 `https://xxx.trycloudflare.com/...` 链接
   - 断线不用管：watchdog 自动重连，链接变了页面自动刷新
3. **拉朋友进来**（三选一）：
   - 📎 发**邀请链接**（最稳）
   - 🔢 发**房间号**（App 会先查公告栏拿你的最新地址）
   - 📢 点房间信息面板「**公开房间**」→ 全网可搜（需公告栏）
4. **（可选）屏幕共享**：
   - 投屏房间 → 切到「OBS 推流」子模式 → 点「**用手机屏幕推流**」→ 系统授权 → 开始
   - 观众直接看，无需任何额外操作

> ⚠️ **公开房间 = 任何人搜到就能进**，不想被陌生人围观请设置**房间密码**（原版支持）。

---

## 👀 观众完整流程

| 方式 | 操作 | 适用场景 |
|---|---|---|
| **点链接** | 房主发的链接，浏览器/App 直接打开 | 最快最稳 |
| **输房间号** | App → 输入房间号 → 加入 | 不知道链接时 |
| **搜房间** | App → 发现公开房间 → 搜索房间名 | 公告栏部署后，全网可搜 |

> 💡 手机浏览器就能看，**不一定要装 App**。

---

## ⚙️ 功能详解

### 1. 后台保活（v11）
- App 退后台、划掉任务，**服务照常运行**（前台服务 + 通知栏常驻「ZViewer 服务运行中」）
- 想停服务：**设置 → 应用 → ZViewer → 强制停止**（等效于旧版关掉 App）

### 2. 进房通知（v11）
- 观众加入/离开房间时，房主界面弹出 toast 提示（原版没有，防"谁进来了都不知道"）

### 3. 屏幕共享（v11.2）
- **原理**：安卓原生 `MediaProjection` 截屏 → `MediaCodec` H.264 编码 → RTMP 推流到内置流媒体服务器（Node-Media-Server），观众走原版 FLV 播放器观看，**观众端零改动**
- **为什么不用 WebRTC**：安卓 WebView 不支持 `getDisplayMedia`（硬限制），App 内 OBS 推流模式是唯一可用方案；网页版浏览器可用 Chrome/Edge 的 WebRTC 共享

### 4. 内网穿透 watchdog（v11.2）
- cloudflared 隧道进程退出后 **5 秒自动重启**（连续失败 5 次退避到 60 秒）
- 用户主动停止则不重启
- 隧道 URL 变化时自动同步到公告栏（若房间已公开）

### 5. 房间发现 / 公告栏（v11.3）
- **房主**：房间信息面板 → 「公开房间」→ 上报 {房间号, 房间名, 最新隧道地址} 到公告栏
- **观众**：首页 → 「发现公开房间」→ 搜索 → 点进；或输入房间号自动查公告栏拿最新地址
- **地址可配置**：后端环境变量 `DIRECTORY_URL`（为空则功能关闭，显示"公告栏未配置"）
- 公告栏条目 **4 小时 TTL** 自动过期，防僵尸房间
- 隧道地址变化自动重新上报，朋友永远拿到最新链接

---

## ☁️ 公告栏部署指南（可选，给想搭建公共公告栏的人）

「房间发现」需要一个**中央公告栏服务器**（所有用户共用的"房间门牌号查询表"）。
推荐用 **Cloudflare Workers 免费版**（无需服务器、免费 10 万请求/天）：

1. 注册 Cloudflare → 控制台 → **Workers 和 Pages** → 创建 Worker
2. 粘贴 [`tools/room-directory-worker.js`](tools/room-directory-worker.js) 的代码 → 部署
3. 创建 **KV 命名空间**（`ROOMS`）→ 在 Worker 设置中绑定变量名 `ROOMS`
4. 部署后把 Worker 地址（`https://xxx.workers.dev`）写入后端环境变量：
   ```
   DIRECTORY_URL=https://xxx.workers.dev
   ```
   （可选）`DIRECTORY_SECRET=自定义密钥` 可防止陌生人乱上报

> 💡 想让全世界用户开箱即用？把公共公告栏地址**写死进 App 默认值**再打包分发即可（本项目已预留该位置，见 `frontend/src/lib/api.ts` 附近注释）。

---

## 📱 安卓壳源码构建（android/ 目录）

本仓库 `android/` 目录是安卓壳工程源码（非完整 Android Studio 工程，零依赖构建）：

```
android/
├── src/com/zero251/zviewer/   # 壳源码（5 个 Java 文件）
│   ├── MainActivity.java      # WebView + JS 桥（含屏幕共享接口）
│   ├── ServerService.java     # 前台服务（node 服务器宿主）
│   ├── ServerManager.java     # node/proot 进程管理
│   ├── RtmpPublisher.java     # 精简 RTMP 推流器（H.264-only，约 400 行）
│   └── ScreenShareManager.java# MediaProjection 截屏 + MediaCodec 编码 + 推流
├── stub/                      # 编译用 android.* API stub（绕开 SDK 依赖）
├── res/                       # 资源
├── AndroidManifest.xml
└── build-apk.sh               # 一键构建脚本（javac + d8 + aapt2 + zipalign）
```

### 构建前提
- 设备上装有 build-tools（d8/aapt2/zipalign）与 `framework-res.apk`
- 需要 `assets/` 与 `lib/`（内置 node 运行时 + proot + server.zip）——体积大未入库，从发布版 APK 中提取或自行准备：
  - `assets/`：node 可执行文件、cloudflared、proot、rootfs、server.zip（前端 dist + 后端 dist + node_modules）
  - `lib/`：Android 架构 so 库（libnode.so 等）

### 构建
```bash
cd android
./build-apk.sh
```

> 壳的定位：**给不会部署服务器的小白一个"点开就能用"的入口**。App 首次启动把内置 server.zip 解压到私有目录，拉起 node 进程，一切都在本地完成。

---

## 🔧 环境变量一览（壳注入 / 后端读取）

| 变量 | 说明 |
|---|---|
| `PROOT_BIN` / `PROOT_LOADER` | proot 可执行文件与 loader 路径（Android 上跑 Linux 二进制用） |
| `CLOUDFLARED_BIN` | cloudflared 可执行文件路径 |
| `CLOUDKIT_DIR` | rootfs 目录（cloudflared 运行环境） |
| `TUNNEL_URL` | 当前隧道公网地址（由 tunnel 路由维护，目录上报用） |
| `DIRECTORY_URL` | 公告栏地址（为空 = 房间发现功能关闭） |
| `DIRECTORY_SECRET` | 公告栏上报密钥（可选，防乱上报） |

---

## ❓ 常见问题（FAQ）

**Q：朋友输房间号进不去，提示"Socket 尚未连接"？**
房间号只是"门牌号"，没有公告栏映射时连不上房主地址。发**邀请链接**最稳；或部署公告栏后输房间号会自动查最新地址。

**Q：内网穿透不稳定？**
隧道进程有 watchdog 自动重启，链接变了会自动刷新。另外注意：**断线重连后地址会变**，旧链接失效属正常。

**Q：「停止服务」按钮点了没反应？**
部分国产 ROM 阉割了 `registerReceiver`，广播按钮失效（服务本身正常）。用**设置 → 强制停止**等效。

**Q：App 内屏幕共享为什么不用 WebRTC？**
安卓 WebView 无 `getDisplayMedia` API（硬限制）。已用原生 MediaProjection + RTMP 推流替代，观众端零改动。

**Q：卸载 App 会怎样？**
卸载 = 全清（服务、隧道、公告栏条目到期自动清）。无需额外清理按钮。

**Q：端口 3333 被占用 / 服务起不来？**
旧 node 进程可能残留，强制停止 App 后重开即可。

---

## 📜 版本历史

- **v11.3**：房间发现（公告栏机制）——发现公开房间页、房间号加入修复、房主公开房间按钮、目录路由（`backend/src/routes/directory.ts`）、隧道 URL 变化自动重新上报
- **v11.2**：屏幕共享（RtmpPublisher + ScreenShareManager + JS 桥）、隧道 watchdog、进房通知 TS 类型修复
- **v11**：安卓壳、后台保活、冷启动提速、进房通知

## 🙏 致谢

- 原作者 [Zero-wyc/ZViewer](https://github.com/Zero-wyc/ZViewer)（MIT）
- Node-Media-Server（内置流媒体服务器）、Cloudflare（内网穿透 + 公告栏托管）
