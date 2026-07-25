#!/bin/bash
# 测试 512KB 头部下载
VIDEO_URL="https://upos-sz-mirror08h.bilivideo.com/upgcxcode/99/91/137649199/137649199_da2-1-30080.m4s?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=&deadline=1784999292&uipk=5&oi=0x24098a34085454907d3857cb3f152ea9&trid=4f2ffbddd44d46c9bf02894ed6e2300u&gen=playurlv3&os=08hbv&og=hw&platform=pc&mid=3546978757642904&nbs=1&upsig=fb17f81e6988a81aad562595529cb445&uparams=e,deadline,uipk,oi,trid,gen,os,og,platform,mid,nbs&bvc=vod&nettype=0&bw=2632421&lrs=81&agrr=0&buvid=F6FAD911-AB3D-8600-5A60-51D580EFC77111694infoc&build=0&dl=0&f=u_0_0&qn_dyeid=b5d8beec31dcdda700cb8ccc6a64d15c&orderid=1,3"
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$VIDEO_URL', safe=''))")
echo "=== 下载 512KB 头部 ==="
curl.exe -s -b cookies.txt -D headers.txt -o head512k.bin -H "Range: bytes=0-524287" "http://localhost:3333/api/stream/proxy?url=$ENCODED"
echo "下载完成"
echo ""
echo "=== 响应头 ==="
cat headers.txt
echo ""
echo "=== 文件大小 ==="
wc -c < head512k.bin
echo ""
echo "=== 扫描 MP4 box 结构 ==="
python3 -c "
import struct
data = open('head512k.bin','rb').read()
print(f'数据大小: {len(data)}')
offset = 0
boxes = []
while offset < len(data):
    if offset + 8 > len(data): break
    size = struct.unpack('>I', data[offset:offset+4])[0]
    btype = data[offset+4:offset+8].decode('ascii', errors='replace')
    if size == 1:
        if offset + 16 > len(data): break
        size = struct.unpack('>Q', data[offset+8:offset+16])[0]
    if size == 0:
        size = len(data) - offset
    if size < 8 or offset + size > len(data):
        print(f'  offset={offset} type={btype} size={size} (无效，停止)')
        break
    print(f'  offset={offset} type={btype} size={size} end={offset+size}')
    boxes.append((btype, offset, size))
    offset += size
print()
print(f'找到 {len(boxes)} 个 top-level box')
ftyp = [b for b in boxes if b[0]=='ftyp']
moov = [b for b in boxes if b[0]=='moov']
sidx = [b for b in boxes if b[0]=='sidx']
print(f'ftyp: {ftyp}')
print(f'moov: {moov}')
print(f'sidx: {sidx}')
if moov:
    _, moff, msize = moov[0]
    if moff + msize <= len(data):
        print(f'moov 完整: 是 (end={moff+msize} <= {len(data)})')
    else:
        print(f'moov 完整: 否 (end={moff+msize} > {len(data)})')
"
