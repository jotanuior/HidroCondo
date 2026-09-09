import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from './db.js';
import { evaluateReading, parseCounter } from './reading-policy.js';

const legacyTelemetrySchema = z.object({
  nivel: z.union([z.string(), z.number()]),
  numero_serie_sensor: z.string().min(1),
  numero_serie_central: z.string().optional().default(''),
  tipo_sensor: z.string().optional(),
  'tipo_sensor recebido': z.string().optional(),
  'data ATUAL': z.union([z.string(), z.date()]).optional(),
  data_atual: z.union([z.string(), z.date()]).optional(),
  timestamp: z.union([z.string(), z.number(), z.date()]).optional()
}).passthrough();

export type TelemetryInput = z.infer<typeof legacyTelemetrySchema>;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function resolveSourceTimestamp(payload: TelemetryInput): Date | null {
  const candidate = payload['data ATUAL'] ?? payload.data_atual ?? payload.timestamp;
  if (candidate === undefined) return null;
  if (candidate instanceof Date) return Number.isNaN(candidate.getTime()) ? null : candidate;
  if (typeof candidate === 'number') {
    const milliseconds = candidate < 10_000_000_000 ? candidate * 1000 : candidate;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveSensorType(payload: TelemetryInput): string {
  return (payload['tipo_sensor recebido'] ?? payload.tipo_sensor ?? payload.numero_serie_sensor.slice(0, 2)).trim();
}

async function ensureSensor(client: PoolClient, serial: string, sensorType: string, centralSerial: string) {
  await client.query(
    `INSERT INTO sensors (serial, sensor_type, central_serial)
     VALUES ($1, $2, NULLIF($3, ''))
     ON CONFLICT (serial) DO UPDATE SET
       central_serial = COALESCE(NULLIF(EXCLUDED.central_serial, ''), sensors.central_serial)`,
    [serial, sensorType, centralSerial]
  );

  const result = await client.query(
    `SELECT id, serial, sensor_type, conversion_factor, last_raw_value, last_reading_at, last_seen_at, last_source_timestamp, counter_digits, max_flow_m3_hour, needs_review, active, virtual_counter
       FROM sensors
      WHERE serial = $1
      FOR UPDATE`,
    [serial]
  );

  return result.rows[0];
}

export async function ingestTelemetry(rawPayload: unknown, eventId?: string) {
  const payload = legacyTelemetrySchema.parse(rawPayload);
  const serial = payload.numero_serie_sensor.trim();
  const sensorType = resolveSensorType(payload);
  const rawValue = parseCounter(payload.nivel);
  if (!serial) throw new Error('Serial vazio');
  const sourceTimestamp = resolveSourceTimestamp(payload);
  const centralSerial = payload.numero_serie_central?.trim() ?? '';
  const receivedAt = new Date();

  // Legacy messages without event identity are separate heartbeats. Their delta is
  // still zero when the counter is unchanged. Never deduplicate them forever.
  const eventKey = crypto.createHash('sha256').update(
    eventId?.trim() ? `${serial}|event|${eventId.trim()}` : sourceTimestamp
      ? `${serial}|${rawValue}|${sourceTimestamp.toISOString()}|${stableJson(rawPayload)}`
      : `${serial}|${crypto.randomUUID()}`
  ).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sensor = await ensureSensor(client, serial, sensorType, centralSerial);
    await client.query('UPDATE sensors SET last_seen_at=GREATEST(last_seen_at,$2) WHERE id=$1', [sensor.id,receivedAt]);
    const duplicate = await client.query(
      `SELECT id, sensor_id, raw_value, delta_raw, consumption_m3, virtual_counter, status, received_at
         FROM telemetry_readings
        WHERE event_key = $1 AND sensor_id=$2`,
      [eventKey,sensor.id]
    );

    if (duplicate.rowCount) {
      await client.query('COMMIT');
      return { duplicate: true, ...duplicate.rows[0] };
    }

    const previous = sensor.last_raw_value === null ? null : Number(sensor.last_raw_value);
    const previousAt = sensor.last_reading_at ? new Date(sensor.last_reading_at) : null;
    const factor = Number(sensor.conversion_factor);

    const previousSeen = sensor.last_seen_at ? new Date(sensor.last_seen_at) : previousAt;
    const offlineSeconds = previousSeen ? Math.max(0, Math.floor((receivedAt.getTime()-previousSeen.getTime())/1000)) : 0;
    const decision = !sensor.active ? { accepted:false,delta:0,status:'inactive_sensor' }
      : sensor.sensor_type !== sensorType ? { accepted:false,delta:0,status:'sensor_type_mismatch' }
      : sensorType !== '09' ? { accepted:false,delta:0,status:'unsupported_type' }
      : evaluateReading({ previous,current:rawValue,digits:Number(sensor.counter_digits),factor,
          elapsedSeconds:previousAt ? (receivedAt.getTime()-previousAt.getTime())/1000 : 0,
          sourceTime:sourceTimestamp?.getTime() ?? null,
          previousSourceTime:sensor.last_source_timestamp ? new Date(sensor.last_source_timestamp).getTime() : null,
          receivedTime:receivedAt.getTime(),maxFlowM3Hour:sensor.max_flow_m3_hour === null ? null : Number(sensor.max_flow_m3_hour),
          pending:sensor.needs_review });
    const delta = decision.delta;
    const rollover = decision.status === 'rollover';
    let status = decision.status;
    if (decision.accepted && previousAt && offlineSeconds > 1800) status = rollover ? 'rollover_recovered_after_offline' : 'recovered_after_offline';

    const consumptionM3 = delta * factor;
    const virtualCounter = Number(sensor.virtual_counter) + consumptionM3;

    const inserted = await client.query(
      `INSERT INTO telemetry_readings
        (sensor_id, raw_value, delta_raw, conversion_factor, consumption_m3, virtual_counter,
         received_at, source_timestamp, status, offline_seconds, event_key, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       RETURNING id, sensor_id, raw_value, delta_raw, consumption_m3, virtual_counter, status,
                 offline_seconds, received_at, source_timestamp`,
      [sensor.id,rawValue,delta,factor,consumptionM3,virtualCounter,receivedAt,sourceTimestamp,status,offlineSeconds,eventKey,JSON.stringify(rawPayload)]
    );

    if (decision.accepted) {
      await client.query(`UPDATE sensors SET last_raw_value=$2,last_reading_at=$3,
        virtual_counter=$4,last_source_timestamp=COALESCE($5,last_source_timestamp) WHERE id=$1`,
        [sensor.id,rawValue,receivedAt,virtualCounter,sourceTimestamp]);
    } else if (!['out_of_order','future_timestamp','inactive_sensor','unsupported_type'].includes(status)) {
      await client.query('UPDATE sensors SET needs_review=true WHERE id=$1',[sensor.id]);
    }

    await client.query('COMMIT');

    return { duplicate: false, serial, sensor_type: sensorType, previous_raw_value: previous, rollover, ...inserted.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
