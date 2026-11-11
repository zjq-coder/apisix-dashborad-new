import { GlobalOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import { Button, Dropdown } from 'antd';
import { setLocale, useLocale, useTranslate, type Locale } from '../i18n';

const languages = { 'zh-CN': '简体中文', 'en-US': 'English' } as const;

export function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const locale = useLocale();
  const t = useTranslate();
  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      getPopupContainer={(trigger) =>
        trigger.closest<HTMLElement>('.topbar-actions') || document.body
      }
      menu={{
        selectable: true,
        selectedKeys: [locale],
        items: Object.entries(languages).map(([key, label]) => ({
          key,
          label: <span lang={key}>{label}</span>,
        })),
        onClick: ({ key }) => setLocale(key as Locale),
      }}
    >
      <Button
        type="text"
        className="language-switch"
        icon={<GlobalOutlined />}
        aria-label={t('切换语言')}
        title={t('切换语言')}
      >
        {!compact && <span className="language-name">{languages[locale]}</span>}
      </Button>
    </Dropdown>
  );
}

export function languageFooter(buttons: ReactNode) {
  return (
    <div className="dialog-footer">
      <LanguageSwitch compact />
      <div>{buttons}</div>
    </div>
  );
}
