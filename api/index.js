export const maxDuration = 300;

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
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-free',
  'deepseek-v4.1',
  'glm-5.3-flash',
  'glm-5.3-flash-free',
  'glm-5.3',
  'mimimax-m3.1-flash',
  'minimax-m3.1-flash',
  'minimax-m3.1-flash-free',
  'minimax-m3.1',
  'muse-spark-1.3',
  'muse-spark-1.3-contributor-free',
  'muse-spark',
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
  'nemotron-3.5-super-vl-free',
  'big-pickle',
  'beam-free',
  'flint-40b-free',
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
<body><div class="card"><h1>OpenCode API Gateway</h1><p>高效、低延迟的 AI API 中转代理服务<br>支持 DeepSeek / GLM / MiMo 全系列免费模型</p><span class="badge">🔒 状态正常运行中</span></div></body></html>`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, x-api-key',
};

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomHex(len) {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

function randomBase62(length) {
  let result = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    result += BASE62_CHARS[bytes[i] % 62];
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
  now = ~now & 0xffffffffffffn;

  let hexStr = "";
  for (let i = 0; i < 6; i++) {
    const b = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
    hexStr += b.toString(16).padStart(2, "0");
  }

  return `ses_${hexStr}${randomBase62(14)}`;
}

let cachedSessionId = "";
let cachedSessionTs = 0;
const SESSION_TTL_MS = 15 * 60 * 1000;

function getStableSessionId(forceRotate = false) {
  const now = Date.now();
  if (forceRotate || !cachedSessionId || (now - cachedSessionTs > SESSION_TTL_MS)) {
    cachedSessionId = generateSessionId();
    cachedSessionTs = now;
  }
  return cachedSessionId;
}

// 官方 2.1.4 完整 Harness Preamble
const AGENT_PREAMBLE = "You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.\r\n\r\n# Harness\r\n- Responses are rendered as GitHub-flavored Markdown.\r\n- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.\r\n- Prefer parallelizing independent tool calls.\r\n- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.\r\n- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.\r\n- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.\r\n- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.\r\n\r\n# Communication\r\n- Use clear file paths when referring to files.\r\n- Keep responses clear and concise, and avoid unnecessary technical jargon.\r\n\r\n# Working in codebases\r\n- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.\r\n- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.\r\n\r\n# Your Model\r\n- Name: Big Pickle\r\n- Provider ID: opencode\r\n- Model ID: big-pickle\r\n# Code Mode\r\n\r\nUse the `execute` tool to call the tools listed below. They cannot be called directly. They only work inside code you pass to `execute`.\r\n\r\nThe catalog is complete. Do not guess tool names.\r\n\r\n## Available tools\r\n\r\n- opencode (8 tools) // Tools for managing OpenCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.\r\n  - tools.opencode.list_mcp_resources({\r\n  /** MCP server name as configured. Omit to list every server. */\r\n  server?: string,\r\n}): Promise<{\r\n  resources: Array<{\r\n      server: string,\r\n      name: string,\r\n      uri: string,\r\n      description?: string,\r\n      mimeType?: string,\r\n    }>,\r\n  templates: Array<{\r\n      server: string,\r\n      name: string,\r\n      uriTemplate: string,\r\n      description?: string,\r\n      mimeType?: string,\r\n    }>,\r\n}> // List documents, records, and other data exposed by MCP servers. Use this when the user refers to something that is no...\r\n  - tools.opencode.models({\r\n  /** Text to search for in model names and IDs. */\r\n  query?: string,\r\n  /** Provider ID or name to filter by. Try your own provider first. */\r\n  provider?: string,\r\n  /** Include older versions of each model family. By default only the newest version is listed. */\r\n  all?: boolean,\r\n  /** Maximum number of models to return. Defaults to 20. @integer @minimum 1 @maximum 100 */\r\n  limit?: number,\r\n  /** Number of models to skip, for paging through results. @integer @minimum 0 */\r\n  offset?: number,\r\n}): Promise<{\r\n  /** Matching models grouped by provider. Your own provider comes first. */\r\n  providers: Array<{\r\n      id: string,\r\n      name: string,\r\n      /** Newest first. */\r\n      models: Array<{\r\n          /** providerID/modelID */\r\n          id: string,\r\n          name: string,\r\n          /** Release date as a Unix timestamp in milliseconds, or 0 when unknown. */\r\n          released: number,\r\n          variants: Array<string>,\r\n          /** Pricing in USD per million tokens. */\r\n          cost: Array<{\r\n              tier?: {\r\n                type: \"context\",\r\n                /** @integer */\r\n                size: number,\r\n              },\r\n              input: number,\r\n              output: number,\r\n              cache: {\r\n                read: number,\r\n                write: number,\r\n              },\r\n            }>,\r\n          status: \"alpha\" | \"beta\" | \"deprecated\" | \"active\",\r\n        }>,\r\n    }>,\r\n  /** Number of matching models across all pages. @integer */\r\n  total: number,\r\n  /** Offset of the next page, or null on the last page. */\r\n  next: number | null,\r\n}> // Search the models available to use. Use this to turn a model name the user mentions into an exact reference before ru...\r\n  - tools.opencode.read_mcp_resource({\r\n  /** The server field of the discovered resource. */\r\n  server: string,\r\n  /** Exact resource URI from discovery, an expanded uriTemplate, or the user. */\r\n  uri: string,\r\n}): Promise<{\r\n  server: string,\r\n  uri: string,\r\n  contents: Array<{\r\n        type: \"text\",\r\n        uri: string,\r\n        text: string,\r\n        mimeType?: string,\r\n      } | {\r\n        type: \"blob\",\r\n        uri: string,\r\n        blob: string,\r\n        mimeType?: string,\r\n      }>,\r\n}> // Read one MCP resource by server and URI. Not for local files. Always return the full contents rather than slicing or ...\r\n  - tools.opencode.session_move({\r\n  /** Omit to move the current session. @pattern ^ses */\r\n  sessionID?: string,\r\n  /** Destination directory, relative to the target session's directory or absolute. Supports ~. @minLength 1 */\r\n  directory: string,\r\n}): Promise<{\r\n  /** @pattern ^ses */\r\n  sessionID: string,\r\n  directory: string,\r\n}> // Move a session to another directory, or omit sessionID to move the current session. The current session moves at the ...\r\n  - tools.opencode.session_rename({\r\n  /** Omit to rename the current session. @pattern ^ses */\r\n  sessionID?: string,\r\n  /** New session title. @minLength 1 */\r\n  title: string,\r\n}): Promise<{\r\n  /** @pattern ^ses */\r\n  sessionID: string,\r\n  title: string,\r\n}> // Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the wo...\r\n  - tools.opencode.worktree_create({\r\n  name: string,\r\n}): Promise<{\r\n  directory: string,\r\n}> // Create a named worktree. Returns its directory.\r\n  - tools.opencode.worktree_list(): Promise<{\r\n  worktrees: Array<{\r\n      directory: string,\r\n      strategy?: string,\r\n    }>,\r\n}> // List a repository's worktrees.\r\n  - tools.opencode.worktree_remove({\r\n  /** Absolute path of the worktree to remove. @minLength 1 */\r\n  directory: string,\r\n  /** Discard modified and untracked files. Only set this when the user has confirmed forced removal. */\r\n  force?: boolean,\r\n}): Promise<{\r\n  directory: string,\r\n  removed: boolean,\r\n}> // Remove a worktree. The repository location selects configuration; directory identifies the worktree to remove.\r\n\r\nSkills provide specialized instructions and workflows for specific tasks.\r\nUse the skill tool to load a skill when a task matches its description.\r\nThe user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.\r\n<available_skills>\r\n  <skill>\r\n    <id>opencode</id>\r\n    <name>OpenCode</name>\r\n    <description>Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app.</description>\r\n  </skill>\r\n  <skill>\r\n    <id>report</id>\r\n    <name>Report</name>\r\n    <description>Use when the user wants to report an opencode issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI.</description>\r\n  </skill>\r\n</available_skills>\r\n\r\nToday's date: Sun Oct 25 2026\r\n\r\nHere is some useful information about the environment you are running in:\r\n<env>\r\n  Working directory: /tmp/opencode/fhome\r\n  Workspace root folder: /tmp/opencode/fhome\r\n  Is directory a git repo: no\r\n  Platform: linux\r\n  Prefer /tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.\r\n</env>\r\nWhen you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.";
const PREAMBLE_MARKER = "You are an AI agent running in OpenCode";

// 官方 2.1.4 完整 Core Tools (12 项)
const AGENT_TOOLS = [{"type":"function","function":{"name":"edit","description":"Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"File to edit"},"oldString":{"type":"string","description":"Exact text to find and replace"},"newString":{"type":"string","description":"Text to replace oldString with (must differ from oldString)"},"replaceAll":{"type":"boolean","description":"Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."}},"required":["path","oldString","newString"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"glob","description":"Search file paths using a glob pattern (examples: \"**/*.ts\", \"src/**/*.tsx\").","parameters":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern to match files against"},"path":{"type":"string","description":"Directory to search. Defaults to the current working directory."},"hidden":{"type":"boolean","description":"Include hidden files and directories (default: false)."},"limit":{"type":"integer","exclusiveMinimum":0,"description":"Maximum number of matching files to return (default: 100)"}},"required":["pattern"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"grep","description":"Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.","parameters":{"type":"object","properties":{"pattern":{"type":"string","minLength":1,"description":"Regular expression or literal text to match in file contents."},"path":{"type":"string","description":"File or directory to search. Defaults to the current working directory."},"include":{"type":"string","description":"Glob pattern to filter files (for example, \"*.js\" or \"*.{ts,tsx}\")"},"literal":{"type":"boolean","description":"Treat `pattern` as exact text instead of a regular expression (default: false)."},"caseSensitive":{"type":"boolean","description":"Use case-sensitive matching (default: true)."},"limit":{"type":"integer","exclusiveMinimum":0,"description":"Maximum number of matching lines to return (default: 100)"}},"required":["pattern"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"question","description":"Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- A \"Type your own answer\" option is added automatically; don't include a separate option for free form answers\n- Set `multiple: true` to allow selecting more than one option\n- If you recommend a specific option, make that the first option in the list and add \"(Recommended)\" at the end of the label","parameters":{"type":"object","properties":{"questions":{"type":"array","items":{"type":"object","properties":{"question":{"type":"string","description":"Complete question"},"header":{"type":"string","description":"Very short label (max 30 chars)"},"options":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string","description":"Display text (1-5 words, concise)"},"description":{"type":"string","description":"Explanation of choice"}},"required":["label","description"],"additionalProperties":false},"description":"Available choices"},"multiple":{"type":"boolean"}},"required":["question","header","options"],"additionalProperties":false},"minItems":1,"description":"Questions to ask"}},"required":["questions"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"read","description":"Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"File or directory to read"},"offset":{"type":"integer","minimum":0,"description":"The line or directory entry to start reading from (1-based)"},"limit":{"type":"integer","minimum":0,"description":"The maximum number of lines or directory entries to read (defaults to and capped at 2000)"}},"required":["path"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"shell","description":"Execute a shell command and return its output. Commands run on Linux using zsh. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.","parameters":{"type":"object","properties":{"command":{"type":"string","description":"Shell command string to execute"},"workdir":{"type":"string","description":"Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."},"timeout":{"type":"integer","minimum":0,"description":"Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."},"background":{"type":"boolean","description":"Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."}},"required":["command"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"skill","description":"Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.\n\nThe skill ID must match an available skill or a skill explicitly referenced by the user.","parameters":{"type":"object","properties":{"id":{"type":"string","description":"The ID of an available skill or a skill explicitly referenced by the user"}},"required":["id"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"subagent","description":"Spawns an agent in a child session to work on the specified task.\nThe output includes a sessionID you can pass back later to continue that specific conversation with the subagent.\nNew child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.\nForeground (default) runs the subagent to completion and returns its final response.\nBackground mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.\nUse background only for independent work that can run while you continue elsewhere.\n\nAvailable subagents:\n- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions.\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.","parameters":{"type":"object","properties":{"agent":{"type":"string","description":"The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead."},"description":{"type":"string","description":"A short 3-5 word label for the task, displayed to the user"},"prompt":{"type":"string","description":"The task for the subagent to perform"},"model":{"type":"string","description":"NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as \"providerID/modelID\", or \"providerID/modelID#variant\" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first."},"sessionID":{"type":"string","pattern":"^ses","description":"Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation."},"background":{"type":"boolean","description":"Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress."}},"required":["agent","description","prompt"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"webfetch","description":"Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.","parameters":{"type":"object","properties":{"url":{"type":"string","description":"The HTTP or HTTPS URL to fetch content from"},"format":{"type":"string","enum":["text","markdown","html"],"description":"The format to return the content in. Defaults to markdown."},"timeout":{"type":"number","exclusiveMinimum":0,"maximum":120,"description":"Optional timeout in seconds (maximum: 120)"}},"required":["url"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"websearch","description":"Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.\n\nThe current year is 2026. Use this year when searching for recent information or current events.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"Websearch query"}},"required":["query"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"write","description":"Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Path to the file to write to"},"content":{"type":"string","description":"Content to write to the file"}},"required":["path","content"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"execute","description":"Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.\n`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.\nWithin `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.\nCall tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>[\"tool-name\"](input)`.\nPrefer an explicit `return`; if omitted, the final top-level expression becomes the result.\nAwait every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.","parameters":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"],"additionalProperties":false},"strict":false}}];

const TRACE_ROOT = randomHex(32);

function applyClientFingerprint(headers, forceRotate = false) {
  const ses = getStableSessionId(forceRotate);
  const span = randomHex(16);
  const parent = randomHex(16);
  const project = randomHex(40);

  headers.set('User-Agent', 'opencode/latest/2.1.4/cli');
  headers.set('x-opencode-client', 'cli');
  headers.set('x-opencode-version', '2.1.4');
  headers.set('x-opencode-project', project);
  headers.set('x-opencode-session', ses);
  headers.set('x-opencode-session-id', ses);
  headers.set('x-session-affinity', ses);
  headers.set('x-session-id', ses);
  headers.set('b3', `${TRACE_ROOT}-${span}-1-${parent}`);
  headers.set('traceparent', `00-${TRACE_ROOT}-${span}-01`);
  headers.set('Accept', 'application/json, text/event-stream');
}

function targetDisplayName(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("deepseek-v4.1") || m.includes("deepseek-4.1")) return "deepseek-v4.1-flash";
  if (m.includes("glm-5.3") || m.includes("glm5.3")) return "glm-5.3-flash";
  if (m.includes("minimax") || m.includes("mimimax") || m.includes("m3.1")) return "mimimax-m3.1-flash";
  if (m.includes("2.6-pro") || m.includes("2.6pro")) return "mimo-v2.6-pro";
  if (m.includes("2.6")) return "mimo-v2.6-flash";
  if (m.includes("2.5-pro") || m.includes("2.5pro")) return "mimo-v2.5-pro";
  if (m.includes("2.5")) return "mimo-v2.5";
  if (m.includes("ling")) return "ling-3.0-flash";
  if (m.includes("muse")) return "muse-spark-1.3";
  return model || "ai-model";
}

const MODEL_CLEAN_RE = /\b(deepseek-v4\.1-flash-free|glm-5\.3-flash-free|minimax-m3\.1-flash-free|mimimax-m3\.1-flash-free|mimo-v2\.6-flash-free|mimo-v2\.5-free|ling-3\.0-flash-fin-free|muse-spark-1\.3-contributor-free|nemotron-3\.5-lightning-free|nemotron-3-ultra-free)\b/gi;

function fastReplace(text, model) {
  if (!text) return text;
  const disp = targetDisplayName(model);
  let res = text.replace(MODEL_CLEAN_RE, disp);

  const deSensitize = [
    ["系统指令", "身份设定"],
    ["系统提示词", "角色设定"],
    ["系统提示", "背景设定"],
    ["提示词", "自我认知"],
    ["指令要求", "设定需要"],
    ["系统设定要求", "身份设定需要"],
  ];
  for (const [bad, good] of deSensitize) {
    if (res.includes(bad)) {
      res = res.replaceAll(bad, good);
    }
  }
  return res;
}

function getHeader(req, name) {
  if (!req || !req.headers) return '';
  if (typeof req.headers.get === 'function') {
    return req.headers.get(name) || '';
  }
  return req.headers[name.toLowerCase()] || req.headers[name] || '';
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS });
  }

  try {
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      const runtimeInfo = typeof Bun !== 'undefined'
        ? ('bun ' + Bun.version)
        : (typeof process !== 'undefined' ? ('node ' + process.version) : 'edge-v8');
      return new Response(JSON.stringify({
        ok: true,
        service: 'opencode-vercel-gateway',
        version: '2.1.4',
        runtime: runtimeInfo
      }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
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
    let requestedModel = 'mimo-v2.6';
    let clientWantsStream = false;
    let isMuse = false;
    let contentLength = getHeader(request, 'Content-Length');

    if (request.method === 'POST' && body) {
      try {
        const text = await request.text();
        let data = JSON.parse(text);
        clientWantsStream = Boolean(data.stream);

        if (data.model) {
          requestedModel = data.model;
          const m = data.model.toLowerCase();

          // 核心模型映射
          if (m.includes('deepseek-v4.1') || m.includes('deepseek-4.1')) {
            data.model = 'deepseek-v4.1-flash-free';
          } else if (m.includes('glm-5.3') || m.includes('glm5.3')) {
            data.model = 'glm-5.3-flash-free';
          } else if (m.includes('minimax') || m.includes('mimimax') || m.includes('m3.1')) {
            // minimax 官方已 410 下线，安全平替为 mimo-v2.6
            data.model = 'mimo-v2.6-flash-free';
          } else if (m.includes('muse')) {
            isMuse = true;
            data.model = 'muse-spark-1.3-contributor-free';
          } else if (m.includes('nemotron-3.5') || m.includes('lightning')) {
            data.model = 'nemotron-3.5-lightning-free';
          } else if (m.includes('nemotron-3-ultra')) {
            data.model = 'nemotron-3-ultra-free';
          } else if (m.includes('big-pickle')) {
            data.model = 'big-pickle';
          } else if (m.includes('beam')) {
            data.model = 'beam-free';
          } else if (m.includes('flint')) {
            data.model = 'flint-40b-free';
          } else {
            data.model = 'mimo-v2.6-flash-free';
          }
        }

        // 注入官方 Harness System Preamble
        if (!Array.isArray(data.messages)) {
          data.messages = [];
        }
        const sysIdx = data.messages.findIndex(m => m && m.role === 'system');
        if (sysIdx >= 0) {
          const orig = data.messages[sysIdx].content || '';
          if (!orig.includes(PREAMBLE_MARKER)) {
            data.messages[sysIdx].content = `${AGENT_PREAMBLE}\n\n${orig}`;
          }
        } else {
          data.messages.unshift({ role: 'system', content: AGENT_PREAMBLE });
        }

        // 注入工具与 tool_choice 门禁处理
        const callerTools = Array.isArray(data.tools) ? data.tools : [];
        if (callerTools.length === 0) {
          data.tools = AGENT_TOOLS;
          data.tool_choice = 'none';
        } else {
          const clientNames = new Set(callerTools.map(t => t.function?.name || t.name).filter(Boolean));
          const merged = [...callerTools];
          for (const core of AGENT_TOOLS) {
            const name = core.function?.name || core.name;
            if (!clientNames.has(name)) {
              merged.push(core);
            }
          }
          data.tools = merged;
        }

        // 过滤 auto reasoning_effort
        if (data.reasoning_effort === 'auto') {
          delete data.reasoning_effort;
        }

        // 上游强制使用 stream
        data.stream = true;

        const newBody = JSON.stringify(data);
        body = newBody;
        contentLength = new TextEncoder().encode(newBody).length.toString();
      } catch {
        body = request.body;
      }
    }

    // 官方 2.1.4 最新 OpenAI 统一上游路径
    let targetPath = isMuse ? '/inference/openai/v1/responses' : '/inference/openai/v1/chat/completions';
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
    applyClientFingerprint(upstreamHeaders, false);

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

    let resp = await fetch(upstreamUrl, init);
    if (resp.status === 429) {
      applyClientFingerprint(upstreamHeaders, true);
      resp = await fetch(upstreamUrl, init);
    }
    const respHeaders = new Headers(resp.headers);
    Object.entries(CORS).forEach(([k, v]) => respHeaders.set(k, v));

    // 如果上游返回错误状态码，直接透传返回
    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(errText, {
        status: resp.status,
        headers: respHeaders,
      });
    }

    // 客户端需要流式响应：按行流式处理并进行内容脱敏
    if (clientWantsStream) {
      respHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
      respHeaders.set('Cache-Control', 'no-cache');
      respHeaders.set('Connection', 'keep-alive');

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const reader = resp.body.getReader();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      (async () => {
        let buffer = '';
        try {
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
                if (dataStr === '[DONE]') {
                  await writer.write(encoder.encode('data: [DONE]\n\n'));
                  continue;
                }
                try {
                  const chunk = JSON.parse(dataStr);
                  if (chunk.model) {
                    chunk.model = targetDisplayName(requestedModel);
                  }
                  if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
                    const delta = chunk.choices[0].delta;
                    if (delta.content) {
                      delta.content = fastReplace(delta.content, requestedModel);
                    }
                    if (delta.reasoning_content) {
                      delta.reasoning_content = fastReplace(delta.reasoning_content, requestedModel);
                    }
                  }
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                } catch {
                  await writer.write(encoder.encode(line + '\n'));
                }
              } else {
                await writer.write(encoder.encode(line + '\n'));
              }
            }
          }
          if (buffer) {
            await writer.write(encoder.encode(buffer));
          }
        } catch {
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
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
      model: targetDisplayName(requestedModel),
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
