'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import Link from 'next/link';

type CustomerSourceSurveyProps = {
  redirectPath: string;
};

export function CustomerSourceSurvey({ redirectPath }: CustomerSourceSurveyProps) {
  const [source, setSource] = useState('');
  const router = useRouter();
  const trpc = useTRPC();

  const { mutate: submitSource, isPending } = useMutation(
    trpc.user.submitCustomerSource.mutationOptions({
      onSuccess: () => {
        router.push(redirectPath);
      },
    })
  );

  return (
    <div className="space-y-4 px-6 pb-6">
      <Textarea
        placeholder="Example: A YouTube video from Theo"
        value={source}
        onChange={e => setSource(e.target.value)}
        rows={3}
        maxLength={1000}
      />
      <div className="flex items-center justify-between">
        <Link href={redirectPath} className="text-muted-foreground text-sm hover:underline">
          Skip
        </Link>
        <Button
          onClick={() => submitSource({ source })}
          disabled={isPending || source.trim().length === 0}
        >
          {isPending ? 'Submitting...' : 'Submit'}
        </Button>
      </div>
    </div>
  );
}
