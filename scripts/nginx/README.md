# nginx configs (finix.vgipl.com)

Copies of the live nginx vhosts on the GPU box. They live here so a server
rebuild cannot silently lose them — in particular the `LOS-SEC-BLOCK` sections,
which are a security control, not cosmetic.

| File | Serves | Proxies `/api/` to |
|---|---|---|
| `finix.conf` | `finix.vgipl.com` :80 → :443 | prod backend `127.0.0.1:8200`, frontend `:3001` |
| `finix-qa.conf` | `finix.vgipl.com:8445` | QA backend `127.0.0.1:8300`, frontend `:3002` |

## Install / update

```bash
sudo cp finix.conf finix-qa.conf /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx
```

Always run `nginx -t` before reloading. Back up first:
`sudo cp /etc/nginx/conf.d/finix.conf{,.bak.$(date +%Y%m%d%H%M%S)}`

## The `LOS-SEC-BLOCK` sections — do not remove

Eight routes carry no application-level auth. They were reachable from the
public internet, which allowed anonymous mass WhatsApp sends through our WABA
(Meta-ban risk) and forged transcripts / guarantor consent. The blocks return
403 at the edge:

```
/api/agent/transcript          /api/send-campaign
/api/agent/send-whatsapp-form  /api/send-campaign-bulk
/api/agent/schedule-callback   /api/ops/errors/cleanup
/api/guarantor/transcript      /api/guarantor/consent
```

Exact-match (`location = …`) is deliberate — it takes priority over the
`location /api/` prefix below it.

**This edge block alone is not sufficient.** uvicorn binds `0.0.0.0`, so
`164.52.217.236:8200` / `:8300` are reachable directly and bypass nginx
entirely. The real guard is `restrict_internal_paths` in `backend/main.py`,
which allows these paths only when the peer is loopback *and* no
`X-Forwarded-For` is present. Keep both layers.

Legitimate callers are the voice agents, which use `BACKEND_URL=127.0.0.1` and
never traverse nginx — so these blocks do not affect them.
