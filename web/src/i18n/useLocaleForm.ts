import { useEffect, useRef } from 'react';
import { Form } from 'antd';
import { useLocale } from './index';

export function useLocaleForm(open = true) {
  const [form] = Form.useForm();
  const locale = useLocale();
  const previous = useRef(locale);
  useEffect(() => {
    if (previous.current === locale) return;
    previous.current = locale;
    if (!open) return;
    const invalid = form.getFieldsError().filter((field) => field.errors.length);
    if (invalid.length)
      void form.validateFields(invalid.map((field) => field.name)).catch(() => {});
  }, [form, locale, open]);
  return form;
}
