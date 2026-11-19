# Diagnosing a self-hosted Clockwork installation

No monitoring server is required. Start with the symptom, time and versions;
never send passwords, cookies, `.env`, full profiles or database dumps as a
technical error report.

1. **User interface or saving problem.** Open **Diagnostics** in the header or
   on the sign-in page. Web: review/copy the local tab report. Electron: review
   the local report, then save it through **Save bundle**. Share it with your
   installation administrator explicitly; the application does not upload it.
   A browser reload clears web history. Electron keeps rotated private local
   logs. An unavailable backend version is shown as `unknown`, not guessed.
2. **Find the server request.** Use the safe `X-Request-ID`, time and backend
   version from that report to select the backend's JSON logs. In the managed
   layout the API service is `erp`:

   ```sh
   docker compose -p erp -f /opt/erp/docker-compose.yml logs \
     --since 15m --tail 1000 --no-color --no-log-prefix erp
   ```

   Root development Compose calls the service `backend`; native Air writes to
   its terminal. See [server logs](server-logs.md) for filtering and startup codes.
3. **Is the server usable?** `GET /api/v1/health` is liveness. `GET /api/v1/ready`
   is bounded database/migration readiness (200 or 503). A living process does
   not prove that PostgreSQL is ready. If ready is 503, inspect DB reachability,
   migration status and storage capacity locally; do not blindly replay SQL or
   delete volumes. See [readiness](readiness.md).
4. **Offline or pending changes.** In Electron compare pending/ready/blocked,
   unknown/conflict/rejected, retry counts and last pull. Offline/sleep wall age
   is normal; it is not failed active delivery. Unknown means a receipt check
   is needed, not safe re-creation of the operation. Diagnose login/permissions
   for 401/403 and review a 409 conflict; these alone do not mean a server outage.
   Never delete SQLite to clear a queue. See [Electron diagnostics](desktop-diagnostics.md).
5. **Disk/journal/audit trouble.** Check the selected filesystem's free space
   and inodes and Docker's rotated logs. Diagnostic logs may drop entries and
   fall back to memory; they do not block business writes. Business SQLite and
   the existing audit journal have separate recovery/access rules. Audit sender
   counters do not turn its in-memory buffers into durable delivery. See
   [operation diagnostics](operation-diagnostics.md) and [troubleshooting](troubleshooting.md).

## Optional integrations

For an existing private scraper, set `metrics.enabled: true` and a private literal
`metrics.address` in the selected backend config; restart through your normal
maintenance procedure. To disable, set it back to `false` and restart. Logs,
readiness, queue state and local reports remain usable. Never expose the endpoint
through the public gateway. See [metrics](metrics.md).

For an existing OTLP/gRPC receiver, explicitly configure `tracing.enabled`, its
endpoint/TLS/authentication and sampling ratio. Set `enabled: false` and restart
to stop export. A failed receiver is best effort and bounded; it does not become
an application dependency. Credentials belong in the installation's private
secret mechanism. See [tracing](tracing.md).

The standalone [Prometheus/Grafana example](optional-monitoring.md) requires an
explicit `monitoring` profile, private secret and deliberate storage allocation.
Ordinary application Compose/deployment does not start it. Its stop command is
shown in that guide; preserve monitoring volumes if their history is required.
The supplied [dashboards](troubleshooting.md) are optional; no data is not green.

## Demonstration instance only

The host check, external HTTPS/TLS/readiness probe and alert state evaluator are
prepared but disabled and unscheduled. Decide thresholds, interval, recipient,
notification adapter and test window before enabling anything. The evaluator
never sends a notification by itself. Follow [demo operations](demo-operations.md),
[probe/readiness](readiness.md) and [demo alerts](demo-alerts.md). Do not substitute
other installations' offline clients for demonstration-server incidents.
