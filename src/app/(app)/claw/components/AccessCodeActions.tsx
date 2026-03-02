'use client';

import { useCallback, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAccessCode } from '../hooks/useAccessCode';

const OPEN_BUTTON_ACCENT_CLASS =
  'animate-pulse-once bg-[oklch(95%_0.15_108)] text-black shadow-[0_0_20px_rgba(237,255,0,0.3)] ring-[oklch(95%_0.15_108)]/20 transition-all duration-500 ease-in-out hover:bg-[oklch(95%_0.15_108)]/90 hover:ring-[oklch(95%_0.15_108)]/40';

export function AccessCodeActions({
  canShow,
  gatewayUrl,
}: {
  canShow: boolean;
  gatewayUrl: string;
}) {
  const { accessCode, isGenerating, isCopied, generateAccessCode, copyAccessCode } =
    useAccessCode();
  const [isOpening, setIsOpening] = useState(false);

  // Generate a fresh access code and open the gateway URL with it embedded,
  // so the user doesn't have to copy-paste the code manually.
  const openWithAutoAuth = useCallback(async () => {
    setIsOpening(true);
    try {
      const code = await generateAccessCode();
      if (code) {
        const url = new URL(gatewayUrl, window.location.origin);
        url.searchParams.set('auth_code', code);
        const win = window.open(url.toString(), '_blank', 'noopener,noreferrer');
        if (!win) {
          toast.error('Popup blocked — please allow popups and try again');
        }
      }
    } catch {
      toast.error('Failed to generate access code for auto-login');
    } finally {
      setIsOpening(false);
    }
  }, [gatewayUrl, generateAccessCode]);

  if (!canShow) return null;

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" onClick={() => generateAccessCode()} disabled={isGenerating}>
            <KeyRound className="mr-2 h-4 w-4" />
            {isGenerating ? 'Generating...' : 'Access Code'}
          </Button>
        </PopoverTrigger>
        {accessCode && (
          <PopoverContent className="w-auto" align="end">
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-xs">One-time code (expires in 10 min)</p>
              <div className="flex items-center gap-2">
                <code className="bg-muted rounded px-3 py-2 font-mono text-lg tracking-widest">
                  {accessCode}
                </code>
                <Button variant="ghost" size="icon" onClick={copyAccessCode}>
                  {isCopied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </PopoverContent>
        )}
      </Popover>
      <Button
        variant="primary"
        className={OPEN_BUTTON_ACCENT_CLASS}
        disabled={isOpening || isGenerating}
        onClick={openWithAutoAuth}
      >
        {isOpening ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <ExternalLink className="mr-2 h-4 w-4" />
        )}
        {isOpening ? 'Opening...' : 'Open'}
      </Button>
    </>
  );
}
