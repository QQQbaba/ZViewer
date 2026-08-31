#!/bin/bash
# ZViewer 壳 APK 构建脚本 v2 —— 零下载版（stub + 设备 framework-res.apk）
cd "$(dirname "$0")"
BASE=~/apkbuild
FRAMEWORK=/sdcard/Download/framework-res.apk

echo "== [1/5] 编译 stub（API 定义）=="
rm -rf stub_classes classes dexout
mkdir -p stub_classes classes dexout
javac -nowarn -d stub_classes $(find stub -name '*.java') 2>&1 | head -10
echo "stub classes: $(find stub_classes -name '*.class' | wc -l) 个"

echo "== [2/5] 编译 MainActivity =="
javac -nowarn -classpath stub_classes -d classes src/com/zero251/zviewer/MainActivity.java 2>&1 | head -10
ls classes/com/zero251/zviewer/

echo "== [3/5] d8 -> dex =="
BT=$(find "$BASE" -maxdepth 3 -name d8 -type f | head -1 | xargs dirname)
echo "build-tools = $BT"
"$BT/d8" --release --min-api 24 --output dexout $(find classes -name '*.class') 2>&1 | head -10
ls -la dexout/

echo "== [4/5] aapt2 打包资源 =="
rm -f res.zip base.apk
"$BT/aapt2" compile --dir res -o res.zip 2>&1 | head -5
"$BT/aapt2" link -o base.apk -I "$FRAMEWORK" --manifest AndroidManifest.xml -R res.zip \
  --auto-add-overlay --min-sdk-version 24 --target-sdk-version 34 2>&1 | head -10

echo "== [5/5] 加入 dex/assets + zipalign =="
cd dexout && zip -q -X ../base.apk classes.dex && cd ..
zip -q -X -r base.apk assets
"$BT/zipalign" -f -p 4 base.apk aligned.apk
ls -la aligned.apk
echo BUILD_ALL_DONE