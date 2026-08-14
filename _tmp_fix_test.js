// 临时验证脚本：模拟 fixLatin1Decoding + normalizePath 修复链
function fixLatin1Decoding(str) {
  if (!str || !/[\u0080-\u00FF]/.test(str)) return str;
  try {
    const fixed = Buffer.from(str, 'latin1').toString('utf8');
    if (fixed !== str) return fixed;
  } catch {}
  return str;
}
function normalizePath(path) {
  let normalized = path.trim();
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  return normalized
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      try {
        const decoded = fixLatin1Decoding(decodeURIComponent(seg));
        return encodeURIComponent(decoded);
      } catch {
        return encodeURIComponent(fixLatin1Decoding(seg));
      }
    })
    .join('/');
}
const badPath = '/139Cloud/share/[ANi] BanG Dream\u00EF\u00BC\u0081YUME\u00E2\u0088\u009EMITA - 05 [1080P][Baha][WEB-DL][AAC AVC][CHT].mp4';
console.log('input :', badPath);
console.log('fixed :', normalizePath(badPath));
console.log('expect: /139Cloud/share/%5BANi%5D%20BanG%20Dream%EF%BC%81YUME%E2%88%9EMITA%20-%2005%20%5B1080P%5D%5BBaha%5D%5BWEB-DL%5D%5BAAC%20AVC%5D%5BCHT%5D.mp4');
