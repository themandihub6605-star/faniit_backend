// Tiny structured logger for Fanitt Store. Every line starts with
// [FanittStore] and an event name, so on the server you can follow one
// flow with:  pm2 logs fanitt-api | grep "FanittStore"
// Errors include the stack; money events include the ids you need to
// trace a payment end to end.

function format(level, event, data) {
  const time = new Date().toISOString();
  let payload = '';
  if (data !== undefined) {
    try {
      payload = ` ${JSON.stringify(data)}`;
    } catch {
      payload = ' [unserializable data]';
    }
  }
  return `${time} [FanittStore] ${level} ${event}${payload}`;
}

module.exports = {
  info(event, data) {
    console.log(format('INFO', event, data));
  },
  warn(event, data) {
    console.warn(format('WARN', event, data));
  },
  error(event, err, data) {
    console.error(format('ERROR', event, { ...(data || {}), message: err?.message }));
    if (err?.stack) console.error(err.stack);
  },
};
