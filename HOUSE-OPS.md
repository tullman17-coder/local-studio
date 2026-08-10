# Local Studio on Spark — house Phase A (2026-08-08)

## Role

Local Studio **controller** is ops glass + OpenAI proxy for Tom's cockpit.

| Door | Port | Who uses it |
|------|------|-------------|
| **zermai** (product law) | `:11500` | DocketCRM, Hermes, any product client |
| **Local Studio controller** | `:18088` | Local Studio macOS app / ops only |

**Do not** point DocketCRM at Local Studio.  
**Do not** let Local Studio launch stock vLLM recipes on this GB10.

## Live install

| Item | Value |
|------|--------|
| Code | `~/srv/local-studio` @ tag `v2.9.10` |
| Unit | `systemctl --user status local-studio-controller` |
| Env | `~/srv/local-studio/controller.env` (mode 600) |
| Data | `~/srv/local-studio/data` |
| Models dir | `/home/djangodgx/models` (weights only; LS does not own lifecycle in Phase A) |
| Listen | `100.115.190.105:18088` |
| Auth | API key in `~/.hermes/secrets/local-studio-api-key` |
| GPU probe | `nvidia-smi` OK |

Port **8080 is SearXNG** (docker-proxy). Local Studio must stay on **18088**.

## Independent image worker (Boop)

Boop is an independent ComfyUI worker in the Local Studio serving group. It is
**not** pooled GPU memory for BigBang and does not change the `zermai :11500`
product route.

| Item | Value |
|------|-------|
| Worker | Boop `100.83.93.21:8188` (RTX 3070 8 GB) |
| Local Studio route | `POST /v1/images/generations` on controller `:18088` |
| Default model | `flux-2-klein-4b-nvfp4.safetensors` |
| Flux encoder / VAE | `qwen_3_4b_fp4_flux2.safetensors` / `flux2-vae.safetensors` |
| Alternate checkpoint | `ponyDiffusionV6XL_v6StartWithThisOne.safetensors` |
| Agent proxy | Spark `:8189`, bearer key from `~/srv/comfyui/api.env` |
| Wrapper | `~/srv/comfyui/imggen.py`; downloads Boop outputs back to `~/srv/comfyui/output` |

The controller talks directly to Boop over Tailscale. Agent scripts use the
authenticated Spark proxy. Flux.2 distilled defaults are 4 steps and CFG 1;
SDXL defaults remain 28 steps and CFG 7.

Health and smoke:

```bash
curl -sS http://100.83.93.21:8188/system_stats
curl -sS http://100.115.190.105:8189/healthz
~/srv/comfyui/venv/bin/python ~/srv/comfyui/imggen.py \
  "a brass robot" --style photo --w 512 --h 512 --prefix smoke
```

## Provider (registered)

```json
{
  "id": "zermai",
  "name": "House Zermai",
  "base_url": "http://127.0.0.1:11500",
  "enabled": true
}
```

Models appear as:

- `zermai/auto` · `zermai/nano` → Nano text
- `zermai/qwen3-vl:30b` → Ollama VL
- `zermai/vision-premium` · `zermai/sonnet` → Nous Claude Sonnet-5

`GET /v1/models` on the controller may be **empty** — that list is LS-managed
runtimes only. Product catalog is `GET /studio/provider-models`.

## Connect from macOS Local Studio app

1. Settings → Connection → add controller  
   `http://100.115.190.105:18088`
2. Paste API key from thebrain  
   `~/.hermes/secrets/local-studio-api-key`  
   (mirrored from Spark; rotate both if leaked)
3. Active target = Spark controller
4. Chat / Workbench models: pick **zermai/…** routes only

Probes:

```bash
KEY=$(cat ~/.hermes/secrets/local-studio-api-key)
curl -sS -H "Authorization: Bearer $KEY" http://100.115.190.105:18088/health
curl -sS -H "Authorization: Bearer $KEY" http://100.115.190.105:18088/status
curl -sS -H "Authorization: Bearer $KEY" http://100.115.190.105:18088/gpus
curl -sS -H "Authorization: Bearer $KEY" http://100.115.190.105:18088/studio/providers
curl -sS -H "Authorization: Bearer $KEY" http://100.115.190.105:18088/studio/provider-models
```

## Verified smokes (2026-08-08)

| Route | Result |
|-------|--------|
| `zermai/nano` | `NANO_OK`, served Nano |
| `zermai/qwen3-vl:30b` | JSON vision reply |
| `zermai/vision-premium` | served `anthropic/claude-sonnet-5` |
| `zermai/sonnet` | same |

Controller `status.running=false` is **expected** in Phase A — Nano/Ollama are
house units, not LS-launched processes. Product health remains  
`curl -s http://100.115.190.105:11500/health`.

## Hard rules (GB10 / house)

1. **Never** use Local Studio stock vLLM/SGLang recipes as-is.
2. **Never** pass `--disable-cuda-graphs` as a “fix” — house Nano uses  
   `--enforce-eager` on purpose (GB10 cicc OOM without it).
3. **Never** chat-launch a second heavy brain beside Nano + VL without UMA math.
4. Product clients stay on **zermai :11500** (DocketCRM env unchanged).
5. No Pi/Hermes agent shell on Spark — controller only.
6. Prefer `max_completion_tokens` in LS UI; thinking models may still need room.

### Safe Nano recipe (reference — house unit, not LS stock)

See `~/srv/vllm/serve-nemotron-nano.sh` and `vllm-nemotron-nano.service`:

- `--gpu-memory-utilization 0.45`
- `--max-model-len 65536`
- `--enforce-eager`
- `--enable-sleep-mode` + `VLLM_SERVER_DEV_MODE=1`
- tool/reasoning parsers for Nemotron-H

Phase B (optional later): wrap **that** script as an LS recipe. Do not import
upstream LS default CUDA flags.

## Ops commands

```bash
systemctl --user status local-studio-controller
systemctl --user restart local-studio-controller
journalctl --user -u local-studio-controller -n 80 --no-pager
```

## Phase map

| Phase | Status |
|-------|--------|
| A — controller + zermai provider + smokes | **done 2026-08-08** |
| B — house launch recipes in LS (no stock flags) | not started |
| C — L1 keys / Pi on thebrain only | not started |
