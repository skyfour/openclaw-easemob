/**
 * 环信 IM (Easemob) Channel 插件
 * - 入站：环信「发送后回调」推送到本插件 HTTP 接口，插件再 POST 到 OpenClaw /hooks/agent
 * - 出站：Agent 回复时通过环信 REST API 发送文本消息
 * 文档：https://doc.easemob.com/
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let pluginApi: { logger?: { info?: (s: string) => void; error?: (s: unknown) => void }; config?: any } | null = null;

function getGatewayBaseUrl(cfg: any): string {
  return (
    process.env.OPENCLAW_GATEWAY_URL ||
    cfg?.gateway?.url ||
    "http://127.0.0.1:18789"
  );
}

/** 与 Gateway 相同的配置文件路径（OPENCLAW_CONFIG_PATH 或 ~/.openclaw/openclaw.json） */
function getOpenClawConfigPath(): string {
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  const home = process.env.OPENCLAW_HOME || process.env.HOME || os.homedir();
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

/** 从与 Gateway 相同的配置文件中读取 hooks.token，避免插件 api.config 与 Gateway 不一致导致 401 */
function readHooksTokenFromConfigFile(): string | null {
  try {
    const configPath = getOpenClawConfigPath();
    const raw = fs.readFileSync(configPath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const token =
      (data?.hooks as any)?.token ?? (data?.gateway as any)?.hooks?.token;
    if (token != null && String(token).trim()) return String(token).trim();
  } catch {
    // 文件不存在或解析失败时忽略
  }
  return null;
}

function getHooksConfig(cfg: any): { path: string; token: string } {
  const token =
    (typeof process.env.OPENCLAW_HOOKS_TOKEN === "string" && process.env.OPENCLAW_HOOKS_TOKEN.trim()) ||
    (cfg?.hooks?.token && String(cfg.hooks.token).trim()) ||
    (cfg?.gateway?.hooks?.token && String(cfg.gateway.hooks.token).trim()) ||
    "";
  const pathVal =
    cfg?.hooks?.path ?? cfg?.gateway?.hooks?.path ?? "/hooks";
  return { path: pathVal, token };
}

// 环信 Token 缓存（简单内存缓存，收到 401 时清空并重试）
type TokenCache = { token: string; expiresAt: number } | null;
const tokenCacheByAccount = new Map<string, TokenCache>();
type ConversationTurn = { role: "user" | "assistant"; text: string; at: number };
const historyBySessionKey = new Map<string, ConversationTurn[]>();
const sessionKeyByTarget = new Map<string, string>();
let historyLoaded = false;

function getHistoryFilePath(): string {
  const home = process.env.OPENCLAW_HOME || process.env.HOME || os.homedir();
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
  return path.join(stateDir, "easemob-history.json");
}

function loadHistoryFromDiskOnce() {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    const p = getHistoryFilePath();
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw) as Record<string, ConversationTurn[]>;
    for (const [k, turns] of Object.entries(data)) {
      if (!Array.isArray(turns) || !k.trim()) continue;
      historyBySessionKey.set(
        k,
        turns
          .filter(
            (t) =>
              t &&
              (t.role === "user" || t.role === "assistant") &&
              typeof t.text === "string" &&
              typeof t.at === "number"
          )
          .slice(-40)
      );
    }
  } catch (e) {
    pluginApi?.logger?.error?.(`[easemob] load history failed: ${String((e as Error)?.message ?? e)}`);
  }
}

function saveHistoryToDisk() {
  try {
    const p = getHistoryFilePath();
    const obj: Record<string, ConversationTurn[]> = {};
    for (const [k, v] of historyBySessionKey.entries()) obj[k] = v.slice(-40);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    pluginApi?.logger?.error?.(`[easemob] save history failed: ${String((e as Error)?.message ?? e)}`);
  }
}

function appendTurn(sessionKey: string, turn: ConversationTurn) {
  const key = sessionKey.trim();
  if (!key) return;
  const list = historyBySessionKey.get(key) ?? [];
  list.push(turn);
  if (list.length > 40) list.splice(0, list.length - 40);
  historyBySessionKey.set(key, list);
  saveHistoryToDisk();
}

function buildMessageWithHistory(params: {
  sessionKey: string;
  currentUserText: string;
  maxTurns: number;
}): string {
  const allTurns = historyBySessionKey.get(params.sessionKey) ?? [];
  const turns = allTurns.slice(-Math.max(0, params.maxTurns));
  if (turns.length === 0) return params.currentUserText;
  const historyText = turns
    .map((t) => `${t.role === "user" ? "用户" : "助手"}: ${t.text}`)
    .join("\n");
  return [
    "以下是最近对话记录，请基于上下文继续回复。",
    historyText,
    `用户: ${params.currentUserText}`,
  ].join("\n");
}

function resolveOutboundTarget(params: {
  to?: string;
  target?: string;
  peer?: { id?: string; kind?: string };
  [k: string]: unknown;
}): string {
  const raw =
    params.to ??
    params.target ??
    (params.peer && typeof params.peer === "object" && "id" in params.peer
      ? String((params.peer as { id?: string }).id ?? "")
      : "");
  const value = String(raw ?? "").trim();
  if (!value) return "";
  // 兼容可能出现的前缀写法
  if (value.startsWith("user:")) return value.slice(5);
  return value;
}

async function getEasemobToken(params: {
  host: string;
  org_name: string;
  app_name: string;
  client_id: string;
  client_secret: string;
  accountKey: string;
}): Promise<string> {
  const cached = tokenCacheByAccount.get(params.accountKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const base = params.host.replace(/\/$/, "");
  const url = `${base}/${params.org_name}/${params.app_name}/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: params.client_id,
      client_secret: params.client_secret,
      ttl: 60 * 60 * 24 * 30, // 30 天
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Easemob token failed: ${res.status} ${t}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  const expiresIn = (data.expires_in ?? 0) * 1000;
  tokenCacheByAccount.set(params.accountKey, {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn,
  });
  return data.access_token;
}

function extractTextFromPayload(payload: any): string {
  if (!payload || typeof payload !== "object") return "";
  const bodies = payload.bodies;
  if (!Array.isArray(bodies) || bodies.length === 0) return "";
  const first = bodies[0];
  if (!first || typeof first !== "object") return "";
  if (first.type === "txt" && typeof first.msg === "string") return first.msg;
  if (first.type === "cmd" && typeof first.action === "string") return first.action;
  return "";
}

function verifyEasemobSecurity(
  callId: string,
  timestamp: string,
  secret: string,
  security: string
): { ok: boolean; expected: string; provided: string; matchedRule: string } {
  const candidates = [
    { rule: "callId+secret+timestamp", str: `${callId}${secret}${timestamp}` },
    { rule: "callId+timestamp+secret", str: `${callId}${timestamp}${secret}` },
    { rule: "secret+callId+timestamp", str: `${secret}${callId}${timestamp}` },
    { rule: "timestamp+callId+secret", str: `${timestamp}${callId}${secret}` },
  ];
  const provided = String(security ?? "").trim().toLowerCase();
  for (const item of candidates) {
    const expected = crypto.createHash("md5").update(item.str).digest("hex");
    if (expected === provided) {
      return { ok: true, expected, provided, matchedRule: item.rule };
    }
  }
  const firstExpected = crypto.createHash("md5").update(candidates[0].str).digest("hex");
  return { ok: false, expected: firstExpected, provided, matchedRule: "none" };
}

function toSessionSafe(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, "_");
}

function buildEasemobSessionKey(params: {
  orgName?: string;
  appName?: string;
  chatType?: string;
  from?: string;
  groupId?: string;
  groupSessionScope?: "group" | "group-user";
}): string {
  const org = toSessionSafe(params.orgName ?? "org");
  const app = toSessionSafe(params.appName ?? "app");
  const ns = `easemob:${org}:${app}`;
  if (params.chatType === "groupchat") {
    const gid = toSessionSafe(params.groupId ?? "unknown-group");
    const scope = params.groupSessionScope ?? "group-user";
    if (scope === "group") {
      return `${ns}:group:${gid}`;
    }
    const uid = toSessionSafe(params.from ?? "unknown-user");
    return `${ns}:group:${gid}:user:${uid}`;
  }
  const uid = toSessionSafe(params.from ?? "unknown-user");
  return `${ns}:dm:${uid}`;
}

const easemobChannel = {
  id: "easemob",

  meta: {
    id: "easemob",
    label: "环信 IM (Easemob)",
    selectionLabel: "环信 IM (Easemob)",
    docsPath: "/channels/easemob",
    blurb: "环信 IM：回调收消息，REST 发消息。",
    aliases: ["huanxin", "环信"],
  },

  capabilities: {
    chatTypes: ["direct", "group"],
  },
  // Channel 配置表单读取的是 channel.configSchema（对应 channels.easemob 节点）
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: true,
            properties: {
              enabled: { type: "boolean" },
              host: { type: "string" },
              org_name: { type: "string" },
              app_name: { type: "string" },
              client_id: { type: "string" },
              client_secret: { type: "string" },
              access_token: { type: "string" },
              callback_secret: { type: "string" },
              callback_verify: { type: "boolean" },
              callback_port: { type: "number" },
              from_user: { type: "string" },
              hooks_token: { type: "string" },
            },
          },
        },
      },
    },
  },

  config: {
    listAccountIds: (cfg: any) =>
      Object.keys(cfg?.channels?.easemob?.accounts ?? {}),
    resolveAccount: (cfg: any, accountId?: string) =>
      cfg?.channels?.easemob?.accounts?.[accountId ?? "default"] ?? {
        accountId: accountId ?? "default",
      },
  },

  outbound: {
    deliveryMode: "direct" as const,
    // 允许直接使用用户输入的 to（如 test / group:xxx）作为目标，避免被目录校验拦截
    resolveTarget: (params: {
      to?: string;
      [k: string]: unknown;
    }) => {
      const raw = typeof params.to === "string" ? params.to.trim() : "";
      if (!raw) {
        return { ok: false as const, error: new Error("Missing target for easemob (expected username or group:groupId)") };
      }
      return { ok: true as const, to: raw };
    },
    sendText: async (params: {
      text: string;
      to?: string;
      target?: string;
      accountId?: string;
      peer?: { id?: string };
      [k: string]: unknown;
    }) => {
      const cfg = pluginApi?.config ?? {};
      const account =
        cfg?.channels?.easemob?.accounts?.[params.accountId ?? "default"] ?? {};
      const host = (account.host ?? "https://a1.easemob.com").replace(/\/$/, "");
      const org_name = account.org_name ?? "";
      const app_name = account.app_name ?? "";
      const client_id = account.client_id ?? "";
      const client_secret = account.client_secret ?? "";
      const from_user = account.from_user ?? "admin";
      const to = resolveOutboundTarget(params);
      const text = params.text ?? "";
      const explicitSessionKey =
        typeof params.sessionKey === "string" && params.sessionKey.trim()
          ? params.sessionKey.trim()
          : undefined;
      const inferredSessionKey =
        explicitSessionKey ||
        (typeof to === "string" && to ? sessionKeyByTarget.get(to) : undefined);
      if (!org_name || !app_name || !to || !text) {
        if (pluginApi?.logger?.error) {
          pluginApi.logger.error(
            `[easemob] sendText missing required fields: org_name=${Boolean(org_name)} app_name=${Boolean(app_name)} to=${Boolean(to)} text=${Boolean(text)}`
          );
        }
        return { ok: false };
      }
      const accountKey = `${org_name}/${app_name}`;
      let token: string;
      try {
        token = account.access_token
          ? (account.access_token as string)
          : await getEasemobToken({
              host,
              org_name,
              app_name,
              client_id,
              client_secret,
              accountKey,
            });
      } catch (e) {
        if (pluginApi?.logger?.error) pluginApi.logger.error(e);
        return { ok: false };
      }
      const isGroup = typeof to === "string" && to.startsWith("group:");
      const targetType = isGroup ? "chatgroups" : "users";
      const target = isGroup ? [to.slice(6)] : [to];
      const url = `${host}/${org_name}/${app_name}/messages`;
      const sendPayload = {
        target_type: targetType,
        target,
        msg: { type: "txt", msg: text },
        from: from_user,
      };
      pluginApi?.logger?.info?.(
        `[easemob] sendText start to=${to} isGroup=${isGroup} from=${from_user} textLen=${text.length}`
      );
      let res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(sendPayload),
      });
      if (res.status === 401) {
        // 立即刷新 token 重试一次，减少临界过期导致的丢消息
        tokenCacheByAccount.delete(accountKey);
        pluginApi?.logger?.info?.("[easemob] sendText got 401, refreshing token and retrying once");
        try {
          const freshToken = account.access_token
            ? (account.access_token as string)
            : await getEasemobToken({
                host,
                org_name,
                app_name,
                client_id,
                client_secret,
                accountKey,
              });
          res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${freshToken}`,
            },
            body: JSON.stringify(sendPayload),
          });
        } catch (e) {
          pluginApi?.logger?.error?.(e);
          return { ok: false };
        }
      }
      if (!res.ok) {
        const t = await res.text();
        pluginApi?.logger?.error?.(
          `[easemob] send failed status=${res.status} to=${to} from=${from_user} body=${t.slice(0, 400)}`
        );
        return { ok: false };
      }
      const okBody = await res.text();
      pluginApi?.logger?.info?.(
        `[easemob] sendText success status=${res.status} to=${to} body=${okBody.slice(0, 200)}`
      );
      if (inferredSessionKey) {
        appendTurn(inferredSessionKey, {
          role: "assistant",
          text: String(text),
          at: Date.now(),
        });
      }
      return { ok: true };
    },
    // 新版 outbound 装配要求同时提供 sendMedia；环信 REST 这里先降级为文本发送（优先 caption/text，其次发送 mediaUrl）
    sendMedia: async (params: {
      mediaUrl?: string;
      text?: string;
      caption?: string;
      to?: string;
      target?: string;
      accountId?: string;
      peer?: { id?: string; kind?: string };
      [k: string]: unknown;
    }) => {
      const fallbackText =
        (typeof params.caption === "string" && params.caption.trim()) ||
        (typeof params.text === "string" && params.text.trim()) ||
        (typeof params.mediaUrl === "string" && params.mediaUrl.trim()) ||
        "[media]";
      return easemobChannel.outbound.sendText({
        ...params,
        text: fallbackText,
      } as {
        text: string;
        to?: string;
        target?: string;
        accountId?: string;
        peer?: { id?: string; kind?: string };
        [k: string]: unknown;
      });
    },
  },
};

export default function register(api: any) {
  pluginApi = api;
  api.logger.info("环信 IM (Easemob) channel plugin loaded");
  api.registerChannel({ plugin: easemobChannel });

  api.registerService({
    id: "easemob-callback-server",
    start: () => {
      loadHistoryFromDiskOnce();
      const cfg = api.config ?? {};
      const port =
        cfg?.channels?.easemob?.accounts?.default?.callback_port ?? 18791;
      const account = cfg?.channels?.easemob?.accounts?.default ?? {};
      const callbackSecret = account.callback_secret ?? "";
      const callbackVerify = account.callback_verify !== false;
      const ignoreSelfMessages = account.ignore_self_messages !== false;
      const fromUser = String(account.from_user ?? "admin").trim();
      const groupSessionScope =
        account.group_session_scope === "group" ? "group" : "group-user";
      const contextBridgeEnabled = account.context_bridge_enabled !== false;
      const contextMaxTurnsRaw = Number(account.context_max_turns);
      const contextMaxTurns =
        Number.isFinite(contextMaxTurnsRaw) && contextMaxTurnsRaw > 0
          ? Math.min(40, Math.floor(contextMaxTurnsRaw))
          : 12;
      const baseUrl = getGatewayBaseUrl(cfg);
      const { path: hooksPath, token: globalHooksToken } = getHooksConfig(cfg);
      // /hooks/agent 只认 hooks.token，不认 gateway.auth.token；此处始终使用 hooks 专用 token
      const hooksTokenFromAccount = account.hooks_token && String(account.hooks_token).trim();
      const agentUrl = `${baseUrl.replace(/\/$/, "")}${hooksPath}/agent`;

      const server = http.createServer(async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed", hint: "环信回调需使用 POST，请勿使用 GET" }));
          return;
        }
        if (req.url !== "/" && req.url !== "/easemob/callback") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not Found" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        let json: any;
        try {
          json = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const callId = json.callId ?? "";
        const timestamp = String(json.timestamp ?? "");
        const security =
          json.security ??
          req.headers["x-easemob-security"] ??
          req.headers["security"] ??
          "";
        const eventType = json.eventType ?? "";
        const chat_type = json.chat_type ?? "";
        const from = json.from ?? "";
        const to = json.to ?? "";
        const payload = json.payload;

        if (
          ignoreSelfMessages &&
          fromUser &&
          typeof from === "string" &&
          from.trim().toLowerCase() === fromUser.toLowerCase()
        ) {
          api.logger.info?.("[easemob] ignored self-sent callback message");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: "ignored", reason: "self message" }));
          return;
        }

        const securityCheck = callbackSecret
          ? verifyEasemobSecurity(callId, timestamp, callbackSecret, security)
          : { ok: true, expected: "", provided: "", matchedRule: "disabled(no-secret)" };
        if (callbackVerify && !securityCheck.ok) {
          api.logger.error?.(
            `[easemob] callback security verify failed (callId=${String(callId).slice(0, 24)}, ts=${timestamp}, provided=${securityCheck.provided.slice(0, 8)}..., expected=${securityCheck.expected.slice(0, 8)}...)`
          );
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid security" }));
          return;
        }
        if (callbackVerify && callbackSecret) {
          api.logger.info?.(`[easemob] callback security verified (rule=${securityCheck.matchedRule})`);
        } else if (!callbackVerify) {
          api.logger.info?.("[easemob] callback security verify disabled by config (callback_verify=false)");
        }

        const text = extractTextFromPayload(payload);
        if (!text.trim()) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: "ignored", reason: "no text" }));
          return;
        }

        const toUser =
          chat_type === "groupchat"
            ? `group:${json.group_id ?? ""}`
            : from;
        const requestSessionKey = buildEasemobSessionKey({
          orgName: account.org_name,
          appName: account.app_name,
          chatType: chat_type,
          from,
          groupId: String(json.group_id ?? ""),
          groupSessionScope,
        });
        const agentMessage = contextBridgeEnabled
          ? buildMessageWithHistory({
              sessionKey: requestSessionKey,
              currentUserText: text,
              maxTurns: contextMaxTurns,
            })
          : text;
        // 优先从与 Gateway 相同的配置文件读取 hooks.token，避免 api.config 与 Gateway 不一致导致 401
        const fileToken = readHooksTokenFromConfigFile();
        const hooksToken = fileToken || hooksTokenFromAccount || globalHooksToken;
        if (!hooksToken) {
          api.logger.error?.("[easemob] hooks token 未配置：请在 openclaw.json 的 hooks.token、或 channels.easemob.accounts.default.hooks_token、或环境变量 OPENCLAW_HOOKS_TOKEN 中设置（/hooks/agent 仅校验 hooks.token）");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "hooks not configured" }));
          return;
        }

        let hookStatus: number | undefined;
        let hookError: string | undefined;
        try {
          api.logger.info?.(
            `[easemob] 调用 ${agentUrl} to=${toUser} sessionKey=${requestSessionKey} (hooks token: ${fileToken ? "from config file" : "from api.config/env"}, length=${hooksToken.length})`
          );
          const hookPayload: Record<string, unknown> = {
            message: agentMessage,
            channel: "easemob",
            to: toUser,
            deliver: true,
            wakeMode: "now",
            sessionKey: requestSessionKey,
          };
          let hookRes = await fetch(agentUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${hooksToken}`,
              "x-openclaw-token": hooksToken,
            },
            body: JSON.stringify(hookPayload),
          });
          hookStatus = hookRes.status;
          let bodyText = await hookRes.text();
          if (
            hookRes.status === 400 &&
            bodyText.includes("sessionKey is disabled for external /hooks/agent payloads")
          ) {
            api.logger.error?.(
              "[easemob] hooks 未开启 request sessionKey，已回退为无 sessionKey 请求。建议在 openclaw.json 配置 hooks.allowRequestSessionKey=true 以保持上下文。"
            );
            delete hookPayload.sessionKey;
            hookRes = await fetch(agentUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${hooksToken}`,
                "x-openclaw-token": hooksToken,
              },
              body: JSON.stringify(hookPayload),
            });
            hookStatus = hookRes.status;
            bodyText = await hookRes.text();
          }
          if (hookRes.status === 401) {
            hookError = bodyText || "Unauthorized";
            api.logger.error?.(
              `[easemob] /hooks/agent 返回 401。请确认 openclaw.json 中 hooks.token 与插件使用的 token 完全一致（当前请求使用的 token 长度=${hooksToken.length}）。body: ${bodyText.slice(0, 200)}`
            );
          } else if (!hookRes.ok) {
            hookError = bodyText.slice(0, 500);
            api.logger.error?.(`[easemob] hooks/agent ${hookRes.status}: ${bodyText.slice(0, 300)}`);
          } else {
            // hooks 已接受，记录用户输入并建立 to -> sessionKey 映射，供出站回写助手回复
            appendTurn(requestSessionKey, {
              role: "user",
              text: String(text),
              at: Date.now(),
            });
            sessionKeyByTarget.set(toUser, requestSessionKey);
          }
        } catch (e) {
          hookError = (e as Error)?.message ?? String(e);
          api.logger.error?.(e);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        const resBody: Record<string, unknown> = hookStatus === 202 || hookStatus === 200 ? { result: "ok" } : { result: "hook_failed", hook_status: hookStatus, hook_error: hookError };
        res.end(JSON.stringify(resBody));
      });

      server.listen(port, () => {
        api.logger.info(`[easemob] callback server listening on port ${port}, path: / or /easemob/callback`);
      });

      (server as any)._easemobServer = true;
      (api as any)._easemobCallbackServer = server;
    },
    stop: () => {
      const server = (pluginApi as any)?._easemobCallbackServer;
      if (server && server.listening) {
        server.close();
      }
      tokenCacheByAccount.clear();
      pluginApi?.logger?.info?.("[easemob] callback server stopped");
    },
  });
}
