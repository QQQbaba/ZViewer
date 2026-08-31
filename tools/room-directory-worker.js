// ZViewer 房间目录（Cloudflare Worker）
// 部署：Dashboard → Workers → 创建 → 粘贴本代码 → 绑定 KV namespace（rooms）
// KV 建议 TTL 由房主上报控制（默认 4 小时过期，房主续期）
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (method === 'OPTIONS') return new Response(null, { headers: cors });

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...cors },
      });

    try {
      // GET /api/rooms?search=xx&limit=20 —— 发现/搜索公开房间
      if (method === 'GET' && path === '/api/rooms') {
        const search = (url.searchParams.get('search') || '').trim().toLowerCase();
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100);
        const now = Date.now();
        const list = await env.rooms.list({ prefix: 'room:', limit: 1000 });
        const out = [];
        for (const key of list.keys) {
          const raw = await env.rooms.get(key.name);
          if (!raw) continue;
          try {
            const r = JSON.parse(raw);
            if (r.expiresAt && r.expiresAt <= now) {
              await env.rooms.delete(key.name); // 清理过期
              continue;
            }
            if (!search || (r.name || '').toLowerCase().includes(search) || (r.roomId || '').toLowerCase().includes(search)) {
              out.push({ roomId: r.roomId, name: r.name || r.roomId, url: r.url, updatedAt: r.updatedAt });
            }
          } catch { /* 坏数据跳过 */ }
        }
        out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return json({ success: true, rooms: out.slice(0, limit) });
      }

      // GET /api/rooms/:roomId —— 按房间号查房主地址
      const roomMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)$/);
      if (method === 'GET' && roomMatch) {
        const raw = await env.rooms.get('room:' + roomMatch[1]);
        if (!raw) return json({ success: false, message: '房间不存在或未公开' }, 404);
        const r = JSON.parse(raw);
        if (r.expiresAt && r.expiresAt <= Date.now()) {
          await env.rooms.delete('room:' + roomMatch[1]);
          return json({ success: false, message: '房间已过期' }, 404);
        }
        return json({ success: true, room: { roomId: r.roomId, name: r.name, url: r.url } });
      }

      // POST /api/rooms —— 房主上报/续期 { roomId, name, url, ttlHours }
      if (method === 'POST' && path === '/api/rooms') {
        const body = await request.json().catch(() => null);
        if (!body || !body.roomId || !body.url) {
          return json({ success: false, message: '缺少 roomId 或 url' }, 400);
        }
        // 可选写保护：部署时设置 SECRET 环境变量，上报需带 secret
        if (env.SECRET && body.secret !== env.SECRET) {
          return json({ success: false, message: 'secret 错误' }, 403);
        }
        const ttlHours = Math.min(parseFloat(body.ttlHours) || 4, 24);
        const record = {
          roomId: body.roomId,
          name: (body.name || body.roomId).slice(0, 50),
          url: body.url,
          ttlHours,
          updatedAt: Date.now(),
          expiresAt: Date.now() + ttlHours * 3600 * 1000,
        };
        await env.rooms.put('room:' + body.roomId, JSON.stringify(record), { expirationTtl: Math.ceil(ttlHours * 3600) });
        return json({ success: true, message: '房间已公开', expiresAt: record.expiresAt });
      }

      // DELETE /api/rooms/:roomId —— 房主下架
      if (method === 'DELETE' && roomMatch) {
        await env.rooms.delete('room:' + roomMatch[1]);
        return json({ success: true, message: '已下架' });
      }

      return json({ success: false, message: 'Not Found' }, 404);
    } catch (e) {
      return json({ success: false, message: 'Server Error: ' + e.message }, 500);
    }
  },
};