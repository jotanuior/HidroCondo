import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';

const sensorSchema = z.object({
  serial: z.string().min(3).max(100),
  type: z.string().min(1).max(20),
  central_serial: z.string().max(200).nullable().optional(),
  last_seen_at: z.string().datetime({ offset: true }).nullable().optional()
});

const syncSchema = z.object({
  source: z.string().default('SCAE'),
  generated_at: z.string().datetime({ offset: true }),
  sensor_count: z.number().int().nonnegative().optional(),
  sensors: z.array(sensorSchema).max(100000)
});

export function registerScaeRoutes(app: Express) {
  app.post('/api/v1/scae/sensores/sync', async (req, res) => {
    const expected = process.env.SCAE_SYNC_API_KEY;
    const supplied = req.header('x-scae-key');

    if (!expected || !supplied || supplied !== expected) {
      return res.status(401).json({ ok: false, error: 'Chave de sincronização SCAE inválida' });
    }

    const parsed = syncSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'Payload de sincronização inválido',
        details: parsed.error.flatten()
      });
    }

    const payload = parsed.data;
    const sensors = payload.sensors
      .filter((sensor) => sensor.type === '09' && sensor.serial.startsWith('09'));

    if (payload.sensors.length > 0 && sensors.length === 0) {
      return res.status(400).json({ ok: false, error: 'Nenhum sensor tipo 09 válido recebido' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // O envio diário é tratado como snapshot completo dos sensores tipo 09.
      // Sensores ausentes não são apagados: apenas deixam de constar como presentes no SCAE.
      await client.query(
        `UPDATE scae_sensor_inventory
            SET scae_present = FALSE,
                updated_at = now()
          WHERE sensor_type = '09'`
      );

      let inserted = 0;
      let updated = 0;

      for (const sensor of sensors) {
        const result = await client.query(
          `INSERT INTO scae_sensor_inventory
            (serial, sensor_type, central_serial, first_synced_at, last_synced_at, last_seen_at, scae_present, updated_at)
           VALUES ($1,$2,$3,now(),now(),$4,TRUE,now())
           ON CONFLICT (serial) DO UPDATE SET
             sensor_type = EXCLUDED.sensor_type,
             central_serial = COALESCE(EXCLUDED.central_serial, scae_sensor_inventory.central_serial),
             last_synced_at = now(),
             last_seen_at = COALESCE(EXCLUDED.last_seen_at, scae_sensor_inventory.last_seen_at),
             scae_present = TRUE,
             updated_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [sensor.serial.trim(), sensor.type.trim(), sensor.central_serial?.trim() || null, sensor.last_seen_at ?? null]
        );

        if (result.rows[0]?.inserted) inserted += 1;
        else updated += 1;
      }

      const absentResult = await client.query(
        `SELECT count(*)::int AS count
           FROM scae_sensor_inventory
          WHERE sensor_type = '09' AND scae_present = FALSE`
      );

      await client.query('COMMIT');

      return res.status(200).json({
        ok: true,
        source: payload.source,
        generated_at: payload.generated_at,
        received: sensors.length,
        inserted,
        updated,
        absent: absentResult.rows[0]?.count ?? 0
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
