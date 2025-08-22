function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const days = Math.floor(minutes / (24 * 60));
  const remMin = minutes - days * 24 * 60;
  const h = Math.floor(remMin / 60);
  const m = remMin % 60;
  if (days > 0) return `${days}d${h}h${m}m`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function formatMass(grams) {
  const g = Math.max(0, Math.round(grams));
  if (g >= 1000) {
    const kg = grams / 1000;
    return `${kg.toFixed(2)}kg`;
  }
  return `${g}g`;
}

function parseLoopSpecifier(arg) {
  const raw = String(arg);
  if (/^\d+$/.test(raw)) {
    const value = parseInt(raw, 10);
    if (value >= 1) return { type: 'count', value, raw };
  }
  const timeMatch = raw.match(/^(\d+(?:\.\d+)?)([mhd])$/i);
  if (timeMatch) {
    const qty = parseFloat(timeMatch[1]);
    const unit = timeMatch[2].toLowerCase();
    let minutes = qty;
    if (unit === 'h') minutes = qty * 60;
    if (unit === 'd') minutes = qty * 60 * 24;
    return { type: 'time', minutes, raw };
  }
  // Accept grams (g) or kilograms (kg)
  const kgMatch = raw.match(/^(\d+(?:\.\d+)?)kg$/i);
  if (kgMatch) {
    const grams = parseFloat(kgMatch[1]) * 1000;
    return { type: 'grams', grams, raw };
  }
  const gMatch = raw.match(/^(\d+(?:\.\d+)?)g$/i);
  if (gMatch) {
    const grams = parseFloat(gMatch[1]);
    return { type: 'grams', grams, raw };
  }
  return { type: 'invalid', raw };
}

module.exports = {
  formatDuration,
  formatMass,
  parseLoopSpecifier,
};


