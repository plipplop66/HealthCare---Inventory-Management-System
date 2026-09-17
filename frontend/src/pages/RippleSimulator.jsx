import { Button, Card, PageHead, SourceBadge, Stat } from '../components/ui';
import { formatQuantity } from '../services/viewModels';

const HORIZONS = [7, 14, 30];

export function RippleSimulator({ target, horizonDays, quantity, onQuantity, onHorizon, onRun, busy, outcome, error, onReview }) {
  const unit = target?.unit || '';
  return <>
    <PageHead eyebrow="ripple simulation" title="Assess a transfer before action" copy={target ? `${target.facilityName} · ${target.medicineName}` : 'No destination is available from the API.'} />
    <Card className="simulation-controls">
      <form className="assessment-form" onSubmit={(event) => { event.preventDefault(); onRun(); }}>
        <label>quantity ({unit})<input value={quantity} onChange={(event) => onQuantity(event.target.value)} inputMode="decimal" placeholder={`amount in ${unit}`} required disabled={busy || !target} /></label>
        <div className="horizon-switch">{HORIZONS.map((days) => <button type="button" key={days} className={horizonDays === days ? 'active' : ''} disabled={busy} onClick={() => onHorizon(days)}>{days} days</button>)}</div>
        <Button type="submit" primary disabled={busy || !target}>{busy ? 'checking safety…' : 'run safety assessment'}</Button>
      </form>
    </Card>
    {error && <section className="info-banner warning" role="alert"><div>!</div><p><strong>Assessment failed</strong>{error.message}</p></section>}
    {outcome?.noSafePlan && <Card><h2>No safe plan for this request</h2><p className="muted">{outcome.message}</p>
      <div className="stat-grid three"><Stat label="requested" value={formatQuantity(outcome.quantity, unit)} /><Stat label="safe donor capacity" value={formatQuantity(outcome.details.safeCapacity, unit)} /><Stat label="unmet quantity" value={formatQuantity(outcome.details.unmetQuantity, unit)} /></div>
    </Card>}
    {outcome?.plan && <Card>
      <div className="card-heading"><div><h2>plan {outcome.plan.data.id}</h2><p>{outcome.plan.data.status} · human approval required</p></div><Button primary onClick={onReview}>review this plan</Button></div>
      <SourceBadge meta={outcome.plan.meta} label="assessment" />
      <ul className="plain-list">{outcome.plan.data.transfers.map((transfer) => <li key={`${transfer.fromFacilityId}-${transfer.batchId}`}>{transfer.fromFacilityId} → {transfer.toFacilityId}: {formatQuantity(transfer.quantity, unit)} · batch {transfer.batchNo}</li>)}</ul>
    </Card>}
  </>;
}
