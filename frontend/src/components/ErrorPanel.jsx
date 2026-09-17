import { Button } from './ui';
import { describeError } from '../services/errors';
import { formatQuantity, humanise } from '../services/viewModels';

function RevalidationFailure({ details, unit }) {
  return <div className="error-details">
    {(details.failedChecks || []).length > 0 && <><h3>failed checks</h3><ul>{details.failedChecks.map((check) => <li key={check.name}><code>{check.name}</code> {check.detail}</li>)}</ul></>}
    {(details.rejectedTransfers || []).length > 0 && <><h3>rejected transfers</h3><ul>{details.rejectedTransfers.map((transfer) => <li key={`${transfer.index}-${transfer.batchId}`}>
      transfer {transfer.index}: {transfer.fromFacilityId} → {transfer.toFacilityId}, batch {transfer.batchNo} ({String(transfer.batchId)}), {formatQuantity(transfer.quantity, unit)}
      <ul>{(transfer.rejectionCodes || []).map((code, index) => <li key={`${code}-${index}`}><code>{code}</code> {transfer.rejectionReasons?.[index] || ''}</li>)}</ul>
    </li>)}</ul></>}
    {(details.unsafeDonors || []).length > 0 && <><h3>donors not safe on received stock</h3><ul>{details.unsafeDonors.map((donor) => <li key={donor.facilityId}>
      <code>{donor.facilityId}</code> {(donor.failureCodes || []).join(', ')} · retained floor {formatQuantity(donor.retainedFloor, unit)} · lowest projected {formatQuantity(donor.lowestProjectedStock, unit)} · future supply excluded {formatQuantity(donor.futureReplenishmentExcluded, unit)}
      {donor.explanation && <small>{donor.explanation}</small>}
    </li>)}</ul></>}
    {(details.newShortagesCreated || []).length > 0 && <p>New shortages: {details.newShortagesCreated.join(', ')}</p>}
    {(details.newRisks || []).length > 0 && <p>New risks: {details.newRisks.map((risk) => `${risk.facilityId} ${humanise(risk.riskType)}`).join('; ')}</p>}
    {details.intelligenceError && <p>Intelligence service answered {details.intelligenceError.status} <code>{details.intelligenceError.code}</code>: {details.intelligenceError.message}</p>}
    {details.instruction && <p className="instruction">{details.instruction}</p>}
  </div>;
}

function StockFailure({ details }) {
  return <div className="error-details"><h3>reservation checks that failed</h3><ul>{(details.failures || []).map((failure, index) => <li key={`${failure.reason}-${index}`}>
    <code>{failure.reason}</code>{failure.fromFacilityId ? ` ${failure.fromFacilityId}` : ''}{failure.batchNo ? ` batch ${failure.batchNo}` : ''}{failure.detail ? ` · ${failure.detail}` : ''}
  </li>)}</ul></div>;
}

export function ErrorPanel({ error, unit = '', onRetry, retryLabel = 'try again' }) {
  if (!error) return null;
  const described = describeError(error);
  const details = described.details && typeof described.details === 'object' ? described.details : null;
  return <section className="error-panel" role="alert">
    <p className="error-code">{described.code}{described.status ? ` · HTTP ${described.status}` : ''}</p>
    <h2>{described.title}</h2>
    {described.guidance && <p>{described.guidance}</p>}
    {described.message && <p className="muted">{described.message}</p>}
    {details && described.code === 'PLAN_REVALIDATION_FAILED' && <RevalidationFailure details={details} unit={unit} />}
    {details && described.code === 'PLAN_STOCK_CHANGED' && <StockFailure details={details} />}
    {described.requestId && <small>request {described.requestId}</small>}
    {onRetry && <Button onClick={onRetry}>{retryLabel}</Button>}
  </section>;
}
