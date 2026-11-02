import { Button, Card, PageHead, RiskPill, SourceBadge, Stat } from '../components/ui';
import { formatDays, formatNumber, formatQuantity, humanise } from '../services/viewModels';

// Plots the intelligence service's own day-by-day projection. Nothing is projected in the browser.
export function ProjectionChart({ projection, protectedStock, unit }) {
  if (!projection) return <p className="projection-unavailable" role="status">Projection unavailable</p>;
  const values = projection.map((day) => Number(day.closingStock) || 0);
  const max = Math.max(1, ...values, Number(protectedStock) || 0);
  const x = (index) => (projection.length === 1 ? 50 : (index / (projection.length - 1)) * 100);
  const y = (value) => 92 - (value / max) * 84;
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
  const middle = projection[Math.floor((projection.length - 1) / 2)];
  return <div className="forecast-chart" aria-label={`projected closing stock in ${unit} for ${projection.length} days`}>
    {Number.isFinite(protectedStock) && <span className="safety-line" style={{ top: `${y(protectedStock)}%` }}>protected stock {formatQuantity(protectedStock, unit)}</span>}
    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
      {Number.isFinite(protectedStock) && <line x1="0" x2="100" y1={y(protectedStock)} y2={y(protectedStock)} />}
      <polyline points={points} />
    </svg>
    <div><span>day {projection[0].day} · {projection[0].date}</span><span>day {middle.day}</span><span>day {projection.at(-1).day} · {projection.at(-1).date}</span></div>
  </div>;
}

export function FacilityDetail({ data, onAssess }) {
  const { facility, medicine, stock, forecast, replenishment } = data;
  const unit = medicine.unit;
  return <>
    <PageHead eyebrow="facility intelligence" title={facility.name} copy={`${facility.id} · ${facility.type} · ${data.horizonDays}-day horizon`} action={<Button primary onClick={onAssess}>run safety assessment</Button>} />
    <section className="risk-banner">
      <div><span>selected medicine</span><h2>{medicine.name}</h2><p>medicine ID {medicine.id} · unit {unit}{medicine.criticality ? ` · ${medicine.criticality}` : ''}{medicine.storage ? ` · storage ${medicine.storage}` : ''}</p></div>
      <div><span>forecast risk</span>{forecast ? <><strong>{formatNumber(forecast.riskScore)}<small>/100</small></strong><RiskPill label={forecast.riskLabel} /></> : <strong>Unavailable</strong>}</div>
    </section>
    <div className="source-row"><SourceBadge meta={data.inventoryMeta} label="inventory" /><SourceBadge meta={data.forecastMeta} label="forecast" /></div>
    {forecast?.isFallback && <section className="info-banner warning" role="status"><div>!</div><p><strong>Fallback forecast</strong>The intelligence service did not answer ({forecast.fallbackReason || 'unavailable'}). These figures are an informational estimate from database records and are never used for approval.</p></section>}
    {data.forecastError && <section className="info-banner warning" role="status"><div>!</div><p><strong>Forecast unavailable</strong>{data.forecastError.message} ({data.forecastError.code})</p></section>}
    <div className="stat-grid four facility-stats">
      <Stat label="recorded stock" value={formatQuantity(stock.recorded, unit)} detail={`${formatQuantity(stock.excluded, unit)} excluded (expired, quarantined or unavailable)`} />
      <Stat label="effective stock" value={formatQuantity(stock.effective, unit)} detail="usable, in-date, not quarantined" />
      <Stat label="protected stock" value={formatQuantity(stock.protected, unit)} detail={stock.protectedSource ? humanise(stock.protectedSource) : 'not reported for this medicine'} />
      <Stat label="daily demand" value={forecast ? formatQuantity(forecast.dailyDemand, `${unit}/day`) : 'Unavailable'} detail={forecast && Number.isFinite(forecast.lowerBound) ? `range ${formatNumber(forecast.lowerBound)}–${formatNumber(forecast.upperBound)} ${unit}/day` : 'from the forecast'} />
    </div>
    <div className="detail-grid">
      <Card>
        <div className="card-heading"><div><h2>projected stock</h2><p>closing stock per day from the forecast service</p></div></div>
        <ProjectionChart projection={data.projection} protectedStock={stock.protected} unit={unit} />
        <dl className="fact-list">
          <div><dt>days of cover</dt><dd>{forecast ? formatDays(forecast.daysRemaining) : 'Unavailable'}</dd></div>
          <div><dt>projected stockout</dt><dd>{forecast?.stockoutDay ? `day ${forecast.stockoutDay}${forecast.stockoutDate ? ` · ${forecast.stockoutDate}` : ''}` : forecast?.withinHorizon === false ? 'none within the horizon' : 'Unavailable'}</dd></div>
          <div><dt>next replenishment</dt><dd>{replenishment ? `${formatQuantity(replenishment.quantity, unit)} · ${replenishment.status}${replenishment.date ? ` · ${replenishment.date}` : ''}${replenishment.timing ? ` · ${humanise(replenishment.timing)}` : ''}` : 'none recorded'}</dd></div>
        </dl>
      </Card>
      <Card className="evidence">
        <h2>why this is flagged</h2>
        <div><span>primary cause</span><strong>{forecast?.cause || 'Unavailable'}</strong><p>{forecast?.explanation || 'No forecast explanation is available.'}</p></div>
        <div><span>forecast confidence</span><strong>{forecast?.confidence || 'Unavailable'}</strong><p>{forecast?.confidenceReason}</p></div>
        <div><span>model and source</span><strong>{forecast ? forecast.modelVersion || forecast.source : 'Unavailable'}</strong><p>{forecast ? `${forecast.dataLabel || forecast.source}${forecast.method ? ` · ${forecast.method}` : ''}` : ''}</p></div>
      </Card>
    </div>
    <Card className="batch-card">
      <div className="card-heading"><div><h2>batches</h2><p>every batch recorded for this facility and medicine</p></div></div>
      {data.batches.length ? <div className="table-wrap"><table><thead><tr><th>batch</th><th>quantity</th><th>expiry</th><th>status</th></tr></thead><tbody>{data.batches.map((batch) => <tr key={`${batch.batchId}-${batch.status}`}>
        <td><strong>{batch.batchNo}</strong><small>batch ID {batch.batchId}</small></td>
        <td>{formatQuantity(batch.quantity, unit)}</td>
        <td>{batch.expiryDate}</td>
        <td>{batch.status}</td>
      </tr>)}</tbody></table></div> : <p className="muted">No batches are recorded for this medicine here.</p>}
    </Card>
  </>;
}
