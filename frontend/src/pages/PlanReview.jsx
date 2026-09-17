import { useState } from 'react';
import { PlanEvidence } from '../components/Evidence';
import { Button, Card, PageHead, SourceBadge, StatusPill } from '../components/ui';
import { mapPlanEvidence } from '../services/evidence';
import { formatQuantity } from '../services/viewModels';

export function PlanReview({ plan: envelope, canDecide, busy, onDecision, onLifecycle, message }) {
  const [note, setNote] = useState('');
  const plan = mapPlanEvidence(envelope);
  const unit = plan.medicine.unit;
  const noteReady = note.trim().length > 0;
  return <>
    <PageHead eyebrow="plan review" title={`Plan ${plan.id}`} copy={`${plan.destination.name} (${plan.destination.id}) · ${plan.medicine.name} · ${plan.horizonDays}-day horizon`} action={<StatusPill tone="neutral">{plan.status}</StatusPill>} />
    <div className="source-row"><SourceBadge meta={envelope.meta} label="plan record" />{plan.source && <p className="source-badge"><span>plan produced by</span><strong>{plan.source}</strong>{plan.dataSource && <small>data {plan.dataSource}</small>}</p>}</div>
    <div className="plan-grid">
      <Card className="plan-summary">
        <h2>summary</h2>
        <dl>
          <div><dt>requested</dt><dd>{formatQuantity(plan.requestedQuantity, unit)}</dd></div>
          <div><dt>allocated</dt><dd>{formatQuantity(plan.allocatedQuantity, unit)}</dd></div>
          <div><dt>medicine ID</dt><dd>{plan.medicine.id} · {unit}</dd></div>
          <div><dt>human approval</dt><dd>{plan.requiresHumanApproval ? 'required' : 'not stated'}</dd></div>
          <div><dt>status</dt><dd>{plan.status}</dd></div>
        </dl>
      </Card>
      <Card className="plan-summary">
        <h2>decision</h2>
        <label>operational note <small>required</small><textarea value={note} disabled={!canDecide || busy} onChange={(event) => setNote(event.target.value)} placeholder="record the reason for this decision" /></label>
        {!canDecide ? <p className="muted">Approver role required.</p> : plan.status === 'PROPOSED' ? <div className="plan-actions">
          <Button primary disabled={busy || !noteReady} onClick={() => onDecision('APPROVE', note)}>approve and reserve stock</Button>
          <Button className="danger" disabled={busy || !noteReady} onClick={() => onDecision('REJECT', note)}>reject</Button>
        </div> : plan.status === 'RESERVED' ? <div className="plan-actions">
          <Button primary disabled={busy || !noteReady} onClick={() => onLifecycle('DISPATCH', note)}>confirm dispatch</Button>
          <Button className="danger" disabled={busy || !noteReady} onClick={() => onLifecycle('CANCEL', note)}>cancel and release stock</Button>
        </div> : plan.status === 'IN_TRANSIT' ? <div className="plan-actions">
          <Button primary disabled={busy || !noteReady} onClick={() => onLifecycle('DELIVER', note)}>confirm delivery</Button>
        </div> : null}
        {message && <p className="muted" role="status">{message}</p>}
      </Card>
    </div>
    <PlanEvidence plan={plan} />
  </>;
}
