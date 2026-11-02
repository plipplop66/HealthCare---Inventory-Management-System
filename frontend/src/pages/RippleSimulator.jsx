import { ErrorPanel } from '../components/ErrorPanel';
import { CandidateTable, PlanEvidence } from '../components/Evidence';
import { SelectionBar } from '../components/SelectionBar';
import { Button, Card, PageHead, SourceBadge, Stat, StatusPill } from '../components/ui';
import { mapCandidates, mapPlanEvidence } from '../services/evidence';
import { formatQuantity } from '../services/viewModels';

export function requestText(request, catalog) {
  if (!request) return '';
  const facility = catalog.facilities.find((item) => item.id === request.destinationFacilityId);
  const medicine = catalog.medicines.find((item) => item.id === request.medicineId);
  return `${formatQuantity(request.quantity, medicine?.unit)} of ${medicine ? `${medicine.genericName} ${medicine.strength}` : request.medicineId} for ${facility?.name || request.destinationFacilityId} over ${request.horizonDays} days`;
}

function NoSafePlanResult({ assessment, catalog }) {
  const candidates = mapCandidates(assessment);
  const details = assessment.details;
  const unit = candidates.unit;
  return <>
    <section className="info-banner warning" role="status"><div>!</div><p><strong>No safe plan for {requestText(assessment.request, catalog)}</strong>{assessment.message} No transfer was proposed and no stock moved.{assessment.requestId ? ` Request ${assessment.requestId}.` : ''}</p></section>
    <div className="stat-grid three">
      <Stat label="requested quantity" value={formatQuantity(candidates.requestedQuantity, unit)} />
      <Stat label="safe donor capacity" value={formatQuantity(details.safeCapacity, unit)} detail={details.solverStatus ? `solver: ${details.solverStatus}` : ''} />
      <Stat label="unmet quantity" value={formatQuantity(details.unmetQuantity, unit)} tone="critical" detail="cannot be supplied safely" />
    </div>
    {(details.recommendedEscalation || []).length > 0 && <Card className="evidence-card"><h2>escalation steps</h2><ul className="plain-list">{details.recommendedEscalation.map((step) => <li key={step}>{step}</li>)}</ul></Card>}
    <CandidateTable rows={candidates.rows} unit={unit} title="eligible and rejected donors" />
  </>;
}

function SafePlanResult({ assessment, catalog, onReview }) {
  const plan = mapPlanEvidence(assessment.plan);
  return <>
    <Card className="plan-result">
      <div className="card-heading">
        <div><p className="eyebrow">proposed plan</p><h2>{plan.id}</h2><p>{requestText(assessment.request, catalog)} · {plan.medicine.name}</p></div>
        <div className="plan-result-actions"><StatusPill tone="neutral">{plan.status}</StatusPill>{plan.requiresHumanApproval && <StatusPill tone="medium">HUMAN APPROVAL REQUIRED</StatusPill>}<Button primary onClick={onReview}>review this plan</Button></div>
      </div>
      <SourceBadge meta={assessment.plan.meta} label="assessment" />
      <div className="stat-grid three">
        <Stat label="requested" value={formatQuantity(plan.requestedQuantity, plan.medicine.unit)} />
        <Stat label="allocated" value={formatQuantity(plan.allocatedQuantity, plan.medicine.unit)} detail={`${plan.transfers.length} transfer(s) from ${new Set(plan.transfers.map((transfer) => transfer.fromFacilityId)).size} donor(s)`} />
        <Stat label="destination" value={plan.destination.name} detail={plan.destination.id} />
      </div>
    </Card>
    <PlanEvidence plan={plan} />
  </>;
}

export function RippleSimulator({ catalog, selection, onSelection, onRun, busy, assessment, error, onReview }) {
  return <>
    <PageHead eyebrow="ripple simulation" title="Assess a transfer before action" copy="Submits the selection to the optimizer through the MEDRIPPLE API. Nothing is reserved until an approver approves the plan." />
    <SelectionBar catalog={catalog} selection={selection} onChange={onSelection} onSubmit={onRun} submitLabel="run safety assessment" busy={busy} />
    {error && <ErrorPanel error={error} />}
    {error && !assessment && <p className="muted" role="status">No plan is selected: a failed assessment never leaves an earlier plan open for approval.</p>}
    {assessment?.kind === 'MISSING' && <section className="info-banner warning" role="status"><div>!</div><p><strong>The previous plan is no longer available</strong>Run a new assessment.</p></section>}
    {assessment?.kind === 'NO_SAFE_PLAN' && <NoSafePlanResult assessment={assessment} catalog={catalog} />}
    {assessment?.kind === 'PLAN' && <SafePlanResult assessment={assessment} catalog={catalog} onReview={onReview} />}
  </>;
}
