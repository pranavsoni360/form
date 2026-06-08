-- ============================================================================
-- Add Vobiz phone number +918071583503 to the phone_numbers table.
-- Run this once against los_form DB after create_vobiz_trunk.py succeeded.
-- Idempotent: re-running won't create duplicates (ON CONFLICT clause).
-- ============================================================================

-- 1. Insert (or update if the phone_number already exists).
INSERT INTO phone_numbers (
    pool_id,
    phone_number,
    livekit_trunk_id,
    status,
    active_calls,
    total_calls,
    created_at,
    updated_at
)
VALUES (
    (SELECT id FROM phone_pools WHERE name = 'pusad-default' LIMIT 1),
    '+918071583503',
    'ST_pTYcg7Az9q8R',
    'active',
    0,
    0,
    NOW(),
    NOW()
)
ON CONFLICT (phone_number) DO UPDATE
    SET livekit_trunk_id = EXCLUDED.livekit_trunk_id,
        status           = 'active',
        pool_id          = EXCLUDED.pool_id,
        updated_at       = NOW();

-- 2. Verify — should show the Vobiz row alongside the existing Viva number.
SELECT pn.phone_number,
       pn.livekit_trunk_id,
       pn.status,
       pn.active_calls,
       pn.total_calls,
       pp.name AS pool_name
  FROM phone_numbers pn
  JOIN phone_pools pp ON pp.id = pn.pool_id
 ORDER BY pn.phone_number;
