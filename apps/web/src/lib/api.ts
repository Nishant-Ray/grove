export type Profile = {
  email: string;
  display_name: string;
  bio: string;
  workspace_mode: 'new' | 'rent' | 'host_setup' | 'host';
};
export type Device = {
  id: string;
  name: string;
  hardware: string;
  specs: {
    cpu: string;
    ram_gb: number;
    gpu: string | null;
    vram_gb: number | null;
    os: string;
    storage_gb: number | null;
    hosting_hours: string;
    acceptance: 'manual' | 'automatic';
  } | null;
  availability: 'available' | 'paused';
  gpu_model: string | null;
  zip: string | null;
  usd_per_kwh_override: number | null;
  green_energy: boolean;
};
export type GpuRate = {
  gpu_model: string;
  label: string;
  vram_gb: number;
  base_rate_usd_hr: number;
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

export async function apiResponse(path: string, method = 'GET', data?: unknown): Promise<Response> {
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
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const message =
      typeof result?.detail === 'string'
        ? result.detail
        : response.status === 422
          ? 'Please check the entries and try again.'
          : 'Could not reach Grove. Please try again.';
    throw new ApiError(response.status, message);
  }
  return response;
}

export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await apiResponse(path, method, data);
  return response.json();
}

export type PriorityLevel = {
  id: string;
  label: string;
  multiplier: number;
  description: string;
};
export type Job = {
  id: string;
  name: string;
  status: 'requested' | 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled' | 'declined';
  progress: number | null;
  requested_at: string;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result_summary: string | null;
  result_filename: string | null;
  host_device_id: string | null;
  gpu_model: string | null;
  priority: string | null;
  est_hours: number | null;
  rate_per_hr: number | null;
  host_payout_per_hr: number | null;
  reserve_micros: number | null;
  charged_micros: number | null;
  code_link: string | null;
  accepted_at: string | null;
  start_by: string | null;
  outcome_reason: string | null;
};
export type Recommendation = {
  host_device_id: string;
  device_name: string;
  host_name: string;
  gpu: string;
  gpu_label: string;
  vram_gb: number;
  state: string | null;
  green_energy: boolean;
  distance_miles: number | null;
  rating: number | null;
  review_count: number;
  rate_per_hr: string;
  estimate: string;
  reserve: string;
};

export const usd = (micros: number) =>
  micros > 0 && micros < 5_000 ? 'less than $0.01' : '$' + (micros / 1_000_000).toFixed(2);
