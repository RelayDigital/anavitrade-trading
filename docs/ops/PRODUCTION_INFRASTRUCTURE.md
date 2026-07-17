# Production Infrastructure Gates

This runbook covers operator actions only. It does not authorize a deployment or
production execution. Store all credentials in the deployment secret manager or a
root-readable environment file; never commit their values.

## Configuration Gate

Set unique, randomly generated `REDIS_PASSWORD` and `GRAFANA_ADMIN_PASSWORD`
values before rendering or starting Compose. Keep `GRAFANA_ADMIN_USER` at its
default or set it explicitly. Validate the rendered configuration without printing
it into CI logs that retain interpolated secrets:

```bash
REDIS_PASSWORD='<validation-only>' \
GRAFANA_ADMIN_PASSWORD='<validation-only>' \
docker compose config --quiet
node --test tests/infra-config.test.mjs
pnpm exec tsc --noEmit -p src/server/tsconfig.json
```

The default host bindings for execution health, Prometheus, and Grafana are
`127.0.0.1`. Redis and node-exporter have no host-published ports. A non-loopback
`*_BIND_ADDRESS` override is a release exception and requires an authenticated,
TLS-terminating reverse proxy plus a reviewed firewall change.

Prometheus scrapes `http://execution:9090/metrics` over the private Compose network.
Do not expose `/metrics` or `/health` directly to the Internet.

## Firewall Gate

Before starting the stack, capture evidence for both layers:

- **Provider firewall:** deny Internet ingress to TCP 3000, 6379, 9090, 9091,
  and 9100. Permit administrative access only through the approved VPN or SSH
  tunnel path.
- **Host firewall:** apply the same inbound denies with the host firewall and verify
  them from an external machine. Docker rules must not bypass the host policy.
- Confirm Redis has no published host port with `docker compose ps` and confirm the
  three published operational ports resolve to `127.0.0.1`.

Do not enable production execution while either firewall layer, monitoring
authentication, or external reachability evidence is incomplete.

## Credential Rotation Gate

### Redis credential rotation

1. Stop execution writers and readers; record the maintenance window.
2. Generate a new password in the secret manager and update every Redis consumer.
3. Recreate Redis and dependent services, then verify authenticated health checks.
4. Prove the previous credential is rejected before resuming traffic.

Redis does not support accepting old and new `requirepass` values simultaneously in
this configuration, so rotation is a coordinated restart.

### Grafana credential rotation

1. Rotate `GRAFANA_ADMIN_PASSWORD` in the secret manager and recreate Grafana.
2. Verify the new login through the loopback tunnel and prove the old login fails.
3. Revoke stale sessions and record the operator, timestamp, and evidence link.

Also rotate any Redis or Grafana credential that existed while its service was
publicly reachable. Never place a real credential in `docker-compose.yml`,
`wrangler.toml`, command history, screenshots, or deployment evidence.

## Worker Configuration Gate

`wrangler.toml` enables sampled Worker logs and uses the reviewed compatibility
date. Logs must not contain authorization headers, API credentials, or decrypted
exchange material. Reassess sampling cost and redaction before release.

Generate binding/runtime declarations after every Wrangler configuration change:

```bash
pnpm exec wrangler types
pnpm exec wrangler types --check
```

Wrangler 3.x may require `--experimental-include-runtime` for runtime declarations.
Commit generated declarations only in a separately owned change, then point the
relevant TypeScript config at them. Updating the compatibility date requires Worker
tests and a dry run; it is not approval to deploy.

## Release Approval

The change record must include successful config assertions, Compose rendering,
TypeScript checks, firewall evidence, old-credential rejection, monitoring access
through the approved path, and named operator/security approvers. Do not enable
production execution until all broader production-safety gates are complete.
