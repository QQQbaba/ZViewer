package com.zero251.zviewer;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;

/**
 * 精简 RTMP 推流器（H.264-only，无音频）：
 * 把 MediaCodec 输出的 AVC 帧封装成 FLV 通过 RTMP 推到本机 Node-Media-Server（127.0.0.1:3334）。
 */
public class RtmpPublisher {
    private static final String TAG = "RtmpPub";

    private Socket socket;
    private DataOutputStream out;
    private InputStream in;
    private int chunkSize = 128;
    // RTMP 协议：connect/createStream/setChunkSize 属于连接级消息，必须用 stream id 0；
    // createStream 成功后 this.streamId 更新为服务器分配的流 id，供 publish/音视频使用。
    private int streamId = 0;
    private long startTimeMs = 0;

    /** 建立 TCP + RTMP 握手 + connect + createStream + publish，并发送 metadata 与 AVC sequence header */
    public void connectAndPublish(String host, int port, String app, String streamKey,
                                  byte[] sps, byte[] pps, int width, int height) throws Exception {
        socket = new Socket(host, port);
        socket.setTcpNoDelay(true);
        socket.setSoTimeout(8000); // 握手/响应超时保护，避免卡死
        out = new DataOutputStream(socket.getOutputStream());
        in = socket.getInputStream();
        startTimeMs = System.currentTimeMillis();

        handshake();
        sendConnect(app, host, port);
        waitCommandResult("connect");
        sendCreateStream();
        this.streamId = waitCreateStreamResult();
        sendPublish(streamKey);
        waitPublishAck();
        sendSetChunkSize(4096);
        sendMetadata(width, height);
        sendAvcSequenceHeader(sps, pps);
        Log.i(TAG, "RTMP 推流已就绪 streamKey=" + streamKey);
    }

    /** 发送一帧（AVC 格式，4 字节长度前缀） */
    public void sendVideoFrame(byte[] avcData, int offset, int size, long ptsMs, boolean keyFrame) throws Exception {
        // 拆 NAL（4 字节长度前缀）
        int pos = offset;
        int end = offset + size;
        while (pos + 4 <= end) {
            int len = ((avcData[pos] & 0xFF) << 24) | ((avcData[pos + 1] & 0xFF) << 16)
                    | ((avcData[pos + 2] & 0xFF) << 8) | (avcData[pos + 3] & 0xFF);
            pos += 4;
            if (len <= 0 || pos + len > end) break;
            sendFlvVideoTag(avcData, pos, len, ptsMs, keyFrame);
            pos += len;
        }
    }

    public void close() {
        try {
            if (socket != null) {
                // 发送 FCUnpublish + deleteStream 后关闭
                try {
                    sendCommand("FCUnpublish", 0.0, null, new Object[]{"null"}, null);
                    sendCommand("deleteStream", 0.0, null, new Object[]{}, null);
                } catch (Exception ignored) {
                }
                socket.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "close 异常", e);
        } finally {
            socket = null;
        }
    }

    // ---------- RTMP 握手 ----------
    private void handshake() throws Exception {
        out.writeByte(0x03); // C0
        byte[] c1 = new byte[1536];
        for (int i = 0; i < c1.length; i++) c1[i] = (byte) (Math.random() * 256);
        out.write(c1); // C1
        out.flush();
        // 读 S0 S1 S2
        byte[] s = new byte[3073];
        int got = 0;
        while (got < s.length) {
            int n = in.read(s, got, s.length - got);
            if (n < 0) throw new Exception("握手失败: 连接关闭");
            got += n;
        }
        // 发 C2（回显 S1）
        out.write(s, 1, 1536);
        out.flush();
    }

    // ---------- 命令 ----------
    private void sendConnect(String app, String host, int port) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(baos);
        writeAmfString(d, "connect");
        writeAmfNumber(d, 1.0);
        writeAmfObjectStart(d);
        writeAmfString(d, "app");
        writeAmfString(d, app);
        writeAmfString(d, "flashVer");
        writeAmfString(d, "FMLE/3.0 (compatible; ZViewer)");
        writeAmfString(d, "tcUrl");
        writeAmfString(d, "rtmp://" + host + ":" + port + "/" + app);
        writeAmfString(d, "fpad");
        writeAmfBoolean(d, false);
        writeAmfString(d, "capabilities");
        writeAmfNumber(d, 15.0);
        writeAmfString(d, "audioCodecs");
        writeAmfNumber(d, 4071.0);
        writeAmfString(d, "videoCodecs");
        writeAmfNumber(d, 252.0);
        writeAmfString(d, "videoFunction");
        writeAmfNumber(d, 1.0);
        writeAmfObjectEnd(d);
        sendChunk(3, 20, 0, baos.toByteArray());
    }

    private void sendCreateStream() throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(baos);
        writeAmfString(d, "createStream");
        writeAmfNumber(d, 2.0);
        writeAmfNull(d);
        sendChunk(3, 20, 0, baos.toByteArray());
    }

    private void sendPublish(String streamKey) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(baos);
        writeAmfString(d, "publish");
        writeAmfNumber(d, 0.0);
        writeAmfNull(d);
        writeAmfString(d, streamKey);
        writeAmfString(d, "live");
        sendChunk(3, 20, 0, baos.toByteArray());
    }

    private void sendCommand(String name, double txId, Object ctx, Object[] args, Object last) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(baos);
        writeAmfString(d, name);
        writeAmfNumber(d, txId);
        if (ctx != null) writeAmfNull(d);
        if (args != null) for (Object a : args) if (a instanceof String) writeAmfString(d, (String) a);
        if (last != null && last instanceof String) writeAmfString(d, (String) last);
        sendChunk(3, 20, 0, baos.toByteArray());
    }

    private void waitCommandResult(String expect) throws Exception {
        // 读到命令类型消息，事务号匹配
        long deadline = System.currentTimeMillis() + 8000;
        while (System.currentTimeMillis() < deadline) {
            RtmpMessage msg = readMessage();
            if (msg == null) continue;
            if (msg.type == 20) {
                // 解析命令名（第一个 AMF string）
                String name = parseAmfString(msg.payload, 0);
                if ("_result".equals(name)) return;
            }
        }
        throw new Exception("等待 " + expect + " 响应超时");
    }

    private int waitCreateStreamResult() throws Exception {
        long deadline = System.currentTimeMillis() + 8000;
        while (System.currentTimeMillis() < deadline) {
            RtmpMessage msg = readMessage();
            if (msg == null) continue;
            if (msg.type == 20) {
                String name = parseAmfString(msg.payload, 0);
                if ("_result".equals(name)) {
                    // payload: [_result][事务号(Number)][Null][streamId(Number)]
                    // streamId 是最后一个 AMF Number（从后往前找，避免误取事务号）
                    byte[] p = msg.payload;
                    for (int i = p.length - 9; i >= 0; i--) {
                        if (p[i] == 0x00) { // AMF Number 标记
                            long bits = 0;
                            for (int j = 0; j < 8; j++) {
                                bits = (bits << 8) | (p[i + 1 + j] & 0xFF);
                            }
                            double d = Double.longBitsToDouble(bits);
                            if (d >= 0 && d < 100000) {
                                return (int) d;
                            }
                        }
                    }
                    // 兼容旧逻辑：取最后 4 字节（某些服务器返回裸 int）
                    return ((p[p.length - 4] & 0xFF) << 24) | ((p[p.length - 3] & 0xFF) << 16)
                            | ((p[p.length - 2] & 0xFF) << 8) | (p[p.length - 1] & 0xFF);
                }
            }
        }
        throw new Exception("createStream 超时");
    }

    private void waitPublishAck() throws Exception {
        long deadline = System.currentTimeMillis() + 8000;
        while (System.currentTimeMillis() < deadline) {
            RtmpMessage msg = readMessage();
            if (msg == null) continue;
            if (msg.type == 20) {
                String name = parseAmfString(msg.payload, 0);
                if ("onFCPublish".equals(name) || "_result".equals(name)) return;
            }
        }
    }

    // ---------- 数据消息 ----------
    private void sendSetChunkSize(int size) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(baos);
        d.writeInt(size);
        sendChunk(2, 1, 0, baos.toByteArray());
        chunkSize = size;
    }

    private void sendMetadata(int width, int height) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(baos);
        writeAmfString(d, "@setDataFrame");
        writeAmfString(d, "onMetaData");
        writeAmfObjectStart(d);
        writeAmfString(d, "width");
        writeAmfNumber(d, width);
        writeAmfString(d, "height");
        writeAmfNumber(d, height);
        writeAmfString(d, "framerate");
        writeAmfNumber(d, 30.0);
        writeAmfString(d, "videocodecid");
        writeAmfNumber(d, 7.0);
        writeAmfString(d, "avcprofile");
        writeAmfNumber(d, 100.0);
        writeAmfString(d, "avclevel");
        writeAmfNumber(d, 31.0);
        writeAmfObjectEnd(d);
        sendChunk(3, 18, 0, baos.toByteArray());
    }

    private void sendAvcSequenceHeader(byte[] sps, byte[] pps) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(baos);
        d.writeByte(0x17); // key frame + AVC
        d.writeByte(0x00); // AVC sequence header
        d.writeByte(0x00); d.writeByte(0x00); d.writeByte(0x00); // composition time
        d.writeByte(0x01); // version
        if (sps != null && sps.length >= 4) {
            d.writeByte(sps[1]); d.writeByte(sps[2]); d.writeByte(sps[3]); // profile/compat/level
        } else {
            d.writeByte(0x64); d.writeByte(0x00); d.writeByte(0x1f);
        }
        d.writeByte(0xFF); // 6 bits reserved + 2 bits lengthSizeMinusOne = 3
        d.writeByte(0xE1); // 3 bits reserved + 5 bits numOfSPS = 1
        if (sps != null) {
            d.writeShort(sps.length);
            d.write(sps);
        }
        d.writeByte(0x01); // numOfPPS
        if (pps != null) {
            d.writeShort(pps.length);
            d.write(pps);
        }
        sendFlvTag(9, 0, baos.toByteArray());
    }

    private void sendFlvVideoTag(byte[] data, int offset, int len, long ptsMs, boolean keyFrame) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(baos);
        d.writeByte(keyFrame ? 0x17 : 0x27); // frame type + AVC
        d.writeByte(0x01); // AVC NALU
        d.writeByte(0x00); d.writeByte(0x00); d.writeByte(0x00); // composition time
        d.writeInt(len); // NALU 长度
        d.write(data, offset, len);
        sendFlvTag(9, ptsMs, baos.toByteArray());
    }

    private void sendFlvTag(int type, long ptsMs, byte[] payload) throws Exception {
        long ts = ptsMs; // 已经换算好的毫秒
        ByteArrayOutputStream header = new ByteArrayOutputStream();
        DataOutputStream h = new DataOutputStream(header);
        // 11 字节 FLV tag header
        h.writeByte(type);
        h.writeByte((payload.length >> 16) & 0xFF);
        h.writeByte((payload.length >> 8) & 0xFF);
        h.writeByte(payload.length & 0xFF);
        h.writeByte((int) ((ts >> 16) & 0xFF));
        h.writeByte((int) ((ts >> 8) & 0xFF));
        h.writeByte((int) (ts & 0xFF));
        h.writeByte((int) ((ts >> 24) & 0xFF)); // extended timestamp
        h.writeByte(0x00); h.writeByte(0x00); h.writeByte(0x00); // stream id
        byte[] hb = header.toByteArray();
        byte[] tag = new byte[11 + payload.length + 4];
        System.arraycopy(hb, 0, tag, 0, 11);
        System.arraycopy(payload, 0, tag, 11, payload.length);
        int dataSize = 11 + payload.length;
        tag[dataSize] = (byte) ((payload.length >> 24) & 0xFF);
        tag[dataSize + 1] = (byte) ((payload.length >> 16) & 0xFF);
        tag[dataSize + 2] = (byte) ((payload.length >> 8) & 0xFF);
        tag[dataSize + 3] = (byte) (payload.length & 0xFF);
        // 以 RTMP chunk 发送：csid=6, fmt=0 头部 + payload 分块
        sendChunk(6, type, ts, tag);
    }

    // ---------- 底层 chunk 发送 ----------
    private void sendChunk(int csid, int msgType, long ts, byte[] payload) throws Exception {
        // 基本头 fmt=0
        out.writeByte(csid);
        // 消息头
        out.writeByte((int) ((ts >> 16) & 0xFF));
        out.writeByte((int) ((ts >> 8) & 0xFF));
        out.writeByte((int) (ts & 0xFF));
        out.writeByte((payload.length >> 16) & 0xFF);
        out.writeByte((payload.length >> 8) & 0xFF);
        out.writeByte(payload.length & 0xFF);
        out.writeByte(msgType);
        // message stream id：4 字节小端
        out.writeByte(streamId & 0xFF);
        out.writeByte((streamId >> 8) & 0xFF);
        out.writeByte((streamId >> 16) & 0xFF);
        out.writeByte((streamId >> 24) & 0xFF);
        out.flush();
        // 分块发送 payload
        int pos = 0;
        while (pos < payload.length) {
            int n = Math.min(chunkSize, payload.length - pos);
            if (pos > 0) out.writeByte(0xC0 | csid); // fmt=3 延续块头（0xC0=fmt3）
            out.write(payload, pos, n);
            pos += n;
        }
        out.flush();
    }

    // ---------- 读消息 ----------
    private RtmpMessage readMessage() throws Exception {
        int b0 = in.read();
        if (b0 < 0) return null;
        int csid = b0 & 0x3F;
        int fmt = (b0 >> 6) & 0x03;
        // 读消息头（fmt=0：11 字节）
        byte[] mh = new byte[11];
        int got = 0;
        while (got < 11) {
            int n = in.read(mh, got, 11 - got);
            if (n < 0) return null;
            got += n;
        }
        int ts = ((mh[0] & 0xFF) << 16) | ((mh[1] & 0xFF) << 8) | (mh[2] & 0xFF);
        int len = ((mh[3] & 0xFF) << 16) | ((mh[4] & 0xFF) << 8) | (mh[5] & 0xFF);
        int type = mh[6] & 0xFF;
        // 读 payload（可能有延续块）
        byte[] payload = new byte[len];
        int got2 = 0;
        while (got2 < len) {
            int n = in.read(payload, got2, len - got2);
            if (n < 0) return null;
            got2 += n;
        }
        RtmpMessage m = new RtmpMessage();
        m.type = type;
        m.payload = payload;
        return m;
    }

    private static class RtmpMessage {
        int type;
        byte[] payload;
    }

    // ---------- AMF0 ----------
    private static void writeAmfString(DataOutputStream d, String s) throws Exception {
        byte[] b = s.getBytes("UTF-8");
        d.writeByte(0x02);
        d.writeShort(b.length);
        d.write(b);
    }

    private static void writeAmfNumber(DataOutputStream d, double v) throws Exception {
        d.writeByte(0x00);
        d.writeLong(Double.doubleToLongBits(v));
    }

    private static void writeAmfBoolean(DataOutputStream d, boolean v) throws Exception {
        d.writeByte(0x01);
        d.writeByte(v ? 1 : 0);
    }

    private static void writeAmfNull(DataOutputStream d) throws Exception {
        d.writeByte(0x05);
    }

    private static void writeAmfObjectStart(DataOutputStream d) throws Exception {
        d.writeByte(0x03);
    }

    private static void writeAmfObjectEnd(DataOutputStream d) throws Exception {
        d.writeByte(0x00);
        d.writeByte(0x00);
        d.writeByte(0x09);
    }

    private static String parseAmfString(byte[] data, int offset) {
        if (offset + 3 > data.length) return "";
        int len = ((data[offset + 1] & 0xFF) << 8) | (data[offset + 2] & 0xFF);
        if (offset + 3 + len > data.length) return "";
        try {
            return new String(data, offset + 3, len, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }
}