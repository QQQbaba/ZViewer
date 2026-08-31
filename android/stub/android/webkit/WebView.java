package android.webkit;

import android.content.Context;
import android.view.View;

public class WebView extends View {
    public WebView(Context context) {}
    public void setWebViewClient(WebViewClient client) {}
    public void setWebChromeClient(WebChromeClient client) {}
    public WebSettings getSettings() { return null; }
    public void setBackgroundColor(int color) {}
    public void loadUrl(String url) {}
    public boolean canGoBack() { return false; }
    public void goBack() {}
    public void onResume() {}
    public void onPause() {}
    public void stopLoading() {}
    public void destroy() {}
    public WebChromeClient getWebChromeClient() { return null; }
    public void addJavascriptInterface(Object obj, String name) {}
    public void evaluateJavascript(String script, ValueCallback<String> callback) {}
}