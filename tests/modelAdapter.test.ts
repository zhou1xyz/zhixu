/**
 * P1-03d-A：模型适配器测试（注入 mock fetch，不触网）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelAdapter } from '../server/agent/modelAdapter.js';

function okResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => '' };
}
const goodData = {
  choices: [{ message: { content: '好的', tool_calls: [
    { type: 'function', id: 'c1', function: { name: 'query_tasks', arguments: '{"limit":3}' } },
  ] } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

test('正常响应：content/toolCalls/usage 解析', async () => {
  const adapter = createModelAdapter({ apiKey: 'k', fetchImpl: async () => okResponse(goodData) as never });
  const r = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.content, '好的');
    assert.equal(r.toolCalls[0].name, 'query_tasks');
    assert.deepEqual(r.toolCalls[0].arguments, { limit: 3 });
    assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  }
});
test('缺少密钥：auth_invalid，不触网', async () => {
  const adapter = createModelAdapter({ apiKey: undefined, fetchImpl: async () => { throw new Error('不应触网'); } });
  const r = await adapter.chat({ messages: [] });
  assert.deepEqual({ ok: r.ok, error_kind: (r as { error_kind?: string }).error_kind }, { ok: false, error_kind: 'auth_invalid' });
});
test('上游 401/500/坏 JSON 错误归一化', async () => {
  const a = createModelAdapter({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }) as never });
  assert.equal((await a.chat({ messages: [] })).error_kind, 'auth_invalid');
  const b = createModelAdapter({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'oops' }) as never });
  assert.equal((await b.chat({ messages: [] })).error_kind, 'model_error');
  const c = createModelAdapter({ apiKey: 'k', fetchImpl: async () => okResponse('not-json') as never });
  assert.equal((await c.chat({ messages: [] })).error_kind, 'bad_response');
  const badTc = { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'x', arguments: 'not-json' } }] } }] };
  const d = createModelAdapter({ apiKey: 'k', fetchImpl: async () => okResponse(badTc) as never });
  assert.equal((await d.chat({ messages: [] })).error_kind, 'bad_response');
});
test('超时：中断映射为 timeout', async () => {
  const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const adapter = createModelAdapter({ apiKey: 'k', timeoutMs: 20, fetchImpl: async (_u, init) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(abortErr));
    });
  } });
  const r = await adapter.chat({ messages: [] });
  assert.equal(r.error_kind, 'timeout');
});
