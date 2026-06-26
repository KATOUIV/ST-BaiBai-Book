import { getContext } from '@/st/context';
import type { ApiChannel } from './settings';

/**
 * 通过 SillyTavern 的服务端代理调用任意 OpenAI 兼容端点。
 *
 * 关键:以 chat_completion_source='openai' + reverse_proxy(base url)+ proxy_password(key)
 * 走 /api/backends/chat-completions/generate。请求由 ST 服务端转发,
 * 因此没有浏览器 CORS 问题,也无需把密钥存进 ST 的 secrets。
 */

const GENERATE_URL = '/api/backends/chat-completions/generate';

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiError extends Error {}

/** 规范化 base url:确保以 /v1 结尾(多数 OpenAI 兼容服务需要) */
function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (!/\/v\d+$/.test(u) && !/\/chat\/completions$/.test(u)) {
    u += '/v1';
  }
  // 端点期望 base(不含 /chat/completions),去掉它
  u = u.replace(/\/chat\/completions$/, '');
  return u;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * 发起一次补全请求,返回文本内容。
 */
export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url || !channel.model) throw new ApiError('副 API 渠道未配置完整(缺 url 或 model)');

  const stream = channel.stream ?? false;
  const body: Record<string, unknown> = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 1.0,
    max_tokens: channel.maxTokens ?? 8192,
    stream,
    // 静默:不影响主对话状态
    presence_penalty: 0,
    frequency_penalty: 0,
  };

  // 排除参数:把用户指定的字段从 body 删掉,规避不接受这些参数的兼容端点报错。
  // 注:固定路由字段(chat_completion_source/reverse_proxy 等)不应被删,但全凭用户填写,
  // 这里只做忠实剔除——文案会提示填采样参数名(temperature/max_tokens/...)。
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }

  const resp = await fetch(GENERATE_URL, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new ApiError(`副 API 请求失败 (${resp.status}): ${text.slice(0, 300)}`);
  }

  // 流式:按 SSE 增量拼接;非流式:直接解析 JSON。
  if (stream) {
    const content = await readSseContent(resp);
    if (!content) throw new ApiError('副 API 返回空内容');
    return content;
  }

  const data = await resp.json();
  if (data?.error) {
    throw new ApiError(data.error.message || '副 API 返回错误');
  }

  const content = extractContent(data);
  if (!content) throw new ApiError('副 API 返回空内容');
  return content;
}

/**
 * 读取 SSE 流(text/event-stream),拼接 delta.content。
 * ST 的 generate 端点在 stream=true 时透传上游 SSE:每行 `data: {json}`,以 `data: [DONE]` 结束。
 */
async function readSseContent(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // 无法流式读取(理论上不会):退回当作整体 JSON 处理
    const data = await resp.json().catch(() => null);
    return data ? extractContent(data) : '';
  }
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // 按行解析,保留最后一段不完整的行到下次
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json?.error) throw new ApiError(json.error.message || '副 API 返回错误');
        const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text;
        if (typeof delta === 'string') out += delta;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // 单行解析失败忽略(可能是注释行/心跳)
      }
    }
  }
  return out.trim();
}

/** 从标准 OpenAI 响应体提取文本 */
function extractContent(data: any): string {
  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.content ??
    ''
  ).trim();
}

/* ============ 跟随主 API(当前连接档) ============ */

/** 不走预设时给摘要/总结用的固定采样参数(预设里的 temperature 等被 includePreset:false 跳过,这里补默认值) */
const MAIN_API_TEMPERATURE = 1.0;
const MAIN_API_MAX_TOKENS = 8192;

/** ST 连接管理当前选中的连接档 id;没有连接管理 / 未选档时返回 null。 */
export function selectedProfileId(): string | null {
  const cm = (getContext()?.extensionSettings?.connectionManager ?? null) as
    | { selectedProfile?: string | null }
    | null;
  const id = cm?.selectedProfile;
  return typeof id === 'string' && id ? id : null;
}

/** 是否具备「跟随主 API」的条件(连接管理可用且已选中一个连接档)。设置页/引擎据此判断空指派能否回退。 */
export function mainApiAvailable(): boolean {
  return typeof getContext()?.ConnectionManagerRequestService?.sendRequest === 'function' && !!selectedProfileId();
}

/**
 * 用「当前连接档」(主 API 信息)发一次补全,只用其 API 信息、不套补全预设/instruct 模板。
 * 采样参数由 overridePayload 显式给(temperature=1 / max_tokens=8192),保证摘要可控且与预设解耦。
 * 非流式,返回文本;失败抛 ApiError。
 */
export async function requestViaMainApi(messages: ChatMsg[], opts: RequestOptions = {}): Promise<string> {
  const ctx = getContext();
  const svc = ctx?.ConnectionManagerRequestService;
  if (typeof svc?.sendRequest !== 'function') {
    throw new ApiError('未启用连接管理(Connection Manager),无法跟随主 API');
  }
  const profileId = selectedProfileId();
  if (!profileId) throw new ApiError('未选中连接档,请在 ST 连接管理里选一个,或为本任务单独指派渠道');

  const data = await svc.sendRequest(
    profileId,
    messages,
    MAIN_API_MAX_TOKENS,
    { stream: false, signal: opts.signal ?? null, extractData: true, includePreset: false, includeInstruct: false },
    { temperature: MAIN_API_TEMPERATURE },
  );

  const content = extractContent(data);
  if (!content) throw new ApiError('主 API 返回空内容');
  return content;
}

/** 连通性测试:发一条极短请求 */
export async function testChannel(channel: ApiChannel): Promise<{ ok: boolean; message: string }> {
  try {
    const reply = await requestCompletion(channel, [{ role: 'user', content: '回复"ok"两个字符即可。' }]);
    return { ok: true, message: `连通正常,返回:${reply.slice(0, 40)}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

const STATUS_URL = '/api/backends/chat-completions/status';

/**
 * 拉取渠道可用的模型列表(走 ST 的 /status 代理,标准 /v1/models)。
 * 只需 url + key,不需要先填 model。
 */
export async function fetchModels(channel: Pick<ApiChannel, 'url' | 'key'>): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url) throw new ApiError('请先填写 API 地址');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
  };

  const resp = await fetch(STATUS_URL, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new ApiError(`拉取模型失败 (${resp.status}): ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (data?.error && !Array.isArray(data?.data)) {
    throw new ApiError(data?.message || '拉取模型失败');
  }

  const list: unknown = data?.data ?? data?.models ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .map((m: any) => (typeof m === 'string' ? m : m?.id))
    .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
    .sort();
}
