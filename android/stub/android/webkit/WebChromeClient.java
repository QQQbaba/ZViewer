package android.webkit;

import android.view.View;

public class WebChromeClient {
    public WebChromeClient() {}
    public void onShowCustomView(View view, CustomViewCallback callback) {}
    public void onHideCustomView() {}
    public interface CustomViewCallback {
        void onCustomViewHidden();
    }
}