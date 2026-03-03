# OpenClaw 环信桥接插件

中文文档。英文主文档见 `README.md`。

## 为什么做这个

这个插件就是为了解决你说的场景：  
**飞书、钉钉 API 调用受限时，改用环信 + 本地回调开发。**

做法很直接：

- OpenClaw 不直接依赖飞书/钉钉 API
- 用环信做消息通道
- 本地服务通过内网穿透暴露回调地址（推荐 natapp）

natapp 官网： https://natapp.cn/

---

## 一句话流程

1. 用户在环信发消息  
2. 环信回调 -> 你的本地插件（通过 natapp 的 HTTPS 地址）  
3. 插件转发到 OpenClaw `/hooks/agent`  
4. OpenClaw 回复 -> 插件调用环信 REST 发回用户/群

---

## 5 分钟上手

### 1）改配置 `~/.openclaw/openclaw.json`

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
      "paths": ["/绝对路径/openclaw-easemob"]
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
          "callback_secret": "<与环信回调规则一致>",
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

### 2）安装并重启

```bash
cd /path/to/openclaw-easemob
npm install
npm run build
openclaw plugins install -l .
openclaw gateway restart
```

### 3）用 natapp 暴露本地回调端口

把本地 `18891` 暴露成公网 HTTPS 地址（按你的 natapp 隧道配置启动客户端）。

环信回调地址填：

- `https://<你的公网域名>/easemob/callback`
- 或 `https://<你的公网域名>/`

重点：

- 回调必须走插件端口映射（这里是 `18891`）
- 不能填 OpenClaw 网关端口 `18789`

### 4）环信后台回调规则

在环信控制台：

- URL：填 natapp 提供的 HTTPS 地址
- Secret：与 `callback_secret` 完全一致
- 消息类型：至少文本
- 会话类型：单聊/群聊按需开启

---

## 主动发送（OpenClaw -> 环信）

```bash
curl -X POST "http://127.0.0.1:18789/hooks/agent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 123" \
  -H "x-openclaw-token: 123" \
  -d '{
    "message": "主动发送测试",
    "channel": "easemob",
    "to": "真实环信用户名",
    "deliver": true,
    "wakeMode": "now"
  }'
```

群聊格式：

```json
"to": "group:<groupId>"
```

---

## 常见问题（最实用）

- `401 Unauthorized`：`hooks.token` / `hooks_token` 不一致，或改完配置没重启。
- `403 Invalid security`：回调密钥不一致，排障可临时 `callback_verify=false`。
- 每条消息都是新上下文：确认 `hooks.allowRequestSessionKey=true`。
- 机器人自回环：保持 `ignore_self_messages=true`。
- Unknown target：使用真实环信用户名；群聊用 `group:<groupId>`。
