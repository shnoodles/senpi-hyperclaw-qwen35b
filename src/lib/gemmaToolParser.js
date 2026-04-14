/**
 * Gemma 4 Tool-Call Parser Proxy
 *
 * Sits between OpenClaw and the upstream OpenAI-compatible LLM endpoint.
 *
 * TWO-WAY CONVERSION:
 *
 * REQUEST direction (OpenAI tools → Gemma 4 native prompt):
 *   Takes the `tools` array from the OpenAI request and injects them into
 *   the system message using Gemma 4's native tool format. This is necessary
 *   because the upstream vLLM doesn't have --enable-auto-tool-choice
 *   --tool-call-parser gemma4 flags, so it ignores the `tools` array.
 *
 * RESPONSE direction (Gemma 4 native tool calls → OpenAI tool_calls):
 *   Detects Gemma 4's native tool-call tokens in message.content and converts
 *   them into standard OpenAI tool_calls objects.
 *
 * Gemma 4 tool-call format:
 *   <|tool_call|>call:function_name{key1:<|"|>string_val<|"|>,key2:123}<tool_call|>
 *
 * This proxy converts that into:
 *   message.tool_calls = [{ id: "call_xxx", type: "function", function: { name, arguments } }]
 *   message.content = (text before/after tool calls, or null)
 *   finish_reason = "tool_calls"
 */

import http from "node:http";
import crypto from "node:crypto";

const GEMMA_PROXY_PORT = parseInt(process.env.GEMMA_PROXY_PORT || "7299", 10);

let server = null;

// ─── Gemma 4 token patterns ────────────────────────────────────────────────

const TOOL_CALL_RE = /<\|tool_call\|?>call:([^{]+)\{(.*?)\}<\|?tool_call\|>/gs;

/**
 * Parse Gemma 4's custom argument format into a JSON object.
 *
 * Input:  location:<|"|>London<|"|>,unit:<|"|>celsius<|"|>,count:5
 * Output: { location: "London", unit: "celsius", count: 5 }
 *
 * Also handles standard JSON arguments as fallback (some vLLM versions
 * may return JSON instead of the native format).
 */
function parseGemmaArgs(raw) {
  if (!raw || !raw.trim()) return {};

  // Try standard JSON first (some configurations return JSON args)
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to custom parser
    }
  }

  // Also try wrapping in braces for bare JSON-like content
  try {
    return JSON.parse(`{${trimmed}}`);
  } catch {
    // fall through to custom parser
  }

  const result = {};
  // Replace <|"|> with a placeholder to simplify parsing
  const PLACEHOLDER = "\x00";
  const normalized = raw.replace(/<\|"\|>/g, PLACEHOLDER);

  let i = 0;
  while (i < normalized.length) {
    // Skip whitespace and commas
    while (i < normalized.length && (normalized[i] === "," || normalized[i] === " ")) i++;
    if (i >= normalized.length) break;

    // Read key (until : or end)
    let keyEnd = normalized.indexOf(":", i);
    if (keyEnd === -1) break;
    const key = normalized.slice(i, keyEnd).trim();
    i = keyEnd + 1;

    // Read value
    if (i < normalized.length && normalized[i] === PLACEHOLDER) {
      // String value: read until next placeholder
      i++; // skip opening placeholder
      let valEnd = normalized.indexOf(PLACEHOLDER, i);
      if (valEnd === -1) valEnd = normalized.length;
      result[key] = normalized.slice(i, valEnd);
      i = valEnd + 1;
    } else if (i < normalized.length && normalized[i] === "[") {
      // Array value: find matching bracket
      let depth = 0;
      let start = i;
      while (i < normalized.length) {
        if (normalized[i] === "[") depth++;
        if (normalized[i] === "]") depth--;
        i++;
        if (depth === 0) break;
      }
      const arrStr = normalized.slice(start, i).replace(new RegExp(PLACEHOLDER, "g"), '"');
      try {
        result[key] = JSON.parse(arrStr);
      } catch {
        result[key] = arrStr;
      }
    } else if (i < normalized.length && normalized[i] === "{") {
      // Nested object: find matching brace
      let depth = 0;
      let start = i;
      while (i < normalized.length) {
        if (normalized[i] === "{") depth++;
        if (normalized[i] === "}") depth--;
        i++;
        if (depth === 0) break;
      }
      const objStr = normalized.slice(start, i).replace(new RegExp(PLACEHOLDER, "g"), '"');
      try {
        result[key] = JSON.parse(objStr);
      } catch {
        result[key] = objStr;
      }
    } else {
      // Bare value (number, boolean, etc.): read until comma or end
      let valEnd = normalized.indexOf(",", i);
      if (valEnd === -1) valEnd = normalized.length;
      const valStr = normalized.slice(i, valEnd).trim();
      i = valEnd;

      // Try to parse as number or boolean
      if (valStr === "true") result[key] = true;
      else if (valStr === "false") result[key] = false;
      else if (valStr === "null") result[key] = null;
      else if (!isNaN(Number(valStr)) && valStr !== "") result[key] = Number(valStr);
      else result[key] = valStr;
    }
  }

  return result;
}

/**
 * Extract Gemma 4 tool calls from message content.
 * Returns { toolCalls, remainingContent } or null if no tool calls found.
 */
function extractToolCalls(content) {
  if (!content || typeof content !== "string") return null;
  if (!content.includes("<|tool_call") && !content.includes("tool_call|>")) return null;

  const toolCalls = [];
  let remaining = content;

  // Reset regex state
  TOOL_CALL_RE.lastIndex = 0;

  let match;
  while ((match = TOOL_CALL_RE.exec(content)) !== null) {
    const funcName = match[1].trim();
    const argsRaw = match[2];
    const args = parseGemmaArgs(argsRaw);

    toolCalls.push({
      id: `call_${crypto.randomBytes(12).toString("hex")}`,
      type: "function",
      function: {
        name: funcName,
        arguments: JSON.stringify(args),
      },
    });
  }

  if (toolCalls.length === 0) {
    // Try alternative format: some versions use slightly different delimiters
    // <|tool_call>call:name{args}<tool_call|>  (no pipe in opening, pipe in closing)
    const ALT_RE = /<\|tool_call>call:([^{]+)\{(.*?)\}<tool_call\|>/gs;
    let altMatch;
    while ((altMatch = ALT_RE.exec(content)) !== null) {
      const funcName = altMatch[1].trim();
      const argsRaw = altMatch[2];
      const args = parseGemmaArgs(argsRaw);

      toolCalls.push({
        id: `call_${crypto.randomBytes(12).toString("hex")}`,
        type: "function",
        function: {
          name: funcName,
          arguments: JSON.stringify(args),
        },
      });
    }
  }

  if (toolCalls.length === 0) return null;

  // Remove tool call tokens from content
  remaining = content
    .replace(/<\|tool_call\|?>call:[^{]+\{.*?\}<\|?tool_call\|>/gs, "")
    .trim();

  return { toolCalls, remainingContent: remaining || null };
}

/**
 * Process a chat completion response — detect and convert Gemma 4 tool calls.
 */
function processResponse(responseBody) {
  if (!responseBody?.choices) return responseBody;

  let modified = false;

  for (const choice of responseBody.choices) {
    if (!choice?.message?.content) continue;

    const result = extractToolCalls(choice.message.content);
    if (!result) continue;

    console.log(
      `[gemma-tool-parser] Extracted ${result.toolCalls.length} tool call(s): ${result.toolCalls.map((t) => t.function.name).join(", ")}`
    );

    choice.message.tool_calls = result.toolCalls;
    choice.message.content = result.remainingContent;
    choice.finish_reason = "tool_calls";
    modified = true;
  }

  if (modified) {
    console.log("[gemma-tool-parser] Response rewritten with tool_calls");
  }

  return responseBody;
}

// ─── REQUEST direction: Inject tools into Gemma 4 native prompt format ──────

/**
 * Convert an OpenAI JSON schema property to a human-readable description.
 */
function describeParam(name, schema, required) {
  const type = schema.type || "any";
  const desc = schema.description ? ` — ${schema.description}` : "";
  const req = required ? " (required)" : " (optional)";
  const enumVals = schema.enum ? ` [one of: ${schema.enum.join(", ")}]` : "";
  return `  - ${name} (${type}${req})${enumVals}${desc}`;
}

/**
 * Convert OpenAI tools array into Gemma 4's native tool-use prompt text.
 *
 * The format follows what vLLM's gemma4 tool parser uses when
 * --enable-auto-tool-choice --tool-call-parser gemma4 is set.
 * We replicate it here client-side since the upstream vLLM lacks those flags.
 */
function toolsToGemmaPrompt(tools) {
  if (!tools || tools.length === 0) return "";

  const lines = [
    "You have access to the following tools. To call a tool, use this exact format:",
    "",
    "<|tool_call|>call:TOOL_NAME{param1:<|\"|>string_value<|\"|>,param2:number_value}<tool_call|>",
    "",
    "For string values, always wrap them with <|\"|> delimiters. For numbers, booleans, and null, use bare values.",
    "You can call multiple tools in one response. Always use tools when the user asks for real-time data, to execute actions, or to read/write files.",
    "",
    "Available tools:",
    "",
  ];

  for (const tool of tools) {
    const fn = tool.function || tool;
    if (!fn.name) continue;

    lines.push(`Tool: ${fn.name}`);
    if (fn.description) {
      lines.push(`Description: ${fn.description}`);
    }

    const params = fn.parameters;
    if (params && params.properties) {
      const required = new Set(params.required || []);
      lines.push("Parameters:");
      for (const [pName, pSchema] of Object.entries(params.properties)) {
        lines.push(describeParam(pName, pSchema, required.has(pName)));
      }
    }
    lines.push("");
  }

  // Add tool_result format explanation so model knows how to handle responses
  lines.push("When you receive a tool result, it will be in the format:");
  lines.push("<|tool_result|>result_content<tool_result|>");
  lines.push("");
  lines.push("IMPORTANT: You MUST use tools to answer questions about real-time data, files, or system state. Do NOT hallucinate or make up data. If you need information, call the appropriate tool first.");
  lines.push("");

  return lines.join("\n");
}

/**
 * Convert tool_call messages in the conversation history to Gemma 4 native format,
 * and convert tool result messages to the expected format.
 */
function convertMessagesForGemma(messages, tools) {
  if (!messages || !Array.isArray(messages)) return messages;

  const toolPrompt = toolsToGemmaPrompt(tools);
  const converted = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = { ...messages[i] };

    // Inject tool definitions into the system message
    if (msg.role === "system" && i === 0 && toolPrompt) {
      msg.content = (msg.content || "") + "\n\n" + toolPrompt;
      converted.push(msg);
      continue;
    }

    // Convert assistant messages with tool_calls to Gemma 4 native format
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      let content = msg.content || "";
      for (const tc of msg.tool_calls) {
        const fn = tc.function;
        if (!fn) continue;
        let argsStr = "";
        try {
          const args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
          const parts = [];
          for (const [k, v] of Object.entries(args || {})) {
            if (typeof v === "string") {
              parts.push(`${k}:<|"|>${v}<|"|>`);
            } else {
              parts.push(`${k}:${JSON.stringify(v)}`);
            }
          }
          argsStr = parts.join(",");
        } catch {
          argsStr = fn.arguments || "";
        }
        content += `\n<|tool_call|>call:${fn.name}{${argsStr}}<tool_call|>`;
      }
      converted.push({ role: "assistant", content: content.trim() });
      continue;
    }

    // Convert tool result messages to Gemma 4 format
    if (msg.role === "tool") {
      const toolContent = msg.content || "";
      // Gemma 4 expects tool results as a user message with special formatting
      converted.push({
        role: "user",
        content: `<|tool_result|>${toolContent}<tool_result|>`,
      });
      continue;
    }

    converted.push(msg);
  }

  // If there was no system message but we have tools, prepend one
  if (toolPrompt && (converted.length === 0 || converted[0].role !== "system")) {
    converted.unshift({ role: "system", content: toolPrompt });
  }

  return converted;
}

/**
 * Convert a non-streaming response to SSE format.
 */
function completionToSSE(completion) {
  const chunk = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: (completion.choices || []).map((c) => ({
      index: c.index,
      delta: {
        role: c.message?.role,
        content: c.message?.content || "",
        ...(c.message?.tool_calls ? { tool_calls: c.message.tool_calls } : {}),
      },
      finish_reason: c.finish_reason,
    })),
    ...(completion.usage ? { usage: completion.usage } : {}),
  };

  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

/**
 * Start the Gemma tool-parser proxy.
 * @param {string} upstreamBaseUrl - The upstream OpenAI-compatible base URL (e.g. vertex-openai-proxy)
 * @param {string} upstreamApiKey  - API key for the upstream
 */
export function startGemmaToolParser(upstreamBaseUrl, upstreamApiKey) {
  // Strip trailing /v1 if present — we'll add paths ourselves
  const upstream = upstreamBaseUrl.replace(/\/v1\/?$/, "");

  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url || "";
      console.log(`[gemma-tool-parser] ${req.method} ${url}`);

      // GET /v1/models — passthrough
      if (req.method === "GET" && url.includes("/models")) {
        try {
          const upRes = await fetch(`${upstream}/v1/models`, {
            headers: {
              Authorization: `Bearer ${upstreamApiKey}`,
            },
          });
          const body = await upRes.text();
          res.writeHead(upRes.status, { "Content-Type": "application/json" });
          res.end(body);
        } catch (err) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: { message: err.message } }));
        }
        return;
      }

      // POST /v1/chat/completions — intercept BOTH request and response
      if (req.method === "POST" && (url.includes("/chat/completions") || url === "/")) {
        let body = "";
        for await (const chunk of req) body += chunk;

        try {
          const openaiReq = JSON.parse(body);
          const wantsStream = !!openaiReq.stream;

          // Force non-streaming to upstream so we can parse the full response
          openaiReq.stream = false;
          delete openaiReq.stream_options;

          // ── REQUEST CONVERSION ──────────────────────────────────────
          // Convert OpenAI tools to Gemma 4 native prompt format
          const tools = openaiReq.tools || [];
          const toolCount = tools.length;

          if (toolCount > 0) {
            console.log(
              `[gemma-tool-parser] → Converting ${toolCount} tools to Gemma native prompt: ${tools.map((t) => t?.function?.name).join(", ")}`
            );

            // Convert messages to include tool definitions in system prompt
            // and convert tool_call/tool_result messages to native format
            openaiReq.messages = convertMessagesForGemma(openaiReq.messages, tools);

            // Remove the tools array — upstream vLLM doesn't handle it
            delete openaiReq.tools;
            delete openaiReq.tool_choice;
          }

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 120000);

          const upRes = await fetch(`${upstream}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${upstreamApiKey}`,
            },
            body: JSON.stringify(openaiReq),
            signal: controller.signal,
          });
          clearTimeout(timeout);

          const upText = await upRes.text();
          if (!upRes.ok) {
            console.error(`[gemma-tool-parser] upstream error ${upRes.status}: ${upText.slice(0, 500)}`);
            res.writeHead(upRes.status, { "Content-Type": "application/json" });
            res.end(upText);
            return;
          }

          let result = JSON.parse(upText);

          // ── RESPONSE CONVERSION ─────────────────────────────────────
          // Parse Gemma 4 tool calls from content
          result = processResponse(result);

          if (wantsStream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.end(completionToSSE(result));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          }
        } catch (err) {
          console.error(`[gemma-tool-parser] Error: ${err.message}`);
          res.writeHead(502);
          res.end(
            JSON.stringify({
              error: { message: err.message, type: "proxy_error", code: 502 },
            })
          );
        }
        return;
      }

      // Catch-all passthrough
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found", path: url }));
    });

    server.listen(GEMMA_PROXY_PORT, "127.0.0.1", () => {
      const baseUrl = `http://127.0.0.1:${GEMMA_PROXY_PORT}/v1`;
      console.log(`[gemma-tool-parser] Listening on ${baseUrl}`);
      console.log(`[gemma-tool-parser] Upstream: ${upstream}/v1`);
      resolve(baseUrl);
    });

    server.on("error", (err) => {
      console.error(`[gemma-tool-parser] Server error: ${err.message}`);
      reject(err);
    });
  });
}

export function stopGemmaToolParser() {
  if (server) {
    server.close();
    server = null;
    console.log("[gemma-tool-parser] Stopped");
  }
}

// Export parser for testing
export { extractToolCalls, parseGemmaArgs, toolsToGemmaPrompt, convertMessagesForGemma };
