package android.webkit;

public class WebViewClient {
    public WebViewClient() {}
    public boolean shouldOverrideUrlLoading(WebView view, String url) { return false; }
    @Deprecated
    public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {}
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {}
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) { return false; }
    public void onPageFinished(WebView view, String url) {}
}