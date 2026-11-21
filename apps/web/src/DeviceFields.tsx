import type { Device } from './lib/api';

export function devicePayload(form: HTMLFormElement, previous: Device | null) {
  const fields = new FormData(form);
  const text = (name: string) => String(fields.get(name) ?? '').trim();
  const number = (name: string) => (text(name) ? Number(text(name)) : null);
  const cpu = text('cpu');
  return {
    name: text('name'),
    availability: text('availability'),
    hardware: previous && !previous.specs ? previous.hardware : cpu,
    specs: {
      cpu,
      ram_gb: number('ram_gb'),
      gpu: text('gpu') || null,
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
            GPU model (optional)
            <input
              name="gpu"
              defaultValue={spec?.gpu ?? ''}
              maxLength={100}
              placeholder="NVIDIA RTX 4060"
            />
          </label>
          <label className="field">
            GPU memory (GB, optional)
            <input
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
            <select name="acceptance" defaultValue={spec?.acceptance ?? 'manual'}>
              <option value="manual">Review each request</option>
              <option value="automatic">Accept automatically</option>
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
