# ADR-0005: Rotate opaque refresh tokens

## Status
Accepted

## Decision
Use short-lived HS256 access JWTs during compatibility migration and opaque, hashed, one-time refresh tokens grouped
into token families. Hash new passwords with Argon2id and rehash legacy Passlib PBKDF2 passwords after login.

## Consequences
Refresh tokens can be revoked and replay can be detected. A later asymmetric JWT migration can be completed without
changing the refresh-token storage model.
