"""Builds the round-3 version of the Braindump Filter Rail page from the round-2 file and a config.

python3 gen.py config.json -> writes filter-rail.html and files.json (published path -> source path)
"""
import html, json, struct, sys, os, re

SP = '/tmp/claude-0/-home-claude-dsul/ab30be3b-ab8d-5f59-97ae-7b55d7f2343a/scratchpad'
OLD = SP + '/filter-rail.html'
HERE = os.path.dirname(os.path.abspath(__file__))
cfg = json.load(open(sys.argv[1]))

def png_size(p):
    with open(p, 'rb') as f:
        head = f.read(24)
    w, h = struct.unpack('>II', head[16:24])
    return w, h

files = {}
def fig(s, cls=''):
    w, h = png_size(s['src'])
    files[s['file']] = s['src']
    cw, ch = w // 2, h // 2
    was = f' <span class="was">today {s["was"]}px</span>' if s.get('was') is not None else ''
    hh = f'<span class="hpx">shelf {s["h"]}px</span>{was}' if s.get('h') is not None else ''
    return (f'<figure class="shot {cls}" style="--w:{cw}px"><img src="{s["file"]}" width="{cw}" height="{ch}" alt="{html.escape(s["alt"])}" loading="lazy">'
            f'<figcaption><span class="where">{html.escape(s["cap"])}</span>{hh}</figcaption></figure>')

old = open(OLD).read()
style_end = old.index('</style>')
page_start = old.index('<div class="page">')
script_start = old.index('<script>')
head_css = old[:style_end]
old_page = old[page_start:script_start]
old_script = old[script_start:]

# The old page becomes the "earlier rounds" part: its h1 steps down to a section heading.
old_inner = old_page[len('<div class="page">'):old_page.rstrip().rindex('</div>')]
old_inner = old_inner.replace('<div class="eyebrow">dsul · braindump sidebar</div>', '<div class="eyebrow">Round 2 · September 24 · braindump sidebar</div>', 1)
old_inner = old_inner.replace('<h1 style="margin-top:6px">A calmer capsule shelf</h1>', '<h2 class="round-h">A calmer capsule shelf</h2>', 1)

R3_CSS = open(os.path.join(HERE, 'r3.css')).read()

parts = []
parts.append('<div class="page">')
parts.append('<header class="r3-head">')
parts.append(f'<div class="eyebrow">{html.escape(cfg["eyebrow"])}</div>')
parts.append(f'<h1 style="margin-top:6px">{html.escape(cfg["title"])}</h1>')
parts.append(f'<p class="lede">{cfg["lede"]}</p>')
parts.append('</header>')

t = cfg['today']
parts.append('<section class="variant ref r3-today">')
parts.append(f'<div class="v-head"><h2>{html.escape(t["name"])}</h2></div>')
parts.append(f'<p class="v-copy">{t["copy"]}</p>')
parts.append('<div class="shots">' + ''.join(fig(s) for s in t['shots']) + '</div>')
parts.append('</section>')

for o in cfg['options']:
    parts.append(f'<section class="variant r3-opt" id="option-{o["key"].lower()}">')
    rec = '<span class="rec">Recommended</span>' if o.get('rec') else ''
    parts.append(f'<div class="v-head"><h2>{html.escape(o["key"])}. {html.escape(o["name"])}</h2>{rec}</div>')
    parts.append(f'<p class="v-copy">{o["copy"]}</p>')
    parts.append('<ul class="tradeoffs">' + ''.join(f'<li data-k="{html.escape(k)}">{v}</li>' for k, v in o['tradeoffs']) + '</ul>')
    parts.append('<div class="shots">' + ''.join(fig(s) for s in o['shots']) + '</div>')
    if o.get('more'):
        parts.append(f'<p class="more-h">{html.escape(o.get("moreTitle", "Up close"))}</p>')
        parts.append('<div class="shots more">' + ''.join(fig(s, 'small') for s in o['more']) + '</div>')
    parts.append('</section>')

if cfg.get('notes'):
    parts.append('<div class="notes r3-notes">')
    for n in cfg['notes']:
        parts.append(f'<div class="note"><h3>{html.escape(n["h"])}</h3><ul>' + ''.join(f'<li>{li}</li>' for li in n['items']) + '</ul></div>')
    parts.append('</div>')

parts.append('<hr class="rounds-rule">')
parts.append('<div class="earlier">')
parts.append(old_inner)
parts.append('</div>')
parts.append('</div>\n')

out = head_css + R3_CSS + '\n</style>\n\n' + '\n'.join(parts) + '\n' + old_script
open(os.path.join(HERE, 'filter-rail.html'), 'w').write(out)
json.dump(files, open(os.path.join(HERE, 'files.json'), 'w'), indent=1)
print('wrote', len(out), 'bytes,', len(files), 'images,', sum(os.path.getsize(p) for p in files.values()), 'image bytes')
