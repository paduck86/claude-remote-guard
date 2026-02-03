// Telegram Bot API를 사용한 Webhook 설정
// https://core.telegram.org/bots/api#setwebhook

export interface WebhookResult {
  ok: boolean;
  description?: string;
}

export interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}

export interface GetWebhookInfoResult {
  ok: boolean;
  result?: WebhookInfo;
  description?: string;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

/**
 * Telegram Bot Webhook 설정
 * POST https://api.telegram.org/bot{token}/setWebhook
 *
 * @param botToken - Telegram Bot Token
 * @param webhookUrl - Webhook URL (Edge Function URL)
 * @param secretToken - Webhook 요청 검증용 비밀 토큰 (선택)
 */
export async function setTelegramWebhook(
  botToken: string,
  webhookUrl: string,
  secretToken?: string
): Promise<WebhookResult> {
  const apiUrl = `https://api.telegram.org/bot${botToken}/setWebhook`;

  try {
    const params: Record<string, string> = {
      url: webhookUrl,
    };

    if (secretToken) {
      params.secret_token = secretToken;
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    const data = (await response.json()) as TelegramApiResponse;

    if (!data.ok) {
      return {
        ok: false,
        description: data.description || 'Unknown error',
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      description: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Telegram Bot Webhook 정보 조회
 * GET https://api.telegram.org/bot{token}/getWebhookInfo
 */
export async function getTelegramWebhookInfo(botToken: string): Promise<GetWebhookInfoResult> {
  const apiUrl = `https://api.telegram.org/bot${botToken}/getWebhookInfo`;

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
    });

    const data = (await response.json()) as TelegramApiResponse;

    if (!data.ok) {
      return {
        ok: false,
        description: data.description || 'Unknown error',
      };
    }

    return {
      ok: true,
      result: data.result as WebhookInfo,
    };
  } catch (error) {
    return {
      ok: false,
      description: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Telegram Bot Webhook 삭제
 * POST https://api.telegram.org/bot{token}/deleteWebhook
 */
export async function deleteTelegramWebhook(botToken: string): Promise<WebhookResult> {
  const apiUrl = `https://api.telegram.org/bot${botToken}/deleteWebhook`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
    });

    const data = (await response.json()) as TelegramApiResponse;

    if (!data.ok) {
      return {
        ok: false,
        description: data.description || 'Unknown error',
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      description: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 랜덤 Webhook Secret 생성 (64자리 hex)
 */
export function generateWebhookSecret(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
