# CLI UX 개선 + 서버 검증 구현

## 개요

CLI init 과정의 용어/안내 개선 및 서버 측 machine_id 검증 구현

---

## 작업 목록

### 1. CLI 라벨 변경
**파일**: `src/bin/cli.ts`

| 현재 | 변경 | 라인 |
|------|------|------|
| `Project URL:` | `Supabase URL:` | 74 |
| `Service Role Key (자동 배포용, 건너뛰려면 Enter):` | `Access Token (자동 배포용, 건너뛰려면 Enter):` | 98 |

**+ Access Token 발급 안내 추가** (프롬프트 전에 출력)

### 2. Telegram Chat ID/Bot ID 확인 방법 안내
**파일**: `src/bin/cli.ts` (라인 252 부근)

Bot Token 입력 후, Chat ID 프롬프트 전에 안내 추가:
```
💡 Chat ID 확인 방법:
   1. Telegram에서 봇에게 아무 메시지 전송
   2. 브라우저에서 열기:
      https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
   3. 응답에서 "chat":{"id": 숫자} 부분이 Chat ID

💡 Bot ID는 Bot Token의 콜론(:) 앞부분입니다
   예: 123456789:ABCdef... → Bot ID: 123456789
```

### 3. Self-signed certificate 에러 처리
**파일**: `src/lib/supabase.ts` 또는 `src/bin/cli.ts`

**원인**: 회사 프록시/VPN에서 SSL 인증서 검증 실패

**해결 방안**:
- 에러 메시지에 해결 방법 안내 추가
- `NODE_TLS_REJECT_UNAUTHORIZED=0` 또는 `NODE_EXTRA_CA_CERTS` 환경변수 안내

```typescript
// 테이블 생성 실패 시 에러 처리
if (error.message.includes('self-signed certificate')) {
  console.log(chalk.yellow('\n⚠️  SSL 인증서 에러 (회사 프록시/VPN 환경)'));
  console.log(chalk.gray('  해결 방법:'));
  console.log(chalk.gray('  1. VPN 끄고 재시도'));
  console.log(chalk.gray('  2. 또는 환경변수 설정 후 재시도:'));
  console.log(chalk.cyan('     NODE_TLS_REJECT_UNAUTHORIZED=0 npx claude-remote-guard init'));
}
```

### 4. 배포 자동화 개선 (CLI 불필요 - Management API 사용)
**파일**: `src/bin/cli.ts`

**이미 구현된 것** (`src/lib/deployment/supabase-deploy.ts`):
- `deployEdgeFunction()` - Management API로 Edge Function 배포
- `setEdgeFunctionSecrets()` - Secrets 설정
- `validateAccessToken()` - Access Token 검증

**Supabase CLI 없이 npm 모듈만으로 자동 배포 가능!**

---

**현재 문제점**:

1. **라벨 오류**: "Service Role Key" → 실제로는 "Access Token (sbp_...)" 필요
   ```typescript
   // 라인 98: 틀린 라벨
   message: 'Service Role Key (자동 배포용, 건너뛰려면 Enter):'

   // 라인 207: 실제로는 sbp_ prefix 확인
   if (supabaseAnswers.accessToken.startsWith('sbp_'))
   ```

2. **안내 부재**: Access Token 발급 방법 설명 없음

---

**개선 사항**:

1. **라벨 수정** (라인 98):
   ```
   'Service Role Key (자동 배포용, 건너뛰려면 Enter):'
   ↓
   'Access Token (자동 배포용, 건너뛰려면 Enter):'
   ```

2. **Access Token 발급 안내 추가** (프롬프트 전에):
   ```
   💡 Access Token 발급 방법 (자동 배포를 원하면):
      1. https://supabase.com/dashboard 접속
      2. 좌측 하단 프로필 클릭 → Account Settings
      3. Access Tokens 탭 → Generate new token
      4. 생성된 토큰 복사 (sbp_로 시작)

   ⏭️  건너뛰면 수동 배포 안내가 표시됩니다.
   ```

3. **플로우 유지**:
   - Access Token 입력 → 자동 배포 시도
   - 입력 안 함 (Enter) → 수동 배포 안내 (기존 동작 유지)

---

**Service Role Key vs Access Token 차이**:

| 키 | 용도 | prefix | 발급 위치 |
|----|------|--------|----------|
| Anon Key | 클라이언트 DB 접근 | `eyJ...` | Project → Settings → API |
| Service Role Key | 서버 DB 접근 (RLS 우회) | `eyJ...` | Project → Settings → API |
| **Access Token** | **Management API (배포)** | `sbp_...` | **Account** → Access Tokens |

### 5. 서버 검증 함수 호출 (SecurityVuna_plan2.md)
**파일**:
- `supabase/functions/telegram-callback/index.ts`
- `supabase/functions/slack-callback/index.ts`
- `supabase/functions/whatsapp-callback/index.ts`
- `src/lib/edge-function.ts` (템플릿 동기화)

**변경 사항**:
- 요청 조회 시 `machine_id` 필드 포함
- 업데이트 전 `verifySignedMachineId()` 호출
- 템플릿과 실제 코드 동기화

---

## 수정 파일 목록

| 파일 | 변경 내용 |
|------|----------|
| `src/bin/cli.ts` | 라벨 변경, 안내 메시지 추가, 에러 처리 개선 |
| `supabase/functions/telegram-callback/index.ts` | 검증 호출 추가 |
| `supabase/functions/slack-callback/index.ts` | verifySignedMachineId + 검증 호출 |
| `supabase/functions/whatsapp-callback/index.ts` | verifySignedMachineId + 검증 호출 |
| `src/lib/edge-function.ts` | 템플릿 동기화 |

---

## 검증 방법

```bash
# 1. 빌드
npm run build

# 2. init 테스트
npx claude-remote-guard init

# 확인 사항:
# - "Supabase URL:" 프롬프트 표시
# - "Service Role Key:" 프롬프트 표시
# - Telegram 선택 시 Chat ID 확인 방법 안내
# - SSL 에러 시 해결 방법 안내
```

---

---

### 6. Edge Function BootFailure 수정
**문제**: Telegram callback Edge Function 부팅 실패

```json
{
  "event_type": "BootFailure",
  "served_by": "supabase-edge-runtime-1.70.0 (compatible with Deno v2.1.4)"
}
```

**원인 가능성**:
- 문법 에러 또는 import 에러
- 템플릿(`src/lib/edge-function.ts`)과 실제 배포 코드 불일치
- Deno 버전 호환성 문제

**해결**:
- [ ] 실제 배포된 `supabase/functions/telegram-callback/index.ts` 코드 확인
- [ ] 템플릿과 동기화
- [ ] Supabase Dashboard에서 Edge Function 로그 상세 확인

---

### 7. 콘솔 승인 프롬프트 안 나옴
**문제**: 로컬 TTY 입력 프롬프트가 표시되지 않음

**현재 코드** (`src/bin/hook.ts` 라인 150-155):
```typescript
try {
  fs.accessSync(ttyPath, fs.constants.R_OK);
} catch {
  // TTY 없음 - 조용히 return (에러 메시지 없음!)
  return;
}
```

**원인**:
- Claude Code가 hook을 subprocess로 실행 → `/dev/tty` 접근 불가
- 실패해도 에러 메시지 없이 원격만 대기

**해결**:
- [ ] TTY 접근 실패 시 stderr로 안내 메시지 출력
- [ ] 또는 대안: stdin이 이미 사용 중이므로 다른 방법 검토 필요

```typescript
} catch {
  // TTY 없음 - 원격 응답만 대기
  process.stderr.write('[Local] TTY not available, waiting for remote only...\n');
  return;
}
```

---

## 우선순위

1. ✅ CLI 라벨 변경 (간단)
2. ✅ Telegram 안내 추가 (간단)
3. ✅ SSL 에러 안내 (간단)
4. ✅ 배포 자동화 개선 (Management API 이미 구현됨 - 호출 로직만 확인/수정)
5. ✅ 서버 검증 구현 (중요)
6. 🔴 Edge Function BootFailure 수정 (긴급)
7. 🟡 콘솔 승인 프롬프트 디버깅
