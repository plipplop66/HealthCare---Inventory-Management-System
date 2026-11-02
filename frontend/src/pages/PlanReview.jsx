import { useState } from 'react';
import { Icon } from '../components/Icon';
import { ErrorPanel } from '../components/ErrorPanel';
import { PlanEvidence } from '../components/Evidence';
import { Button, Card, PageHead, SourceBadge, StatusPill } from '../components/ui';
import { mapPlanEvidence } from '../services/evidence';
import { formatQuantity, formatTimestamp } from '../services/viewModels';

const STATUS_TONES = { PROPOSED: 'medium', RESERVED: 'approved', APPROVED: 'approved', IN_TRANSIT: 'neutral', DELIVERED: 'approved', REJECTED: 'rejected', CANCELLED: 'rejected' };

// The evidence the API returned (or recorded in the audit event) for a revalidated approval.
export function RevalidationEvidence({ revalidation, unit }) {
  if (!revalidation) return null;
  if (revalidation.performed === false) {
    return <section className="info-banner warning" role="status"><div>!</div><p><strong>Fixture approval: no stock reserved</strong>{revalidation.detail || 'The intelligence service was not consulted. This is not a production safety check.'}</p></section>;
  }
  return <Card className="evidence-card revalidation">
    <div className="card-heading"><div><h2>revalidation before reservation</h2><p>{revalidation.modelVersion} · data {revalidation.dataSource} · checked {formatTimestamp(revalidation.checkedAt)}{Number.isFinite(revalidation.maxTravelHours) ? ` · route limit ${revalidation.maxTravelHours} h` : ''}</p></div><StatusPill tone={revalidation.passed ? 'approved' : 'rejected'}>{revalidation.passed ? 'ALL CHECKS PASSED' : 'NOT PASSED'}</StatusPill></div>
    <ul className="check-grid">{(revalidation.checks || []).map((check) => <li key={check}><Icon name="check" size={13} /><code>{check}</code></li>)}</ul>
    {(revalidation.transfers || []).length > 0 && <><h3 className="subhead">transfers checked</h3><ul className="plain-list">{revalidation.transfers.map((transfer) => <li key={`${transfer.index}-${transfer.batchId}`}>
      {transfer.fromFacilityId} → {transfer.toFacilityId}: {formatQuantity(transfer.quantity, unit)} · batch {transfer.batchNo} ({String(transfer.batchId)}) · day {transfer.departureDay}→{transfer.arrivalDay}{Number.isFinite(transfer.travelHours) ? ` · ${transfer.travelHours} h` : ''}{transfer.coldChainAvailable !== undefined ? ` · cold chain ${transfer.coldChainAvailable ? 'available' : 'unavailable'}` : ''}
    </li>)}</ul></>}
    {revalidation.receivedStockCheck && <><h3 className="subhead">donors on stock already received · {revalidation.receivedStockCheck.passed ? 'passed' : 'failed'}</h3><ul className="plain-list">{(revalidation.receivedStockCheck.donors || []).map((donor) => <li key={donor.facilityId}>
      {donor.facilityId}: sends {formatQuantity(donor.totalSent, unit)} · retained floor {formatQuantity(donor.retainedFloor, unit)} · lowest projected {formatQuantity(donor.lowestProjectedStock, unit)} · future supply excluded {formatQuantity(donor.futureReplenishmentExcluded, unit)}
    </li>)}</ul></>}
  </Card>;
}

function ActionButtons({ status, busy, noteReady, onDecision, onLifecycle }) {
  if (status === 'PROPOSED') {
    return <div className="plan-actions">
      <Button primary disabled={busy || !noteReady} onClick={() => onDecision('APPROVE')}>{busy ? 'revalidating and reserving…' : 'approve and reserve stock'}</Button>
      <Button className="danger" disabled={busy || !noteReady} onClick={() => onDecision('REJECT')}>reject</Button>
    </div>;
  }
  if (status === 'RESERVED') {
    return <div className="plan-actions">
      <Button primary disabled={busy || !noteReady} onClick={() => onLifecycle('DISPATCH')}>confirm dispatch</Button>
      <Button className="danger" disabled={busy || !noteReady} onClick={() => onLifecycle('CANCEL')}>cancel and release stock</Button>
    </div>;
  }
  if (status === 'IN_TRANSIT') {
    return <div className="plan-actions"><Button primary disabled={busy || !noteReady} onClick={() => onLifecycle('DELIVER')}>confirm delivery</Button></div>;
  }
  return <p className="muted">No further action is available for a {status} plan.</p>;
}

// outcome: { ok, action, response?, error? } for the latest action on this plan; decisionEvent: the recorded audit
// event (with its revalidation evidence) after a refresh.
export function PlanReview({ plan: envelope, role, busy, outcome, decisionEvent, onDecision, onLifecycle, onOpenSimulator }) {
  const [note, setNote] = useState('');
  const plan = mapPlanEvidence(envelope);
  const unit = plan.medicine.unit;
  const canDecide = ['APPROVER', 'ADMIN'].includes(role);
  const noteReady = note.trim().length > 0;
  const shownRevalidation = outcome?.ok ? outcome.response.data.revalidation : decisionEvent?.revalidation;
  return <>
    <PageHead eyebrow="plan review" title={`Plan ${plan.id}`} copy={`${plan.destination.name} (${plan.destination.id}) · ${plan.medicine.name} · ${plan.horizonDays}-day horizon`} action={<StatusPill tone={STATUS_TONES[plan.status] || 'neutral'}>{plan.status}</StatusPill>} />
    <div className="source-row"><SourceBadge meta={envelope.meta} label="plan record" />{plan.source && <p className="source-badge"><span>plan produced by</span><strong>{plan.source}</strong>{plan.dataSource && <small>data {plan.dataSource}</small>}</p>}</div>
    {plan.status === 'PROPOSED' && <section className="info-banner success" role="note"><Icon name="shield" /><p><strong>Approval re-checks safety before any stock is reserved</strong>Approving sends these exact transfers, batches and quantities back to the intelligence service for a fresh safety simulation. Only if every check still passes does the database reserve the donor stock. If anything changed, nothing is reserved and you will be asked to run a new assessment. Rejecting needs no re-check.</p></section>}
    {outcome?.ok && <section className="info-banner success" role="status"><Icon name="check" /><p><strong>{outcome.action === 'APPROVE' ? (outcome.response.data.plan.status === 'RESERVED' ? 'Revalidated and reserved: plan is RESERVED' : 'Fixture approval recorded: plan is APPROVED') : `Recorded: plan is ${outcome.response.data.plan.status}`}</strong>Audit event {String(outcome.response.data.audit?.id ?? '')} was recorded{outcome.response.meta.requestId ? ` (request ${outcome.response.meta.requestId})` : ''}.</p></section>}
    {outcome && !outcome.ok && <ErrorPanel error={outcome.error} unit={unit} onRetry={['PLAN_REVALIDATION_FAILED', 'PLAN_STOCK_CHANGED', 'NO_SAFE_PLAN'].includes(outcome.error.code) ? onOpenSimulator : undefined} retryLabel="run a new assessment" />}
    <div className="plan-grid">
      <Card className="plan-summary">
        <h2>summary</h2>
        <dl>
          <div><dt>requested</dt><dd>{formatQuantity(plan.requestedQuantity, unit)}</dd></div>
          <div><dt>allocated</dt><dd>{formatQuantity(plan.allocatedQuantity, unit)}</dd></div>
          <div><dt>medicine ID</dt><dd>{plan.medicine.id} · {unit}</dd></div>
          <div><dt>human approval</dt><dd>{plan.requiresHumanApproval ? 'required' : 'not stated'}</dd></div>
          <div><dt>status</dt><dd>{plan.status}</dd></div>
          {envelope.data.decidedBy && <div><dt>decided by</dt><dd>{envelope.data.decidedBy} · {formatTimestamp(envelope.data.decidedAt)}</dd></div>}
        </dl>
      </Card>
      <Card className="plan-summary">
        <h2>decision</h2>
        {canDecide ? <>
          <label>operational note <small>required for every decision</small><textarea value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="record the reason for this decision" /></label>
          <ActionButtons status={plan.status} busy={busy} noteReady={noteReady} onDecision={(decision) => onDecision(decision, note)} onLifecycle={(action) => onLifecycle(action, note)} />
          {!noteReady && ['PROPOSED', 'RESERVED', 'IN_TRANSIT'].includes(plan.status) && <p className="muted">Enter a note to enable the actions.</p>}
        </> : <div className="role-notice"><Icon name="shield" /><div><strong>approver role required</strong><span>Your {role ? role.toLowerCase() : 'current'} account can review this plan but cannot approve, reject, dispatch, deliver or cancel it.</span></div></div>}
      </Card>
    </div>
    <RevalidationEvidence revalidation={shownRevalidation} unit={unit} />
    {decisionEvent && !outcome?.ok && <p className="muted">Recorded decision: {decisionEvent.action} by {decisionEvent.actor} · {decisionEvent.at} · audit {decisionEvent.id}</p>}
    <PlanEvidence plan={plan} />
  </>;
}
