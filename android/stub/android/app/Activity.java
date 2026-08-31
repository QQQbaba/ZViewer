package android.app;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.Window;

public class Activity extends Context {
    public static final int RESULT_OK = -1;
    public Activity() {}
    protected void onCreate(Bundle savedInstanceState) {}
    protected void onResume() {}
    protected void onPause() {}
    protected void onDestroy() {}
    public void onBackPressed() {}
    public void setContentView(View view) {}
    public Window getWindow() { return null; }
    public void runOnUiThread(Runnable action) {}
    public void requestPermissions(String[] permissions, int requestCode) {}
    public void startActivityForResult(Intent intent, int requestCode) {}
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {}
}