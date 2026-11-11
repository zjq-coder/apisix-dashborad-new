import type { ReactNode } from 'react';

const tokens = /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function ConfigPreview({ value }: { value: string }) {
  const content: ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(tokens)) {
    const index = match.index;
    content.push(value.slice(offset, index));
    const token = match[0];
    const kind = token.startsWith('"')
      ? /^\s*:/.test(value.slice(index + token.length))
        ? 'key'
        : 'string'
      : /true|false|null/.test(token)
        ? 'literal'
        : 'number';
    content.push(
      <span className={`config-${kind}`} key={index}>
        {token}
      </span>,
    );
    offset = index + token.length;
  }
  content.push(value.slice(offset));
  return <pre className="config-preview">{content}</pre>;
}
