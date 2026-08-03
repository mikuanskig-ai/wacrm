'use client';

import { useTranslations } from 'next-intl';
import { Store } from 'lucide-react';

export default function PublicMenuNotFound() {
  const t = useTranslations('PublicMenu.notFound');
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 text-center">
      <Store className="h-8 w-8 text-muted-foreground" />
      <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('body')}</p>
    </div>
  );
}
