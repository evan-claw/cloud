import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { HexVizPageClient } from './HexVizPageClient';

export default async function HexVizPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/viz`
  );

  if (!(await isGastownEnabled(user.id))) {
    return notFound();
  }

  return <HexVizPageClient townId={townId} />;
}
