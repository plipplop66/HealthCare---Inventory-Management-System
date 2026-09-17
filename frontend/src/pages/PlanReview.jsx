import { useState } from 'react';
import { Button, Card, PageHead, SourceBadge, StatusPill } from '../components/ui';
import { formatQuantity, medicineName } from '../services/viewModels';

export function PlanReview({ plan, canDecide, busy, onDecision, onLifecycle, message }) {
  const [note, setNote] = useState('');
  const data = plan.data;
  const unit = data.medicine?.unit || '';
  const noteReady = note.trim().length > 0;
  return <>
    <PageHead eyebrow="plan review" title={`Plan ${data.id}`} copy={`${data.destinationFacilityName || data.destinationFacilityId} · ${medicineName(data.medicine)} · ${data.horizonDays}-day horizon`} action={<StatusPill tone="neutral">{data.status}</StatusPill>} />
    <SourceBadge meta={plan.meta} label="plan" />
    <div className="plan-grid">
      <Card className="instruction-card"><p className="eyebrow">transfer instructions</p><h2>exact transfers</h2><p className="muted">{data.rationale}</p>
        {data.transfers.map((transfer, index) => <article className="transfer" key={`${transfer.fromFacilityId}-${transfer.batchId}`}><b>{index + 1}</b>
          <div><span>donor</span><h3>{transfer.fromFacilityName || transfer.fromFacilityId}</h3><p>batch {transfer.batchNo} (ID {transfer.batchId})</p></div>
          <div><strong>{formatQuantity(transfer.quantity, unit)}</strong></div>
        </article>)}
      </Card>
      <Card className="plan-summary"><h2>decision</h2>
        <label>operational note <small>required</small><textarea value={note} disabled={!canDecide || busy} onChange={(event) => setNote(event.target.value)} placeholder="record the reason for this decision" /></label>
        {!canDecide ? <p className="muted">Approver role required.</p> : data.status === 'PROPOSED' ? <div className="plan-actions">
          <Button primary disabled={busy || !noteReady} onClick={() => onDecision('APPROVE', note)}>approve</Button>
          <Button className="danger" disabled={busy || !noteReady} onClick={() => onDecision('REJECT', note)}>reject</Button>
        </div> : data.status === 'RESERVED' ? <div className="plan-actions">
          <Button primary disabled={busy || !noteReady} onClick={() => onLifecycle('DISPATCH', note)}>confirm dispatch</Button>
          <Button className="danger" disabled={busy || !noteReady} onClick={() => onLifecycle('CANCEL', note)}>cancel and release stock</Button>
        </div> : data.status === 'IN_TRANSIT' ? <div className="plan-actions">
          <Button primary disabled={busy || !noteReady} onClick={() => onLifecycle('DELIVER', note)}>confirm delivery</Button>
        </div> : null}
        {message && <p className="muted" role="status">{message}</p>}
      </Card>
    </div>
  </>;
}
