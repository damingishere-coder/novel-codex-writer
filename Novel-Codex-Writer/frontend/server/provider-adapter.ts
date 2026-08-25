import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { ApiError } from "./file-storage.ts";
import { getErrorMessage, HttpError } from "./http-error.ts";
import { parseReviewReply } from "./review-utils.ts";
import type { ReviewProvider } from "./review-provider.ts";
import { observeOperation } from "./observability.ts";
import { terminateProcessTree } from "./process-tree.ts";
import type { AiEngine, ReasoningEffort } from "../shared/api-contract.ts";

interface ProviderSettings {
  reasoningEffort: ReasoningEffort;
}

type SecretName = "DEEPSEEK_API_KEY" | "CODEX_API_KEY" | "OPENAI_API_KEY";

interface ProviderAdapterOptions {
  deepSeekModel: string;
  maxOutputBytes: number;
  suggestionSchemaFile: string;
  getRuntimeSecret(name: SecretName): Promise<string>;
  getCodexBin(): string;
  getCodexAuthFile(): string;
}

export function createProviderAdapter(options: ProviderAdapterOptions) {
  const { deepSeekModel, maxOutputBytes, suggestionSchemaFile, getRuntimeSecret, getCodexBin, getCodexAuthFile } = options;

  function createReviewProvider(engine: AiEngine, projectRoot: string, settings: ProviderSettings): ReviewProvider {
    if (engine === "codex") {
      return {
        engine,
        model: "codex-cli",
        requestReply: ({ combined, expectedBefore, signal }) => observeOperation(
          "provider",
          { characters: combined.length },
          () => requestCodexReviewReply(combined, projectRoot, settings, expectedBefore, signal)
        ),
        requestJson: ({ combined, schemaFile, signal }) => observeOperation(
          "provider",
          { characters: combined.length },
          () => requestCodexJson(combined, projectRoot, settings, schemaFile, signal)
        )
      };
    }
    return {
      engine,
      model: deepSeekModel,
      requestReply: ({ system, user, expectedBefore, signal }) => observeOperation(
        "provider",
        { characters: system.length + user.length },
        () => requestDeepSeekReviewReply(system, user, expectedBefore, signal)
      ),
      requestJson: ({ system, user, maxTokens, signal }) => observeOperation(
        "provider",
        { characters: system.length + user.length },
        () => requestDeepSeekJson(system, user, maxTokens, signal)
      )
    };
  }

  async function readProviderJson(
    response: Response,
    transportSignal: AbortSignal,
    clientSignal: AbortSignal,
    timeoutSignal: AbortSignal
  ): Promise<unknown> {
    if (!response.body) return {};
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (transportSignal.aborted) {
          if (clientSignal.aborted) throw new HttpError(499, "AI 响应读取已取消。", "AI_REQUEST_ABORTED");
          if (timeoutSignal.aborted) throw new HttpError(504, "AI 响应读取超时。", "PROVIDER_TIMEOUT");
        }
        bytes += value.byteLength;
        if (bytes > maxOutputBytes) {
          await reader.cancel();
          throw new HttpError(502, "AI 响应超过 1 MiB 安全上限，已停止读取。", "PROVIDER_OUTPUT_LIMIT");
        }
        chunks.push(Buffer.from(value));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      return text.trim() ? JSON.parse(text) : {};
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (clientSignal.aborted) throw new HttpError(499, "AI 响应读取已取消。", "AI_REQUEST_ABORTED");
      if (timeoutSignal.aborted) throw new HttpError(504, "AI 响应读取超时。", "PROVIDER_TIMEOUT");
      throw new HttpError(502, "AI 响应不是有效 JSON。", "PROVIDER_RESPONSE_INVALID");
    }
  }

  async function requestDeepSeekReviewReply(system: string, user: string, expectedBefore: string, signal: AbortSignal) {
    const value = await requestDeepSeekJson(system, user, 2_048, signal);
    const parsed = parseReviewReply(value, expectedBefore);
    if (!parsed) throw new HttpError(502, "DeepSeek 没有返回可读取的回答，请重试本轮问题。", "PROVIDER_RESPONSE_INVALID");
    return parsed;
  }

  async function requestDeepSeekJson(system: string, user: string, maxTokens: number, signal: AbortSignal) {
    const apiKey = await getRuntimeSecret("DEEPSEEK_API_KEY");
    if (!apiKey) throw new HttpError(503, "DeepSeek 未配置：请在 AI 设置中填写 API 密钥。");
    const timeoutSignal = AbortSignal.timeout(120_000);
    const providerSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: deepSeekModel,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          max_tokens: maxTokens,
          stream: false
        }),
        signal: providerSignal
      });
    } catch (error) {
      if (signal.aborted) throw new HttpError(499, "客户端已取消 DeepSeek 请求。", "AI_REQUEST_ABORTED");
      if (timeoutSignal.aborted) throw new HttpError(504, "DeepSeek 请求超时，已停止等待。", "PROVIDER_TIMEOUT");
      throw new HttpError(502, `DeepSeek 网络请求失败：${getErrorMessage(error)}`, "PROVIDER_FAILED");
    }
    const payload = await readProviderJson(response, providerSignal, signal, timeoutSignal);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new HttpError(502, "DeepSeek 响应顶层格式无效。", "PROVIDER_RESPONSE_INVALID");
    }
    const payloadRecord = payload as Record<string, unknown>;
    if (!response.ok) {
      const errorValue = payloadRecord.error;
      const detail = errorValue && typeof errorValue === "object" && !Array.isArray(errorValue) &&
        typeof (errorValue as Record<string, unknown>).message === "string"
        ? ((errorValue as Record<string, unknown>).message as string).slice(0, 240)
        : "";
      throw new HttpError(response.status === 401 ? 401 : 502, `DeepSeek 请求失败${detail ? `：${detail}` : `（状态码 ${response.status}）`}`, "PROVIDER_FAILED");
    }
    const choices = payloadRecord.choices;
    const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
    const message = firstChoice && typeof firstChoice === "object" && !Array.isArray(firstChoice)
      ? (firstChoice as Record<string, unknown>).message
      : undefined;
    const content = message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>).content
      : undefined;
    if (typeof content !== "string" || !content.trim()) {
      throw new HttpError(502, "DeepSeek 响应缺少有效 choices[0].message.content。", "PROVIDER_RESPONSE_INVALID");
    }
    return parseJsonText(content.trim());
  }

  async function requestCodexReviewReply(prompt: string, projectRoot: string, settings: ProviderSettings, expectedBefore: string, signal: AbortSignal) {
    const value = await requestCodexJson(prompt, projectRoot, settings, suggestionSchemaFile, signal);
    const parsed = parseReviewReply(value, expectedBefore);
    if (!parsed) throw new HttpError(502, "Codex 没有返回可读取的回答，请重试本轮问题。", "PROVIDER_RESPONSE_INVALID");
    return parsed;
  }

  async function requestCodexJson(prompt: string, projectRoot: string, settings: ProviderSettings, schemaFile: string, signal: AbortSignal) {
    const apiKey = await getRuntimeSecret("CODEX_API_KEY") || await getRuntimeSecret("OPENAI_API_KEY");
    const codexBin = getCodexBin();
    if (!apiKey && !existsSync(getCodexAuthFile())) throw new HttpError(503, "Codex 未登录：请先在本机 Codex App 中登录 ChatGPT，然后重启工作台。");
    if (!existsSync(codexBin)) throw new HttpError(503, "Codex CLI 未就绪，DeepSeek 和普通编辑仍可使用。");
    return parseLastJson(await runCodex(codexBin, projectRoot, prompt, settings.reasoningEffort, schemaFile, signal, apiKey));
  }

  function runCodex(codexBin: string, cwd: string, prompt: string, reasoningEffort: ReasoningEffort, schemaFile: string, signal: AbortSignal, apiKey?: string) {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const childEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "", HTTPS_PROXY: process.env.HTTPS_PROXY ?? "",
        HTTP_PROXY: process.env.HTTP_PROXY ?? "", NO_PROXY: process.env.NO_PROXY ?? ""
      };
      if (process.env.CODEX_HOME?.trim()) childEnv.CODEX_HOME = process.env.CODEX_HOME;
      if (apiKey) { childEnv.CODEX_API_KEY = apiKey; childEnv.OPENAI_API_KEY = apiKey; }
      const child = spawn(process.execPath,
        [codexBin, "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-c", `model_reasoning_effort="${reasoningEffort}"`, "--output-schema", schemaFile, "-"],
        { cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv, detached: process.platform !== "win32", windowsHide: true });
      let stdout = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let terminationError: Error | undefined;
      let terminationEscalation: NodeJS.Timeout | undefined;
      const finish = (error?: Error, output?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (terminationEscalation) clearTimeout(terminationEscalation);
        signal.removeEventListener("abort", onAbort);
        if (error) rejectPromise(error); else resolvePromise(output ?? "");
      };
      const terminate = (error: Error) => {
        if (settled || terminationError) return;
        terminationError = error;
        child.stdin.destroy();
        terminateProcessTree(child, "SIGTERM");
        terminationEscalation = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 2_000);
        terminationEscalation.unref();
      };
      const onAbort = () => terminate(new HttpError(499, "客户端已取消 Codex 审校，子进程已停止。", "AI_REQUEST_ABORTED"));
      const timeout = setTimeout(() => terminate(new HttpError(504, "Codex 审校超时，已安全停止；草稿没有被修改。", "PROVIDER_TIMEOUT")), 120_000);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > maxOutputBytes) { terminate(new HttpError(502, "Codex 输出超过 1 MiB 安全上限，已停止子进程。", "PROVIDER_OUTPUT_LIMIT")); return; }
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > maxOutputBytes) { terminate(new HttpError(502, "Codex 错误输出超过 1 MiB 安全上限，已停止子进程。", "PROVIDER_OUTPUT_LIMIT")); return; }
      });
      child.on("error", (error) => {
        const providerError = terminationError ?? new HttpError(503, `Codex 启动失败：${error.message}`, "PROVIDER_START_FAILED");
        if (child.pid && child.exitCode === null && child.signalCode === null) terminate(providerError);
        else finish(providerError);
      });
      child.on("close", (code) => terminationError
        ? finish(terminationError)
        : code === 0
          ? finish(undefined, stdout)
          : finish(new HttpError(502, `Codex 审校失败（退出码 ${code ?? "unknown"}）。`, "PROVIDER_FAILED")));
      child.stdin.on("error", () => {
        if (!terminationError) terminate(new HttpError(502, "Codex 输入管道提前关闭。", "PROVIDER_FAILED"));
      });
      if (!settled) {
        try {
          child.stdin.end(prompt);
        } catch {
          terminate(new HttpError(502, "Codex 输入管道提前关闭。", "PROVIDER_FAILED"));
        }
      }
    });
  }

  return { createReviewProvider };
}

export function parseLastJson(output: string) {
  const trimmed = output.trim();
  try { return JSON.parse(trimmed); }
  catch {
    const candidates: Array<{ start: number; end: number; value: unknown }> = [];
    const stack: Array<{ character: string; start: number }> = [];
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < trimmed.length; index += 1) {
      const character = trimmed[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") quoted = false;
        else if (character === "\n" || character === "\r") {
          // Literal newlines cannot occur inside valid JSON strings; recover from noisy unmatched logs.
          quoted = false;
          escaped = false;
          stack.length = 0;
        }
        continue;
      }
      if (character === "\"" && stack.length) { quoted = true; continue; }
      if (character === "{" || character === "[") { stack.push({ character, start: index }); continue; }
      if (character !== "}" && character !== "]") continue;
      const opening = stack.pop();
      if (!opening || (opening.character === "{" && character !== "}") || (opening.character === "[" && character !== "]")) {
        stack.length = 0;
        continue;
      }
      const lineStart = trimmed.lastIndexOf("\n", opening.start - 1) + 1;
      const startsValueLine = trimmed.slice(lineStart, opening.start).trim() === "";
      if (stack.length === 0 || startsValueLine) {
        try { candidates.push({ start: opening.start, end: index, value: JSON.parse(trimmed.slice(opening.start, index + 1)) }); }
        catch { /* Continue looking for the next complete JSON value. */ }
      }
    }
    if (candidates.length) return candidates.sort((left, right) => right.end - left.end || left.start - right.start)[0].value;
    throw new HttpError(502, "Codex 没有返回有效的结构化结果。", "PROVIDER_RESPONSE_INVALID");
  }
}

export function parseJsonText(output: string) {
  const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); }
  catch { throw new HttpError(502, "AI 没有返回有效的 JSON 结果。", "PROVIDER_RESPONSE_INVALID"); }
}

export function createMockReviewReply(before: string) {
  const after = before.replace(/非常/g, "格外").replace(/说道/g, "说");
  const changed = after !== before;
  return {
    reply: changed ? "我压缩了重复措辞，使句子更自然。" : "原文已经足够自然，可以保留。",
    suggestion: {
      decision: changed ? "change" as const : "keep" as const,
      severity: "S4" as const,
      category: "language" as const,
      before,
      after,
      rationale: changed ? "模拟审校：压缩重复措辞，使句子更自然；未改变剧情事实。" : "模拟审校：原文已足够自然，建议保留。"
    }
  };
}
