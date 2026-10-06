# 12 · Single sign-on (OIDC)

KMate speaks standard OpenID Connect. You give it an issuer URL and a client,
and it reads the provider's own discovery document for everything else, so the
same configuration shape works with **Keycloak, Okta, Authentik, Entra ID,
Google, Dex** or anything else that is standards-compliant. There is no
provider-specific code.

The payoff is more than convenience. The groups your identity provider already
manages are written to the user's Kubernetes identity, so the agent impersonates
them and your existing `RoleBinding`s decide what each person may do in the
cluster. One directory, enforced by Kubernetes.

```
browser ──▶ /auth/oidc/login ──▶ provider ──▶ /auth/oidc/callback
                                                     │
                      verify id_token, read claims   │
                                                     ▼
                           user.k8s_user  ← username claim
                           user.k8s_groups ← groups claim
                                                     │
                                                     ▼
                     agent impersonates ──▶ Kubernetes RBAC decides
```

## Configuration

Only the first two are required. OIDC stays off until both are set.

| Variable | Default | Notes |
|---|---|---|
| `KMATE_OIDC_ISSUER` | – | e.g. `https://keycloak.example.com/realms/kmate` |
| `KMATE_OIDC_CLIENT_ID` | – | |
| `KMATE_OIDC_CLIENT_SECRET` | – | omit for a public client |
| `KMATE_OIDC_SCOPES` | `openid profile email` | add `groups` for Okta and Authentik, see below |
| `KMATE_OIDC_REDIRECT_URL` | `<KMATE_PUBLIC_URL>/auth/oidc/callback` | must match the provider exactly |
| `KMATE_OIDC_BUTTON_LABEL` | derived from the issuer host | e.g. "Sign in with Keycloak" |
| `KMATE_OIDC_USERNAME_CLAIM` | `email` | becomes the impersonated Kubernetes username |
| `KMATE_OIDC_EMAIL_CLAIM` | `email` | |
| `KMATE_OIDC_NAME_CLAIM` | `name` | |
| `KMATE_OIDC_GROUPS_CLAIM` | `groups` | becomes the impersonated Kubernetes groups |
| `KMATE_OIDC_AUTO_PROVISION` | `true` | create an account on first login |
| `KMATE_OIDC_DEFAULT_ROLE` | `viewer` | role when no group mapping matches |
| `KMATE_OIDC_ADMIN_GROUPS` | – | comma list of provider groups granted `admin` |
| `KMATE_OIDC_OPERATOR_GROUPS` | – | comma list granted `operator` |
| `KMATE_OIDC_VIEWER_GROUPS` | – | comma list granted `viewer` |
| `KMATE_LOCAL_LOGIN` | `true` | set `false` to require SSO once it works |
| `KMATE_OIDC_INSECURE_SKIP_VERIFY` | `false` | development only |

Via Helm, the same settings live under `oidc.*` in `deploy/helm/kmate-hub`.

### Roles and groups

When no `*_GROUPS` mapping is configured, every user gets `KMATE_OIDC_DEFAULT_ROLE`
and you assign cluster access with grants afterwards. That is the simplest setup
and usually the right one.

When mappings are configured they are evaluated highest first: admin, then
operator, then viewer. The role is re-evaluated on every login, so moving someone
between groups in your directory moves them in KMate too.

The groups claim always flows into `k8s_groups` regardless of mappings, because
that is what Kubernetes RBAC binds against.

### Accounts

A user provisioned by the provider is flagged, has no local password, and is
refused by the password form with a message pointing at the SSO button. Local
accounts created by an administrator are unaffected, and both kinds can coexist.

Keep at least one local administrator until SSO is proven. Setting
`KMATE_LOCAL_LOGIN=false` with no working issuer is ignored, so a
misconfiguration cannot lock everyone out.

## Keycloak

1. Create or pick a realm.
2. **Clients → Create client**: client ID `kmate`, client authentication **on**
   (confidential), standard flow enabled.
3. **Valid redirect URIs**: `https://kmate.example.com/auth/oidc/callback`.
4. Copy the secret from the **Credentials** tab.
5. Groups: Keycloak does **not** send them by default and has no `groups` scope.
   Add a mapper instead. **Client scopes → kmate-dedicated → Add mapper → By
   configuration → Group Membership**, name `groups`, token claim name `groups`,
   **Full group path off**, and tick the ID token and userinfo boxes.

```bash
KMATE_OIDC_ISSUER=https://keycloak.example.com/realms/kmate
KMATE_OIDC_CLIENT_ID=kmate
KMATE_OIDC_CLIENT_SECRET=...
# leave KMATE_OIDC_SCOPES unset: asking for a "groups" scope makes Keycloak
# fail with invalid_scope, because the mapper above already supplies the claim
```

## Okta

1. **Applications → Create App Integration → OIDC → Web Application**.
2. Sign-in redirect URI: `https://kmate.example.com/auth/oidc/callback`.
3. Issuer is your authorization server, e.g.
   `https://example.okta.com/oauth2/default`.
4. Groups: add a **Groups claim** to the ID token (**Security → API → your
   authorization server → Claims → Add claim**, name `groups`, include in ID
   token, matches regex `.*`). Okta does expose a `groups` scope, so request it:

```bash
KMATE_OIDC_ISSUER=https://example.okta.com/oauth2/default
KMATE_OIDC_SCOPES="openid profile email groups"
```

## Authentik

1. **Applications → Providers → Create → OAuth2/OpenID Provider**, client type
   confidential, redirect URI `https://kmate.example.com/auth/oidc/callback`.
2. Create an Application bound to that provider.
3. Issuer is the provider's OpenID configuration base, typically
   `https://authentik.example.com/application/o/<app-slug>/`.
4. Authentik ships a `groups` scope mapping, so request it:

```bash
KMATE_OIDC_ISSUER=https://authentik.example.com/application/o/kmate/
KMATE_OIDC_SCOPES="openid profile email groups"
```

## Troubleshooting

**The provider rejects the redirect, or you are sent back to `http://`.** A
gateway that terminates TLS forwards plain HTTP to the hub, so a redirect built
from the request alone comes out `http://` and no longer matches the registered
callback. KMate honours `X-Forwarded-Proto` and `X-Forwarded-Host`, but your
ingress has to send them. With Istio they are set automatically; with nginx
ensure `proxy_set_header X-Forwarded-Proto $scheme;`. Setting
`KMATE_OIDC_REDIRECT_URL` explicitly also fixes it.

**`invalid_scope`.** You asked for a scope the provider does not define, almost
always `groups` on Keycloak. Remove it and use a protocol mapper.

**Login succeeds but the user has no groups.** Check the claim actually reaches
the ID token. KMate falls back to the userinfo endpoint when the ID token has no
groups, but the claim must exist in one of them. Confirm `KMATE_OIDC_GROUPS_CLAIM`
matches the name your provider emits.

**"the … claim was empty".** Your provider does not send the claim named by
`KMATE_OIDC_USERNAME_CLAIM`. Keycloak and Authentik commonly use
`preferred_username`; set it accordingly.

**Provider is down.** Discovery is lazy and retried, never performed at startup,
so the hub still boots and local login still works. That is the way back in.
