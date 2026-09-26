'use client';

import { useParams } from 'next/navigation';
import { ContainerPage } from '@/components/planner/container-page';

/** A program's page — see components/planner/container-page.tsx. */
export default function ProgramPage() {
  const params = useParams<{ id: string }>();
  return <ContainerPage kind="program" id={params?.id} />;
}
