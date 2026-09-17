// MEDRIPPLE's PostgreSQL TIMESTAMP columns carry no time zone. The API writes them as UTC wall-clock time and reads
// them back as UTC instants, so neither the database session's TimeZone nor the Node process's TZ can shift them.
const UTC_NOW = "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')";

// "<timestamp> AT TIME ZONE 'UTC'" is a TIMESTAMPTZ for the stored UTC wall-clock time; pg parses it as an instant.
function utcInstant(column) {
  return `(${column} AT TIME ZONE 'UTC')`;
}

function isoInstant(value) {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('A PostgreSQL timestamp must be read with utcInstant() so it is an unambiguous instant.');
  }
  return value.toISOString();
}

module.exports = { UTC_NOW, utcInstant, isoInstant };
