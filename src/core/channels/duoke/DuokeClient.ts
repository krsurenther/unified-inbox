import { DuokeTokenReader } from './DuokeTokenReader';
import {
  normalizeConversation,
  normalizeDuokeMessage,
  normalizeOrder,
  type DuokeRawConversation,
  type DuokeRawMessage,
  type DuokeRawOrder,
  type NormalizedDuokeConversation,
  type NormalizedDuokeMessage,
  type NormalizedDuokeOrder,
} from './normalize';

export interface DuokeShop {
  id: string;
  platform: string; // 'lazada' | 'tiktok' | 'shopee' | ...
  country?: string;
  shopName?: string;
}

export interface DuokeClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  token?: string; // explicit token (tests); otherwise read live from Duoke
  tokenReader?: DuokeTokenReader;
}

interface ApiEnvelope<T> {
  code: number;
  data?: T;
  message?: string | null;
}

/**
 * Thin wrapper over Duoke's own backend (`app.duoke.com`), authenticating by
 * reusing Duoke's stored session JWT. Read methods only for now — `sendMessage`
 * is added in the gated send step. All responses are normalized so callers never
 * see Duoke's raw payload shape.
 */
export class DuokeClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly tokenReader: DuokeTokenReader;
  private token: string;

  constructor(opts: DuokeClientOptions = {}) {
    this.base = opts.baseUrl ?? 'https://app.duoke.com';
    this.fetchFn = opts.fetchFn ?? fetch;
    this.tokenReader = opts.tokenReader ?? new DuokeTokenReader();
    this.token = opts.token ?? this.tokenReader.read()?.token ?? '';
  }

  /** Re-read the token from Duoke's profile (e.g. after a re-login). */
  refreshToken(): boolean {
    const t = this.tokenReader.read()?.token ?? '';
    this.token = t;
    return Boolean(t);
  }

  hasToken(): boolean {
    return Boolean(this.token);
  }

  private headers(): Record<string, string> {
    return {
      Cookie: `token=${this.token}`,
      token: this.token,
      Referer: 'https://app.duoke.com/',
      Origin: 'https://app.duoke.com',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(this.base + path, { ...init, headers: this.headers() });
    const text = await res.text();
    let env: ApiEnvelope<T>;
    try {
      env = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      throw new Error(`Duoke ${path}: non-JSON response (status ${(res as Response).status})`);
    }
    if (env.code !== 0) {
      throw new Error(`Duoke ${path}: API code ${env.code}${env.message ? ` (${env.message})` : ''}`);
    }
    return env.data as T;
  }

  async listShops(): Promise<DuokeShop[]> {
    const data = await this.call<{ shops?: Array<Record<string, unknown>> }>('/api/v1/shop/');
    return (data.shops ?? []).map((s) => ({
      id: String(s.id),
      platform: String(s.platform),
      country: s.country == null ? undefined : String(s.country),
      shopName: s.shopName == null ? undefined : String(s.shopName),
    }));
  }

  async queryConversations(
    shopId: string,
    opts: { size?: number; offset?: number } = {},
  ): Promise<{ conversations: NormalizedDuokeConversation[]; hasMore: boolean; nextOffset?: string }> {
    const data = await this.call<{ list?: DuokeRawConversation[]; hasMore?: boolean; nextOffset?: string }>(
      '/api/v1/im/conversation/queryConversationList',
      {
        method: 'POST',
        body: JSON.stringify({
          shopIdList: [shopId],
          filterGroups: [],
          size: opts.size ?? 20,
          offset: opts.offset ?? 0,
          sortModel: '',
        }),
      },
    );
    return {
      conversations: (data.list ?? []).map(normalizeConversation),
      hasMore: Boolean(data.hasMore),
      nextOffset: data.nextOffset,
    };
  }

  async getMessages(args: {
    shopId: string;
    conversationId: string;
    platform: string;
    pageNo?: number;
    pageSize?: number;
    language?: string;
  }): Promise<NormalizedDuokeMessage[]> {
    const q = new URLSearchParams({
      pageNo: String(args.pageNo ?? 1),
      pageSize: String(args.pageSize ?? 30),
      shopId: args.shopId,
      conversationId: args.conversationId,
      platform: args.platform,
      language: args.language ?? 'en',
    });
    const data = await this.call<{ list?: DuokeRawMessage[] }>(`/api/v1/im/message/list?${q.toString()}`);
    // API returns newest-first; reverse to chronological (oldest-first) for the inbox.
    return (data.list ?? []).map(normalizeDuokeMessage).reverse();
  }

  /** Orders (+ their products) attached to a buyer's conversation — for the order card. */
  async getOrders(args: {
    shopId: string;
    buyerId: string;
    conversationId: string;
    platform: string;
    pageNo?: number;
    pageSize?: number;
  }): Promise<NormalizedDuokeOrder[]> {
    const data = await this.call<{ list?: DuokeRawOrder[] }>('/api/v1/dk/unity/order/list', {
      method: 'POST',
      body: JSON.stringify({
        shopId: args.shopId,
        buyerId: args.buyerId,
        conversationId: args.conversationId,
        platform: args.platform,
        pageNo: args.pageNo ?? 1,
        pageSize: args.pageSize ?? 20,
      }),
    });
    return (data.list ?? []).map(normalizeOrder);
  }
}
