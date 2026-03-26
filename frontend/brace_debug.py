from pathlib import Path
p = Path('app/page.tsx')
text = p.read_text(encoding='utf-8')

depth = 0
for i, line in enumerate(text.splitlines(), 1):
    for c in line:
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
    if i >= 2180 and i <= 2270:
        print(i, depth, line.strip())
    if depth < 0:
        print('negative depth at', i)
        break
print('final depth', depth)
