package com.zero251.zviewer;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class MainActivity extends Activity {

    private static final String TAG = "ZViewer";
    private static final String HOME_URL = "http://127.0.0.1:3333";
    private static final int SERVER_PORT = 3333;

    private WebView webView;
    private boolean errorShown = false;
    private boolean startedService = false;
    private File filesDir;
    private String nativeLibDir;
    private volatile String tunnelUrl = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        filesDir = getFilesDir();
        nativeLibDir = getApplicationInfo().nativeLibraryDir;
        Log.i(TAG, "filesDir=" + filesDir.getAbsolutePath() + " nativeLibDir=" + nativeLibDir);

        webView = new WebView(this);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }

        webView.setBackgroundColor(Color.BLACK);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                view.loadUrl(url);
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // 渲染进程崩溃：不退出 App，重新加载
                Log.e(TAG, "WebView 渲染进程崩溃，尝试恢复: " + (detail != null ? detail.didCrash() : "?"));
                if (view != null) {
                    try {
                        view.loadUrl(HOME_URL);
                    } catch (Exception e) {
                        Log.e(TAG, "恢复失败", e);
                    }
                }
                return true;
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                Log.w(TAG, "onReceivedError(deprecated): " + errorCode + " " + description + " " + failingUrl);
                if (!errorShown && failingUrl != null && failingUrl.startsWith(HOME_URL)) {
                    errorShown = true;
                    view.loadUrl("file:///android_asset/error.html");
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                Log.w(TAG, "onReceivedError: " + (error != null ? error.getErrorCode() : "?") + " mainFrame=" + (request != null && request.isForMainFrame()));
                if (!errorShown && request != null && request.isForMainFrame()) {
                    errorShown = true;
                    view.loadUrl("file:///android_asset/error.html");
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                enterImmersive();
                setContentView(customView);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                setContentView(webView);
                customView = null;
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
            }
        });

        // JS 桥接：错误页的"重试"按钮通过它触发服务重启（v3.1 修复：原来只是跳主页，服务没起来当然无效）
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void retry() {
                Log.i(TAG, "用户点击重试");
                retryServer();
            }

            @JavascriptInterface
            public String getTunnelStatus() {
                String s = "{\"service\":" + isServerUp() + ",\"tunnel\":\"" + (tunnelUrl != null ? tunnelUrl : "") + "\"}";
                return s;
            }

            @JavascriptInterface
            public void copyTunnelUrl() {
                if (tunnelUrl != null) {
                    try {
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        cm.setPrimaryClip(ClipData.newPlainText("ZViewer邀请链接", tunnelUrl));
                        Log.i(TAG, "邀请链接已复制");
                    } catch (Exception e) {
                        Log.e(TAG, "复制剪贴板失败", e);
                    }
                }
            }

            @JavascriptInterface
            public void enterApp() {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        errorShown = false;
                        webView.loadUrl(HOME_URL);
                    }
                });
            }

            @JavascriptInterface
            public String startScreenShare(String streamKey) {
                Log.i(TAG, "前端请求开始屏幕共享 streamKey=" + streamKey);
                ScreenShareManager.get().start(MainActivity.this, streamKey);
                return "requesting";
            }

            @JavascriptInterface
            public String stopScreenShare() {
                Log.i(TAG, "前端请求停止屏幕共享");
                ScreenShareManager.get().stop();
                return "stopped";
            }

            @JavascriptInterface
            public String isScreenSharing() {
                return String.valueOf(ScreenShareManager.get().isRunning());
            }
        }, "ZViewerBridge");

        setContentView(webView);
        enterImmersive();
        webView.loadUrl("file:///android_asset/loading.html");

        // v11：启动前台服务（通知栏常驻，App 退后台服务不中断；同时负责拉起后端）
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 100);
            } catch (Throwable ignored) {
            }
        }
        ServerService.start(this);

        // 并行启动：服务线程 + 组件预解压线程（隧道改为由前端「管理→设置」手动开启）
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    ensureServer();
                } catch (Exception e) {
                    Log.e(TAG, "服务启动流程异常", e);
                }
            }
        }).start();

        new Thread(new Runnable() {
            @Override
            public void run() {
                // 仅预解压 cloudkit 组件（供后端按需启动隧道），不自动开启公网通道
                try {
                    extractCloudkitIfNeeded(new File(filesDir, "cloudkit"));
                } catch (Exception e) {
                    Log.e(TAG, "cloudkit 预解压失败", e);
                }
            }
        }).start();
    }

    private void ensureServer() {
        // v11：服务启动逻辑统一交给 ServerManager（幂等：已在跑直接返回；否则解压+启动）。
        // 服务进程由前台 ServerService 保活，App 退后台/划掉任务后服务不中断。
        ServerManager.ensureRunning(this);
        // 自动重试：等待端口就绪（最多 5 分钟）
        for (int i = 0; i < 300; i++) {
            if (isServerUp()) {
                Log.i(TAG, "服务就绪（第 " + i + " 次检查）");
                return;
            }
            try {
                Thread.sleep(1000);
            } catch (InterruptedException ie) {
                return;
            }
            if (i % 15 == 0) Log.i(TAG, "等待服务就绪... " + (i + 1) + "s");
        }
        Log.e(TAG, "服务 5 分钟内未就绪");
    }

    private void retryServer() {
        // 重置启动标志，允许重新尝试启动服务
        startedService = false;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    ensureServer();
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            errorShown = false;
                            webView.loadUrl(HOME_URL);
                        }
                    });
                } catch (Exception e) {
                    Log.e(TAG, "重试启动服务异常", e);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            errorShown = false;
                            webView.loadUrl("file:///android_asset/error.html");
                        }
                    });
                }
            }
        }).start();
    }

    private void startTunnel() {
        try {
            File kitDir = new File(filesDir, "cloudkit");
            extractCloudkitIfNeeded(kitDir);
            // proot/loader/cloudflared 走 nativeLibraryDir（apk_data_file 才允许 app 执行）
            String prootPath = nativeLibDir + "/libproot.so";
            String loaderPath = nativeLibDir + "/libproot_loader.so";
            String cfdPath = nativeLibDir + "/libcloudflared.so";
            if (!new File(prootPath).exists() || !new File(cfdPath).exists()) {
                Log.e(TAG, "cloudkit 组件缺失: " + prootPath + " " + cfdPath);
                return;
            }
            ProcessBuilder pb = new ProcessBuilder(
                    prootPath,
                    "-0", "-r", new File(kitDir, "rootfs").getAbsolutePath(),
                    "-b", "/proc", "-b", "/sys", "-b", "/dev",
                    "-b", cfdPath + ":/cloudflared",
                    "/cloudflared", "tunnel", "--url", "http://127.0.0.1:" + SERVER_PORT, "--no-autoupdate");
            Map<String, String> env = pb.environment();
            env.put("LD_LIBRARY_PATH", new File(kitDir, "lib").getAbsolutePath());
            env.put("PROOT_TMP_DIR", new File(kitDir, "rootfs/tmp").getAbsolutePath());
            env.put("PROOT_LOADER", loaderPath);
            File extDir = getExternalFilesDir(null);
            File log = new File(extDir != null ? extDir : filesDir, "cloudflared.log");
            pb.redirectErrorStream(true);
            pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
            pb.start();
            Log.i(TAG, "cloudflared 隧道进程已启动");
            // 轮询提取邀请链接（最多 90 秒）
            for (int i = 0; i < 90; i++) {
                String url = extractTunnelUrl(log);
                if (url != null) {
                    tunnelUrl = url;
                    Log.i(TAG, "隧道就绪: " + url);
                    return;
                }
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ie) {
                    return;
                }
                if (i % 15 == 0) Log.i(TAG, "等待隧道... " + (i + 1) + "s");
            }
            Log.e(TAG, "隧道 90 秒未就绪");
        } catch (Exception e) {
            Log.e(TAG, "启动隧道失败", e);
        }
    }

    private void extractCloudkitIfNeeded(File kitDir) throws Exception {
        File flag = new File(kitDir, ".ok");
        if (flag.exists()) {
            Log.i(TAG, "cloudkit 已解压过，跳过");
            return;
        }
        Log.i(TAG, "开始解压 cloudkit.zip...");
        if (!kitDir.exists()) kitDir.mkdirs();
        extractZip("cloudkit.zip", filesDir); // zip 内自带 cloudkit/ 前缀
        // proot/loader/cloudflared 由系统从 APK lib/ 提取到 nativeLibraryDir（自带执行权限）
        new File(kitDir, "rootfs/tmp").mkdirs();
        flag.createNewFile();
        Log.i(TAG, "cloudkit 解压完成");
    }

    private String extractTunnelUrl(File log) {
        try {
            if (!log.exists()) return null;
            String content = readFile(log);
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("https://[a-z0-9-]+\\.trycloudflare\\.com").matcher(content);
            while (m.find()) {
                String u = m.group();
                if (!u.contains("api.")) return u;
            }
        } catch (Exception e) {
        }
        return null;
    }

    private String readFile(File f) throws Exception {
        java.io.FileInputStream fis = new java.io.FileInputStream(f);
        try {
            byte[] b = new byte[(int) Math.min(f.length(), 65536)];
            int n = fis.read(b);
            return new String(b, 0, n > 0 ? n : 0);
        } finally {
            fis.close();
        }
    }

    private boolean isServerUp() {
        try {
            Socket socket = new Socket();
            socket.connect(new InetSocketAddress("127.0.0.1", SERVER_PORT), 1000);
            socket.close();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void extractIfNeeded() throws Exception {
        File flag = new File(filesDir, ".installed");
        if (flag.exists()) {
            Log.i(TAG, "组件已解压过，跳过");
            return;
        }
        Log.i(TAG, "开始解压 server.zip...");
        extractZip("server.zip", filesDir);
        Log.i(TAG, "server.zip 完成，复制 openssl.cnf...");
        copyAsset("openssl.cnf", new File(filesDir, "openssl.cnf"));
        // node 由系统从 APK lib/ 提取到 nativeLibraryDir，验证存在
        File node = new File(nativeLibDir, "libnode.so");
        if (!node.exists() || node.length() < 1000000) {
            Log.e(TAG, "node 二进制异常: " + node.getAbsolutePath() + " exists=" + node.exists() + " size=" + node.length());
            throw new Exception("node 二进制异常");
        }
        flag.createNewFile();
        Log.i(TAG, "解压全部完成，node 就绪: " + node.getAbsolutePath());
    }

    private void extractZip(String assetName, File dest) throws Exception {
        InputStream in = getAssets().open(assetName);
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

    private void copyAsset(String name, File dest) throws Exception {
        InputStream in = getAssets().open(name);
        FileOutputStream fos = new FileOutputStream(dest);
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
        fos.close();
        in.close();
    }

    private void startServer() throws Exception {
        File node = new File(nativeLibDir, "libnode.so");
        File serverDir = filesDir; // v3.1 修复：解压根目录就是 filesDir，原来指向不存在的 files/server 导致 execve error=2
        File outLog = new File(filesDir, "server.log");

        Log.i(TAG, "启动服务: " + node.getAbsolutePath() + " 存在=" + node.exists());
        ProcessBuilder pb = new ProcessBuilder(node.getAbsolutePath(), "backend/dist/index.js");
        pb.directory(serverDir);
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
        try {
            pb.start();
            Log.i(TAG, "node 进程已启动");
        } catch (Exception e) {
            Log.e(TAG, "node 进程启动失败（可能被系统拦截）", e);
            throw e;
        }
    }

    private void enterImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    @Override
    public void onBackPressed() {
        if (customView != null) {
            webView.getWebChromeClient().onHideCustomView();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == ScreenShareManager.REQ_CODE) {
            ScreenShareManager.get().onActivityResult(resultCode, data);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        enterImmersive();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}