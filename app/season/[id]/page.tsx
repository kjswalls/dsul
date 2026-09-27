'use client';

import { useParams } from 'next/navigation';
import { ContainerPage } from '@/components/planner/container-page';

/** A season's page — see components/planner/container-page.tsx. */
export default function SeasonPage() {
  const params = useParams<{ id: string }>();
  return <ContainerPage kind="season" id={params?.id} />;
}
