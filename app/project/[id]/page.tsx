'use client';

import { useParams } from 'next/navigation';
import { ContainerPage } from '@/components/planner/container-page';

/** A project's page — see components/planner/container-page.tsx. */
export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  return <ContainerPage kind="project" id={params?.id} />;
}
