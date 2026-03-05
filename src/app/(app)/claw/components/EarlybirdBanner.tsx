import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

type EarlybirdBannerProps = {
  purchased: boolean;
};

export function EarlybirdBanner({ purchased }: EarlybirdBannerProps) {
  if (purchased) {
    return (
      <div className="border-brand-primary/30 bg-brand-primary/5 flex items-center gap-3 rounded-xl border p-4">
        <span className="text-xl">🦀</span>
        <div>
          <span className="text-brand-primary text-sm font-semibold">
            Thanks for being an early KiloClaw subscriber.
          </span>
          <span className="text-muted-foreground ml-2 text-sm">
            Your earlybird hosting expires September 26, 2026.
          </span>
        </div>
      </div>
    );
  }

  return (
    <Link
      href="/claw/earlybird"
      className="border-brand-primary/30 bg-brand-primary/5 hover:bg-brand-primary/10 hover:border-brand-primary/50 group flex items-center justify-between rounded-xl border p-4 transition-all"
    >
      <div className="flex items-center gap-3">
        <span className="text-xl">🦀</span>
        <div>
          <span className="text-brand-primary text-sm font-semibold">
            Early Bird: 50% Off KiloClaw Hosting
          </span>
          <span className="text-muted-foreground ml-2 text-sm">
            First 1,000 users &mdash; $25/mo instead of $49
          </span>
        </div>
      </div>
      <ArrowRight className="text-brand-primary h-4 w-4 transition-transform group-hover:translate-x-1" />
    </Link>
  );
}
