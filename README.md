# OpenClaw Easemob Bridge

Primary language: English  
Chinese version: `README.zh-CN.md`

## Why this exists

This bridge is for teams who want to continue local bot development when Feishu/DingTalk API limits become a blocker.

Instead of calling Feishu/DingTalk directly:

- Use Easemob as the IM channel
- Receive callbacks on your local machine
- Expose local callback endpoint via NAT tunnel (recommended: natapp)

natapp: https://natapp.cn/

---

## How it works (simple)

1. User sends message in Easemob.
2. Easemob callback calls your local plugin endpoint (public HTTPS via tunnel).
3. Plugin forwards message to OpenClaw `/hooks/agent`.
4. OpenClaw reply is sent back through Easemob REST API.

---

## 5-minute setup

### 1) Configure `~/.openclaw/openclaw.json`

```json
{
  "hooks": {
    "enabled": true,
    "path": "/hooks",
    "token": "123",
    "allowRequestSessionKey": true
  },
  "plugins": {
    "load": {
      "paths": ["/absolute/path/to/openclaw-easemob"]
    }
  },
  "channels": {
    "easemob": {
      "accounts": {
        "default": {
          "enabled": true,
          "host": "https://a1.easemob.com",
          "org_name": "<org_name>",
          "app_name": "<app_name>",
          "client_id": "<client_id>",
          "client_secret": "<client_secret>",
          "callback_secret": "<same secret as Easemob callback rule>",
          "callback_verify": true,
          "callback_port": 18891,
          "from_user": "openclaw",
          "hooks_token": "123",
          "ignore_self_messages": true,
          "group_session_scope": "group-user",
          "context_bridge_enabled": true,
          "context_max_turns": 12
        }
      }
    }
  }
}
```

### 2) Install plugin and restart

```bash
cd /path/to/openclaw-easemob
npm install
npm run build
openclaw plugins install -l .
openclaw gateway restart
```

### 3) Expose callback port with natapp

Expose local port `18891` to public HTTPS using natapp client.

Then set Easemob callback URL to either:

- `https://<your-public-domain>/easemob/callback`
- `https://<your-public-domain>/`

Important:

- Callback must go to plugin callback port mapping (`18891`)
- Do not point callback to OpenClaw gateway port `18789`

### 4) Configure Easemob callback rule

In Easemob console:

- callback URL: your natapp HTTPS URL
- callback Secret: exactly same as `callback_secret`
- message type: text (required)
- chat type: direct/group as needed

---

## Proactive send from OpenClaw

```bash
curl -X POST "http://127.0.0.1:18789/hooks/agent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 123" \
  -H "x-openclaw-token: 123" \
  -d '{
    "message": "Proactive message test",
    "channel": "easemob",
    "to": "real-easemob-username",
    "deliver": true,
    "wakeMode": "now"
  }'
```

Group target format:

```json
"to": "group:<groupId>"
```

---

## Troubleshooting (common)

- `401 Unauthorized`: `hooks.token` / `hooks_token` mismatch, or gateway not restarted.
- `403 Invalid security`: callback secret mismatch (temporarily set `callback_verify=false` for debugging only).
- Context resets every message: ensure `hooks.allowRequestSessionKey=true`.
- Bot loops itself: keep `ignore_self_messages=true`.
- Unknown target: use real Easemob username, group uses `group:<groupId>`.
