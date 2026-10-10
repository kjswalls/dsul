#!/usr/bin/env python3
"""Mobile web mockups in the iOS app's structure, drawn in the web app's own look.
Writes boards.html; shoot.mjs screenshots each .phone and each .board."""

I = {
 'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
 'spark': '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
 'grid': '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
 'search': '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
 'plus': '<path d="M5 12h14M12 5v14"/>',
 'inbox': '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
 'list': '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
 'rows': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18"/>',
 'timeline': '<path d="M4 6h9M8 12h12M6 18h8"/><path d="M3 3v18"/>',
 'trash': '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
 'tag': '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1"/>',
 'bell': '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
 'skip': '<path d="m5 4 10 8-10 8V4zM19 5v14"/>',
 'pause': '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
 'tobd': '<path d="M3 19V5M21 12H7m6-6-6 6 6 6"/>',
 'select': '<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
 'clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 'updown': '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
 'check': '<path d="M20 6 9 17l-5-5"/>',
 'sliders': '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
 'chev': '<path d="m9 18 6-6-6-6"/>',
 'chevd': '<path d="m6 9 6 6 6-6"/>',
 'back': '<path d="m15 18-6-6 6-6"/>',
 'repeat': '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
 'leaf': '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
 'target': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
 'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
 'moon': '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
 'sunrise': '<path d="M12 2v6M4.93 10.93l1.41 1.41M2 18h2M20 18h2M17.66 12.34l1.41-1.41M22 22H2M8 6l4-4 4 4M16 18a4 4 0 0 0-8 0"/>',
 'arrowup': '<path d="m5 12 7-7 7 7M12 19V5"/>',
 'mic': '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
 'cal': '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
 'x': '<path d="M18 6 6 18M6 6l12 12"/>',
 'dots': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
 'share': '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>',
 'tabs': '<rect x="3" y="7" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/>',
 'lock': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
 'home': '<path d="M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
 'flame': '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
 'key': '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
}
def ic(n, s=18, w=1.75, cls=''):
    return f'<svg class="ic {cls}" width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round">{I[n]}</svg>'

PROJ = {'Work': 'var(--a3)', 'Home': 'var(--a2)', 'Personal': 'var(--a4)', 'Health': 'var(--a5)'}

def prio(level):
    on = {'high': 3, 'medium': 2, 'low': 1}.get(level, 0)
    col = {'high': 'var(--a5)', 'medium': 'var(--a6)', 'low': 'var(--a1)'}.get(level, 'var(--ink2)')
    bars = ''.join(f'<i style="height:{4+3*k}px;background:{col if k < on else "var(--hair)"}"></i>' for k in range(3))
    return f'<span class="prio">{bars}</span>'

def row(t, proj=None, meta='', p=None, done=False, hab=False, streak=None):
    box = f'<span class="box {"hab" if hab else ""} {"on" if done else ""}">{ic("check", 12, 3) if done else ""}</span>'
    dot = f'<span class="dot" style="background:{PROJ[proj]}"></span>' if proj else ''
    st = f'<span class="streak">{ic("flame", 12, 2)}{streak}</span>' if streak else ''
    return (f'<div class="row {"done" if done else ""}">{box}<span class="t">{t}</span>'
            f'<span class="rm">{st}{f"<span class=meta>{meta}</span>" if meta else ""}{dot}{prio(p) if p else ""}</span></div>')

def statusbar(dark_ink=False):
    return ('<div class="sb"><b>9:41</b><span class="island"></span>'
            '<span class="sbr"><i class="sig"></i><i class="sig"></i><i class="sig"></i><i class="bat"></i></span></div>')

def android_status():
    return '<div class="sb and"><b>9:41</b><span class="sbr"><i class="sig"></i><i class="bat"></i></span></div>'

def header(title='Today', sub='Fri, Oct 2 · Buckets', lay='grid', ring=False, back=False):
    tb = '<span class="todaybtn">Today</span>' if back else ''
    return (f'<div class="hdr"><div class="ttl"><span class="title plain">{title}</span><small>{sub}</small></div>'
            f'<div class="hr">{tb}<span class="capsule {"ring" if ring else ""}">{ic(lay, 17)}{ic("updown", 13, 2)}</span>'
            f'<span class="av">KI</span></div></div>')

def bucket(icon, name, rows, n, note=''):
    body = ''.join(rows) if rows else ''
    return (f'<section class="bkt"><header>{ic(icon, 15)}<b>{name}</b><span class="n">{n if rows else note}</span></header>{body}</section>')

BUCKETS = (
    bucket('clock', 'Anytime', [row('Reply to Avery about pricing', 'Work', '', 'medium'), row('Groceries', 'Home', '', 'low')], 2)
    + bucket('sunrise', 'Morning', [row('Meds', done=True, hab=True, streak=41), row('Stretch 10 min', done=True, hab=True, streak=12),
                                  row('Journal', hab=True, streak=3), row('Draft Q4 roadmap', 'Work', 'Now · 9–11', 'high')], 4)
    + bucket('sun', 'Afternoon', [row('Call the dentist', 'Home', '3 PM', 'medium')], 1)
    + bucket('moon', 'Evening', [], 0, 'Nothing yet')
)
CHIPS = ('<div class="fchips"><span class="pill on">All 8</span><span class="pill">Tasks 5</span><span class="pill">Habits 3</span>'
         '<span class="pill"><span class="dot" style="background:var(--a3)"></span>Work</span><span class="pill"><span class="dot" style="background:var(--a2)"></span>Home</span></div>')
LISTV = (CHIPS + '<div class="grp">' + ic('chevd', 13, 2) + '<b>Morning routine</b><span>2/3</span></div>'
         + row('Meds', done=True, hab=True, streak=41) + row('Stretch 10 min', done=True, hab=True, streak=12) + row('Journal', hab=True, streak=3)
         + '<div class="grp">' + ic('chevd', 13, 2) + '<span class="dot" style="background:var(--a3)"></span><b>Work</b><span>3</span></div>'
         + row('Draft Q4 roadmap', None, 'Now · 9–11', 'high') + row('Reply to Avery about pricing', None, '', 'medium') + row('Review design PR', None, '', 'low')
         + '<div class="grp">' + ic('chevd', 13, 2) + '<span class="dot" style="background:var(--a2)"></span><b>Home</b><span>2</span></div>'
         + row('Call the dentist', None, '3 PM', 'medium') + row('Groceries', None, '', 'low'))

def schedule(drag=False):
    hours = ['8 AM', '9 AM', '10 AM', '11 AM', 'Noon', '1 PM', '2 PM', '3 PM', '4 PM']
    lines = ''.join(f'<div class="hl" style="top:{i*64}px"><small>{h}</small></div>' for i, h in enumerate(hours))
    blocks = (
        '<div class="blk" style="top:0;height:30px;--c:var(--a6)"><b>Morning routine</b></div>'
        '<div class="blk" style="top:64px;height:124px;--c:var(--a3)"><b>Draft Q4 roadmap</b><small>Work · Deep work</small></div>'
        '<div class="now" style="top:110px"><i></i></div>'
        '<div class="blk" style="top:320px;height:60px;--c:var(--a4)"><b>Lunch with Sam</b><small>From your calendar</small></div>'
        '<div class="blk" style="top:448px;height:30px;--c:var(--a2)"><b>Call the dentist</b></div>')
    if drag:
        blocks += ('<div class="ghost" style="top:192px;height:62px"></div>'
                   '<div class="lift" style="top:184px"><span class="box"></span><b>Book flights for Thanksgiving</b><em>11:00</em></div>')
    anytime = ('<div class="anyt"><small>ANYTIME</small><div class="chips"><span class="chip"><span class="box"></span>Groceries</span>'
               '<span class="chip"><span class="box"></span>Reply to Avery</span><span class="chip">+1</span></div></div>')
    return anytime + f'<div class="sched">{lines}{blocks}</div>'

def capture(count=6):
    return (f'<div class="capture"><span class="plus">{ic("plus", 18, 2)}</span><span class="ph">Get it out of your head</span>'
            f'<span class="bdc">{ic("inbox", 15)}{count}</span></div>')

def tabs(active='today'):
    t = [('today', 'sun', 'Today'), ('ask', 'spark', 'Ask'), ('organize', 'grid', 'Organize')]
    items = ''.join(f'<span class="tab {"on" if k == active else ""}">{ic(i, 19)}<small>{l}</small></span>' for k, i, l in t)
    return f'<div class="tabrow"><div class="tabs">{items}</div><span class="circ">{ic("search", 19)}</span></div>'

def collapsed(count=6):
    return (f'<div class="tabrow one"><span class="circ on">{ic("sun", 20)}</span>'
            f'<div class="capture inl"><span class="plus">{ic("plus", 17, 2)}</span><span class="ph">Capture</span><span class="bdc">{ic("inbox", 14)}{count}</span></div>'
            f'<span class="circ">{ic("search", 19)}</span></div>')

def safari_bottom(mini=False):
    if mini:
        return f'<div class="safari mini"><span class="url">{ic("lock", 10, 2)} do.dsul.app</span></div>'
    return (f'<div class="safari"><span class="sbtn">{ic("back", 18, 2)}</span><span class="url">{ic("lock", 11, 2)} do.dsul.app</span>'
            f'<span class="sbtn">{ic("dots", 18, 2)}</span></div>')

def chrome_top():
    return (f'<div class="chrome">{ic("home", 17)}<span class="curl">{ic("lock", 11, 2)} do.dsul.app</span>'
            f'<span class="tabsn">3</span>{ic("dots", 17, 2)}</div>')

def phone(body, frame='pwa', dark=False, id_='', mini=False):
    top = statusbar() if frame in ('pwa', 'safari') else android_status() + chrome_top()
    bottom = safari_bottom(mini) if frame == 'safari' else ('<div class="navbar"><i></i></div>' if frame == 'chrome' else '<div class="homeind"></div>')
    return (f'<div class="phone f-{frame} {"dark" if dark else ""}" id="{id_}"><div class="screen">{top}'
            f'<div class="app">{body}</div>{bottom}</div></div>')

def today(view, sub='Fri, Oct 2 · Buckets', lay='grid', dock=None, extra='', ring=False, back=False, scrolled=False):
    dock = dock if dock is not None else capture() + tabs('today')
    return (header(sub=sub, lay=lay, ring=ring, back=back) + f'<div class="scroll {"scrolled" if scrolled else ""}">{view}</div>'
            + (f'<div class="dock">{dock}</div>' if dock else '') + extra)

S = {}
# b1: one structure, every frame
S['pwa'] = phone(today(BUCKETS), 'pwa', id_='w-pwa')
S['safari'] = phone(today(BUCKETS), 'safari', id_='w-safari')
S['safari-scrolled'] = phone(today(BUCKETS, dock=collapsed(), scrolled=True), 'safari', id_='w-safari-scrolled', mini=True)
S['chrome'] = phone(today(LISTV, 'Fri, Oct 2 · List', 'list'), 'chrome', id_='w-chrome')

# b2: capsule and title
menu = ('<div class="scrim light"></div><div class="menu" style="top:104px;right:56px">'
        f'<small>Layout</small><div class="mi">{ic("list")}List</div><div class="mi on">{ic("grid")}Buckets{ic("check", 16, 2, "ck")}</div>'
        f'<div class="mi">{ic("timeline")}Schedule</div><hr><small>Show</small>'
        f'<div class="mi">{ic("cal")}Day{ic("check", 16, 2, "ck")}</div><div class="mi off">{ic("cal")}Week<span class="kb">Later</span></div><hr>'
        f'<div class="mi">{ic("sliders")}Display…<span class="tagweb">web</span></div></div>')
S['menu'] = phone(today(BUCKETS, extra=menu, ring=True), 'pwa', id_='w-menu')
cal = ('<div class="scrim"></div><div class="sheet" style="top:330px"><div class="grab"></div>'
       '<div class="sh"><span class="lnk">Today</span><b>Go to date</b><span class="lnk strong">Done</span></div>'
       f'<div class="calin"><div class="ch"><b>October 2026</b><span>{ic("back", 15, 2)}{ic("chev", 15, 2)}</span></div>'
       '<div class="cg wk"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>'
       '<div class="cg"><span class="mut">27</span><span class="mut">28</span><span class="mut">29</span><span class="mut">30</span>'
       + ''.join(f'<span class="{"on" if d == 2 else ""}">{d}</span>' for d in range(1, 32)) + '</div></div></div>')
S['date'] = phone(today(BUCKETS, extra=cal), 'pwa', id_='w-date')
S['offday'] = phone(today(BUCKETS.replace('Now · 9–11', '9–11'), 'Sun, Oct 4 · Buckets', back=True), 'pwa', dark=True, id_='w-offday')

# b3: capture, braindump sheet, drag, tap path
kbd = ('<div class="kbd"><div class="krow">' + ''.join(f'<i>{c}</i>' for c in 'qwertyuiop') + '</div><div class="krow">'
       + ''.join(f'<i>{c}</i>' for c in 'asdfghjkl') + '</div><div class="krow">' + ''.join(f'<i>{c}</i>' for c in 'zxcvbnm') + '</div></div>')
capsheet = ('<div class="scrim"></div><div class="capsheet">'
            f'<div class="capfield"><span class="typed">Book flights for Thanksgiving</span><span class="caret"></span><span class="send">{ic("arrowup", 16, 2.2)}</span></div>'
            '<div class="capnote">Return adds it and keeps the field open · <b>2 added</b></div></div>' + kbd)
S['capture'] = phone(today(BUCKETS, dock='') .replace('<div class="app">', '<div class="app">') + capsheet, 'pwa', id_='w-capture')
bd_rows = (row('Book flights for Thanksgiving', None, '2m') + row('Birthday present for Mom', 'Home', '1d')
           + row('Cancel the old gym membership', None, '1d') + row('Idea: weekly review template', 'Work', '6d')
           + row('Look into a standing desk', None, '2w') + row('Renew passport', 'Personal', '3w'))
sheet = ('<div class="sheet" style="top:400px"><div class="grab"></div>'
         f'<div class="sh"><b>Braindump <span>6</span></b><span class="shr">{ic("sliders", 16)}<span class="tagweb">web</span><span class="lnk">Close</span></span></div>'
         f'<div class="hint">Hold a thought and drop it on an hour</div>{bd_rows}</div>')
S['sheet'] = phone(today(schedule(), 'Fri, Oct 2 · Schedule', 'timeline', dock='') + sheet, 'pwa', dark=True, id_='w-sheet')
peek = ('<div class="sheet peek" style="top:722px"><div class="grab"></div>'
        '<div class="sh"><b>Braindump <span>5</span></b><span class="shr dim">Drop on an hour</span></div></div>')
S['drag'] = phone(today(schedule(drag=True), 'Fri, Oct 2 · Schedule', 'timeline', dock='') + peek, 'pwa', dark=True, id_='w-drag')
def bbtn(i, l, on=False): return f'<span class="bb {"on" if on else ""}">{ic(i, 16)}{l}</span>'
def act(i, l, red=False): return f'<div class="act {"red" if red else ""}">{ic(i, 16)}{l}</div>'
quick = ('<div class="scrim"></div><div class="sheet" style="top:250px"><div class="grab"></div>'
         '<div class="sh"><b>Book flights for Thanksgiving</b></div>'
         '<div class="qs"><small>Schedule for Fri, Oct 2</small><div class="bgrid">' + bbtn('clock', 'Anytime') + bbtn('sunrise', 'Morning') + bbtn('sun', 'Afternoon', True) + bbtn('moon', 'Evening') + '</div>'
         '<div class="newrow"><small>At a time <span class="tagweb">new</span></small><div class="pills"><span class="pill">2:00</span><span class="pill on">2:30</span><span class="pill">3:00</span><span class="pill">3:30</span><span class="pill">Other…</span></div></div></div>'
         '<div class="acts">' + act('select', 'Select') + act('skip', 'Skip today') + act('pause', 'Pause') + act('tobd', 'Move to Braindump') + act('trash', 'Delete', True) + '</div></div>')
S['quick'] = phone(today(schedule(), 'Fri, Oct 2 · Schedule', 'timeline', dock='') + quick, 'pwa', dark=True, id_='w-quick')

# b4: Ask, Organize, Search
ask_head = (f'<div class="hdr"><div class="ttl"><span class="title plain">Ask</span><small>AI · Gemini Flash</small></div>'
            f'<div class="hr"><span class="capsule sq">{ic("plus", 17, 2)}</span><span class="av">KI</span></div></div>')
ask = (ask_head + '<div class="scroll pad">'
       '<div class="stats"><div><b>5</b><small>left today</small></div><div><b>3h 20m</b><small>scheduled</small></div><div><b class="cor">1</b><small>needs you</small></div></div>'
       '<div class="me">I only have energy for two things before lunch. Which ones?</div>'
       '<p class="ai">Stay on the roadmap until 11, it is due Friday. Then the Avery reply: it is quick and already carried once.</p>'
       '<div class="prop">'
       '<div class="pr"><span class="box on">' + ic('check', 12, 3) + '</span>Reply to Avery about pricing<i>Today 11:00</i></div>'
       '<div class="pr"><span class="box on">' + ic('check', 12, 3) + '</span>Review design PR<i>Moved to Mon</i></div>'
       '<div class="pb"><span class="limebtn">Do all of it</span><span class="ghostbtn">Not now</span></div>'
       '<div class="else2">Something else</div></div></div>'
       f'<div class="dock"><div class="composer"><span class="ph">Ask about your day…</span><div class="cr"><span class="pill sm">{ic("sun", 12)}Today</span><span class="send">{ic("arrowup", 16, 2.2)}</span></div></div>{tabs("ask")}</div>')
S['ask'] = phone(ask, 'pwa', id_='w-ask')
noai = (f'<div class="hdr"><div class="ttl"><span class="title plain">Ask</span><small>Nothing connected yet</small></div><div class="hr"><span class="av">KI</span></div></div>'
        '<div class="scroll pad center">'
        f'<div class="connect"><span class="kicon">{ic("key", 22)}</span><b>Plan out loud</b>'
        '<p>Connect your own model (OpenAI, Anthropic, Gemini, OpenRouter or any compatible service), or pair OpenClaw.</p>'
        '<span class="limebtn wide">Connect a model</span><span class="ghostbtn wide">Pair OpenClaw</span></div></div>'
        f'<div class="dock">{tabs("ask")}</div>')
S['noai'] = phone(noai, 'pwa', id_='w-noai')
def orow(icon, col, name, meta, n):
    return (f'<div class="orow"><span class="oi" style="color:{col}">{ic(icon, 17)}</span><span class="on"><b>{name}</b><small>{meta}</small></span>'
            f'<span class="oc">{n}</span>{ic("chev", 15, 2, "dimc")}</div>')
org = (f'<div class="hdr"><div class="ttl"><span class="title plain">Organize</span><small>Everything your items belong to</small></div>'
       f'<div class="hr"><span class="capsule sq">{ic("plus", 17, 2)}</span><span class="av">KI</span></div></div>'
       '<div class="scroll pad">'
       '<div class="osec">Routines</div>' + orow('repeat', 'var(--a6)', 'Morning routine', '7:00 · 3 steps · 2 done today', '3')
       + '<div class="osec">Seasons</div>' + orow('leaf', 'var(--a1)', 'Marathon block', 'Active · until Nov 30', '6')
       + '<div class="osec">Goals</div>' + orow('target', 'var(--a5)', 'Learn Chinese', 'Next milestone Oct 15', '9')
       + '<div class="osec">Projects</div>' + orow('folder', 'var(--a3)', 'Work', '3 open', '14') + orow('folder', 'var(--a2)', 'Home', '2 open', '8')
       + '<div class="osec">More</div>' + orow('tag', 'var(--ink1)', 'Item types', 'Task, Habit and 2 of yours', '4') + orow('trash', 'var(--ink1)', 'Trash', 'Empties after 30 days', '3')
       + f'</div><div class="dock">{capture()}{tabs("organize")}</div>')
S['org'] = phone(org, 'pwa', id_='w-org')
srch = ('<div class="launch"><div class="lin">' + ic('search', 17) + '<span class="typed">dent</span><span class="caret"></span><span class="esc">Cancel</span></div>'
        '<div class="modes"><span class="pill on">Search</span><span class="pill">+ Add</span><span class="pill">/ Command</span><span class="pill">? Ask</span></div>'
        '<div class="res"><small>Items</small>' + row('Call the <u>dent</u>ist', 'Home', 'Today 3 PM', 'medium')
        + row('Book <u>dent</u>al cleaning', None, 'Braindump') + '<small>Commands</small>'
        f'<div class="cmd">{ic("cal", 16)}Go to date…</div><div class="cmd">{ic("timeline", 16)}Switch to Schedule</div></div></div>' + kbd)
S['search'] = phone(srch, 'pwa', id_='w-search')

# b5: installing, for reminders
inst = (f'<div class="hdr"><div class="ttl"><span class="title plain">Reminders</span><small>Settings</small></div><div class="hr"><span class="av">KI</span></div></div>'
        '<div class="scroll pad">'
        f'<div class="instcard"><span class="kicon">{ic("bell", 22)}</span><b>Get reminders on this iPhone</b>'
        f'<p>iPhone sends reminders only to apps on your Home Screen. Tap {ic("share", 13, 2)} Share, then <b>Add to Home Screen</b>, and open dsul from there.</p>'
        '<span class="lnk">Not now</span></div>'
        '<div class="setrow"><span>Habit cues</span><span class="tog"></span></div><div class="setrow"><span>Last call before midnight</span><span class="tog"></span></div>'
        '<div class="setrow dimrow"><span>Push to this device</span><span class="mut">Needs Home Screen</span></div></div>')
S['install-ios'] = phone(inst, 'safari', id_='w-install-ios')
inst2 = (f'<div class="hdr"><div class="ttl"><span class="title plain">Reminders</span><small>Settings</small></div><div class="hr"><span class="av">KI</span></div></div>'
         '<div class="scroll pad">'
         f'<div class="instcard"><span class="kicon">{ic("bell", 22)}</span><b>Install dsul for reminders that feel like an app</b>'
         '<p>Opens in its own window, with Done and Snooze 15m right on the notification.</p>'
         '<span class="limebtn wide">Install</span><span class="lnk">Not now</span></div>'
         '<div class="setrow"><span>Habit cues</span><span class="tog on"></span></div><div class="setrow"><span>Last call before midnight</span><span class="tog on"></span></div>'
         '<div class="setrow"><span>Push to this device</span><span class="tog on"></span></div></div>')
S['install-and'] = phone(inst2, 'chrome', id_='w-install-and')

CSS = open(__file__.replace('gen.py', 'mw.css')).read()
boards = {
 'b1': ['pwa', 'safari', 'safari-scrolled', 'chrome'],
 'b2': ['menu', 'date', 'offday'],
 'b3': ['capture', 'sheet', 'drag', 'quick'],
 'b4': ['ask', 'noai', 'org', 'search'],
 'b5': ['install-ios', 'install-and'],
}
html = ['<!doctype html><html><head><meta charset="utf-8"><style>', CSS, '</style></head><body>']
for bid, keys in boards.items():
    html.append(f'<div class="board" id="{bid}"><div class="phones">' + ''.join(S[k] for k in keys) + '</div></div>')
html.append('</body></html>')
open(__file__.replace('gen.py', 'boards.html'), 'w').write('\n'.join(html))
print('ok', len(S))
