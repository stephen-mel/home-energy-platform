# Kraken customer API-key authentication

HEP supports the documented Kraken account-user API-key exchange. Configure the
customer-provided key only in the local, Git-ignored `.env.local` file:

```text
EON_KRAKEN_API_KEY=<customer-provided-key>
```

HEP sends the key only as the standalone `APIKey` input to the public
`obtainKrakenToken` GraphQL mutation. The returned Kraken JWT is then reused by
the existing read session for account, tariff, vehicle, dispatch and historical
rate queries. The API key itself is never sent in an `Authorization` header.

When `EON_KRAKEN_API_KEY` is present, malformed or rejected keys fail closed. HEP
does not retry with `EON_EMAIL` and `EON_PASSWORD`. When the key is absent, the
existing email/password exchange remains temporarily available for migration.
The exchange result must have the three-segment compact JWT syntax before it is
used; this is a structural check, not local cryptographic verification. Kraken
remains responsible for authenticating and authorising the token. Upstream
transport, HTTP, GraphQL and response-format failures expose only fixed error
codes, never provider response content.

The key and returned JWT are process-only authentication material. They are not
written to Kraken state, schedule observations, SQLite, the compatibility cache,
diagnostics or logs. Account selection remains controlled independently by
`EON_ACCOUNT` and optional `EON_EXPORT_ACCOUNT`; existing opaque account and
meter-point binding is unchanged.

After adding or rotating the key, restart the HEP server so the next refresh uses
the new configuration. Remove the legacy email/password variables after a
controlled read-only verification if legacy fallback is no longer required.
