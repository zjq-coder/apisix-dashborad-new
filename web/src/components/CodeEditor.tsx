import { useTranslate } from '../i18n';
import Editor, { DiffEditor, loader } from '@monaco-editor/react';
// Register contribution services before the first standalone editor is created.
// This also keeps repeated form / JSON / diff transitions safe in Vite dev mode.
import 'monaco-editor/editor/contrib/codelens/browser/codeLensCache';
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsController';
import 'monaco-editor/editor/common/services/treeViewsDndService';
import 'monaco-editor/editor/contrib/suggest/browser/suggestMemory';
import 'monaco-editor/platform/actionWidget/browser/actionWidget';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/language/json/monaco.contribution';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import { useConsole } from '../context';

self.MonacoEnvironment = {
  getWorker: (_moduleId: string, label: string) =>
    label === 'json' ? new JsonWorker() : new EditorWorker(),
};
loader.config({ monaco });
const options: monaco.editor.IStandaloneEditorConstructionOptions = {
  editContext: false,
  minimap: { enabled: false },
  fontSize: 13,
  lineHeight: 22,
  scrollBeyondLastLine: false,
  wordWrap: 'on',
  automaticLayout: true,
  tabSize: 2,
  padding: { top: 14, bottom: 14 },
  renderLineHighlight: 'none',
  fixedOverflowWidgets: true,
};
export default function CodeEditor({
  value,
  onChange,
  readOnly = false,
  height = 420,
  label = 'JSON 配置编辑器',
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: number;
  label?: string;
}) {
  const t = useTranslate();
  const { dark } = useConsole();
  return (
    <div className="code-editor" aria-label={t(label)}>
      <Editor
        height={height}
        defaultLanguage="json"
        value={value}
        onChange={(value) => onChange?.(value || '')}
        theme={dark ? 'vs-dark' : 'vs'}
        options={{ ...options, readOnly, ariaLabel: t(label) }}
        loading={<div className="editor-loading">{t('正在加载配置编辑器…')}</div>}
      />
    </div>
  );
}
export function JSONDiff({ before, after }: { before: string; after: string }) {
  const { dark } = useConsole();
  return (
    <DiffEditor
      height={430}
      language="json"
      original={before}
      modified={after}
      theme={dark ? 'vs-dark' : 'vs'}
      options={{
        ...options,
        readOnly: true,
        renderSideBySide: window.innerWidth > 900,
        originalEditable: false,
      }}
    />
  );
}
