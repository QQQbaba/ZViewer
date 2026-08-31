package android.content;
import android.content.pm.ApplicationInfo;
import android.content.res.AssetManager;
import java.io.File;
public abstract class Context {
    public static final String CLIPBOARD_SERVICE = "clipboard";
    public static final String MEDIA_PROJECTION_SERVICE = "media_projection";
    public static final int RECEIVER_NOT_EXPORTED = 4;
    public Context() {}
    public File getFilesDir() { return null; }
    public File getExternalFilesDir(String type) { return null; }
    public AssetManager getAssets() { return null; }
    public ApplicationInfo getApplicationInfo() { return null; }
    public Object getSystemService(String name) { return null; }
    public <T> T getSystemService(Class<T> serviceClass) { return null; }
    public void startService(Intent service) {}
    public boolean bindService(Intent service, ServiceConnection conn, int flags) { return false; }
    public void startForegroundService(Intent service) {}
    public void registerReceiver(BroadcastReceiver receiver, IntentFilter filter, int flags) {}
    public void unregisterReceiver(BroadcastReceiver receiver) {}
}