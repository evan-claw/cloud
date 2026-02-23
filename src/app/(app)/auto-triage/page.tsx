import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { AutoTriagePageClient } from '@/components/auto-triage/AutoTriagePageClient';

type AutoTriagePageProps = {
  searchParams: Promise<{ success?: string; error?: string }>;
};

export default async function PersonalAutoTriagePage({ searchParams }: AutoTriagePageProps) {
  const search = await searchParams;
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/auto-triage');

  return <AutoTriagePageClient successMessage={search.success} errorMessage={search.error} />;
}
