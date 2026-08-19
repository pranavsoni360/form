-- ============================================================================
--  v41 — Bank-defined custom roles ("profiles")
--
--  WHY THIS EXISTS
--  ---------------
--  A bank admin can already pick "Recovery caller" or "Auditor, read only" when
--  inviting a user, but those two strings are HARD-CODED in the frontend
--  (app/bank/admin/users/page.tsx ROLE_OPTIONS). They are not roles: choosing one
--  stores role='custom' plus a free-text custom_role_label, and carries no
--  permission set of its own. An admin cannot add a third profile, cannot say
--  what it may do, and cannot reuse it across users without re-ticking the whole
--  permission grid by hand each time.
--
--  This makes a custom role a real, named, per-bank object with its own default
--  permission set — a "profile" an admin defines once and assigns repeatedly.
--
--  WHY NOT LOOSEN bank_users.role
--  ------------------------------
--  Tempting, but wrong. `role` is a CHECK-constrained enum (v28 reconciled two
--  conflicting v26 definitions into one list) and it is still read by role-string
--  comparisons throughout the routers. Turning it into free text would silently
--  break every one of those comparisons, and v28's comment history shows how
--  easily competing definitions of this column go wrong.
--
--  The constraint ALREADY allows 'custom'. So a custom role is stored the way the
--  console already stores one — role='custom' — and gains a foreign key to its
--  definition. Existing role-string checks keep working untouched: to them a
--  custom-role user is simply 'custom', exactly as today.
--
--  PERMISSION RESOLUTION
--  ---------------------
--  services/permissions.py resolves:
--      effective = role_default UNION grants EXCEPT revokes
--  For a custom-role user, "role_default" now comes from this table's permission
--  set instead of bank_role_default_permissions (which has no 'custom' row, on
--  purpose — see v40). Per-user grant/revoke deltas layer on top exactly as
--  before, so an admin can still make a one-person exception to a profile.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bank_custom_roles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id         UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    -- Display name the admin types, e.g. "Recovery caller".
    name            VARCHAR(60)  NOT NULL,
    -- One-line explanation shown under the name in the role picker, mirroring
    -- how the built-in roles describe themselves ("Own queue, approve and
    -- reject"). Optional: a profile is usable before it is documented.
    description     VARCHAR(200),
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by      UUID,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by      UUID
);

-- Names are unique PER BANK and case-insensitively, so two admins cannot create
-- "Recovery caller" and "recovery caller" and leave everyone guessing which is
-- which. Scoped to active rows so a deleted name can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_custom_roles_name
    ON bank_custom_roles (bank_id, LOWER(name))
    WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_bank_custom_roles_bank
    ON bank_custom_roles (bank_id) WHERE is_active = TRUE;

COMMENT ON TABLE bank_custom_roles IS
    'Bank-defined role profiles. Users on one carry bank_users.role = ''custom'' plus custom_role_id, so existing role-string checks keep working.';


-- ── The profile's default permission set ────────────────────────────────────
-- Same shape as bank_role_default_permissions, keyed by custom role id instead
-- of a role string. Deliberately a separate table rather than a JSONB column so
-- the FK to permissions(permission_code) still guarantees every stored code is
-- real — a typo'd code in JSON would silently grant nothing.
CREATE TABLE IF NOT EXISTS bank_custom_role_permissions (
    custom_role_id  UUID NOT NULL REFERENCES bank_custom_roles(id) ON DELETE CASCADE,
    permission_code VARCHAR(100) NOT NULL REFERENCES permissions(permission_code) ON DELETE CASCADE,
    PRIMARY KEY (custom_role_id, permission_code)
);

COMMENT ON TABLE bank_custom_role_permissions IS
    'Default permission set for a bank_custom_roles profile. Per-user deltas in bank_user_permissions still layer on top.';


-- ── Link users and invites to their profile ─────────────────────────────────
-- Nullable: only role='custom' users have one. ON DELETE SET NULL rather than
-- CASCADE — deleting a profile must never delete the PEOPLE holding it. Such a
-- user falls back to no role default (custom has none), which is the safe
-- direction: they lose inherited rights rather than silently keeping rights
-- whose definition no longer exists.
ALTER TABLE bank_users
    ADD COLUMN IF NOT EXISTS custom_role_id UUID
    REFERENCES bank_custom_roles(id) ON DELETE SET NULL;

ALTER TABLE bank_invites
    ADD COLUMN IF NOT EXISTS custom_role_id UUID
    REFERENCES bank_custom_roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bank_users_custom_role
    ON bank_users (custom_role_id) WHERE custom_role_id IS NOT NULL;

COMMENT ON COLUMN bank_users.custom_role_id IS
    'When role=''custom'', the bank_custom_roles profile this user holds. Its permission set acts as their role default.';


-- ── Seed the two profiles that were hard-coded in the frontend ──────────────
-- ROLE_OPTIONS in app/bank/admin/users/page.tsx shipped "Recovery caller" and
-- "Auditor, read only" as literals. Seeding them for every existing bank means
-- the picker keeps offering what admins already see, with real permission sets
-- behind them for the first time. Idempotent: skipped where the name exists.
DO $$
DECLARE
    b RECORD;
    rid UUID;
BEGIN
    FOR b IN SELECT id FROM banks LOOP

        -- Recovery caller: works the dialler and sees outcomes, no lending
        -- authority. Matches the description the frontend already showed.
        IF NOT EXISTS (
            SELECT 1 FROM bank_custom_roles
             WHERE bank_id = b.id AND LOWER(name) = 'recovery caller' AND is_active
        ) THEN
            INSERT INTO bank_custom_roles (bank_id, name, description)
            VALUES (b.id, 'Recovery caller',
                    'Runs calling campaigns and sees outcomes. No lending decisions.')
            RETURNING id INTO rid;

            INSERT INTO bank_custom_role_permissions (custom_role_id, permission_code)
            SELECT rid, c FROM (VALUES
                ('application.view_assigned'),
                ('calls.view'),
                ('calls.listen_recording'),
                ('batch.upload'),
                ('batch.start')
            ) AS t(c)
            WHERE EXISTS (SELECT 1 FROM permissions p WHERE p.permission_code = t.c);
        END IF;

        -- Auditor, read only: the description the frontend showed was "Reads call
        -- records and logs, changes nothing", so this set is strictly read codes.
        IF NOT EXISTS (
            SELECT 1 FROM bank_custom_roles
             WHERE bank_id = b.id AND LOWER(name) = 'auditor, read only' AND is_active
        ) THEN
            INSERT INTO bank_custom_roles (bank_id, name, description)
            VALUES (b.id, 'Auditor, read only',
                    'Reads call records, applications and logs. Changes nothing.')
            RETURNING id INTO rid;

            INSERT INTO bank_custom_role_permissions (custom_role_id, permission_code)
            SELECT rid, c FROM (VALUES
                ('application.view_all'),
                ('application.view_branch'),
                ('application.view_assigned'),
                ('calls.view'),
                ('calls.listen_recording'),
                ('scorecard.view'),
                ('usage.view'),
                ('activity.view')
            ) AS t(c)
            WHERE EXISTS (SELECT 1 FROM permissions p WHERE p.permission_code = t.c);
        END IF;

    END LOOP;
END $$;
