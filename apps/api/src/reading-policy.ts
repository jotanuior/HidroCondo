export type ReadingDecision = { accepted: boolean; delta: number; status: string };

export function parseCounter(value: string | number): number {
  if (typeof value === 'string' && !/^\d{1,6}$/.test(value.trim())) {
    throw new Error('Leitura deve conter somente de 1 a 6 dígitos');
  }
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < 0 || raw > 999999) throw new Error('Leitura fora do intervalo permitido');
  return raw;
}

export function evaluateReading(input: {
  previous: number | null; current: number; digits: number; factor: number;
  elapsedSeconds: number; sourceTime: number | null; previousSourceTime: number | null;
  receivedTime: number; maxFlowM3Hour: number | null; pending: boolean;
}): ReadingDecision {
  const reject = (status: string): ReadingDecision => ({ accepted: false, delta: 0, status });
  if (input.current >= 10 ** input.digits) return reject('counter_out_of_range');
  if (input.sourceTime !== null && input.sourceTime > input.receivedTime + 300_000) return reject('future_timestamp');
  if (input.sourceTime !== null && input.previousSourceTime !== null && input.sourceTime <= input.previousSourceTime) return reject('out_of_order');
  if (input.pending) return reject('pending_review');
  if (input.previous === null) return { accepted: true, delta: 0, status: 'first_reading' };
  const rollover = input.current < input.previous;
  const delta = rollover ? 10 ** input.digits - input.previous + input.current : input.current - input.previous;
  // A decreasing counter is ambiguous without a configured physical flow limit.
  if (rollover && input.maxFlowM3Hour === null) return reject('suspect_decrease');
  if (input.maxFlowM3Hour !== null) {
    const elapsed = input.sourceTime !== null && input.previousSourceTime !== null
      ? (input.sourceTime - input.previousSourceTime) / 1000 : input.elapsedSeconds;
    const maxVolume = input.maxFlowM3Hour * Math.max(0, elapsed) / 3600;
    // One increment of tolerance accounts for counter quantization.
    if (delta * input.factor > maxVolume + input.factor) return reject('suspect_flow');
    if (rollover && maxVolume >= 10 ** input.digits * input.factor) return reject('ambiguous_rollover');
  }
  return { accepted: true, delta, status: rollover ? 'rollover' : 'normal' };
}
