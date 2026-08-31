package com.zero251.zviewer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Binder;
import android.os.IBinder;
import android.util.Log;

/**
 * 屏幕共享前台服务（v11.4）：
 * Android 14+ 要求使用 MediaProjection 前必须存在类型为 mediaProjection 的前台服务，
 * 否则 getMediaProjection 抛 SecurityException（"Media projections require a foreground
 * service of type mediaProjection"）。
 *
 * 流程：用户授权成功 → MainActivity 绑定本服务（bindService + BIND_AUTO_CREATE，
 * 兼容阉割 startService 的 ROM）→ onCreate 里 startForeground(三参, MEDIA_PROJECTION 类型)
 * → MainActivity 通过 LocalBinder 调 startProjection(resultCode, data) 真正开始推流。
 */
public class MediaProjectionService extends Service {
    private static final String TAG = "MediaProjSvc";
    private static final String CHANNEL_ID = "zviewer_projection";
    private static final int NOTIF_ID = 1002;

    private final IBinder binder = new LocalBinder();

    public class LocalBinder extends Binder {
        public MediaProjectionService getService() {
            return MediaProjectionService.this;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        // 必须以 mediaProjection 类型进入前台（Android 14 硬性要求）
        try {
            startForeground(NOTIF_ID, buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            Log.i(TAG, "mediaProjection 前台服务已启动（通知 #" + NOTIF_ID + "）");
        } catch (Throwable t) {
            Log.e(TAG, "startForeground(3参) 失败，回退两参: " + t);
            try {
                startForeground(NOTIF_ID, buildNotification());
                Log.i(TAG, "已用两参 startForeground 进入前台");
            } catch (Throwable t2) {
                Log.e(TAG, "startForeground 两参也失败: " + t2);
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.i(TAG, "MediaProjectionService 已销毁");
    }

    /** 由 MainActivity 授权回调后调用：获取 MediaProjection 并开始编码推流 */
    public void startProjection(int resultCode, Intent data) {
        Log.i(TAG, "startProjection resultCode=" + resultCode);
        ScreenShareManager.get().onActivityResult(resultCode, data);
    }

    private void createChannel() {
        try {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "屏幕共享",
                    NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.createNotificationChannel(ch);
        } catch (Throwable ignored) {
        }
    }

    private Notification buildNotification() {
        try {
            Notification.Builder b = new Notification.Builder(this, CHANNEL_ID)
                    .setContentTitle("ZViewer 屏幕共享")
                    .setContentText("正在共享屏幕画面")
                    .setSmallIcon(android.R.drawable.ic_menu_share)
                    .setOngoing(true);
            return b.build();
        } catch (Throwable t) {
            return new Notification();
        }
    }
}