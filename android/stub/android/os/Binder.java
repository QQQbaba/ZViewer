package android.os;

public class Binder implements IBinder {
    public Binder() {
    }

    public String getInterfaceDescriptor() {
        return null;
    }

    public boolean transact(int code, Parcel data, Parcel reply, int flags) {
        return false;
    }
}