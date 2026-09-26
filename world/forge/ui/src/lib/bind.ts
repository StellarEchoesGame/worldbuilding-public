import { loopbackOnly } from '../../../engine/loopback.ts';

export interface ServerRefusalInput {
  /** process.env.HOST of the server (undefined → astro.config's 127.0.0.1). */
  bindHost: string | undefined;
  /** Host header / URL host of the request. */
  requestHost: string;
  /** agentMarkers(process.env) (engine/ui-launch.ts). */
  markers: readonly string[];
  /** isRealData(). */
  realData: boolean;
}

/** Chinese refusal (the middleware answers 403) when bound or addressed off loopback, or an agent marker meets real data; else null. */
export function serverRefusal(input: ServerRefusalInput): string | null {
  if (input.bindHost !== undefined && !loopbackOnly(input.bindHost)) return '这个 UI 绑定在非本机地址上，拒绝服务。请用 npm run ui 在本机（127.0.0.1）启动。';
  if (!loopbackOnly(input.requestHost)) return '请求的主机名不是本机地址，拒绝服务。请通过 127.0.0.1 访问。';
  if (input.realData && input.markers.length > 0) return `检测到代理会话标记（${input.markers.join('、')}），拒绝对真实数据目录服务。请在你自己的终端里运行 npm run ui。`;
  return null;
}
