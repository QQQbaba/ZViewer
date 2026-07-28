lines = open('cli-node/src/server.ts', 'r', encoding='utf-8').readlines()
start = next(i for i, l in enumerate(lines) if 'return `' in l)
end = next(i for i in range(start + 1, len(lines)) if lines[i].strip().endswith('`;'))
html = ''.join(lines[start:end + 1])
html = html.split('`', 1)[1]
html = html.rsplit('`', 1)[0]
open('cli/page.html', 'w', encoding='utf-8').write(html)
print('ok', len(html))
