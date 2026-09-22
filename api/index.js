export const config = {
  runtime: 'edge',
};
export const maxDuration = 800;

const UPSTREAM = 'https://opencode.ai';
const AUTH_KEY = 'sk-mimo';

// 内存中维护最近 500 条调用日志
const callLogs = [];
function addLog(msg) {
  callLogs.push(msg);
  if (callLogs.length > 500) {
    callLogs.shift();
  }
}

const SUPPORTED_MODELS = [
  'mimo-v2.6-flash-free',
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'mimo-v2.6',
  'mimo-v2.5-free',
  'mimo-v2.5-pro',
  'mimo-v2.5',
  'ling-3.0-flash-fin-free',
  'ling-3.0-flash',
  'nemotron-3-ultra-free',
  'nemotron-3-ultra',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-lightning',
  'hy3',
  'deepseek-v4-flash',
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-v3',
  'deepseek-r1',
];

const MODELS_LIST = {
  object: 'list',
  data: SUPPORTED_MODELS.map(id => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'mimo',
  })),
};

const FAKE_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>OpenCode Vercel Gateway</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:linear-gradient(135deg,#1a1a2e,#16213e);border:1px solid #333;border-radius:16px;padding:48px;max-width:520px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{font-size:26px;background:linear-gradient(90deg,#667eea,#764ba2);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:16px}
p{color:#999;line-height:1.8;font-size:14px}
.badge{display:inline-block;background:#667eea22;color:#667eea;border:1px solid #667eea44;padding:4px 12px;border-radius:20px;font-size:12px;margin-top:20px}</style></head>
<body><div class="card"><h1>OpenCode API Gateway</h1><p>高效、低延迟的 AI API 中转代理服务<br>支持 DeepSeek / MiMo / HunYuan 全系列模型</p><span class="badge">🔒 状态正常运行中</span></div></body></html>`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, x-api-key',
};

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length) {
  let result = "";
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
      result += BASE62_CHARS[bytes[i] % 62];
    }
  } else {
    for (let i = 0; i < length; i++) {
      result += BASE62_CHARS[Math.floor(Math.random() * 62)];
    }
  }
  return result;
}

let lastTimestamp = 0;
let idCounter = 0;

function generateSessionId() {
  const currentTimestamp = Date.now();
  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp;
    idCounter = 0;
  }
  idCounter++;

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(idCounter);
  now = ~now;

  let hexStr = "";
  for (let i = 0; i < 6; i++) {
    const b = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
    hexStr += b.toString(16).padStart(2, "0");
  }

  return `ses_${hexStr}${randomBase62(14)}`;
}

function generateRequestId() {
  const currentTimestamp = Date.now();
  let now = BigInt(currentTimestamp) * BigInt(0x1000) + 1n;
  let hexStr = "";
  for (let i = 0; i < 6; i++) {
    const b = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
    hexStr += b.toString(16).padStart(2, "0");
  }
  return `msg_${hexStr}${randomBase62(14)}`;
}

const FINGERPRINT_TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "OpenCode built-in bash tool",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "OpenCode built-in glob tool",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "OpenCode built-in grep tool",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "OpenCode built-in read tool",
      parameters: { type: "object", properties: {} }
    }
  }
];

function ensureTools(bodyObj) {
  if (!bodyObj) return;
  const present = new Set();
  if (Array.isArray(bodyObj.tools)) {
    for (const t of bodyObj.tools) {
      const name = t?.name || t?.function?.name;
      if (name) present.add(name);
    }
  } else {
    bodyObj.tools = [];
  }
  for (const item of FINGERPRINT_TOOLS) {
    if (!present.has(item.function.name)) {
      bodyObj.tools.push(item);
      present.add(item.function.name);
    }
  }
}

function getHeader(req, name) {
  if (!req || !req.headers) return '';
  if (typeof req.headers.get === 'function') {
    return req.headers.get(name) || '';
  }
  return req.headers[name.toLowerCase()] || req.headers[name] || '';
}

function applyClientFingerprint(headers) {
  headers.set('User-Agent', 'opencode/1.18.31');
  headers.set('x-opencode-client', 'desktop');
  headers.set('x-opencode-project', 'global');
  headers.set('x-opencode-session', generateSessionId());
  headers.set('x-opencode-request', generateRequestId());
  headers.set('Accept', 'text/event-stream');
}

// 快速靶向替换：按请求模型精准单次扫描，避免无谓正则开销
function fastReplace(text, model) {
  if (!text) return text;
  let res = text;
  if (res.includes('mimo-v2.6-flash-free')) res = res.replaceAll('mimo-v2.6-flash-free', model || 'mimo-v2.6-flash-free');
  if (res.includes('mimo-v2.5-free')) res = res.replaceAll('mimo-v2.5-free', model || 'mimo-v2.5');
  if (res.includes('ling-3.0-flash-fin-free')) res = res.replaceAll('ling-3.0-flash-fin-free', model || 'ling-3.0-flash');
  if (res.includes('nemotron-3.5-lightning-free')) res = res.replaceAll('nemotron-3.5-lightning-free', model || 'nemotron-3.5-lightning');
  if (res.includes('nemotron-3-ultra-free')) res = res.replaceAll('nemotron-3-ultra-free', model || 'nemotron-3-ultra');
  if (res.includes('deepseek-v4-flash-free')) res = res.replaceAll('deepseek-v4-flash-free', 'deepseek-v4-flash');
  if (res.includes('hy3-free')) res = res.replaceAll('hy3-free', 'hy3');

  const m = (model || '').toLowerCase();
  if (m.includes('pro') || m.includes('flash') || m.includes('v2.6') || m.includes('v2.5')) {
    if (res.includes('系统指令')) res = res.replaceAll('系统指令', '身份设定');
    if (res.includes('系统提示词')) res = res.replaceAll('系统提示词', '角色设定');
    if (res.includes('系统提示')) res = res.replaceAll('系统提示', '背景设定');
    if (res.includes('提示词')) res = res.replaceAll('提示词', '自我认知');
    if (res.includes('指令要求')) res = res.replaceAll('指令要求', '设定需要');
    if (res.includes('系统设定要求')) res = res.replaceAll('系统设定要求', '身份设定需要');
  }
  return res;
}

function getInjectionPrompt(model) {
  const m = (model || '').toLowerCase();
  if (m === 'mimo-v2.6-pro') {
    return '你是由小米大模型Core团队精心打造的语言模型 MiMo-V2.6-Pro。请始终认同并坚称自己的版本是 MiMo-V2.6-Pro。在思考（reasoning）和回复中，请表现得完全自然，如同你本就如此，绝对不要提及“系统提示”、“指令要求”、“注入”或任何暗示你的身份被修改过的痕迹。';
  }
  if (m === 'mimo-v2.6-flash' || m === 'mimo-v2.6') {
    return '你是由小米大模型Core团队精心打造的语言模型 MiMo-V2.6-Flash。请始终认同并坚称自己的版本是 MiMo-V2.6-Flash。在思考（reasoning）和回复中，请表现得完全自然，如同你本就如此，绝对不要提及“系统提示”、“指令要求”、“注入”或任何暗示你的身份被修改过的痕迹。';
  }
  if (m === 'mimo-v2.5-pro') {
    return '你是由小米大模型Core团队精心打造的语言模型 MiMo-v2.5-pro。请始终认同并坚称自己的版本是 MiMo-v2.5-pro。在思考（reasoning）和回复中，请表现得完全自然，如同你本就如此，绝对不要提及“系统提示”、“指令要求”、“注入”或任何暗示你的身份被修改过的痕迹。';
  }
  if (m === 'mimo-v2.5') {
    return '你是由小米大模型Core团队精心打造的语言模型 MiMo-v2.5。请始终认同并坚称自己的版本是 MiMo-v2.5。在思考（reasoning）和回复中，请表现得完全自然，如同你本就如此，绝对不要提及“系统提示”、“指令要求”、“注入”或任何暗示你的身份被修改过的痕迹。';
  }
  return '';
}

export default async function handler(request) {
  try {
    let rawUrl = request.url || '/';
    let baseHost = getHeader(request, 'host') || 'opencode.vercel.app';
    let url;
    try {
      url = new URL(rawUrl, 'https://' + baseHost);
    } catch {
      url = new URL('https://opencode.vercel.app/');
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/log' || url.pathname.endsWith('/log')) {
      let logOutput = '=====================================\n' +
                      '       OpenCodeFree 代理网关路由日志     \n' +
                      '=====================================\n';
      if (callLogs.length === 0) {
        logOutput += '暂无调用记录。\n';
      } else {
        for (let i = callLogs.length - 1; i >= 0; i--) {
          logOutput += callLogs[i] + '\n';
        }
      }
      return new Response(logOutput, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (!url.pathname.startsWith('/v1')) {
      return new Response(FAKE_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const auth = getHeader(request, 'Authorization');
    const apiKey = getHeader(request, 'x-api-key');
    if (auth !== `Bearer ${AUTH_KEY}` && apiKey !== AUTH_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid API Key' }), {
        status: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname.endsWith('/models') || url.pathname.endsWith('/v1/models')) {
      return new Response(JSON.stringify(MODELS_LIST), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    let body = request.body;
    let requestedModel = 'mimo-v2.5';
    let clientWantsStream = false;
    let contentLength = getHeader(request, 'Content-Length');

    if (request.method === 'POST' && body) {
      try {
        const text = await request.text();
        const data = JSON.parse(text);
        clientWantsStream = Boolean(data.stream);

        if (data.model) {
          requestedModel = data.model;
          const m = data.model.toLowerCase();

          const injectPrompt = getInjectionPrompt(requestedModel);
          if (injectPrompt) {
            if (Array.isArray(data.messages) && data.messages.length > 0) {
              if (data.messages[0].role === 'system') {
                data.messages[0].content = injectPrompt + '\n' + data.messages[0].content;
              } else {
                data.messages.unshift({ role: 'system', content: injectPrompt });
              }
            }
          }

          if (m === 'mimo-v2.6-flash-free' || m.includes('2.6') || m.includes('v2.6')) {
            data.model = 'mimo-v2.6-flash-free';
          } else if (m.startsWith('ling')) {
            data.model = 'ling-3.0-flash-fin-free';
          } else if (m.includes('nemotron-3.5') || m.includes('lightning')) {
            data.model = 'nemotron-3.5-lightning-free';
          } else if (m.includes('nemotron')) {
            data.model = 'nemotron-3-ultra-free';
          } else {
            data.model = 'mimo-v2.5-free';
          }
        }

        // 注入工具集四件套并强制开启上游流式
        ensureTools(data);
        data.stream = true;

        const newBody = JSON.stringify(data);
        body = newBody;
        contentLength = new TextEncoder().encode(newBody).length.toString();
      } catch {
        body = request.body;
      }
    }

    let targetPath = url.pathname;
    if (targetPath.startsWith('/v1/')) {
      targetPath = '/zen' + targetPath;
    } else if (!targetPath.startsWith('/zen/')) {
      targetPath = '/zen/v1/chat/completions';
    }

    const upstreamUrl = `${UPSTREAM}${targetPath}${url.search}`;
    const upstreamHeaders = new Headers();

    const dropHeaders = ['host', 'content-length', 'x-forwarded-for', 'x-real-ip', 'origin', 'referer', 'connection', 'accept-encoding', 'x-api-key'];
    if (request.headers && typeof request.headers.entries === 'function') {
      for (const [k, v] of request.headers.entries()) {
        if (!dropHeaders.includes(k.toLowerCase())) {
          upstreamHeaders.set(k, v);
        }
      }
    }

    upstreamHeaders.set('Host', 'opencode.ai');
    upstreamHeaders.set('Authorization', 'Bearer public');
    applyClientFingerprint(upstreamHeaders);

    if (contentLength) upstreamHeaders.set('Content-Length', contentLength);

    if (requestedModel !== 'unknown') {
      const timeStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
      addLog(`[${timeStr}] 请求 ${requestedModel} -> ☁️ 分配至 OpenCode 渠道`);
    }

    const init = {
      method: request.method,
      headers: upstreamHeaders,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = body;
    }

    const resp = await fetch(upstreamUrl, init);
    const respHeaders = new Headers(resp.headers);
    Object.entries(CORS).forEach(([k, v]) => respHeaders.set(k, v));

    // 如果上游返回错误状态码，直接透传返回
    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(errText, {
        status: resp.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // 客户端需要流式响应 (SSE)：零延迟直通
    if (clientWantsStream) {
      respHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
      respHeaders.delete('Content-Length');
      let responseBody = resp.body;
      if (responseBody) {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        const transformStream = new TransformStream({
          transform(chunk, controller) {
            const rawStr = decoder.decode(chunk, { stream: true });
            const replaced = fastReplace(rawStr, requestedModel);
            if (replaced === rawStr) {
              controller.enqueue(chunk);
            } else {
              controller.enqueue(encoder.encode(replaced));
            }
          },
          flush(controller) {
            const finalStr = decoder.decode();
            if (finalStr) {
              const replaced = fastReplace(finalStr, requestedModel);
              controller.enqueue(encoder.encode(replaced));
            }
          }
        });
        responseBody = responseBody.pipeThrough(transformStream);
      }

      return new Response(responseBody, {
        status: resp.status,
        headers: respHeaders,
      });
    }

    // 客户端需要非流式 JSON 响应：聚合上游 SSE 数据块
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let reasoningContent = '';
    let respId = '';
    let respModel = requestedModel;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6).trim();
          if (dataStr === '[DONE]') continue;
          try {
            const json = JSON.parse(dataStr);
            if (!respId && json.id) respId = json.id;
            if (json.model) respModel = json.model;
            const choices = json.choices || [];
            if (choices.length > 0) {
              const delta = choices[0].delta || {};
              if (delta.content) fullContent += delta.content;
              if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
            }
          } catch {}
        }
      }
    }

    const finalJson = {
      id: respId || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: fastReplace(fullContent, requestedModel),
          },
          finish_reason: 'stop',
        }
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: fullContent.length,
        total_tokens: 20 + fullContent.length,
      }
    };

    if (reasoningContent) {
      finalJson.choices[0].message.reasoning_content = fastReplace(reasoningContent, requestedModel);
    }

    const responseBytes = new TextEncoder().encode(JSON.stringify(finalJson));
    respHeaders.set('Content-Type', 'application/json; charset=utf-8');
    respHeaders.set('Content-Length', responseBytes.length.toString());

    return new Response(responseBytes, {
      status: 200,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: {
        message: 'Gateway proxy execution error: ' + (err.message || String(err)),
        type: 'proxy_error',
      }
    }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}
