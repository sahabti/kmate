-- The hub's internal certificate authority. One row, generated on first start
-- and reloaded afterwards so certificates already issued to agents keep
-- validating across restarts. The key never leaves the hub.
CREATE TABLE IF NOT EXISTS hub_ca (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  cert_pem   TEXT NOT NULL,
  key_pem    TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL
);

-- Certificate currently issued to each cluster's agent, so the hub can report
-- expiry and refuse a certificate that was replaced by a later enrolment.
ALTER TABLE clusters ADD COLUMN agent_cert_serial TEXT NOT NULL DEFAULT '';
ALTER TABLE clusters ADD COLUMN agent_cert_expiry TIMESTAMP NULL;
