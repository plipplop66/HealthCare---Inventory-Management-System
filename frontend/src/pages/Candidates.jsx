import { CandidateTable } from '../components/Evidence';
import { Button, EmptyOrError, PageHead, SourceBadge, Stat } from '../components/ui';
import { formatNumber, formatQuantity, humanise } from '../services/viewModels';

// Donor candidates come only from the optimizer's assessment (a plan, or NO_SAFE_PLAN details).
export function Candidates({ data, onOpenSimulator }) {
  if (!data) {
    return <EmptyOrError title="No donor assessment yet" copy="Run the ripple simulator for the selected facility, medicine and quantity. The optimizer's assessment lists every eligible and rejected donor with its reasons." actionLabel="open ripple simulator" retry={onOpenSimulator} />;
  }
  const unit = data.unit;
  const eligible = data.rows.filter((row) => row.status !== 'REJECTED').length;
  return <>
    <PageHead
      eyebrow="transfer safety"
      title={data.kind === 'PLAN' ? 'Donor candidates for the proposed plan' : 'Donor candidates: no safe plan'}
      copy={data.kind === 'PLAN' ? `${data.destination} · ${data.medicine} · plan ${data.planId}` : `request ${formatQuantity(data.requestedQuantity, unit)} · no transfer can be recommended`}
      action={<Button primary onClick={onOpenSimulator}>open ripple simulator</Button>}
    />
    {data.meta && <SourceBadge meta={data.meta} label="assessment" />}
    {data.requestId && <p className="source-badge"><span>assessment</span><strong>NO_SAFE_PLAN</strong><small>request {data.requestId}</small></p>}
    <section className="info-banner warning"><div>!</div><p><strong>How donors are judged</strong>Donor capacity counts only stock already received{data.capacityBasis ? ` (${humanise(data.capacityBasis)})` : ''}; scheduled or delayed deliveries never add to it. Routes may take at most {Number.isFinite(data.maxTravelHours) ? `${formatNumber(data.maxTravelHours)} hours` : 'the configured limit'}.</p></section>
    <div className="stat-grid three">
      <Stat label="requested quantity" value={formatQuantity(data.requestedQuantity, unit)} />
      {data.kind === 'PLAN'
        ? <Stat label="allocated quantity" value={formatQuantity(data.allocatedQuantity, unit)} detail="from the proposed plan" />
        : <Stat label="safe donor capacity" value={formatQuantity(data.safeCapacity, unit)} detail={`unmet ${formatQuantity(data.unmetQuantity, unit)}`} tone="critical" />}
      <Stat label="candidates" value={`${eligible} eligible`} detail={`${data.rows.length - eligible} rejected of ${data.rows.length} assessed`} />
    </div>
    <CandidateTable rows={data.rows} unit={unit} />
  </>;
}
