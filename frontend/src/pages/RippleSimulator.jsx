import { SelectionBar } from '../components/SelectionBar';
import { Button, Card, PageHead, SourceBadge, Stat } from '../components/ui';
import { formatQuantity } from '../services/viewModels';

function requestText(request, catalog) {
  if (!request) return '';
  const facility = catalog.facilities.find((item) => item.id === request.destinationFacilityId);
  const medicine = catalog.medicines.find((item) => item.id === request.medicineId);
  return `${formatQuantity(request.quantity, medicine?.unit)} of ${medicine ? `${medicine.genericName} ${medicine.strength}` : request.medicineId} for ${facility?.name || request.destinationFacilityId} over ${request.horizonDays} days`;
}

export function RippleSimulator({ catalog, selection, onSelection, onRun, busy, assessment, error, onReview }) {
  const unit = assessment?.plan?.data?.medicine?.unit || assessment?.details?.unit || '';
  return <>
    <PageHead eyebrow="ripple simulation" title="Assess a transfer before action" copy="Submits the selection to the optimizer through the MEDRIPPLE API. Nothing is reserved until a human approves the plan." />
    <SelectionBar catalog={catalog} selection={selection} onChange={onSelection} onSubmit={onRun} submitLabel="run safety assessment" busy={busy} />
    {error && <section className="info-banner warning" role="alert"><div>!</div><p><strong>Assessment failed</strong>{error.message}</p></section>}
    {assessment?.kind === 'MISSING' && <section className="info-banner warning" role="status"><div>!</div><p><strong>The previous plan is no longer available</strong>Run a new assessment.</p></section>}
    {assessment?.kind === 'NO_SAFE_PLAN' && <Card><h2>No safe plan for this request</h2><p className="muted">{requestText(assessment.request, catalog)}</p><p className="muted">{assessment.message}</p>
      <div className="stat-grid three"><Stat label="requested" value={formatQuantity(assessment.request?.quantity, unit)} /><Stat label="safe donor capacity" value={formatQuantity(assessment.details.safeCapacity, unit)} /><Stat label="unmet quantity" value={formatQuantity(assessment.details.unmetQuantity, unit)} /></div>
    </Card>}
    {assessment?.kind === 'PLAN' && <Card>
      <div className="card-heading"><div><h2>plan {assessment.plan.data.id}</h2><p>{requestText(assessment.request, catalog)} · {assessment.plan.data.status} · human approval required</p></div><Button primary onClick={onReview}>review this plan</Button></div>
      <SourceBadge meta={assessment.plan.meta} label="assessment" />
      <ul className="plain-list">{assessment.plan.data.transfers.map((transfer) => <li key={`${transfer.fromFacilityId}-${transfer.batchId}`}>{transfer.fromFacilityId} → {transfer.toFacilityId}: {formatQuantity(transfer.quantity, unit)} · batch {transfer.batchNo}</li>)}</ul>
    </Card>}
  </>;
}
