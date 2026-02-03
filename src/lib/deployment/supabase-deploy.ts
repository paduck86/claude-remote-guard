// Supabase Management API를 사용한 Edge Function 배포
// https://supabase.com/docs/reference/api/introduction

export interface DeployResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface SecretsResult {
  success: boolean;
  error?: string;
}

interface SupabaseApiError {
  message?: string;
  error?: string;
}

/**
 * Supabase URL에서 project ref 추출
 * https://abcd1234.supabase.co -> abcd1234
 */
export function extractProjectRef(supabaseUrl: string): string | null {
  const match = supabaseUrl.match(/^https:\/\/([^.]+)\.supabase\.co/);
  return match ? match[1] : null;
}

/**
 * Edge Function 배포
 * POST https://api.supabase.com/v1/projects/{ref}/functions/{slug}
 */
export async function deployEdgeFunction(
  projectRef: string,
  accessToken: string,
  functionSlug: string,
  sourceCode: string
): Promise<DeployResult> {
  try {
    // 먼저 함수가 존재하는지 확인
    const checkResponse = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/functions/${functionSlug}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const method = checkResponse.ok ? 'PATCH' : 'POST';
    const url = checkResponse.ok
      ? `https://api.supabase.com/v1/projects/${projectRef}/functions/${functionSlug}`
      : `https://api.supabase.com/v1/projects/${projectRef}/functions`;

    // 함수 배포 또는 업데이트
    const requestBody: Record<string, unknown> = {
      slug: functionSlug,
      name: functionSlug,
      body: sourceCode,
      verify_jwt: false,
    };

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as SupabaseApiError;
      const errorMessage = errorData.message || errorData.error || `HTTP ${response.status}`;
      return {
        success: false,
        error: `배포 실패: ${errorMessage}`,
      };
    }

    const functionUrl = `https://${projectRef}.supabase.co/functions/v1/${functionSlug}`;

    return {
      success: true,
      url: functionUrl,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Edge Function 환경 변수(Secrets) 설정
 * POST https://api.supabase.com/v1/projects/{ref}/secrets
 */
export async function setEdgeFunctionSecrets(
  projectRef: string,
  accessToken: string,
  secrets: Record<string, string>
): Promise<SecretsResult> {
  const apiUrl = `https://api.supabase.com/v1/projects/${projectRef}/secrets`;

  try {
    // Secrets API는 배열 형식으로 전달
    const secretsArray = Object.entries(secrets).map(([name, value]) => ({
      name,
      value,
    }));

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(secretsArray),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as SupabaseApiError;
      const errorMessage = errorData.message || errorData.error || `HTTP ${response.status}`;
      return {
        success: false,
        error: `Secrets 설정 실패: ${errorMessage}`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Supabase Access Token 유효성 검사
 */
export async function validateAccessToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.supabase.com/v1/projects', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
