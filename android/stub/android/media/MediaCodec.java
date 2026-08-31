package android.media;

import android.view.Surface;

public final class MediaCodec {
    public static final int CONFIGURE_FLAG_ENCODE = 1;
    public static final int INFO_TRY_AGAIN_LATER = -1;
    public static final int INFO_OUTPUT_FORMAT_CHANGED = -2;
    public static final int INFO_OUTPUT_BUFFERS_CHANGED = -3;

    public MediaCodec() {
    }

    public static MediaCodec createEncoderByType(String type) {
        return null;
    }

    public void configure(MediaFormat format, Surface surface, MediaCrypto crypto, int flags) {
    }

    public Surface createInputSurface() {
        return null;
    }

    public void start() {
    }

    public void stop() {
    }

    public void release() {
    }

    public int dequeueOutputBuffer(BufferInfo info, long timeoutUs) {
        return 0;
    }

    public java.nio.ByteBuffer getOutputBuffer(int index) {
        return null;
    }

    public void releaseOutputBuffer(int index, boolean render) {
    }

    public MediaFormat getOutputFormat() {
        return null;
    }

    public static class BufferInfo {
        public int size;
        public int offset;
        public long presentationTimeUs;
        public int flags;
        public static final int BUFFER_FLAG_CODEC_CONFIG = 2;
        public static final int BUFFER_FLAG_KEY_FRAME = 1;

        public void set(int newOffset, int newSize, long newTimeUs, int newFlags) {
        }
    }
}