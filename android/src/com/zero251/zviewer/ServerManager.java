package com.zero251.zviewer;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 服务管理器（v11）：
 * - 把"解压组件 + 启动 node 服务"逻辑从 MainActivity 抽出来，供 Activity 与前台 Service 共用
 * - ensureRunning 幂等：已在跑直接返回；并发调用只启动一次
 * - stopServer：销毁 node 进程（前台服务通知栏「停止服务」时调用）
 */
public class ServerManager {
    private static final String TAG = "ZViewer";
    public static final int SERVER_PORT = 3333;

    private static volatile Process nodeProcess = null;
    private static volatile boolean starting = false;

    /** 确保服务在跑。线程安全。 */
    public static void ensureRunning(final Context ctx) {
        if (isServerUp()) {
            Log.i(TAG, "服务已在运行，直接使用");
            return;
        }
        synchronized (ServerManager.class) {
            if (starting) return;
            starting = true;
        }
        try {
            final File filesDir = ctx.getFilesDir();
            final String nativeLibDir = ctx.getApplicationInfo().nativeLibraryDir;

            File flag = new File(filesDir, ".installed");
            if (!flag.exists()) {
                Log.i(TAG, "首次运行：解压 server.zip...");
                extractZip(ctx, "server.zip", filesDir);
                copyAsset(ctx, "openssl.cnf", new File(filesDir, "openssl.cnf"));
                File node = new File(nativeLibDir, "libnode.so");
                if (!node.exists() || node.length() < 1000000) {
                    Log.e(TAG, "node 二进制异常: " + node.getAbsolutePath() + " exists=" + node.exists() + " size=" + node.length());
                    return;
                }
                flag.createNewFile();
                Log.i(TAG, "解压完成，node 就绪");
            }
            startServer(ctx, filesDir, nativeLibDir);
            Log.i(TAG, "服务启动流程完成");
        } catch (Exception e) {
            Log.e(TAG, "ensureRunning 异常", e);
        } finally {
            synchronized (ServerManager.class) {
                starting = false;
            }
        }
    }

    /** 停止服务：销毁 node 进程 */
    public static void stopServer() {
        Process p = nodeProcess;
        nodeProcess = null;
        if (p != null) {
            try {
                p.destroy();
                Log.i(TAG, "node 进程已销毁");
            } catch (Exception e) {
                Log.e(TAG, "stopServer 异常", e);
            }
        }
    }

    private static void startServer(Context ctx, File filesDir, String nativeLibDir) throws Exception {
        File node = new File(nativeLibDir, "libnode.so");
        // 日志写到外部私有目录（/sdcard/Android/data/<pkg>/files/），便于诊断排查
        File extDir = ctx.getExternalFilesDir(null);
        File outLog = new File(extDir != null ? extDir : filesDir, "server.log");
        Log.i(TAG, "启动服务: " + node.getAbsolutePath() + " 存在=" + node.exists() + " 日志=" + outLog.getAbsolutePath());
        ProcessBuilder pb = new ProcessBuilder(node.getAbsolutePath(), "backend/dist/index.js");
        pb.directory(filesDir);
        Map<String, String> env = pb.environment();
        env.put("LD_LIBRARY_PATH", nativeLibDir);
        env.put("OPENSSL_CONF", filesDir.getAbsolutePath() + "/openssl.cnf");
        env.put("CONFIG_DIR", filesDir.getAbsolutePath() + "/config");
        env.put("PORT", String.valueOf(SERVER_PORT));
        env.put("HOME", filesDir.getAbsolutePath());
        // 隧道组件路径（供后端 /api/tunnel/* 按需启动公网通道）
        env.put("PROOT_BIN", nativeLibDir + "/libproot.so");
        env.put("CLOUDFLARED_BIN", nativeLibDir + "/libcloudflared.so");
        env.put("PROOT_LOADER", nativeLibDir + "/libproot_loader.so");
        env.put("CLOUDKIT_DIR", filesDir.getAbsolutePath() + "/cloudkit");
        env.put("ZCLI_BIN", nativeLibDir + "/libzcli.so");
        env.put("JWT_ACCESS_SECRET", "zviewer_apk_" + System.currentTimeMillis());
        env.put("JWT_REFRESH_SECRET", "zviewer_apk_refresh_" + System.currentTimeMillis());
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(outLog));
        nodeProcess = pb.start();
        Log.i(TAG, "node 进程已启动");
    }

    public static boolean isServerUp() {
        try {
            Socket socket = new Socket();
            socket.connect(new InetSocketAddress("127.0.0.1", SERVER_PORT), 1000);
            socket.close();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static void extractZip(Context ctx, String assetName, File dest) throws Exception {
        InputStream in = ctx.getAssets().open(assetName);
        ZipInputStream zis = new ZipInputStream(in);
        byte[] buf = new byte[65536];
        ZipEntry entry;
        int count = 0;
        long total = 0;
        while ((entry = zis.getNextEntry()) != null) {
            File f = new File(dest, entry.getName());
            if (entry.isDirectory()) {
                f.mkdirs();
                continue;
            }
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            FileOutputStream fos = new FileOutputStream(f);
            int n;
            while ((n = zis.read(buf)) > 0) {
                fos.write(buf, 0, n);
                total += n;
            }
            fos.close();
            zis.closeEntry();
            count++;
            if (count % 2000 == 0) Log.i(TAG, assetName + " 解压中: " + count + " 文件, " + (total / 1024 / 1024) + "MB");
        }
        zis.close();
        Log.i(TAG, assetName + " 解压完成: " + count + " 文件, " + (total / 1024 / 1024) + "MB");
    }

    private static void copyAsset(Context ctx, String name, File dest) throws Exception {
        InputStream in = ctx.getAssets().open(name);
        FileOutputStream fos = new FileOutputStream(dest);
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
        fos.close();
        in.close();
    }
}
