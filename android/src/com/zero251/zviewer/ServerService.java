package com.zero251.zviewer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * 前台服务（v11）：
 * - 通知栏常驻「ZViewer 服务运行中」，App 退后台/划掉 Activity 后服务不中断
 * - 通知带「停止服务」按钮：杀 node + 停止服务（等于旧版"停掉 App"的行为）
 * - START_STICKY：被系统回收后自动重启
 */
public class ServerService extends Service implements IBinder {
    private static final String TAG = "ZViewerSvc";
    public static final String ACTION_STOP = "com.zero251.zviewer.action.STOP_SERVER";
    private static final String CHANNEL_ID = "zviewer_server";
    private static final int NOTIF_ID = 1001;

    /**
     * 启动服务（v11.1 兼容魔改 ROM）：
     * 本机 ROM 的 framework 阉割了 Context.startService / startForegroundService
     * （NoSuchMethodError），bindService 可用，因此改用 bindService 启动服务。
     * 服务在 onCreate 中调用 startForeground 变为前台服务，效果等同。
     */
    private static final ServiceConnection CONN = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            Log.i(TAG, "服务绑定成功: " + name);
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            Log.i(TAG, "服务绑定断开: " + name);
        }
    };

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, ServerService.class);
        try {
            boolean ok = ctx.bindService(i, CONN, 1 /* Context.BIND_AUTO_CREATE */);
            Log.i(TAG, "bindService 调用结果: " + ok);
        } catch (Throwable t) {
            Log.e(TAG, "bindService 失败", t);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        try {
            registerReceiver(stopReceiver, new IntentFilter(ACTION_STOP), Context.RECEIVER_NOT_EXPORTED);
        } catch (Throwable e) {
            Log.e(TAG, "注册接收器失败（ROM 阉割 registerReceiver，停止按钮将不可用）", e);
        }
        // bindService 启动时不会触发 onStartCommand，前台化逻辑放 onCreate
        try {
            startForeground(NOTIF_ID, buildNotification());
            Log.i(TAG, "已进入前台服务");
        } catch (Throwable t) {
            Log.e(TAG, "startForeground 失败（不影响服务运行）", t);
        }
        // 确保服务在跑（已跑则直接返回；未跑则解压+启动）
        new Thread(new Runnable() {
            @Override
            public void run() {
                ServerManager.ensureRunning(ServerService.this);
            }
        }).start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // startService 可用的设备走这里（幂等：重复调用无副作用）
        try {
            startForeground(NOTIF_ID, buildNotification());
        } catch (Throwable ignored) {
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                ServerManager.ensureRunning(ServerService.this);
            }
        }).start();
        return START_STICKY;
    }

    private Notification buildNotification() {
        // 「停止服务」按钮
        Intent stopIntent = new Intent(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getBroadcast(this, 1, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // 点通知打开 App
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPi = PendingIntent.getActivity(this, 2, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        return b
                .setContentTitle("ZViewer 服务运行中")
                .setContentText("朋友可通过邀请链接加入你的房间")
                .setSmallIcon(android.R.drawable.ic_menu_share)
                .setContentIntent(openPi)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止服务", stopPi)
                .setOngoing(true)
                .build();
    }

    private final BroadcastReceiver stopReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            Log.i(TAG, "收到「停止服务」请求");
            ServerManager.stopServer();
            stopForeground(true);
            stopSelf();
        }
    };

    @Override
    public void onDestroy() {
        try {
            unregisterReceiver(stopReceiver);
        } catch (Throwable ignored) {
        }
        // 注意：不在 onDestroy 里杀 node —— Activity 关闭/系统回收时服务停止不应连带停服务；
        // 只有通知栏「停止服务」才通过 stopServer() 主动停。
        super.onDestroy();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "ZViewer 服务", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("保持 ZViewer 服务在后台运行");
                NotificationManager nm = getSystemService(NotificationManager.class);
                if (nm != null) nm.createNotificationChannel(ch);
            } catch (Throwable t) {
                Log.e(TAG, "创建通知渠道失败（ROM 阉割 getSystemService）", t);
            }
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        // 返回自身作为 Binder，保持绑定连接（防止绑定服务被系统回收）
        return this;
    }
}
