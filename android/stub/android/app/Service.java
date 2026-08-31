package android.app;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
public abstract class Service extends Context {
    public static final int START_STICKY = 1;
    public static final int START_NOT_STICKY = 2;
    public Service() {}
    public void onCreate() {}
    public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }
    public void onDestroy() {}
    public abstract IBinder onBind(Intent intent);
    public final void startForeground(int id, Notification notification) {}
    public final void startForeground(int id, Notification notification, int foregroundServiceType) {}
    public final void stopForeground(boolean removeNotification) {}
    public final void stopSelf() {}
}