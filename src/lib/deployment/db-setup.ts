// PostgreSQL 직접 연결을 통한 데이터베이스 설정
// Supabase는 PostgreSQL이므로 Connection String으로 직접 연결 가능

import pg from 'pg';
import { SETUP_SQL } from '../setup-instructions.js';
import { extractProjectRef } from './supabase-deploy.js';

export interface DbSetupResult {
  ok: boolean;
  error?: string;
}

/**
 * 연결 문자열에서 민감한 정보(비밀번호) 마스킹
 * 다양한 패턴을 처리하여 비밀번호 노출 방지
 */
function maskConnectionString(text: string): string {
  return text
    // postgresql://user:password@host 형식
    .replace(/:\/\/([^:]+):([^@]+)@/g, '://$1:[REDACTED]@')
    // password=xxx 또는 password:xxx 형식
    .replace(/password[=:][^\s&]+/gi, 'password=[REDACTED]');
}

/**
 * Supabase 리전별 Pooler 호스트 매핑
 * 참고: https://supabase.com/docs/guides/database/connecting-to-postgres#connection-pooler
 */
const REGION_POOLER_HOSTS: Record<string, string> = {
  // 아시아
  'ap-northeast-1': 'aws-0-ap-northeast-1.pooler.supabase.com', // 도쿄
  'ap-northeast-2': 'aws-0-ap-northeast-2.pooler.supabase.com', // 서울
  'ap-southeast-1': 'aws-0-ap-southeast-1.pooler.supabase.com', // 싱가포르
  'ap-southeast-2': 'aws-0-ap-southeast-2.pooler.supabase.com', // 시드니
  'ap-south-1': 'aws-0-ap-south-1.pooler.supabase.com', // 뭄바이
  // 미주
  'us-east-1': 'aws-0-us-east-1.pooler.supabase.com', // 버지니아
  'us-east-2': 'aws-0-us-east-2.pooler.supabase.com', // 오하이오
  'us-west-1': 'aws-0-us-west-1.pooler.supabase.com', // 캘리포니아
  'us-west-2': 'aws-0-us-west-2.pooler.supabase.com', // 오레곤
  'ca-central-1': 'aws-0-ca-central-1.pooler.supabase.com', // 캐나다
  'sa-east-1': 'aws-0-sa-east-1.pooler.supabase.com', // 상파울루
  // 유럽
  'eu-west-1': 'aws-0-eu-west-1.pooler.supabase.com', // 아일랜드
  'eu-west-2': 'aws-0-eu-west-2.pooler.supabase.com', // 런던
  'eu-west-3': 'aws-0-eu-west-3.pooler.supabase.com', // 파리
  'eu-central-1': 'aws-0-eu-central-1.pooler.supabase.com', // 프랑크푸르트
  'eu-central-2': 'aws-0-eu-central-2.pooler.supabase.com', // 취리히
  'eu-north-1': 'aws-0-eu-north-1.pooler.supabase.com', // 스톡홀름
};

// 기본 리전 (한국)
const DEFAULT_REGION = 'ap-northeast-2';

/**
 * Supabase Management API를 통해 프로젝트 리전 조회
 */
async function getProjectRegion(projectRef: string, accessToken?: string): Promise<string | null> {
  if (!accessToken) {
    return null;
  }

  try {
    const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { region?: string };
    return data.region || null;
  } catch {
    return null;
  }
}

/**
 * 리전에 맞는 Pooler 호스트 반환
 */
function getPoolerHost(region: string): string {
  return REGION_POOLER_HOSTS[region] || REGION_POOLER_HOSTS[DEFAULT_REGION];
}

/**
 * PostgreSQL 연결 문자열 생성
 * Session mode (port 5432)가 아닌 Transaction mode (port 6543) 사용
 */
function buildConnectionString(
  projectRef: string,
  databasePassword: string,
  poolerHost: string
): string {
  // Transaction pooler는 postgres.[project-ref] 형식
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(databasePassword)}@${poolerHost}:6543/postgres`;
}

/**
 * 데이터베이스에 직접 연결하여 Setup SQL 실행
 *
 * @param projectUrl - Supabase Project URL (https://xxx.supabase.co)
 * @param databasePassword - Database password
 * @param accessToken - Optional: Access Token (리전 자동 감지용)
 */
export async function executeSetupSQL(
  projectUrl: string,
  databasePassword: string,
  accessToken?: string
): Promise<DbSetupResult> {
  const projectRef = extractProjectRef(projectUrl);
  if (!projectRef) {
    return {
      ok: false,
      error: 'Supabase URL에서 project ref를 추출할 수 없습니다',
    };
  }

  // 리전 자동 감지 시도 (Access Token이 있는 경우)
  let region = await getProjectRegion(projectRef, accessToken);
  if (!region) {
    region = DEFAULT_REGION;
  }

  const poolerHost = getPoolerHost(region);
  const connectionString = buildConnectionString(projectRef, databasePassword, poolerHost);

  const client = new pg.Client({
    connectionString,
    // SSL 검증: 기본적으로 활성화, 환경변수로 비활성화 가능
    ssl: {
      rejectUnauthorized: process.env.CLAUDE_GUARD_SSL_VERIFY !== 'false',
    },
    // 연결 타임아웃 설정
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();

    // SQL 실행 (여러 문장이 포함된 스크립트)
    await client.query(SETUP_SQL);

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // 에러 메시지에서 비밀번호 마스킹
    const maskedError = maskConnectionString(errorMessage);

    // 일반적인 에러에 대한 친절한 메시지
    if (maskedError.includes('password authentication failed')) {
      return {
        ok: false,
        error: 'Database Password가 올바르지 않습니다. Supabase Dashboard > Settings > Database에서 확인하세요.',
      };
    }

    if (maskedError.includes('ENOTFOUND') || maskedError.includes('getaddrinfo')) {
      return {
        ok: false,
        error: `데이터베이스 서버에 연결할 수 없습니다. 리전이 올바른지 확인하세요. (현재: ${region})`,
      };
    }

    if (maskedError.includes('timeout') || maskedError.includes('ETIMEDOUT')) {
      return {
        ok: false,
        error: '연결 시간이 초과되었습니다. 네트워크 상태를 확인하세요.',
      };
    }

    return {
      ok: false,
      error: maskedError,
    };
  } finally {
    await client.end().catch(() => {
      // 연결 종료 실패는 무시
    });
  }
}

/**
 * 데이터베이스 연결 테스트 (SQL 실행 없이)
 */
export async function testDatabaseConnection(
  projectUrl: string,
  databasePassword: string,
  accessToken?: string
): Promise<DbSetupResult> {
  const projectRef = extractProjectRef(projectUrl);
  if (!projectRef) {
    return {
      ok: false,
      error: 'Supabase URL에서 project ref를 추출할 수 없습니다',
    };
  }

  let region = await getProjectRegion(projectRef, accessToken);
  if (!region) {
    region = DEFAULT_REGION;
  }

  const poolerHost = getPoolerHost(region);
  const connectionString = buildConnectionString(projectRef, databasePassword, poolerHost);

  const client = new pg.Client({
    connectionString,
    // SSL 검증: 기본적으로 활성화, 환경변수로 비활성화 가능
    ssl: {
      rejectUnauthorized: process.env.CLAUDE_GUARD_SSL_VERIFY !== 'false',
    },
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    // 간단한 쿼리로 연결 확인
    await client.query('SELECT 1');
    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const maskedError = maskConnectionString(errorMessage);

    if (maskedError.includes('password authentication failed')) {
      return {
        ok: false,
        error: 'Database Password가 올바르지 않습니다',
      };
    }

    return {
      ok: false,
      error: maskedError,
    };
  } finally {
    await client.end().catch(() => {});
  }
}
