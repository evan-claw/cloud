export function EarlybirdBanner() {
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
