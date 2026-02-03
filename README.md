# Claude Guard

Claude Code에서 위험한 명령어 실행 시 Slack, Telegram, WhatsApp으로 알림을 받고 승인/거부할 수 있는 원격 승인 시스템입니다.

## 목차

- [Quick Start](#quick-start)
- [메신저별 설정 가이드](#메신저별-설정-가이드)
  - [Slack 설정](#slack-설정)
  - [Telegram 설정](#telegram-설정)
  - [WhatsApp (Twilio) 설정](#whatsapp-twilio-설정)
- [Supabase 설정](#supabase-설정)
- [Edge Function 배포](#edge-function-배포)
- [설정 완료 및 테스트](#설정-완료-및-테스트)
- [사용법](#사용법)
- [설정 옵션](#설정-옵션)

---

## Quick Start

```bash
# 1. 설치
npm install -g claude-remote-guard

# 2. 초기화 (대화형 설정)
guard init
```

`guard init`을 실행하면 다음을 안내받습니다:
1. 메신저 선택 (Slack / Telegram / WhatsApp)
2. 선택한 메신저의 인증 정보 입력
3. Supabase 연결 정보 입력
4. SQL 스키마 및 Edge Function 생성

**중요**: 아래 가이드를 먼저 읽고 필요한 정보를 준비한 후 `guard init`을 실행하세요.

---

## 메신저별 설정 가이드

### Slack 설정

#### 1단계: Slack 앱 생성

1. [Slack API](https://api.slack.com/apps) 접속
2. **Create New App** → **From scratch** 선택
3. 앱 이름 입력 (예: `Claude Guard`), 워크스페이스 선택 후 **Create App**

#### 2단계: Incoming Webhook 활성화

1. 왼쪽 메뉴에서 **Incoming Webhooks** 클릭
2. **Activate Incoming Webhooks**를 **On**으로 전환
3. 하단의 **Add New Webhook to Workspace** 클릭
4. 알림 받을 채널 선택 후 **Allow**
5. **Webhook URL** 복사 (예: `https://hooks.slack.com/services/T.../B.../xxx`)

```
📋 복사할 정보: Webhook URL
```

#### 3단계: Interactivity 설정 (Edge Function 배포 후)

> ⚠️ 이 단계는 [Edge Function 배포](#edge-function-배포) 완료 후 진행합니다.

1. Slack 앱 설정 페이지에서 **Interactivity & Shortcuts** 클릭
2. **Interactivity**를 **On**으로 전환
3. **Request URL**에 Edge Function URL 입력:
   ```
   https://<project-ref>.supabase.co/functions/v1/slack-callback
   ```
4. **Save Changes** 클릭

---

### Telegram 설정

#### 1단계: 봇 생성

1. Telegram에서 [@BotFather](https://t.me/botfather) 검색하여 대화 시작
2. `/newbot` 명령어 전송
3. 봇 이름 입력 (예: `Claude Guard Bot`)
4. 봇 username 입력 (예: `claude_guard_bot`) - 반드시 `_bot`으로 끝나야 함
5. **Bot Token** 복사 (예: `123456789:ABCdefGHI...`)

```
📋 복사할 정보: Bot Token
```

#### 2단계: Chat ID 확인

**방법 A: 봇과 대화 후 확인**
1. 생성한 봇과 대화 시작 (`/start` 전송)
2. 브라우저에서 다음 URL 접속:
   ```
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```
3. 응답에서 `"chat":{"id":` 뒤의 숫자가 Chat ID

**방법 B: @userinfobot 사용**
1. [@userinfobot](https://t.me/userinfobot)과 대화 시작
2. 표시되는 `Id` 값이 Chat ID

```
📋 복사할 정보: Chat ID (숫자)
```

#### 3단계: Webhook 설정 (Edge Function 배포 후)

> ⚠️ 이 단계는 [Edge Function 배포](#edge-function-배포) 완료 후 진행합니다.

브라우저에서 다음 URL 접속 (한 번만 실행):

```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<project-ref>.supabase.co/functions/v1/telegram-callback
```

성공 시 응답:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

---

### WhatsApp (Twilio) 설정

#### 1단계: Twilio 계정 생성

1. [Twilio](https://www.twilio.com/try-twilio) 회원가입
2. [Console](https://console.twilio.com/) 접속
3. **Account SID**와 **Auth Token** 복사

```
📋 복사할 정보: Account SID, Auth Token
```

#### 2단계: WhatsApp Sandbox 활성화

1. Console에서 **Messaging** → **Try it out** → **Send a WhatsApp message** 이동
2. 표시된 번호로 지정된 코드를 WhatsApp 메시지로 전송 (예: `join <sandbox-keyword>`)
3. Sandbox 번호 확인 (예: `+1 415 523 8886`)

```
📋 복사할 정보: Twilio WhatsApp 번호, 내 전화번호
```

#### 3단계: Webhook 설정 (Edge Function 배포 후)

> ⚠️ 이 단계는 [Edge Function 배포](#edge-function-배포) 완료 후 진행합니다.

1. Twilio Console에서 **Messaging** → **Settings** → **WhatsApp Sandbox Settings** 이동
2. **When a message comes in** URL 설정:
   ```
   https://<project-ref>.supabase.co/functions/v1/whatsapp-callback
   ```
3. Method: **POST** 선택
4. **Save** 클릭

---

## Supabase 설정

#### 1단계: 프로젝트 생성

1. [Supabase Dashboard](https://supabase.com/dashboard) 접속
2. **New Project** 클릭
3. 프로젝트 이름, 데이터베이스 비밀번호 설정 후 생성

#### 2단계: API 정보 확인

1. 프로젝트 선택 후 **Settings** → **API** 이동
2. 다음 정보 복사:
   - **Project URL**: `https://xxxx.supabase.co`
   - **anon public** 키: `eyJhbGciOiJIUzI1NiIs...`

```
📋 복사할 정보: Project URL, anon public 키
```

#### 3단계: SQL 스키마 실행

`guard init` 실행 후 출력된 SQL을 복사하여:

1. Supabase Dashboard에서 **SQL Editor** 클릭
2. **New Query** 클릭
3. SQL 붙여넣기 후 **Run** 클릭

또는 직접 실행:

```sql
-- approval_requests 테이블 생성
CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  command TEXT NOT NULL,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_approval_requests_request_id ON approval_requests(request_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);

-- RLS 활성화
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;

-- RLS 정책
CREATE POLICY "Allow anonymous read" ON approval_requests FOR SELECT USING (true);
CREATE POLICY "Allow anonymous insert" ON approval_requests FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anonymous update" ON approval_requests FOR UPDATE USING (true);

-- Realtime 활성화
ALTER PUBLICATION supabase_realtime ADD TABLE approval_requests;
```

---

## Edge Function 배포

#### 1단계: Supabase CLI 설치

```bash
npm install -g supabase
```

#### 2단계: 로그인 및 프로젝트 연결

```bash
# Supabase 로그인
supabase login

# 프로젝트 연결 (project-ref는 URL에서 확인: https://[project-ref].supabase.co)
supabase link --project-ref <your-project-ref>
```

#### 3단계: Edge Function 배포

`guard init` 실행 시 `~/.claude-guard/supabase/functions/` 디렉토리에 Edge Function이 생성됩니다.

```bash
# Slack 사용 시
supabase functions deploy slack-callback --project-ref <your-project-ref>

# Telegram 사용 시
supabase functions deploy telegram-callback --project-ref <your-project-ref>

# WhatsApp 사용 시
supabase functions deploy whatsapp-callback --project-ref <your-project-ref>
```

배포 완료 후 Edge Function URL:
```
https://<project-ref>.supabase.co/functions/v1/<function-name>
```

> ⚠️ 배포 완료 후 위의 메신저별 Webhook 설정 단계로 돌아가 URL을 등록하세요.

---

## 설정 완료 및 테스트

#### 연결 상태 확인

```bash
guard status
```

출력 예시:
```
Claude Guard Status
───────────────────
Messenger: telegram ✓
Supabase:  connected ✓
Hook:      installed ✓
```

#### 테스트 알림 전송

```bash
guard test
```

선택한 메신저로 테스트 알림이 전송됩니다. 버튼(Slack/Telegram) 또는 답장(WhatsApp)으로 승인/거부를 테스트하세요.

---

## 사용법

설정 완료 후 Claude Code를 평소처럼 사용하면 됩니다. 위험한 명령어 실행 시 자동으로 알림이 전송됩니다.

### 명령어 목록

| 명령어 | 설명 |
|--------|------|
| `guard init` | 초기 설정 (대화형) |
| `guard status` | 연결 상태 확인 |
| `guard test` | 테스트 알림 전송 |
| `guard uninstall` | Claude Guard 제거 |

### 동작 방식

```
Claude Code ──▶ Hook ──▶ 메신저 알림
    │                        │
    │ (대기)                  │ 승인/거부
    │                        ▼
    │◀── Supabase ◀── Edge Function
    │
    ▼
 명령어 실행 또는 차단
```

1. Claude Code가 위험한 명령어를 실행하려 할 때 Hook이 가로챔
2. Supabase에 승인 요청 저장 & 메신저로 알림 전송
3. 사용자가 승인 또는 거부
4. Edge Function이 Supabase 상태 업데이트
5. Hook이 Realtime 구독으로 결과 수신
6. 명령어 실행 허용 또는 차단

---

## 설정 옵션

설정 파일 위치: `~/.claude-guard/config.json`

```json
{
  "messenger": {
    "type": "slack",
    "slack": {
      "webhookUrl": "https://hooks.slack.com/services/..."
    }
  },
  "supabase": {
    "url": "https://xxxx.supabase.co",
    "anonKey": "eyJhbGciOiJIUzI1NiIs..."
  },
  "rules": {
    "timeoutSeconds": 300,
    "defaultAction": "deny",
    "customPatterns": [],
    "whitelist": []
  }
}
```

### 옵션 설명

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `timeoutSeconds` | 300 | 승인 대기 시간 (초) |
| `defaultAction` | `"deny"` | 타임아웃 시 동작 (`allow` 또는 `deny`) |
| `customPatterns` | `[]` | 추가 위험 패턴 |
| `whitelist` | `[]` | 항상 허용할 명령어 패턴 (정규식) |

### 커스텀 패턴 예시

```json
{
  "rules": {
    "customPatterns": [
      {
        "pattern": "deploy-prod",
        "severity": "critical",
        "reason": "프로덕션 배포 명령"
      }
    ]
  }
}
```

### 기본 위험 패턴

| 패턴 | 심각도 | 이유 |
|------|--------|------|
| `rm -rf` | high | 재귀적 강제 삭제 |
| `git push --force` | critical | 원격 히스토리 덮어쓰기 |
| `git reset --hard` | high | 커밋되지 않은 변경사항 삭제 |
| `npm publish` | high | npm 패키지 배포 |
| `sudo` | high | 관리자 권한 실행 |
| `curl \| bash` | critical | 원격 스크립트 실행 |

---

## 문제 해결

### Slack 버튼이 동작하지 않음

- Interactivity가 활성화되어 있는지 확인
- Request URL이 정확한지 확인
- Edge Function 로그 확인: `supabase functions logs slack-callback`

### Telegram 버튼이 동작하지 않음

- Webhook이 설정되어 있는지 확인:
  ```
  https://api.telegram.org/bot<TOKEN>/getWebhookInfo
  ```
- Edge Function 로그 확인: `supabase functions logs telegram-callback`

### WhatsApp 답장이 인식되지 않음

- Sandbox 번호로 메시지를 보내고 있는지 확인
- 답장 형식 확인: `APPROVE <request-id>` 또는 `REJECT <request-id>`
- Twilio Webhook URL이 정확한지 확인

### 일반적인 문제

```bash
# 설정 상태 확인
guard status

# Edge Function 로그 확인
supabase functions logs <function-name> --project-ref <project-ref>
```

---

## 요구사항

- Node.js 18 이상
- Supabase 계정 (무료 플랜 가능)
- Slack / Telegram / Twilio 계정 (선택)

---

## License

MIT
