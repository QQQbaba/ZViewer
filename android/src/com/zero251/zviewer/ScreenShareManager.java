package com.zero251.zviewer;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.util.Log;
import android.view.Surface;

import java.nio.ByteBuffer;

/**
 * 屏幕共享管理器（v11.2）：
 * MediaProjection 截屏 → MediaCodec(H.264) 编码 → RtmpPublisher 推到本机 NMS(3334)。
 * 前端通过 JS 桥调用 startScreenShare(streamKey) / stopScreenShare()。
 */
public class ScreenShareManager {
    private static final String TAG = "ScreenShare";
    public static final int REQ_CODE = 10086;
    private static final int WIDTH = 1280;
    private static final int HEIGHT = 720;
    private static final int FPS = 30;
    private static final int BITRATE = 2_500_000;
    private static final int VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR = 0x10;

    private static final ScreenShareManager INSTANCE = new ScreenShareManager();

    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private MediaCodec encoder;
    private RtmpPublisher publisher;
    private Thread pushThread;
    private volatile boolean running = false;
    private String streamKey;
    private Activity activity;
    private byte[] sps, pps;

    public static ScreenShareManager get() {
        return INSTANCE;
    }

    private ScreenShareManager() {
    }

    /** 请求屏幕捕获授权（弹系统框） */
    public void start(Activity act, String key) {
        if (running) {
            Log.i(TAG, "已在推流中");
            return;
        }
        this.activity = act;
        this.streamKey = (key == null || key.isEmpty()) ? "screen" : key;
        try {
            final MediaProjectionManager mpm = (MediaProjectionManager) act.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            // 必须在主线程启动授权 Activity（JS 桥线程调用会静默失败）
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        act.startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CODE);
                        Log.i(TAG, "已请求屏幕捕获授权");
                    } catch (Throwable t) {
                        Log.e(TAG, "请求屏幕捕获失败", t);
                    }
                }
            });
        } catch (Throwable t) {
            Log.e(TAG, "请求屏幕捕获失败", t);
        }
    }

    /** 授权回调（由 MainActivity.onActivityResult 转发） */
    public void onActivityResult(int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null) {
            Log.w(TAG, "屏幕捕获被拒绝");
            return;
        }
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            mediaProjection = mpm.getMediaProjection(resultCode, data);
            startEncoding();
        } catch (Throwable t) {
            Log.e(TAG, "获取 MediaProjection 失败", t);
        }
    }

    private void startEncoding() {
        try {
            MediaFormat format = MediaFormat.createVideoFormat("video/avc", WIDTH, HEIGHT);
            format.setInteger(MediaFormat.KEY_COLOR_FORMAT, 0x7f000789); // COLOR_FormatSurface
            format.setInteger(MediaFormat.KEY_BIT_RATE, BITRATE);
            format.setInteger(MediaFormat.KEY_FRAME_RATE, FPS);
            format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);

            encoder = MediaCodec.createEncoderByType("video/avc");
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            Surface inputSurface = encoder.createInputSurface();
            encoder.start();

            virtualDisplay = mediaProjection.createVirtualDisplay(
                    "ZViewerScreenShare", WIDTH, HEIGHT, 320,
                    VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, inputSurface, null, new Handler());
            Log.i(TAG, "编码器与虚拟显示已启动");

            running = true;
            pushThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    pushLoop();
                }
            }, "zviewer-screen-push");
            pushThread.start();
        } catch (Throwable t) {
            Log.e(TAG, "启动编码失败", t);
            stop();
        }
    }

    private void pushLoop() {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        boolean published = false;
        try {
            while (running) {
                int outIndex = encoder.dequeueOutputBuffer(info, 10000);
                if (outIndex >= 0) {
                    ByteBuffer buf = encoder.getOutputBuffer(outIndex);
                    byte[] frame = new byte[info.size];
                    if (buf != null) {
                        buf.position(info.offset);
                        buf.get(frame);
                    }
                    if ((info.flags & MediaCodec.BufferInfo.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                        // SPS/PPS 配置帧：从 output format 提取
                        extractCodecConfig();
                    } else if (frame.length > 0) {
                        boolean keyFrame = (info.flags & MediaCodec.BufferInfo.BUFFER_FLAG_KEY_FRAME) != 0;
                        if (!published) {
                            if (sps == null || pps == null) {
                                extractCodecConfig();
                            }
                            publisher = new RtmpPublisher();
                            publisher.connectAndPublish("127.0.0.1", 3334, "live",
                                    streamKey, sps, pps, WIDTH, HEIGHT);
                            published = true;
                        }
                        if (published) {
                            publisher.sendVideoFrame(frame, 0, frame.length, info.presentationTimeUs / 1000, keyFrame);
                        }
                    }
                    encoder.releaseOutputBuffer(outIndex, false);
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "推流循环异常", t);
        } finally {
            cleanup();
        }
    }

    private void extractCodecConfig() {
        try {
            MediaFormat fmt = encoder.getOutputFormat();
            if (fmt.containsKey("csd-0")) {
                ByteBuffer csd0 = fmt.getByteBuffer("csd-0");
                sps = new byte[csd0.remaining()];
                csd0.get(sps);
            }
            if (fmt.containsKey("csd-1")) {
                ByteBuffer csd1 = fmt.getByteBuffer("csd-1");
                pps = new byte[csd1.remaining()];
                csd1.get(pps);
            }
            Log.i(TAG, "SPS=" + (sps == null ? 0 : sps.length) + "B PPS=" + (pps == null ? 0 : pps.length) + "B");
        } catch (Throwable t) {
            Log.e(TAG, "提取 SPS/PPS 失败", t);
        }
    }

    /** 停止推流（前端调用） */
    public void stop() {
        running = false;
        if (pushThread != null) {
            try {
                pushThread.join(3000);
            } catch (Exception ignored) {
            }
            pushThread = null;
        }
        cleanup();
    }

    public boolean isRunning() {
        return running;
    }

    private void cleanup() {
        try {
            if (publisher != null) {
                publisher.close();
                publisher = null;
            }
        } catch (Throwable ignored) {
        }
        try {
            if (virtualDisplay != null) {
                virtualDisplay.release();
                virtualDisplay = null;
            }
        } catch (Throwable ignored) {
        }
        try {
            if (encoder != null) {
                encoder.stop();
                encoder.release();
                encoder = null;
            }
        } catch (Throwable ignored) {
        }
        try {
            if (mediaProjection != null) {
                mediaProjection.stop();
                mediaProjection = null;
            }
        } catch (Throwable ignored) {
        }
        Log.i(TAG, "屏幕共享已清理");
    }
}