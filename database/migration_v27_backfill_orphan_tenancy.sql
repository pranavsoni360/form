-- ============================================================================
--  migration_v27_backfill_orphan_tenancy.sql
--
--  Give every orphaned operational row a tenant, so v28 can enforce
--  bank_id NOT NULL. ~25% of pre-multi-bank rows were created before bank_id
--  existed (loan_applications, agent_calls, agent_batches) or never had it
--  (phone_pools, phone_numbers).
--
--  Policy (from the design review): DO NOT silently attribute orphans to the
--  only real bank — that fabricates attribution on loan records. Park them on
--  the explicit LEGACY / UNASSIGNED tenant (created by v26 seeds) so the trail
--  stays honest and the rows remain queryable.
--
--  Idempotent: every statement only touches rows that are still NULL.
-- ============================================================================

DO $$
DECLARE
    legacy_bank UUID;
    n_apps   INT; n_calls INT; n_batches INT; n_pools INT; n_nums INT;
BEGIN
    SELECT id INTO legacy_bank FROM banks WHERE code = 'LEGACY';
    IF legacy_bank IS NULL THEN
        RAISE EXCEPTION 'LEGACY bank not found — apply v26 (which seeds it) first';
    END IF;

    UPDATE loan_applications SET bank_id = legacy_bank WHERE bank_id IS NULL;
    GET DIAGNOSTICS n_apps = ROW_COUNT;

    UPDATE agent_calls SET bank_id = legacy_bank WHERE bank_id IS NULL;
    GET DIAGNOSTICS n_calls = ROW_COUNT;

    UPDATE agent_batches SET bank_id = legacy_bank WHERE bank_id IS NULL;
    GET DIAGNOSTICS n_batches = ROW_COUNT;

    -- phone_pools: an untenanted pool goes to LEGACY.
    UPDATE phone_pools SET bank_id = legacy_bank WHERE bank_id IS NULL;
    GET DIAGNOSTICS n_pools = ROW_COUNT;

    -- phone_numbers: inherit the pool's bank where possible, else LEGACY.
    -- (phone_pools is backfilled just above, so the join now resolves.)
    UPDATE phone_numbers pn
       SET bank_id = COALESCE(pp.bank_id, legacy_bank)
      FROM phone_pools pp
     WHERE pn.pool_id = pp.id AND pn.bank_id IS NULL;
    UPDATE phone_numbers SET bank_id = legacy_bank WHERE bank_id IS NULL;  -- pool-less rows
    GET DIAGNOSTICS n_nums = ROW_COUNT;

    RAISE NOTICE 'v27 backfill -> LEGACY: apps=%, calls=%, batches=%, pools=%, phone_numbers=%',
        n_apps, n_calls, n_batches, n_pools, n_nums;
END $$;
