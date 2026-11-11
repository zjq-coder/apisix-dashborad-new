import { useTranslate } from './index';

function Message({ source, values }: { source: string; values: unknown[] }) {
  const t = useTranslate();
  return <>{t(source, ...values)}</>;
}

// Imperative confirmation dialogs keep their initial props until they close.
export function messageText(source: string, ...values: unknown[]) {
  return <Message source={source} values={values} />;
}
