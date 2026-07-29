'use client';

import { Store, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function PublicMenuHeader({
  storeName,
  open,
  closedMessage,
}: {
  storeName: string;
  open: boolean;
  closedMessage: string | null;
}) {
  const t = useTranslations('PublicMenu.closedBanner');

  return (
    <div className="border-b border-border bg-card">
      <div className="mx-auto max-w-3xl px-4 py-5">
        <div className="flex items-center gap-2">
          <Store className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">{storeName}</h1>
        </div>
        {!open && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">{t('title')}</p>
              {closedMessage && (
                <p className="mt-1 whitespace-pre-line text-xs text-amber-600/90 dark:text-amber-400/90">
                  {closedMessage}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
