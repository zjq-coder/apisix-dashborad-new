import { useSyncExternalStore } from 'react';
import english from './en.json';

export type Locale = 'zh-CN' | 'en-US';
export type Translate = (source: string, ...values: unknown[]) => string;
const messages: Readonly<Record<string, string>> = english;
const storageKey = 'console.locale';
const listeners = new Set<() => void>();

function readPreference(): Locale {
  try {
    return window.localStorage.getItem(storageKey) === 'en-US' ? 'en-US' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

let activeLocale = readPreference();

function update(locale: Locale) {
  if (locale === activeLocale) return;
  activeLocale = locale;
  listeners.forEach((notify) => notify());
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) update(readPreference());
  });
}

export function setLocale(locale: Locale) {
  try {
    window.localStorage.setItem(storageKey, locale);
  } catch {
    // The current session can still change language when storage is unavailable.
  }
  update(locale);
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

export const translate = (locale: Locale, source: string, ...values: unknown[]) => {
  const template =
    locale === 'en-US' && Object.hasOwn(messages, source) ? messages[source] : source;
  return values.length
    ? template.replace(/\{(\d+)\}/g, (token, index) =>
        index < values.length ? String(values[index]) : token,
      )
    : template;
};

const translators: Record<Locale, Translate> = {
  'zh-CN': (source, ...values) => translate('zh-CN', source, ...values),
  'en-US': (source, ...values) => translate('en-US', source, ...values),
};

export function useLocale() {
  return useSyncExternalStore(subscribe, () => activeLocale);
}

export function useTranslate() {
  return translators[useLocale()];
}
