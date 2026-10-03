'use client';

import { AppShell } from '@/components/shell/app-shell';
import { PreviewCrashBoundary } from '@/components/shell/preview-crash-boundary';

export default function PlannerPage() {
  // A cached planner that throws while rendering drops back to the skeleton
  // instead of taking the page down (components/shell/preview-crash-boundary.tsx).
  return (
    <PreviewCrashBoundary>
      <AppShell />
    </PreviewCrashBoundary>
  );
}
