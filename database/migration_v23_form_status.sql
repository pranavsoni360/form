-- migration_v23_form_status.sql
-- Truthful WhatsApp form-link status for the Batch Calling "Form" column.
--
-- Problem: the UI showed "Sent" for any call where the boolean agent_calls.form_sent
-- was true, but form_sent was set from "AiSensy returned HTTP 200" / the voice
-- agent's optimistic self-report — NOT from an actual accepted send. A 200 (or an
-- error body returned with 200) or a 400 "template mismatch" could still show "Sent".
--
-- Fix: introduce a real status column written ONLY by the actual sender
-- (backend/agent/whatsapp.py), based on the AiSensy response body
-- (success flag + submitted_message_id):
--   not_sent  – no send attempted yet (default)
--   sent      – AiSensy accepted the message (queued for delivery)
--   failed    – AiSensy rejected / errored / network failure
-- (sending/delivered/retry are reserved for the async delivery-webhook phase.)
--
-- Idempotent: safe to re-run on every deploy (qa + prod).

ALTER TABLE agent_calls
    ADD COLUMN IF NOT EXISTS form_status VARCHAR(20) NOT NULL DEFAULT 'not_sent';

CREATE INDEX IF NOT EXISTS idx_agent_calls_form_status ON agent_calls(form_status);

-- Backfill existing rows: anything currently flagged sent maps to 'sent',
-- everything else stays 'not_sent'. (We cannot retroactively know which old
-- "sent" rows actually failed delivery; new rows will be accurate going forward.)
UPDATE agent_calls
   SET form_status = 'sent'
 WHERE form_sent = TRUE
   AND form_status = 'not_sent';
