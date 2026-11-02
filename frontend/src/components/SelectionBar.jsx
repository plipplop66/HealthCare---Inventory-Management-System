import { Button, Card } from './ui';
import { HORIZONS, isCountUnit, validateQuantity } from '../services/selection';

// Facility, medicine, quantity and horizon, using the API's facility and medicine IDs and the medicine's unit.
export function SelectionBar({ catalog, selection, onChange, onSubmit, submitLabel, busy = false, showQuantity = true }) {
  const medicine = catalog.medicines.find((item) => item.id === selection.medicineId);
  const unit = medicine?.unit || '';
  const check = selection.quantity === '' ? null : validateQuantity(selection.quantity, unit);
  const submit = (event) => {
    event.preventDefault();
    onSubmit?.();
  };
  return <Card className="simulation-controls selection-bar">
    <form className="assessment-form" onSubmit={submit} aria-label="assessment selection">
      <label>facility
        <select value={selection.facilityId} disabled={busy} onChange={(event) => onChange({ facilityId: event.target.value })}>
          {catalog.facilities.map((facility) => <option key={facility.id} value={facility.id}>{facility.name} ({facility.id})</option>)}
        </select>
      </label>
      <label>medicine
        <select value={selection.medicineId} disabled={busy} onChange={(event) => onChange({ medicineId: event.target.value })}>
          {catalog.medicines.map((item) => <option key={item.id} value={item.id}>{item.genericName} {item.strength} · {item.unit}</option>)}
        </select>
      </label>
      {showQuantity && <label>quantity{unit ? ` (${unit})` : ''}
        <input
          value={selection.quantity}
          disabled={busy}
          inputMode={isCountUnit(unit) ? 'numeric' : 'decimal'}
          placeholder={isCountUnit(unit) ? 'whole units' : `up to 2 decimals${unit ? ` in ${unit}` : ''}`}
          aria-invalid={check ? !check.ok : undefined}
          onChange={(event) => onChange({ quantity: event.target.value })}
        />
      </label>}
      <div className="horizon-field"><span>horizon</span><div className="horizon-switch" role="group" aria-label="horizon">{HORIZONS.map((days) => <button type="button" key={days} className={selection.horizonDays === days ? 'active' : ''} aria-pressed={selection.horizonDays === days} disabled={busy} onClick={() => onChange({ horizonDays: days })}>{days} days</button>)}</div></div>
      {onSubmit && <Button type="submit" primary disabled={busy || (showQuantity && !check?.ok)}>{busy ? 'checking safety…' : submitLabel}</Button>}
    </form>
    {check && !check.ok && <p className="field-error" role="alert">{check.message}</p>}
  </Card>;
}
