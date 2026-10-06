-- Mark accounts that came from an identity provider. The UI hides password
-- management for them, and the password login path refuses them outright so a
-- provisioned account cannot be taken over by setting a local password.
ALTER TABLE users ADD COLUMN oidc INTEGER NOT NULL DEFAULT 0;
