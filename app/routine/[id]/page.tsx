'use client';

import { useParams } from 'next/navigation';
import { ContainerPage } from '@/components/planner/container-page';

/** A routine's page — see components/planner/container-page.tsx. */
export default function RoutinePage() {
  const params = useParams<{ id: string }>();
  return <ContainerPage kind="routine" id={params?.id} />;
}
