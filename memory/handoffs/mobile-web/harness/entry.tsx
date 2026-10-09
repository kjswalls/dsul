import './styles.css';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext, useSensor, useSensors, TouchSensor, MeasuringStrategy } from '@dnd-kit/core';
import { NonTouchPointerSensor, POINTER_ACTIVATION_DISTANCE_PX, TOUCH_ACTIVATION_DELAY_MS, TOUCH_ACTIVATION_TOLERANCE_PX, dragInputOf } from '@/lib/dnd/sensors';
import { plannerCollision } from '@/lib/dnd/collision';
import { useDragStore } from '@/lib/drag-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_GOALS, EXT_ORGANIZE } from '@/lib/extension-registry';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { useIsMobile } from '@/hooks/use-mobile';
import { useUIStore, openEditFor } from '@/lib/ui-store';
import { DesktopShell } from '@/components/shell/desktop-shell';
import { MobileShell } from '@/components/shell/mobile-shell';
import { ZenStage } from '@/components/zen/zen-stage';
import { useEODStore } from '@/lib/eod-store';
import { TooltipProvider } from '@/components/ui/tooltip';

const params = new URLSearchParams(location.search);
// desktop | phone: that shell, always. auto: AppShell's own swap, on the real useIsMobile.
const shell = params.get('shell') ?? 'desktop';
const scope = (params.get('scope') ?? 'day') as 'day' | 'week';
const layout = (params.get('layout') ?? 'schedule') as 'schedule' | 'list' | 'buckets';
const preset = Number(params.get('s') ?? '0');
const bdPreset = Number(params.get('bd') ?? '0');
const sidebarW = Number(params.get('sw') ?? '406');
const strict = params.get('strict') !== '0';
const withReview = params.get('review') === '1';
const withProgram = params.get('program') === '1';
const withZenStage = params.get('zenstage') === '1';
const withPanel = params.get('panel') === '1';

const today = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const DATE_STR = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

const bucketOf = (t?: unknown) => {
  if (typeof t !== 'string') return undefined;
  const h = Number(t.slice(0, 2));
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
};
const task = (over: Record<string, unknown>) => ({
  type: 'task',
  status: 'pending',
  isScheduled: true,
  order: 0,
  startDate: DATE_STR,
  timeBucket: bucketOf(over.startTime),
  ...over,
});
const tasks = [
  task({ id: 't1', title: 'Standup', startTime: '09:00', duration: 30, project: 'Work', priority: 'medium' }),
  task({ id: 't2', title: 'Deep work: planner shelf', startTime: '10:00', duration: 120, project: 'Work', priority: 'high' }),
  task({ id: 't3', title: 'Lunch with Sam', startTime: '12:30', duration: 60, project: 'Personal', priority: 'low' }),
  task({ id: 't4', title: 'Review PRs', startTime: '14:00', duration: 60, project: 'Work', priority: 'medium' }),
  task({ id: 't5', title: 'Gym', startTime: '17:30', duration: 60, project: 'Health' }),
  task({ id: 't6', title: 'Groceries', timeBucket: 'afternoon', project: 'Home', priority: 'low' }),
  task({ id: 't7', title: 'Call the dentist', timeBucket: 'morning', project: 'Home', priority: 'medium' }),
  task({ id: 't8', title: 'Pay the water bill', timeBucket: 'evening', project: 'Home', status: 'completed' }),
  task({ id: 'b1', title: 'Look into standing desks', isScheduled: false, startDate: undefined, project: 'Home' }),
  task({ id: 'b2', title: 'Draft Q4 goals', isScheduled: false, startDate: undefined, project: 'Work', priority: 'high' }),
];

useExtensionsStore.setState((s) => ({ enabled: { ...s.enabled, [EXT_GOALS]: true, [EXT_ORGANIZE]: true } }));
useSidebarStore.setState({ leftSidebarWidth: sidebarW } as never);
usePlannerStore.setState({
  userId: 'user-1',
  isLoading: false,
  userTimezone: 'UTC',
  selectedDate: today,
  weekStartDay: 'sunday',
  navDirection: null,
  items: tasks,
  tasks,
  habits: [],
  projects: [
    { id: 'p1', name: 'Work', emoji: '💼' },
    { id: 'p2', name: 'Home', emoji: '🏠' },
    { id: 'p3', name: 'Personal', emoji: '🙂' },
    { id: 'p4', name: 'Health', emoji: '🩺' },
    { id: 'p9', name: 'Wind-down', emoji: '🌙', color: 'var(--accent-8)' },
  ],
  routines: [],
  programs: withProgram ? [{ id: 'pr1', name: 'Summer', state: 'paused', itemIds: ['t6', 't7'], routineIds: [] }] : [],
  // main renamed programs to seasons (#329); a build of either side reads its own key.
  seasons: withProgram ? [{ id: 'pr1', name: 'Summer', state: 'paused', itemIds: ['t6', 't7'], routineIds: [] }] : [],
  goals: [
    { id: 'g1', name: 'Learn Chinese', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] },
    { id: 'g2', name: 'Marathon', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] },
  ],
  goalsAvailable: true,
  showCompletedTasks: true,
  showPausedOnGrid: false,
  showCurrentTimeIndicator: false,
} as never);

const presets: Record<number, Record<string, unknown>> = {
  0: {},
  1: { canvasGroupBy: 'project' },
  2: { canvasGroupBy: 'project', canvasSortBy: 'priority' },
  3: { canvasGroupBy: 'project', canvasSortBy: 'priority', canvasFilters: { ...EMPTY_VIEW_FILTERS, priorities: ['high', 'medium'] } },
  4: {
    canvasGroupBy: 'project',
    canvasSortBy: 'priority',
    canvasFilters: { ...EMPTY_VIEW_FILTERS, priorities: ['high', 'medium'], containers: ['project:Work', 'project:Home'], hideFinished: true },
  },
  5: {
    typeFilter: 'tasks',
    canvasGroupBy: 'project',
    canvasSortBy: 'priority',
    canvasFilters: { priorities: ['high', 'medium'], containers: ['project:Work', 'project:Home'], goals: ['g1'], hideFinished: true },
  },
  6: { canvasFilters: { ...EMPTY_VIEW_FILTERS, hideFinished: true } },
  7: { typeFilter: 'tasks', canvasGroupBy: 'project', canvasFilters: { ...EMPTY_VIEW_FILTERS, hideFinished: true } },
};
const bdPresets: Record<number, Record<string, unknown>> = {
  0: {},
  1: { braindumpGroupBy: 'project', braindumpSortBy: 'priority', braindumpFilters: { ...EMPTY_VIEW_FILTERS, hideFinished: true } },
  2: {
    braindumpGroupBy: 'project',
    braindumpSortBy: 'priority',
    braindumpFilters: { ...EMPTY_VIEW_FILTERS, priorities: ['high', 'medium'], containers: ['project:Work', 'project:Home'], hideFinished: true },
  },
  3: { braindumpGroupBy: 'project', braindumpFilters: { ...EMPTY_VIEW_FILTERS, priorities: ['high'] } },
};
useViewStore.setState({
  scope,
  layout,
  typeFilter: 'all',
  canvasGroupBy: 'none',
  braindumpGroupBy: 'none',
  canvasSortBy: 'default',
  braindumpSortBy: 'default',
  canvasFilters: EMPTY_VIEW_FILTERS,
  braindumpFilters: EMPTY_VIEW_FILTERS,
  ...presets[preset],
  ...bdPresets[bdPreset],
  ...(params.get('st') ? JSON.parse(params.get('st')!) : {}),
} as never);
if (params.get('tab')) useMobileNavStore.setState({ activeTab: params.get('tab') as never });

declare global {
  interface Window {
    __view: typeof useViewStore;
    __planner: typeof usePlannerStore;
    __sidebar: typeof useSidebarStore;
    __nav: typeof useMobileNavStore;
  }
}
window.__view = useViewStore;
window.__planner = usePlannerStore;
window.__sidebar = useSidebarStore;
window.__nav = useMobileNavStore;
(window as any).__ui = useUIStore;
(window as any).__openEditFor = openEditFor;
(window as any).__eod = useEODStore;
(window as any).__openEdit = (id: string) => {
  const it = (usePlannerStore.getState() as any).items.find((i: any) => i.id === id);
  openEditFor(it, 'task');
};
if (withReview) {
  useEODStore.setState({ _hasHydrated: true, eodReviewEnabled: true, eodReviewTime: '00:00', lastEodReviewDate: null, eodDeferredDate: null } as never);
}
if (withPanel) setTimeout(() => (window as any).__openEdit('t2'), 0);

/** AppShell's swap: one shell at a time, on the same hook AppShell reads. */
function AutoShell() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileShell /> : <DesktopShell />;
}

function RealDnd({ children }: { children: ReactNode }) {
  const sensors = useSensors(
    useSensor(NonTouchPointerSensor, { activationConstraint: { distance: POINTER_ACTIVATION_DISTANCE_PX } }),
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_ACTIVATION_DELAY_MS, tolerance: TOUCH_ACTIVATION_TOLERANCE_PX } })
  );
  return (
    <DndContext
      id="planner-dnd"
      sensors={sensors}
      collisionDetection={plannerCollision}
      onDragStart={(e) => { useDragStore.getState().startDrag(e.active.id as string, dragInputOf(e.activatorEvent)); (window as any).__dragLog?.push(['start', e.active.id]); }}
      onDragOver={(e) => { (window as any).__dragLog?.push(['over', e.over?.id ?? null]); }}
      onDragEnd={(e) => { useDragStore.getState().endDrag(); (window as any).__dragLog?.push(['end', e.over?.id ?? null]); }}
      onDragCancel={() => useDragStore.getState().endDrag()}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
    >
      {children}
    </DndContext>
  );
}
(window as any).__dragLog = [];
const Dnd = params.get('dnd') === '1' ? RealDnd : DndContext;
const tree: ReactNode = (
  <Dnd>
    {shell === 'phone' ? <MobileShell /> : shell === 'auto' ? <AutoShell /> : withZenStage ? <ZenStage planner={<DesktopShell />} /> : <DesktopShell />}
  </Dnd>
);
createRoot(document.getElementById('app')!).render(strict ? <StrictMode>{tree}</StrictMode> : tree);
