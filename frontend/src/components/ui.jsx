import { Icon } from './Icon';
import { riskText, riskTone, sourceText } from '../services/viewModels';

export function RiskPill({ label, score }) {
  const text = riskText(label);
  return <span className={`risk-pill ${riskTone(text)}`}>{text}{Number.isFinite(score) ? ` · ${score}` : ''}</span>;
}

export function StatusPill({ tone = 'neutral', children }) {
  return <span className={`risk-pill ${tone}`}>{children}</span>;
}

export function Button({ children, primary = false, className = '', ...props }) {
  return <button type="button" className={`mr-button ${primary ? 'primary' : ''} ${className}`} {...props}>{children}</button>;
}

export function Card({ className = '', children, ...props }) {
  return <section className={`mr-card ${className}`} {...props}>{children}</section>;
}

export function Stat({ label, value, detail, tone = '' }) {
  return <article className="mr-stat">
    <span>{label}</span>
    <strong>{value}</strong>
    {detail && <small className={tone}>{detail}</small>}
  </article>;
}

export function PageHead({ eyebrow, title, copy, action }) {
  return <div className="page-head">
    <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{copy && <p className="page-copy">{copy}</p>}</div>
    {action && <div className="page-action">{action}</div>}
  </div>;
}

export function EmptyOrError({ title, copy, retry, actionLabel = 'try again' }) {
  return <section className="empty-state" role="alert"><Icon name="alert" size={24} /><h1>{title}</h1><p>{copy}</p>{retry && <Button primary onClick={retry}>{actionLabel}</Button>}</section>;
}

// Where a result came from, whether it is a fallback, and its request ID.
export function SourceBadge({ meta, label = 'source' }) {
  if (!meta) return null;
  return <p className={`source-badge ${meta.fallback ? 'fallback' : ''} ${meta.source === 'MOCK_DATA' ? 'mock' : ''}`}>
    <span>{label}</span>
    <strong>{sourceText(meta.source)}</strong>
    {meta.fallback && <b>FALLBACK</b>}
    {meta.decisionSupportOnly && <em>decision support only</em>}
    {meta.requestId && <small>request {meta.requestId}</small>}
  </p>;
}

export function Definition({ label, children }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
