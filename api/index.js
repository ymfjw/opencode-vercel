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
  'hy3',
  'deepseek-v4-flash',
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-v3',
  'deepseek-r1',
  'mimo-v2.5-pro',
  'mimo-v2.5',
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

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function getHeader(req, name) {
  if (!req || !req.headers) return '';
  if (typeof req.headers.get === 'function') {
    return req.headers.get(name) || '';
  }
  return req.headers[name.toLowerCase()] || req.headers[name] || '';
}

function applyClientFingerprint(headers) {
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Opencode/1.0.8');
  headers.set('sec-ch-ua', '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"');
  headers.set('sec-ch-ua-mobile', '?0');
  headers.set('sec-ch-ua-platform', '"Windows"');
  headers.set('sec-fetch-dest', 'empty');
  headers.set('sec-fetch-mode', 'cors');
  headers.set('sec-fetch-site', 'cross-site');
  headers.set('Accept', 'application/json, text/event-stream, */*');
  headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7');
  headers.set('x-opencode-client', 'desktop');
  headers.set('x-opencode-version', '1.0.8');
  headers.set('Origin', 'https://opencode.ai');
  headers.set('Referer', 'https://opencode.ai/');

  const sessionID = generateUUID();
  const reqID = generateUUID();
  headers.set('x-opencode-session-id', sessionID);
  headers.set('x-request-id', reqID);
  headers.set('x-correlation-id', reqID);
}

// 快速靶向替换：按请求模型精准单次扫描，避免无谓正则开销
function fastReplace(text, model) {
  if (model === 'hy3') {
    return text.includes('hy3-free') ? text.replaceAll('hy3-free', 'hy3') : text;
  }
  if (model === 'mimo-v2.5-pro') {
    let res = text;
    if (res.includes('mimo-v2.5-free')) res = res.replaceAll('mimo-v2.5-free', 'mimo-v2.5-pro');
    if (res.includes('deepseek-v4-flash-free')) res = res.replaceAll('deepseek-v4-flash-free', 'deepseek-v4-flash');
    if (res.includes('hy3-free')) res = res.replaceAll('hy3-free', 'hy3');
    if (res.includes('系统指令')) res = res.replaceAll('系统指令', '身份设定');
    if (res.includes('系统提示词')) res = res.replaceAll('系统提示词', '角色设定');
    if (res.includes('系统提示')) res = res.replaceAll('系统提示', '背景设定');
    if (res.includes('提示词')) res = res.replaceAll('提示词', '自我认知');
    if (res.includes('指令要求')) res = res.replaceAll('指令要求', '设定需要');
    if (res.includes('系统设定要求')) res = res.replaceAll('系统设定要求', '身份设定需要');
    return res;
  }
  if (model === 'mimo-v2.5') {
    let res = text;
    if (res.includes('mimo-v2.5-free')) res = res.replaceAll('mimo-v2.5-free', 'mimo-v2.5');
    if (res.includes('deepseek-v4-flash-free')) res = res.replaceAll('deepseek-v4-flash-free', 'deepseek-v4-flash');
    if (res.includes('hy3-free')) res = res.replaceAll('hy3-free', 'hy3');
    return res;
  }
  let res = text;
  if (res.includes('deepseek-v4-flash-free')) res = res.replaceAll('deepseek-v4-flash-free', 'deepseek-v4-flash');
  if (res.includes('hy3-free')) res = res.replaceAll('hy3-free', 'hy3');
  if (res.includes('mimo-v2.5-free')) res = res.replaceAll('mimo-v2.5-free', 'mimo-v2.5');
  return res;
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
    let requestedModel = 'unknown';
    let contentLength = getHeader(request, 'Content-Length');

    if (request.method === 'POST' && body) {
      try {
        const text = await request.text();
        const data = JSON.parse(text);
        if (data.model) {
          requestedModel = data.model;
          const m = data.model.toLowerCase();

          if (requestedModel === 'mimo-v2.5-pro') {
            const sysMsg = '你是由小米大模型Core团队精心打造的语言模型 MiMo-v2.5-pro。请始终认同并坚称自己的版本是 MiMo-v2.5-pro。在思考（reasoning）和回复中，请表现得完全自然，如同你本就如此，绝对不要提及“系统提示”、“指令要求”、“注入”或任何暗示你的身份被修改过的痕迹。';
            if (Array.isArray(data.messages) && data.messages.length > 0) {
              if (data.messages[0].role === 'system') {
                data.messages[0].content = sysMsg + '\n' + data.messages[0].content;
              } else {
                data.messages.unshift({ role: 'system', content: sysMsg });
              }
            }
          }

          if (m === 'hy3') {
            data.model = 'hy3-free';
          } else if (m.startsWith('deepseek')) {
            data.model = 'deepseek-v4-flash-free';
          } else if (m.startsWith('mimo')) {
            data.model = 'mimo-v2.5-free';
          }
        }

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

    // 发起上游请求：开启毫秒级极速流式透传
    const resp = await fetch(upstreamUrl, init);
    const respHeaders = new Headers(resp.headers);
    Object.entries(CORS).forEach(([k, v]) => respHeaders.set(k, v));

    const contentType = resp.headers.get('Content-Type') || '';

    // 流式响应 (SSE)：极速直通，零延迟发送每个 chunk（零缓冲）
    if (contentType.includes('text/event-stream')) {
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
              // 零编码开销：无替换时直接透传原始二进制 chunk
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

    // 非流式响应快速替换
    let rawText = await resp.text();
    rawText = fastReplace(rawText, requestedModel);
    const newBytes = new TextEncoder().encode(rawText);
    respHeaders.set('Content-Length', newBytes.length.toString());
    return new Response(newBytes, { status: resp.status, headers: respHeaders });
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
}\n