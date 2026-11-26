import { useEffect, useRef, useState } from 'react';
import { api, type Device, type GpuRate } from './lib/api';

export function devicePayload(form: HTMLFormElement, previous: Device | null) {
  const fields = new FormData(form);
  const text = (name: string) => String(fields.get(name) ?? '').trim();
  const number = (name: string) => (text(name) ? Number(text(name)) : null);
  const cpu = text('cpu');
  const gpuSelect = form.elements.namedItem('gpu_model') as HTMLSelectElement;
  // If the GPU list failed to load, keep whatever GPU the listing already had.
  const keep = gpuSelect.disabled;
  const gpuModel = keep ? (previous?.gpu_model ?? null) : gpuSelect.value || null;
  const gpuLabel = keep ? (previous?.specs?.gpu ?? null) : gpuModel ? gpuSelect.selectedOptions[0].text : null;
  return {
    name: text('name'),
    availability: text('availability'),
    hardware: previous && !previous.specs ? previous.hardware : cpu,
    gpu_model: gpuModel,
    zip: text('zip'),
    usd_per_kwh_override: number('usd_per_kwh_override'),
    green_energy: fields.get('green_energy') === 'on',
    specs: {
      cpu,
      ram_gb: number('ram_gb'),
      gpu: gpuLabel,
      vram_gb: number('vram_gb'),
      storage_gb: number('storage_gb'),
      os: text('os'),
      acceptance: text('acceptance'),
      hosting_hours: text('hosting_hours'),
    },
  };
}

export default function DeviceFields({ device }: { device: Device | null }) {
  const spec = device?.specs;
  const [rates, setRates] = useState<GpuRate[] | null>(null);
  const [ratesError, setRatesError] = useState(false);
  const vram = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    api<GpuRate[]>('/gpu-rates')
      .then((rows) => active && setRates(rows))
      .catch(() => active && setRatesError(true));
    return () => {
      active = false;
    };
  }, []);
  const legacyGpu = spec?.gpu && !device?.gpu_model ? spec.gpu : null;
  return (
    <>
      {device && !spec && <p>Previous hardware details: {device.hardware}</p>}
      <label className="field">
        Device name
        <input
          name="name"
          defaultValue={device?.name}
          placeholder="Studio workstation"
          required
          maxLength={100}
        />
      </label>
      <fieldset className="spec-fields">
        <legend>Compute specifications</legend>
        <div className="spec-grid">
          <label className="field">
            CPU model
            <input
              name="cpu"
              defaultValue={spec?.cpu}
              placeholder="AMD Ryzen 7 7700"
              required
              maxLength={100}
            />
          </label>
          <label className="field">
            System memory (GB)
            <input
              name="ram_gb"
              type="number"
              min="1"
              max="65536"
              defaultValue={spec?.ram_gb}
              required
              placeholder="32"
            />
          </label>
          <label className="field">
            GPU model
            {rates ? (
              <select
                name="gpu_model"
                defaultValue={device?.gpu_model ?? ''}
                onChange={(event) => {
                  const rate = rates.find((r) => r.gpu_model === event.target.value);
                  if (rate && vram.current) vram.current.value = String(rate.vram_gb);
                }}
              >
                <option value="">Other / no supported GPU</option>
                {rates.map((rate) => (
                  <option key={rate.gpu_model} value={rate.gpu_model}>
                    {rate.label}
                  </option>
                ))}
              </select>
            ) : (
              <select name="gpu_model" disabled defaultValue="">
                <option value="">{ratesError ? 'GPU list unavailable' : 'Loading GPUs…'}</option>
              </select>
            )}
          </label>
          <label className="field">
            GPU memory (GB, optional)
            <input
              ref={vram}
              name="vram_gb"
              type="number"
              min="1"
              max="65536"
              defaultValue={spec?.vram_gb ?? ''}
              placeholder="8"
            />
          </label>
          <label className="field">
            Operating system
            <select name="os" defaultValue={spec?.os ?? ''} required>
              <option value="" disabled>
                Select system
              </option>
              {['Linux', 'Windows', 'macOS', 'Other'].map((os) => (
                <option key={os}>{os}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Free storage (GB, optional)
            <input
              name="storage_gb"
              type="number"
              min="1"
              max="10000000"
              defaultValue={spec?.storage_gb ?? ''}
              placeholder="250"
            />
          </label>
        </div>
        {legacyGpu && (
          <p className="fine-print">
            Previously listed GPU: {legacyGpu}. Choose the matching model so renters can find
            this device.
          </p>
        )}
        {ratesError && (
          <p className="fine-print">
            The GPU list could not be loaded. Saving now keeps the GPU already on this listing.
          </p>
        )}
      </fieldset>
      <fieldset className="spec-fields">
        <legend>Location &amp; power</legend>
        <div className="spec-grid">
          <label className="field">
            ZIP code
            <input
              name="zip"
              inputMode="numeric"
              pattern="\d{5}"
              title="Five-digit US ZIP code"
              defaultValue={device?.zip ?? ''}
              placeholder="14850"
              required
            />
          </label>
          <label className="field">
            Electricity price ($/kWh, optional)
            <input
              name="usd_per_kwh_override"
              type="number"
              step="0.001"
              min="0.01"
              max="2"
              defaultValue={device?.usd_per_kwh_override ?? ''}
              placeholder="Your state's average"
            />
          </label>
        </div>
        <label className="consent">
          <input
            type="checkbox"
            name="green_energy"
            defaultChecked={device?.green_energy ?? false}
          />
          This device runs on renewable energy
        </label>
        <p className="fine-print">
          Grove only offers your device for jobs whose payout covers its electricity cost with a
          margin. Your ZIP code is used for approximate distance and is never shown to renters.
        </p>
      </fieldset>
      <fieldset className="spec-fields">
        <legend>Hosting preferences</legend>
        <div className="spec-grid">
          <label className="field">
            Listing availability
            <select name="availability" defaultValue={device?.availability ?? 'paused'}>
              <option value="paused">Paused</option>
              <option value="available">Available</option>
            </select>
          </label>
          <label className="field">
            Job acceptance
            <select name="acceptance" defaultValue={spec?.acceptance ?? 'automatic'}>
              <option value="automatic">Accept automatically</option>
              <option value="manual">Review each request</option>
            </select>
          </label>
        </div>
        <label className="field">
          Hosting hours (optional)
          <input
            name="hosting_hours"
            maxLength={200}
            defaultValue={spec?.hosting_hours}
            placeholder="Weekdays after 6 pm, Eastern time"
          />
        </label>
        <p className="fine-print">
          These settings record your preferences. Saving a listing does not start jobs on your
          device.
        </p>
      </fieldset>
    </>
  );
}
