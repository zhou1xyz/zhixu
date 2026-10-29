/**
 * modelAdapter —— 模型适配层（P1-03d-A）
 *
 * 统一接口：chat({ messages, tools }) → { content, toolCalls, usage }。
 * 首版实现：DashScope OpenAI 兼容模式，原生 fetch，零依赖。
 * 密钥只从环境变量读取；未配置时 isConfigured()=false，不抛错。
 * 可注入 fetchImpl / 配置，便于测试（不触网）。
 *
 * 错误归一化（error_kind 闭集，与 agent 表 CHECK 一致）：
 *   auth_invalid  密钥未配置/上游 401/403
 *   timeout       超时或中断
 *   model_error   上游其他 HTTP 错误
 *   bad_response  响应不可解析/结构不符
 */
import { readFileSync } from 'node:fs';

export function isConfigured(env = process.env) {
  return Boolean(env.AGENT_MODEL_KEY);
}

export function loadEnvFile(path) {
  // 读取 server/.env.agent（KEY=VALUE 每行），仅返回解析对象；文件不存在返回空
  try {
    const out = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

export function createModelAdapter(options = {}) {
  const env = options.env ?? { ...process.env, ...options.fileEnv };
  const apiKey = options.apiKey ?? env.AGENT_MODEL_KEY;
  const model = options.modelName ?? env.AGENT_MODEL_NAME ?? 'qwen-max';
  const baseUrl = options.baseUrl ?? env.AGENT_MODEL_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const timeoutMs = options.timeoutMs ?? 30000;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    /** 供测试与运行时判断 */
    isConfigured: () => Boolean(apiKey),
    model,
    /**
     * 发起一次模型调用。
     * 返回 { ok:true, content, toolCalls, usage } 或 { ok:false, error_kind, error }。
     * 永不抛错（网络层异常也归一化）。
     */
    async chat({ messages, tools }) {
      if (!apiKey) {
        return { ok: false, error_kind: 'auth_invalid', error: '模型密钥未配置' };
      }
      const body = {
        model,
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp;
      try {
        resp = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const isAbort = e?.name === 'AbortError' || /abort/i.test(String(e?.message));
        return { ok: false, error_kind: isAbort ? 'timeout' : 'model_error', error: String(e?.message ?? e).slice(0, 500) };
      }
      clearTimeout(timer);

      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          return { ok: false, error_kind: 'auth_invalid', error: `上游鉴权失败：HTTP ${resp.status}` };
        }
        const text = await resp.text().catch(() => '');
        return { ok: false, error_kind: 'model_error', error: `上游 HTTP ${resp.status}: ${text.slice(0, 300)}` };
      }

      let data;
      try {
        data = await resp.json();
      } catch {
        return { ok: false, error_kind: 'bad_response', error: '响应不是合法 JSON' };
      }
      const choice = data?.choices?.[0];
      if (!choice || typeof choice !== 'object') {
        return { ok: false, error_kind: 'bad_response', error: '响应缺少 choices[0]' };
      }
      const message = choice.message ?? {};
      const rawTools = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const toolCalls = [];
      for (const tc of rawTools) {
        if (tc?.type !== 'function' || typeof tc?.function?.name !== 'string') {
          return { ok: false, error_kind: 'bad_response', error: 'tool_calls 结构不符' };
        }
        let args;
        try {
          args = JSON.parse(tc.function.arguments ?? '{}');
        } catch {
          return { ok: false, error_kind: 'bad_response', error: `tool_calls 参数不是合法 JSON：${tc.function.name}` };
        }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) {
          return { ok: false, error_kind: 'bad_response', error: `tool_calls 参数必须是对象：${tc.function.name}` };
        }
        toolCalls.push({ id: typeof tc.id === 'string' ? tc.id : undefined, name: tc.function.name, arguments: args });
      }
      const u = data.usage ?? {};
      const usage = {
        prompt_tokens: Number(u.prompt_tokens ?? 0),
        completion_tokens: Number(u.completion_tokens ?? 0),
        total_tokens: Number(u.total_tokens ?? 0),
      };
      return {
        ok: true,
        content: typeof message.content === 'string' ? message.content : '',
        toolCalls,
        usage,
      };
    },
  };
}
