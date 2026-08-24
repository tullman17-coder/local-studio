# Local Studio on Spark — house overlay on official v2.15.2

## Role

Local Studio **controller** is ops glass + OpenAI proxy. Product door stays zermai.

| Door | Port | Who uses it |
|------|------|-------------|
| **zermai** | `:11500` | DocketCRM, Hermes, product clients |
| **Local Studio controller** | `:18088` | Local Studio macOS app / ops |

Do not point DocketCRM at Local Studio.

## Live install

| Item | Value |
|------|--------|
| Code (this branch) | `house/boop-comfy-inline-v2.15.2` on official `v2.15.2` |
| Spark checkout | still older until promoted |
| Unit | `systemctl --user status local-studio-controller` |
| Env | `~/srv/local-studio/controller.env` (mode 600) |
| Data | `~/srv/local-studio/data` |
| Models | `/home/djangodgx/models` |
| Listen | NetBird `10.250.158.81:18088` |
| Auth | API key in `~/.hermes/secrets/local-studio-api-key` |

Port **8080 is SearXNG**. Local Studio stays on **18088**. Never Tailscale `100.115.190.105` for LS.

## Independent image worker (Boop)

| Item | Value |
|------|-------|
| Worker | Boop NetBird `10.250.253.60:8188` (RTX 3070 8 GB) |
| Local Studio route | `POST /v1/images/generations` on `:18088` |
| Default model | `flux-2-klein-4b-nvfp4.safetensors` |
| Flux encoder / VAE | `qwen_3_4b_fp4_flux2.safetensors` / `flux2-vae.safetensors` |
| Agent proxy | Spark `:8189` |

Controller talks to Boop over NetBird. Flux.2 distilled defaults: 4 steps, CFG 1.

```bash
curl -sS http://10.250.253.60:8188/system_stats
curl -sS http://10.250.158.81:8189/healthz
```

## Connect from macOS Local Studio

Settings → Connection → `http://10.250.158.81:18088` plus the API key.
Never `100.115.190.105:18088`.

## Hard rules

1. Never use stock LS vLLM/SGLang recipes as-is on GB10.
2. Product clients stay on **zermai :11500**.
3. No Hermes on Spark — controller only.
4. One resident engine. Evict before launching another.
