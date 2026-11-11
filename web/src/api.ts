let csrf = '';
export function setCSRF(token: string) {
  csrf = token;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const requestCSRF = csrf;
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...options.headers,
    },
  });
  const data = await response
    .json()
    .catch(() => ({ error: `服务返回了非 JSON 响应 (${response.status})` }));
  if (!response.ok) {
    if (
      response.status === 401 &&
      requestCSRF === csrf &&
      !['/login', '/session', '/logout'].includes(path)
    )
      window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(data.error || '请求失败', response.status);
  }
  return data as T;
}
export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
