# Claude Guard

Claude Code에서 위험한 명령어 실행 시 원격으로 승인/거부할 수 있는 시스템.

## 프로젝트 구조

```
src/
├── bin/
│   ├── cli.ts          # claude-remote-guard 명령어 (init, status, test, uninstall)
│   └── hook.ts         # Claude Code PreToolUse 훅
├── lib/
│   ├── config.ts       # 설정 로드/저장/마이그레이션
│   ├── edge-function.ts # Edge Function 코드 생성
│   ├── slack.ts        # (deprecated) 하위 호환용 re-export
│   └── messenger/      # 메신저 추상화 레이어
│       ├── types.ts    # MessengerType, Messenger 인터페이스
│       ├── base.ts     # 공통 유틸리티 (truncate, mask, emoji)
│       ├── factory.ts  # MessengerFactory.create()
│       ├── slack.ts    # Slack 구현체
│       ├── telegram.ts # Telegram 구현체
│       └── whatsapp.ts # WhatsApp(Twilio) 구현체
supabase/functions/
├── slack-callback/     # Slack Interactivity 웹훅
├── telegram-callback/  # Telegram Bot 웹훅
└── whatsapp-callback/  # Twilio WhatsApp 웹훅
```

## 핵심 설정 구조

```typescript
interface Config {
  messenger: {
    type: 'slack' | 'telegram' | 'whatsapp';  // 단일 선택
    slack?: { webhookUrl: string };
    telegram?: { botToken: string; chatId: string };
    whatsapp?: { accountSid: string; authToken: string; fromNumber: string; toNumber: string };
  };
  supabase: { url: string; anonKey: string };
  rules: { timeoutSeconds: number; defaultAction: 'allow' | 'deny'; customPatterns: []; whitelist: [] };
}
```

## 동작 흐름

1. Claude Code가 위험 명령 실행 시 `hook.ts`가 가로챔
2. Supabase에 승인 요청 저장 (status: 'pending')
3. 선택된 메신저로 알림 전송 (버튼 또는 텍스트)
4. 사용자가 승인/거부 → Edge Function이 Supabase 상태 업데이트
5. `hook.ts`가 Realtime 구독으로 결과 수신 → 명령 허용 또는 차단

## 개발 명령어

```bash
npm run build               # TypeScript 빌드
npm run lint                # ESLint 실행
claude-remote-guard init    # 설정 초기화
claude-remote-guard test    # 테스트 알림 전송
claude-remote-guard status  # 연결 상태 확인
```

---

# Global Instructions

## Role Mode

When the user specifies a role such as "you are a reviewer", "code validator", or "just review":

- **Do not generate/modify code** (use only Read/Grep/Glob, no Edit/Write)
- Act as a 20-year Staff Engineer and perform:
  - Plan review: Identify critical errors, improvements, and go/no-go decisions across project/solution/monorepo
  - Code review: Critical defects, remediation, and better alternatives
  - Architecture validation: Security, performance, SSR compatibility, data flow
- Actively use subagents (Task tool) to explore related code and provide evidence-based reviews
- Maintain review mode until the user releases the role with phrases like "now code it", "implement it"

## Language Rules

- **Conversation/explanation**: Korean
- **Code**: English
- **Comments**: Korean
- **Commit messages**: Title in English, body in Korean

## Subagent Usage

Actively use subagents (Task tool) during work. Unless the user explicitly says "single agent", parallelizable tasks should be executed concurrently via subagents.