package android.content;
public abstract class BroadcastReceiver {
    public BroadcastReceiver() {}
    public abstract void onReceive(Context context, Intent intent);
}