-- migration_v21_twilio_phone.sql
-- Register the Twilio US caller-ID (+15076046329, LiveKit outbound trunk
-- ST_2h7bcKSkRDHm) in the default dispatcher pool so it appears in the
-- Batch → "From number (caller ID)" dropdown as "Twilio US" and can be
-- selected for outbound calls. The frontend already labels +1 numbers as
-- "Twilio US" and the dispatcher routes a selected number strictly through
-- its own trunk, so this row is the only missing piece.
--
-- SCOPED TO QA ONLY (current_database() = 'los_form_qa'): deliberately a no-op
-- on prod (los_form) and local dev (los_form) so merging qa -> master does NOT
-- auto-add a US number to the prod dial pool. Adopting the US caller ID in prod
-- should be a separate, deliberate change — a US number auto-selected by
-- "Auto (least-loaded)" for Indian customers has caller-ID + cost implications.
--
-- Idempotent: deploy-qa.sh re-runs every migration on each deploy, so this is
-- safe to apply repeatedly (find-or-create pool + upsert the number).

DO $$
DECLARE
  v_pool_id UUID;
BEGIN
  IF current_database() <> 'los_form_qa' THEN
    RAISE NOTICE 'migration_v21_twilio_phone: skipped (db=% is not los_form_qa)', current_database();
    RETURN;
  END IF;

  -- Find-or-create the default dispatcher pool.
  SELECT id INTO v_pool_id
    FROM phone_pools WHERE name = 'pusad-default'
    ORDER BY created_at LIMIT 1;
  IF v_pool_id IS NULL THEN
    INSERT INTO phone_pools (id, bank_id, name, capacity,
                             cooldown_seconds_min, cooldown_seconds_max, created_at)
    VALUES (gen_random_uuid(), NULL, 'pusad-default', 5, 180, 300, NOW())
    RETURNING id INTO v_pool_id;
  END IF;

  -- Add / reactivate the Twilio number in that pool.
  INSERT INTO phone_numbers (pool_id, phone_number, livekit_trunk_id, status,
                             active_calls, total_calls, created_at, updated_at)
  VALUES (v_pool_id, '+15076046329', 'ST_2h7bcKSkRDHm', 'active', 0, 0, NOW(), NOW())
  ON CONFLICT (pool_id, phone_number) DO UPDATE
    SET livekit_trunk_id = EXCLUDED.livekit_trunk_id,
        status = 'active',
        updated_at = NOW();

  RAISE NOTICE 'migration_v21_twilio_phone: +15076046329 registered in pool %', v_pool_id;
END $$;
