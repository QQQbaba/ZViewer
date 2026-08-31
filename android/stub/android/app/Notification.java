package android.app;
import android.content.Context;
public class Notification {
    public Notification() {}
    public static class Builder {
        public Builder(Context context) {}
        public Builder(Context context, String channelId) {}
        public Builder setContentTitle(CharSequence title) { return this; }
        public Builder setContentText(CharSequence text) { return this; }
        public Builder setSmallIcon(int icon) { return this; }
        public Builder setContentIntent(PendingIntent pi) { return this; }
        public Builder addAction(int icon, CharSequence title, PendingIntent pi) { return this; }
        public Builder setOngoing(boolean ongoing) { return this; }
        public Notification build() { return null; }
    }
}