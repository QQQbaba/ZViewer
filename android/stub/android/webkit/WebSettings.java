package android.webkit;

public class WebSettings {
    public static final int LOAD_DEFAULT = -1;
    public static final int MIXED_CONTENT_ALWAYS_ALLOW = 2;
    public void setJavaScriptEnabled(boolean enabled) {}
    public void setDomStorageEnabled(boolean enabled) {}
    public void setDatabaseEnabled(boolean enabled) {}
    public void setMediaPlaybackRequiresUserGesture(boolean require) {}
    public void setAllowFileAccess(boolean allow) {}
    public void setLoadWithOverviewMode(boolean overview) {}
    public void setUseWideViewPort(boolean use) {}
    public void setCacheMode(int mode) {}
    public void setMixedContentMode(int mode) {}
}