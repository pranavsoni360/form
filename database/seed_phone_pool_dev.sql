-- Dev-only seed for /ops/phones smoke testing.
-- Creates a single "pusad-default" pool with 5 demo numbers in different states
-- (active, in cooldown, quarantined, with active calls). Safe to run multiple
-- times — uses ON CONFLICT to dedupe.

INSERT INTO phone_pools (id, bank_id, name, capacity, cooldown_seconds_min, cooldown_seconds_max)
VALUES (gen_random_uuid(), NULL, 'pusad-default', 5, 180, 300)
ON CONFLICT (bank_id, name) DO NOTHING;

WITH pool AS (SELECT id FROM phone_pools WHERE name = 'pusad-default')
INSERT INTO phone_numbers (pool_id, phone_number, livekit_trunk_id, active_calls, total_calls, status)
SELECT pool.id, p, 'ST_TEST_' || replace(p, '+', ''), 0, t, 'active'
FROM pool, (VALUES
  ('+919876543210', 142),
  ('+919876543211', 138),
  ('+919876543212', 95),
  ('+919876543213', 120),
  ('+919876543214', 89)
) AS v(p, t)
ON CONFLICT (pool_id, phone_number) DO NOTHING;

UPDATE phone_numbers SET status = 'quarantined'         WHERE phone_number = '+919876543214';
UPDATE phone_numbers SET cooldown_until = NOW() + INTERVAL '2 minutes'
                                                        WHERE phone_number = '+919876543212';
UPDATE phone_numbers SET active_calls = 2               WHERE phone_number = '+919876543210';

SELECT phone_number, active_calls, total_calls, cooldown_until, status
FROM phone_numbers
ORDER BY phone_number;
