'use client';

import { useRef, type CSSProperties, type FC } from 'react';

import { cn } from '@/lib/utils';
import { usePlayWhenVisible } from '@/hooks/use-play-when-visible';
import {
  EXT_ACCOUNTABILITY_PARTNER,
  EXT_BEEMINDER,
  EXT_COMPLETION_CONFETTI,
  EXT_GOALS,
  EXT_HABIT_HEATMAP,
  EXT_ORGANIZE,
  EXT_PHONE_CALL,
  EXT_PLEDGE,
  EXT_SMS_NUDGE,
  EXT_STREAKS,
  EXT_VOICE_ANNOUNCEMENTS,
  extensionManifest,
} from '@/lib/extension-registry';
import s from './previews.module.css';

/**
 * A small looping scene of what one extension does, for the store card and the
 * header of the extension's settings pane.
 *
 * Every scene is INERT SAMPLE DATA — fixed rows, no store reads. That is not
 * only tidiness: the store and settings are lean routes, and
 * tests/unit/route-data.test.ts fails any file in their import tree that reads
 * items from the planner store. A preview drawn from the user's own items would
 * also show the feature working on data it may never touch.
 *
 * Animation is CSS, keyed off `data-playing` (see previews.module.css for why
 * the resting frame matters). The scene is aria-hidden; the extension's own
 * description is the accessible name of the figure.
 */

type Scene = FC;

const CHECK = (
  <svg viewBox="0 0 24 24" aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const FLAME_PATH =
  'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z';
const FLAME = (
  <svg viewBox="0 0 24 24" aria-hidden>
    <path d={FLAME_PATH} />
  </svg>
);
const TARGET = (
  <svg viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);
const PHONE_PATH =
  'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z';

/** Deterministic, so server and client render the same frame. */
function seeded(seed: number) {
  let n = seed;
  return () => {
    n = (n * 16807) % 2147483647;
    return (n - 1) / 2147483646;
  };
}

function vars(v: Record<string, string>): CSSProperties {
  return v as CSSProperties;
}

/* ── scenes ──────────────────────────────────────────────────────────────── */

const CONFETTI_COLOURS = [
  'var(--lime-solid)',
  'var(--honey-solid)',
  'var(--coral-solid)',
  'var(--accent-2)',
  'var(--accent-3)',
  'var(--accent-4)',
];
const CONFETTI_PIECES = (() => {
  const r = seeded(7);
  return Array.from({ length: 18 }, (_, i) => {
    const a = (i / 18) * Math.PI * 2 + r() * 0.3;
    const d = 2.2 + r() * 2.6;
    return vars({
      '--c': CONFETTI_COLOURS[i % CONFETTI_COLOURS.length],
      '--dx': `${(Math.cos(a) * d * 1.5).toFixed(2)}em`,
      '--dy': `${(Math.sin(a) * d - 1.2).toFixed(2)}em`,
      '--r': `${Math.round(r() * 540 - 270)}deg`,
    });
  });
})();

const Confetti: Scene = () => (
  <div className={s.stage}>
    <div className={s.col}>
      <div className={cn(s.row, s.dim)}>
        <span className={cn(s.box, s.done)}>{CHECK}</span>
        <span className={s.struck}>Inbox to zero</span>
        <span className={s.time}>7:00</span>
      </div>
      <div className={s.row}>
        <span className={cn(s.box, s.done, s.tick)}>{CHECK}</span>
        <span className={s.strike}>Stretch 10 min</span>
        <span className={s.time}>7:30</span>
        <span className={s.burst}>
          {CONFETTI_PIECES.map((style, i) => (
            <i key={i} className={s.piece} style={style} />
          ))}
        </span>
      </div>
      <div className={s.row}>
        <span className={s.box}>{CHECK}</span>
        <span>Call the dentist</span>
        <span className={s.time}>10:00</span>
      </div>
    </div>
  </div>
);

const Streaks: Scene = () => (
  <div className={s.stage}>
    <div className={s.col}>
      <div className={s.row}>
        <span className={cn(s.box, s.done)}>{CHECK}</span>
        <span>Meditate</span>
        <span className={s.flame}>{FLAME}27</span>
      </div>
      <div className={s.row}>
        <span className={cn(s.box, s.done, s.tick)}>{CHECK}</span>
        <span>Read 20 pages</span>
        <span className={cn(s.flame, s.flameLive)}>
          {FLAME}
          <span className={s.roll}>
            <span className={s.rollInner}>
              <b>11</b>
              <b>12</b>
            </span>
          </span>
        </span>
        <span className={s.plus}>+1</span>
      </div>
      <div className={s.row}>
        <span className={s.box}>{CHECK}</span>
        <span>Walk after lunch</span>
        <span className={s.flame}>{FLAME}4</span>
      </div>
    </div>
  </div>
);

const HEAT_LEVELS = [
  'var(--muted)',
  'color-mix(in oklab, var(--warning) 35%, var(--muted))',
  'color-mix(in oklab, var(--warning) 60%, var(--muted))',
  'color-mix(in oklab, var(--warning) 85%, var(--muted))',
  'var(--warning)',
];
const HEAT_CELLS = (() => {
  const r = seeded(42);
  const cells: CSSProperties[] = [];
  for (let c = 0; c < 26; c++) {
    for (let d = 0; d < 7; d++) {
      const p = 0.25 + (c / 26) * 0.6;
      const v = r();
      let level = v > p ? 0 : v > p * 0.66 ? 1 : v > p * 0.4 ? 2 : v > p * 0.18 ? 3 : 4;
      if (c > 19 && c < 23 && d !== 6) level = Math.max(level, 3);
      cells.push(vars({ '--lv': HEAT_LEVELS[level], '--dl': `${(c * 0.07 + d * 0.012).toFixed(3)}s` }));
    }
  }
  return cells;
})();

const Heatmap: Scene = () => (
  <div className={s.stage}>
    <div className={s.card}>
      <div className={s.cardHead}>
        Read 20 pages<span>Apr – Sep</span>
      </div>
      <div className={s.grid}>
        {HEAT_CELLS.map((style, i) => (
          <i key={i} className={s.cell} style={style} />
        ))}
      </div>
      <div className={s.months}>
        {['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'].map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>
      <div className={s.foot}>
        <span>
          Longest run <b>23</b> days
        </span>
        <span>
          <b>71%</b> of days
        </span>
      </div>
    </div>
  </div>
);

const Goals: Scene = () => (
  <div className={s.stage}>
    <div className={s.col} style={{ gap: '1em', ['--loop' as string]: '5s' }}>
      <div className={s.card}>
        <div className={s.goalHead}>
          {TARGET}Run a half marathon<span className={s.by}>by Nov 16</span>
        </div>
        <div className={s.track}>
          <div className={s.trackFill} />
          <span className={cn(s.dot, s.hit)} style={{ left: 0 }}>
            <em>10 km</em>
          </span>
          <span className={cn(s.dot, s.hit)} style={{ left: '33.3%' }}>
            <em>15 km</em>
          </span>
          <span className={cn(s.dot, s.hit, s.next)} style={{ left: '66.6%' }}>
            <em>18 km</em>
          </span>
          <span className={s.dot} style={{ left: '100%' }}>
            <em>Race</em>
          </span>
        </div>
      </div>
      <div className={s.row}>
        <span className={cn(s.box, s.done, s.tick)}>{CHECK}</span>
        <span className={s.strike}>Long run, 18 km</span>
        <span className={s.why}>{TARGET}Half marathon</span>
      </div>
    </div>
  </div>
);

const Organize: Scene = () => (
  <div className={s.stage}>
    <div className={s.console}>
      <div className={s.rail}>
        <span className={s.railMark} />
        {(
          [
            ['Overview', 'var(--muted-foreground)'],
            ['Routines', 'var(--accent-2)'],
            ['Seasons', 'var(--accent-6)'],
            ['Projects', 'var(--accent-3)'],
            ['Trash', 'var(--accent-5)'],
          ] as const
        ).map(([name, colour]) => (
          <div key={name} className={s.railRow}>
            <i style={vars({ '--c': colour })} />
            {name}
          </div>
        ))}
      </div>
      <div className={s.pane}>
        <div className={cn(s.panel, s.panel1)}>
          <div className={s.row}>
            Morning<span className={s.time}>7:00 · 5 steps</span>
          </div>
          <div className={s.row}>
            Shutdown<span className={s.time}>18:00 · 4</span>
          </div>
          <div className={s.row}>
            Sunday reset<span className={s.time}>6 steps</span>
          </div>
        </div>
        <div className={cn(s.panel, s.panel2)}>
          <div className={s.row}>
            Work<span className={s.time}>12 items</span>
          </div>
          <div className={s.row}>
            Home<span className={s.time}>7 items</span>
          </div>
          <div className={s.row}>
            Side quest<span className={s.time}>3 items</span>
          </div>
        </div>
        <div className={cn(s.panel, s.panel3)}>
          <div className={s.row}>
            Marathon block<span className={s.time}>Sep – Nov</span>
          </div>
          <div className={s.row}>
            Holiday mode<span className={s.time}>Paused</span>
          </div>
        </div>
      </div>
    </div>
  </div>
);

const Voice: Scene = () => (
  <div className={s.stage}>
    <div className={s.voice}>
      <div className={s.speaker}>
        <i className={s.ring} />
        <i className={s.ring} />
        <i className={s.ring} />
        <div className={s.speakerBox}>
          <span className={s.cone} />
        </div>
      </div>
      <div className={s.caption}>
        <span className={s.captionText}>Stretch 10 min. 4 days so far.</span>
      </div>
      <div className={s.where}>
        <i />
        Kitchen speaker
      </div>
    </div>
  </div>
);

function LockScreen({ time }: { time: string }) {
  return (
    <div className={s.lock}>
      <div className={s.date}>Tuesday</div>
      <div className={s.clock}>{time}</div>
    </div>
  );
}

const Text: Scene = () => (
  <>
    <LockScreen time="9:02" />
    <div className={cn(s.stage, s.top)}>
      <div className={cn(s.banner, s.slideIn)}>
        <span className={s.appIcon}>
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        <div className={s.bannerText}>
          <div className={s.bannerTitle}>
            Messages<span>now</span>
          </div>
          Still open today — Read 20 pages · 11 days riding on it
        </div>
      </div>
    </div>
  </>
);

const Call: Scene = () => (
  <>
    <LockScreen time="9:45" />
    <div className={cn(s.stage, s.top)} style={vars({ '--loop': '4.5s' })}>
      <div className={cn(s.banner, s.slideIn)}>
        <div className={s.callRow}>
          <span className={s.avatar}>d</span>
          <div className={s.bannerText}>
            <div className={s.bannerTitle}>dsul</div>
            Last call · Read 20 pages
          </div>
          <span className={cn(s.callButton, s.decline)}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d={PHONE_PATH} />
            </svg>
          </span>
          <span className={cn(s.callButton, s.accept)}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d={PHONE_PATH} />
            </svg>
          </span>
        </div>
      </div>
    </div>
  </>
);

const BEE_POINTS: [number, number][] = [
  [20, 86],
  [36, 82],
  [52, 78],
  [68, 71],
  [84, 70],
  [100, 63],
  [116, 60],
  [132, 55],
  [148, 50],
];

const Beeminder: Scene = () => (
  <div className={s.stage}>
    <div className={s.chart}>
      <svg viewBox="0 0 200 104" aria-hidden>
        <path className={s.axis} d="M12 6V96H192" />
        <path className={s.road} d="M12 96 L192 34 L192 20 L12 82 Z" />
        <path className={s.roadLine} d="M12 89 L192 27" />
        <path className={s.pointLine} d={BEE_POINTS.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')} />
        {BEE_POINTS.map(([x, y]) => (
          <circle key={x} className={s.point} cx={x} cy={y} r="2.2" />
        ))}
        <path className={s.newLine} d="M148 50 L164 44" />
        <circle className={s.newRing} cx="164" cy="44" r="3" />
        <circle className={s.newPoint} cx="164" cy="44" r="2.8" />
        <text className={s.label} x="14" y="103">
          reading
        </text>
        <text className={s.label} x="192" y="103" textAnchor="end">
          today
        </text>
      </svg>
      <div className={s.toast}>
        <i />
        Posted +1 to reading
      </div>
    </div>
  </div>
);

const Pledge: Scene = () => (
  <div className={s.stage}>
    <div className={s.ledger}>
      <div className={s.ledgerHead}>
        Ledger · September
        <span className={s.total}>
          $
          <span className={s.roll}>
            <span className={s.rollInner}>
              <b>10</b>
              <b>15</b>
            </span>
          </span>
        </span>
      </div>
      <div className={s.ledgerRow}>
        <span className={s.ledgerDate}>Sep 26</span>
        <span>Run</span>
        <span className={s.dim}>kept</span>
      </div>
      <div className={s.ledgerRow}>
        <span className={s.ledgerDate}>Sep 27</span>
        <span>Run</span>
        <span className={s.miss}>$5</span>
      </div>
      <div className={s.ledgerRow}>
        <span className={s.ledgerDate}>Sep 28</span>
        <span>Run</span>
        <span className={s.miss}>$5</span>
      </div>
      <div className={cn(s.ledgerRow, s.ledgerNew)}>
        <span className={s.ledgerDate}>Sep 29</span>
        <span>Run</span>
        <span className={s.miss}>$5</span>
      </div>
      <div className={s.ledgerFoot}>Payable to a cause you can’t stand. Recorded, never charged.</div>
    </div>
  </div>
);

const Partner: Scene = () => (
  <div className={s.stage}>
    <div className={s.chat}>
      <div className={s.chatHead}>
        # accountability<span>· Discord</span>
      </div>
      <div className={s.chatBody}>
        <div className={s.typing}>
          <i />
          <i />
          <i /> dsul is typing
        </div>
        <div className={s.message}>
          <span className={s.bot}>d</span>
          <div className={s.messageText}>
            <b>
              dsul<span>9:00 PM</span>
            </b>
            Sam’s 2026-09-29: 4/5 done. Done — Meditate, Run, Read and Walk. Not done — Stretch.
            <div className={s.bar}>
              <i />
              <i />
              <i />
              <i />
              <i className={s.empty} />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
);

/**
 * One scene per catalog slug. tests/unit/extension-store.test.ts holds this
 * map to OFFICIAL_EXTENSIONS exactly, so an extension cannot ship to the store
 * without one.
 */
export const EXTENSION_PREVIEWS: Record<string, Scene> = {
  [EXT_GOALS]: Goals,
  [EXT_ORGANIZE]: Organize,
  [EXT_STREAKS]: Streaks,
  [EXT_HABIT_HEATMAP]: Heatmap,
  [EXT_COMPLETION_CONFETTI]: Confetti,
  [EXT_VOICE_ANNOUNCEMENTS]: Voice,
  [EXT_SMS_NUDGE]: Text,
  [EXT_PHONE_CALL]: Call,
  [EXT_BEEMINDER]: Beeminder,
  [EXT_PLEDGE]: Pledge,
  [EXT_ACCOUNTABILITY_PARTNER]: Partner,
};

export function ExtensionPreview({
  slug,
  className,
  play = 'visible',
}: {
  slug: string;
  className?: string;
  /** 'visible' loops while on screen (an extension's own page, one preview);
   *  'engaged' rests until its card is hovered or focused (the store's grid). */
  play?: 'visible' | 'engaged';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const playing = usePlayWhenVisible(ref, { whileEngaged: play === 'engaged' });
  const SceneFor = EXTENSION_PREVIEWS[slug];
  const manifest = extensionManifest(slug);
  if (!SceneFor) return null;
  return (
    <div
      ref={ref}
      role="img"
      aria-label={manifest ? `Preview: ${manifest.description}` : undefined}
      className={cn(s.root, className)}
      data-extension-preview={slug}
      data-playing={playing ? 'true' : 'false'}
    >
      <div aria-hidden className="contents">
        <SceneFor />
      </div>
    </div>
  );
}
