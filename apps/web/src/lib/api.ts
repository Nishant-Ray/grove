export type Profile = { email: string; display_name: string; bio: string };
export type Device = {
  id: string;
  name: string;
  hardware: string;
  availability: 'available' | 'paused';
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function send(path: string, method: string, data?: unknown) {
  return fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Grove-Request': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

let refreshing: Promise<Response> | undefined;

export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  let response = await send(path, method, data);
  if (response.status === 401 && !['/auth/login', '/auth/register'].includes(path)) {
    refreshing ??= send('/auth/refresh', 'POST').finally(() => {
      refreshing = undefined;
    });
    const refresh = await refreshing;
    if (refresh.ok) response = await send(path, method, data);
    else if (refresh.status === 401) window.dispatchEvent(new Event('grove:signed-out'));
    else throw new ApiError(refresh.status, 'Could not reconnect to Grove. Please try again.');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result === null) {
    const message =
      typeof result?.detail === 'string'
        ? result.detail
        : response.status === 422
          ? 'Please check the entries and try again.'
          : 'Could not reach Grove. Please try again.';
    throw new ApiError(response.status, message);
  }
  return result;
}
