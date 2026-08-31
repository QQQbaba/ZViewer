package android.media;

import java.nio.ByteBuffer;

public final class MediaFormat {
    public static final String KEY_WIDTH = "width";
    public static final String KEY_HEIGHT = "height";
    public static final String KEY_BIT_RATE = "bitrate";
    public static final String KEY_FRAME_RATE = "frame-rate";
    public static final String KEY_I_FRAME_INTERVAL = "i-frame-interval";
    public static final String KEY_COLOR_FORMAT = "color-format";
    public static final String KEY_MIME = "mime";
    public static final String KEY_MAX_INPUT_SIZE = "max-input-size";

    public MediaFormat() {
    }

    public static MediaFormat createVideoFormat(String mime, int width, int height) {
        return null;
    }

    public void setInteger(String name, int value) {
    }

    public ByteBuffer getByteBuffer(String name) {
        return null;
    }

    public int getInteger(String name) {
        return 0;
    }

    public boolean containsKey(String name) {
        return false;
    }
}