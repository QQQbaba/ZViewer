# 将 FFmpeg 转码迁移至前端 ffmpeg.wasm（DTS 音频实时转码重构）

## 背景与目标

现状：服务器中转模式下，后端对 mkv/avi/wmv/ts/flv 用 ffprobe 探测音轨，DTS 等不支持编码时由原生 FFmpeg 实时转成 fMP4 流；**直链模式后端拿不到字节、DTS 无声无解**。

目标：转码管线整体搬到浏览器端（ffmpeg.wasm），中转与直链统一支持 DTS 音轨。用户已确认的决策：
1. 第一期容器仅 **MKV**
2. 服务端移除自动探测+流式转码，四处路由改回**纯字节中转**
3. 沿用 `audioTranscodeEnabled` 开关，**默认保持 false**
4. Emby/Jellyfin 维持远端 HLS 委托转码，不动

## 架构总览

```
直链 URL ──fetch(CORS失败自动回退代理)──┐
中转 URL (/api/*/stream 纯字节中转) ────┤
                                        ▼
                          [Worker] 渐进式 EBML/MKV 解复用器
                            ├─ 视频轨 samples ──────┐
                            └─ 音频帧(DTS...)       │
                                  │ 按10~30s批送入   │
                                  ▼                 ▼
                     ffmpeg.wasm 解码→PCM → WebCodecs AudioEncoder(AAC)
                                                      │
                                                      ▼
                              [主线程] mp4-muxer 组装分片MP4 → MSE SourceBuffer
```

- 单线程 core（无需 SharedArrayBuffer / COOP/COEP 头，不影响跨域直链与现有页面资源）
- 只处理音频解码；视频轨直接 copy 进 JS 封装器（复刻原 `-c:v copy -c:a aac` 语义）
- AAC 编码优先用 WebCodecs `AudioEncoder`（Chrome 内置）；不可用时回退 ffmpeg 批量输出 ADTS 再剥头
- 容器内音轨本来就是 aac/mp3 等 MSE 支持格式时走纯 remux 分支（不启 wasm）

## 一、前端新增 `wasm-engine`（核心工作量）

目录 `frontend/src/modules/player/wasm-engine/`：

| 文件 | 职责 |
|---|---|
| `engine.ts` | 实现 `PlayerEngine`：MediaSource 生命周期、启动缓冲（首帧前缓冲约 5~8 秒）、lookahead 限速（缓冲超前播放点 ~30s 时暂停拉流） |
| `controller.ts` | 实现 `PlayerController`：buffered 内直接 seek；未缓冲区域按 demux 记录的 Cluster 时间码→字节偏移表发起 `Range` 重连重启管线 |
| `demuxer/ebml.ts` + `matroska-demuxer.ts` | 手写渐进式 EBML/MKV 解析器：Header/Info(Duration/TimestampScale)/Tracks(CodecID、**CodecPrivate**——avcC/SPC+PPS/AudioSpecificConfig 必须取出交给封装器)/Cluster(SimpleBlock/BlockGroup 含 lacing)；同时产出「字节偏移↔时间码」索引用于 seek 续传 |
| `worker/transcode-worker.ts` | Vite worker 入口，承载 `@ffmpeg/ffmpeg` 0.12；接收音频帧批次写 MEMFS 后 `exec -f dts -i … -c:a pcm_s16le`，回传 PCM transferable |
| `fetch-source.ts` | ReadableStream 读取器：Range 续传、断线重试、直链 CORS 失败时按 direct-engine 同款逻辑回退 `buildProxyUrl` |

引擎选择与降级：
- `engine-selector.ts` 新增 `'wasm'` 类型：`format==='mkv' && audioCodec 存在 && 不在白名单(aac/mp3/opus/vorbis/flac) && systemSettingsStore 中开关开启` → 选 wasm 引擎
- 白名单常量从后端同步为同一份（新增 `frontend/src/lib/audioCodecs.ts`）
- 引擎内部防御性校验：解出真实 TrackEntry 后若音轨其实可支持→纯 remux；若视频编解码 MSE 不支持（如部分 HEVC profile）→抛错并**自动回退原生播放路径**（direct/proxy），复用 attach 失败重试链路并提示「已回退，音频可能无声」

状态展示：worker 上报转码速率/缓冲水位，控制栏轻量徽标「WASM 转码中」（可选简化为通知文案）。更新 `WatchTogetherCore.tsx:206` 附近的既有通知逻辑语义。

## 二、依赖与资产

- 新增依赖：`@ffmpeg/ffmpeg ^0.12`、`@ffmpeg/util`、`mp4-muxer`
- 构建：把 `@ffmpeg/core`（单线程，约 31MB）UMD 产物复制到 `frontend/public/ffmpeg/`（node_modules 复制脚本或 Vite 插件二选一，倾向简单复制脚本）；core.js/core.wasm 经 `toBlobURL` 加载避免 CSP/路径问题
- 生产环境单端口 3333 由后端托管静态文件，public 随 dist 分发即可，无需额外 Vite 配置（dist 已有 jassub-worker wasm 先例）

## 三、后端改造（瘦身为主）

1. **删除** `services/proxy/audio-transcode.ts` 及其四个调用点：
   - `routes/serverFiles.ts` GET/HEAD `/proxy` 的转码分支（保留 Range 字节中转能力）
   - `routes/webdav.ts` `/stream` L629-662、`routes/openlist.ts` L748-762、`routes/stream/ftp.ts` L117-132 的检测接管块
2. `services/ffmpeg/index.ts`：删除 `createAudioTranscodeStream`、`needsAudioTranscode`、`BROWSER_SUPPORTED_AUDIO_CODECS`、`isFfmpegTranscodeCapable` 及相关缓存；保留 `probeMediaInfo`（改为入库期探测用）、ffprobe 可执行文件管理、字幕提取、B站合并逻辑不动
3. **入库期补齐音轨信息**（关键新增）：影片创建/更新时若 `format==='mkv'` 且 `audioCodec` 为空 → 用现成 `probeMediaInfo`（带超时上限约 3s）异步探测并持久化 `Movie.audioCodec`（实体字段已存在）；resolve 接口把该值带给前端。成本每片仅一次
4. Emby/Jellyfin、admin 设置接口（开关沿用原名）、FFmpeg 安装/下载弹窗全部不动

## 四、兼容性与边界

- 开关关闭（默认）＝行为回到今天的纯中转直推，零回归风险
- 音频批量转码延迟远低于实时，DTS 2.0/5.1 无压力；7.1 高码率通过 `-ac 2` 下混保持一致（与旧服务端行为相同）
- seek 未缓冲区会有一次 Range 重连 + 重建管线的小停顿（约 1~2s），文档标注
- WebCodecs 不存在（Firefox/Safari 旧版）→ 自动落到 ffmpeg ADTS 编码路径，功能不缺只是稍慢
- 内存可控：源字节只流式消费不驻留，MEMFS 仅持有当前批次；MSE 自带驱逐背压

## 五、实施顺序

1. 后端：删转码分支→四处路由改纯中转→入库期 audioCodec 探测
2. 前端：EBML/MKV 解复用器（含单测式的本地 fixture 调试入口）→ worker+ffmpeg.wasm 音频链路 → mp4-muxer+MSE 封装与限速 → engine/controller/seek → 引擎选择器接入
3. 回退链路与 UI 文案、手动验证：中转 MKV(DTS)、直链 MKV(DTS)、直连失败回退代理、开关关闭回归

预计涉及文件约 15 个（前端 9 个新增 + 5 个修改，后端 6 个修改 + 1 个删除）。