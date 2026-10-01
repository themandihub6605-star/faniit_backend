// All money is stored and passed around in paise (integers).

/** Percentage of an amount, rounded to the nearest paisa. */
function percentOf(amount, percent) {
  return Math.round((amount * percent) / 100);
}

function formatRupees(paise) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

module.exports = { percentOf, formatRupees };
