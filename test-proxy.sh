#!/bin/bash
# 测试 B站 CDN 头部代理
VIDEO_URL="https://upos-sz-mirror08h.bilivideo.com/upgcxcode/99/91/137649199/137649199_da2-1-30080.m4s?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=&deadline=1784999292&uipk=5&oi=0x24098a34085454907d3857cb3f152ea9&trid=4f2ffbddd44d46c9bf02894ed6e2300u&gen=playurlv3&os=08hbv&og=hw&platform=pc&mid=3546978757642904&nbs=1&upsig=fb17f81e6988a81aad562595529cb445&uparams=e,deadline,uipk,oi,trid,gen,os,og,platform,mid,nbs&bvc=vod&nettype=0&bw=2632421&lrs=81&agrr=0&buvid=F6FAD911-AB3D-8600-5A60-51D580EFC77111694infoc&build=0&dl=0&f=u_0_0&qn_dyeid=b5d8beec31dcdda700cb8ccc6a64d15c&orderid=1,3"
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$VIDEO_URL', safe=''))")
echo "=== 代理请求 URL ==="
echo "http://localhost:3333/api/stream/proxy?url=$ENCODED"
echo ""
echo "=== 响应头 ==="
curl.exe -s -b cookies.txt -D - -o head.bin -H "Range: bytes=0-511" "http://localhost:3333/api/stream/proxy?url=$ENCODED"
echo ""
echo "=== 响应体大小 ==="
ls -la head.bin 2>/dev/null || wc -c < head.bin
echo ""
echo "=== 前 32 字节 hex ==="
xxd head.bin | head -2
