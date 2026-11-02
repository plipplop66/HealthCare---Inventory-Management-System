import { Card, RiskPill, StatusPill } from './ui';
import { formatCover, formatNumber, formatQuantity, humanise } from '../services/viewModels';

const STATUS_TONES = { SELECTED: 'approved', ELIGIBLE_NOT_SELECTED: 'neutral', ELIGIBLE: 'neutral', REJECTED: 'rejected' };

export function CandidateTable({ rows, unit, title = 'donor assessment' }) {
  return <Card className="assessment">
    <div className="card-heading"><div><h2>{title}</h2><p>Every facility the optimizer considered, with each rejection code and reason it returned.</p></div><StatusPill tone="neutral">{rows.length} candidates</StatusPill></div>
    {rows.length ? <div className="table-wrap"><table><thead><tr><th>facility</th><th>status and reasons</th><th>safe capacity</th><th>retained floor</th><th>route</th><th>cold chain</th><th>future supply excluded</th></tr></thead><tbody>{rows.map((row) => <tr key={row.facilityId}>
      <td><strong>{row.facilityName}</strong><small>{row.facilityId} · {row.facilityType}</small>{row.baselineRiskLabel && <RiskPill label={row.baselineRiskLabel} score={row.baselineRiskScore} />}</td>
      <td><StatusPill tone={STATUS_TONES[row.status] || 'neutral'}>{row.status}</StatusPill>
        {row.rejectionCodes.length > 0 && <ul className="reason-list">{row.rejectionCodes.map((code, index) => <li key={`${code}-${index}`}><code>{code}</code> {row.rejectionReasons[index] || ''}</li>)}</ul>}
        {row.rejectionReasons.slice(row.rejectionCodes.length).map((reason) => <small key={reason}>{reason}</small>)}
        {row.explanation && row.status !== 'REJECTED' && <small>{row.explanation}</small>}
      </td>
      <td>{formatQuantity(row.safeCapacity, unit)}{Number(row.allocatedQuantity) > 0 && <small>allocated {formatQuantity(row.allocatedQuantity, unit)}</small>}</td>
      <td>{formatQuantity(row.retainedFloor, unit)}<small>protected {formatQuantity(row.protectedStock, unit)} · effective {formatQuantity(row.effectiveStock, unit)}</small></td>
      <td>{Number.isFinite(row.travelHours) ? `${formatNumber(row.travelHours)} h` : 'no route'}{Number.isFinite(row.distanceKm) && <small>{formatNumber(row.distanceKm)} km</small>}</td>
      <td>{row.coldChain}</td>
      <td>{formatQuantity(row.futureReplenishmentExcluded, unit)}{Number(row.futureReplenishmentExcluded) > 0 && <small>scheduled or delayed stock not counted toward donor capacity</small>}</td>
    </tr>)}</tbody></table></div> : <p className="muted">The optimizer returned no candidate details for this assessment.</p>}
  </Card>;
}

export function TransferTable({ transfers, unit }) {
  return <div className="table-wrap"><table><thead><tr><th>donor</th><th>batch</th><th>quantity</th><th>schedule</th><th>route</th><th>cold chain</th></tr></thead><tbody>{transfers.map((transfer) => <tr key={`${transfer.fromFacilityId}-${transfer.batchId}`}>
    <td><strong>{transfer.fromFacilityName}</strong><small>{transfer.fromFacilityId} → {transfer.toFacilityId}</small></td>
    <td><strong>{transfer.batchNo}</strong><small>batch ID {String(transfer.batchId)}{transfer.expiryDate ? ` · expires ${transfer.expiryDate}` : ''}</small></td>
    <td>{formatQuantity(transfer.quantity, unit)}</td>
    <td>{transfer.departureDay ? `depart day ${transfer.departureDay}` : 'departure not reported'}<small>arrive day {transfer.arrivalDay ?? '—'}{transfer.arrivalDate ? ` · ${transfer.arrivalDate}` : ''}</small></td>
    <td>{Number.isFinite(transfer.travelHours) ? `${formatNumber(transfer.travelHours)} h` : 'not reported'}{Number.isFinite(transfer.distanceKm) && <small>{formatNumber(transfer.distanceKm)} km</small>}</td>
    <td>{transfer.coldChainAvailable === true ? 'available' : transfer.coldChainAvailable === false ? 'unavailable' : 'not reported'}</td>
  </tr>)}</tbody></table></div>;
}

export function ValidationChecks({ checks, title = 'validation checks' }) {
  if (!checks?.length) return null;
  return <div className="check-list"><h3>{title}</h3><ul>{checks.map((check) => <li key={check.name} className={check.passed ? 'passed' : 'failed'}>
    <b>{check.passed ? 'PASSED' : 'FAILED'}</b><code>{check.name}</code>{check.detail && <span>{check.detail}</span>}
  </li>)}</ul></div>;
}

export function RiskChanges({ rows }) {
  if (!rows?.length) return null;
  return <div className="table-wrap"><table><thead><tr><th>facility</th><th>role</th><th>before</th><th>after</th></tr></thead><tbody>{rows.map((row) => <tr key={row.facilityId}>
    <td><strong>{row.facilityName}</strong><small>{row.facilityId}</small></td>
    <td>{row.role}</td>
    <td><RiskPill label={row.before.riskLabel} score={row.before.riskScore} /><small>{formatCover(row.before.daysRemaining)}{row.before.stockoutDay ? ` · stockout day ${row.before.stockoutDay}` : ''}</small></td>
    <td><RiskPill label={row.after.riskLabel} score={row.after.riskScore} /><small>{formatCover(row.after.daysRemaining)}{row.after.stockoutDay ? ` · stockout day ${row.after.stockoutDay}` : ''}</small></td>
  </tr>)}</tbody></table></div>;
}

export function ReceivedStockEvidence({ check, unit }) {
  if (!check) return null;
  return <div className="check-list"><h3>donor safety on stock already received <StatusPill tone={check.passed ? 'approved' : 'rejected'}>{check.passed ? 'PASSED' : 'FAILED'}</StatusPill></h3>
    <p className="muted">{check.explanation}</p>
    <ul>{(check.donors || []).map((donor) => <li key={donor.facilityId} className={donor.passed ? 'passed' : 'failed'}>
      <b>{donor.passed ? 'PASSED' : 'FAILED'}</b><code>{donor.facilityId}</code>
      <span>sends {formatQuantity(donor.totalSent, unit)} · retained floor {formatQuantity(donor.retainedFloor, unit)} · lowest projected {formatQuantity(donor.lowestProjectedStock, unit)}{donor.lowestProjectedDay ? ` on day ${donor.lowestProjectedDay}` : ''} · future supply excluded {formatQuantity(donor.futureReplenishmentExcluded, unit)}</span>
      {(donor.failureCodes || []).map((code) => <code key={code}>{code}</code>)}
      {donor.explanation && <span>{donor.explanation}</span>}
    </li>)}</ul>
  </div>;
}

export function PlanEvidence({ plan }) {
  const unit = plan.medicine.unit;
  return <>
    <Card className="evidence-card">
      <div className="card-heading"><div><h2>exact transfers</h2><p>{plan.rationale}</p></div></div>
      <TransferTable transfers={plan.transfers} unit={unit} />
    </Card>
    <Card className="evidence-card">
      <div className="card-heading"><div><h2>safety evidence</h2><p>{plan.solver || 'optimizer'} · route limit {Number.isFinite(plan.maxTravelHours) ? `${formatNumber(plan.maxTravelHours)} h` : 'not reported'} · model {plan.modelVersion || plan.source || 'not reported'}</p></div>
        <StatusPill tone={plan.comparison.safeToRecommend ? 'approved' : 'rejected'}>{plan.comparison.safeToRecommend ? 'SAFE TO RECOMMEND' : 'NOT SAFE TO RECOMMEND'}</StatusPill></div>
      {plan.recipient && <dl className="fact-list">
        <div><dt>recipient stockout</dt><dd>{plan.recipient.stockoutDayBefore ? `day ${plan.recipient.stockoutDayBefore}` : 'none'} → {plan.recipient.stockoutDayAfter ? `day ${plan.recipient.stockoutDayAfter}` : 'none'}</dd></div>
        <div><dt>shortage days</dt><dd>{formatNumber(plan.recipient.shortageDaysBefore)} → {formatNumber(plan.recipient.shortageDaysAfter)}</dd></div>
        <div><dt>unmet demand</dt><dd>{formatQuantity(plan.recipient.unmetDemandBefore, unit)} → {formatQuantity(plan.recipient.unmetDemandAfter, unit)}</dd></div>
        <div><dt>new shortages created</dt><dd>{plan.comparison.newShortagesCreated.join(', ') || 'none'}</dd></div>
        <div><dt>new risks</dt><dd>{plan.comparison.newRisks.map((risk) => `${risk.facilityId} ${humanise(risk.riskType)}`).join('; ') || 'none'}</dd></div>
      </dl>}
      <h3 className="subhead">risk before and after</h3>
      <RiskChanges rows={plan.facilityStates} />
      <ValidationChecks checks={plan.validation?.checks} title={`validation checks${plan.validation ? ` · ${plan.validation.passed ? 'all passed' : 'failed'}` : ''}`} />
      <ReceivedStockEvidence check={plan.receivedStockCheck} unit={unit} />
      {plan.limitations.length > 0 && <p className="muted limitation">{plan.limitations.join(' ')}</p>}
    </Card>
  </>;
}
