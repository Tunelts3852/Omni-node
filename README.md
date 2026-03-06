# Omni-node

Omni-node는 로컬 PC 자원 제어, LLM 오케스트레이션, 코딩 개발/수정/유지보수/실행 자동화, 루틴 스케줄링을 하나로 묶은 로컬 에이전트입니다.
현재 워크스페이스 기준으로 `C 코어 + C#(.NET 9) 미들웨어 + 대시보드(React) + 텔레그램 봇` 구조로 동작합니다.

## 1) 현재 아키텍처

### 1-1. `omninode-core` (C)
- POSIX 기반 로우레벨 데몬
- UDS 서버: 기본 `/tmp/omninode_core.<uid>.sock`
- 단일 실행 락: `/tmp/omninode.<uid>.lock`
- 같은 사용자 프로세스(peer uid)만 UDS 연결 허용

### 1-2. `omninode-middleware` (C# / .NET 9)
- WebSocket + HTTP 서버 (기본 `127.0.0.1:8080`)
- OTP 인증, 텔레그램 롱폴링, LLM 라우팅/오케스트레이션
- 대화/코딩/루틴 상태 영속 저장
- 다중 언어 코드 실행 계층 통합

### 1-3. `omninode-dashboard` (React)
- 탭: `대화 / 루틴 / 코딩 / 설정`
- 모델/키/사용량/메타데이터/운영 콘솔 관리
- WebSocket 자동 연결
- OTP 인증 세션 유지

### 1-4. 실행 계층
- `UniversalCodeRunner`가 언어별 실행 담당
- 지원 언어: `python`, `javascript`, `bash`, `c`, `cpp`, `csharp`, `java`, `kotlin`, `html`, `css`
- 정적 자산(`html`, `css`)은 실행 대신 파일 저장

## 2) 기본 모델/라우팅 정책

### 2-1. 기본 모델
- Groq 기본: `meta-llama/llama-4-scout-17b-16e-instruct`
- Gemini 기본: `gemini-3-flash-preview`
- Copilot 기본: `gpt-5-mini`

### 2-2. Telegram 단일 모드 Groq 자동 전환
- 기본: `meta-llama/llama-4-scout-17b-16e-instruct`
- 한도 근접/429: `qwen/qwen3-32b`로 자동 승격(대화 압축 후 전달)
- qwen도 한도/429: `llama-3.1-8b-instant`로 자동 폴백

### 2-3. 탭 기본 모드
- 대화 탭 기본: `오케스트레이션`
- 코딩 탭 기본: `오케스트레이션`

## 3) 주요 기능

### 3-1. 대화 탭
- 단일/오케스트레이션/다중 LLM 모드
- 모델 선택, 프로젝트/카테고리/태그 관리
- 대화 히스토리 저장 및 재접속 복원
- 장문 컨텍스트 자동 압축 + 메모리 노트 저장

### 3-2. 코딩 탭
- 실제 파일 생성/수정/실행/검증 루프
- 작업 루트 기본값: `<repo>/coding`
- 코딩 결과는 변경 파일 카드 중심으로 표시
- 코드 본문은 자동 노출하지 않으며, 파일 선택 시 프리뷰 확인

### 3-3. 루틴 탭
- 자연어 요청으로 루틴 생성
- 루틴 스크립트 생성 후 즉시 1회 실행
- 20초 주기 스케줄러가 만기 루틴 자동 실행
- 로컬 시간대 기준으로 다음 실행 시각 계산/표시

### 3-4. 멀티모달/웹 참조
- 대화/코딩/텔레그램 입력에 이미지/파일 첨부 가능
- URL 참조 + 웹 검색 기반 컨텍스트 보강 가능
- 비멀티모달 모델은 안내 메시지 반환

### 3-5. OTP 인증
- OTP 요청 버튼을 눌렀을 때만 OTP 발송
- 인증 성공 시 토큰 발급
- 만료 시간(시간 단위)을 UI에서 지정 가능
- 브라우저 새로고침/미들웨어 재시작 후에도 만료 전까지 유지

### 3-6. Copilot Premium 사용량 연동
- 설정 탭에서 `GitHub Copilot Premium Requests` 카드 제공
- 항목: 사용률(%), 사용량(used/quota), 모델별 사용 횟수/비율, 갱신 시각, GitHub 링크
- 텔레그램 `/llm usage` 및 대화 탭 자연어 질의로도 조회 가능
- quota 미제공 응답은 기본 `300` 기준으로 사용률 추정(`inferred-pro-default`)

## 4) 보안/저장 정책

### 4-1. 시크릿 저장
- macOS: Keychain
- Linux: `~/.config/omninode/secrets.json` (0600)
- 대상: Telegram 토큰/Chat ID, Groq/Gemini API 키

### 4-2. 상태 저장(기본)
- `~/.omninode/llm_usage.json`
- `~/.omninode/copilot_usage.json`
- `~/.omninode/conversations.json`
- `~/.omninode/auth_sessions.json`
- `~/.omninode/routines.json`
- `~/.omninode/memory-notes/`
- `~/.omninode/code-runs/`

### 4-3. 파일 저장 안정성
- 상태 파일은 원자적 쓰기(임시 파일 + rename) 경로 사용

## 5) 요구사항

- macOS 또는 Linux
- `.NET SDK 9`
- `gcc`/`clang` 또는 `cc`
- `python3`
- (선택) `node`, `npm`, `javac`, `kotlinc`, `gh`, `copilot`, `playwright`

## 6) 실행 방법

### 6-1. 코어 실행
```bash
cd omninode-core
make
./omninode_core
```

### 6-2. 미들웨어 실행
```bash
cd omninode-middleware
dotnet run --project OmniNode.Middleware.csproj
```

### 6-3. 대시보드 접속
- 대시보드: `http://127.0.0.1:8080/`
- 헬스체크: `http://127.0.0.1:8080/healthz`

## 7) 대시보드 사용 순서

1. 설정 탭에서 Telegram / Groq / Gemini 키 입력
2. 필요 시 Copilot 로그인 시작
   - Copilot Premium 사용량 조회용 권한 1회 부여:
     - `gh auth refresh -h github.com -s user`
3. OTP 요청 → OTP 인증
4. 대화/코딩/루틴 탭에서 작업

## 8) 텔레그램 연동

### 8-1. 최초 설정
1. BotFather에서 봇 생성 후 Bot Token 발급
2. 봇 대화창에서 `/start` 1회 전송
3. Chat ID 확인
4. 설정 탭에 Bot Token/Chat ID 저장

### 8-2. `/help` 체계
- `/help` : 요약 도움말
- `/help llm` : LLM 모드/모델 제어 상세
- `/help routine` : 루틴 명령 상세
- `/help natural` : 자연어 제어 상세

### 8-3. 텔레그램 명령어

#### 시스템
- `/metrics`
- `/kill <pid>`

#### 루틴
- `/routine list`
- `/routine create <요청>`
- `/routine run <routine-id>`
- `/routine on <routine-id>`
- `/routine off <routine-id>`
- `/routine delete <routine-id>`

#### 프리셋
- `/talk [low|high]`
- `/code [low|high]`

#### 빠른 모델 전환
- `/model groq`
- `/model gemini`
- `/model copilot`

#### LLM 상세 제어
- `/llm status`
- `/llm models [groq|copilot|all]`
- `/llm usage` (Gemini + Copilot Premium + Groq 사용량/한도)
- `/llm mode <single|orchestration|multi>`
- `/llm single provider <groq|gemini|copilot>`
- `/llm single model <model-id>`
- `/llm orchestration provider <auto|groq|gemini|copilot>`
- `/llm orchestration model <model-id>`
- `/llm multi groq <model-id>`
- `/llm multi copilot <model-id>`
- `/llm multi summary <auto|groq|gemini|copilot>`

### 8-4. 자연어 제어(슬래시 없이)
아래처럼 일반 문장으로도 설정 변경이 가능합니다.
- `llm mode multi`
- `단일 모드로 바꿔`
- `코딩 프리셋 high로`
- `Groq 모델 openai/gpt-oss-120b로 변경`
- `루틴 목록 보여줘`
- `루틴 생성: 매일 오전 8시 뉴스 요약`
- `메트릭 보여줘`

## 9) 환경 변수

### 9-1. 서버/경로
- `OMNINODE_WS_PORT` (기본 `8080`)
- `OMNINODE_CORE_SOCKET_PATH` (기본 `/tmp/omninode_core.<uid>.sock`)
- `OMNINODE_DASHBOARD_INDEX`
- `OMNINODE_WORKSPACE_ROOT` (기본 `<repo>/coding`)

### 9-2. 텔레그램
- `OMNINODE_TELEGRAM_BOT_TOKEN`
- `OMNINODE_TELEGRAM_CHAT_ID`
- `OMNINODE_TELEGRAM_ALLOWED_USER_ID`

### 9-3. LLM/Copilot
- `OMNINODE_GROQ_API_KEY`
- `OMNINODE_GEMINI_API_KEY`
- `OMNINODE_GROQ_BASE_URL`
- `OMNINODE_GEMINI_BASE_URL`
- `OMNINODE_GROQ_MODEL` (기본 `meta-llama/llama-4-scout-17b-16e-instruct`)
- `OMNINODE_GEMINI_MODEL` (기본 `gemini-3-flash-preview`)
- `OMNINODE_COPILOT_MODEL` (기본 `gpt-5-mini`)
- `OMNINODE_COPILOT_BIN` (기본 `gh`)
- `OMNINODE_COPILOT_DIRECT_BIN` (기본 `copilot`)

### 9-4. 성능/제한
- `OMNINODE_CHAT_MAX_OUTPUT_TOKENS` (기본 `8192`)
- `OMNINODE_CODING_MAX_OUTPUT_TOKENS` (기본 `16384`)
- `OMNINODE_LLM_TIMEOUT_SEC` (기본 `20`)
- `OMNINODE_CODE_EXEC_TIMEOUT_SEC` (기본 `120`)
- `OMNINODE_CODING_AGENT_MAX_ITERATIONS` (기본 `6`)
- `OMNINODE_CODING_AGENT_MAX_ACTIONS` (기본 `8`)
- `OMNINODE_CODING_COPILOT_MAX_ACTIONS` (기본 `2`)
- `OMNINODE_CODING_SNAPSHOT_MAX_ENTRIES` (기본 `80`)
- `OMNINODE_CODING_COPILOT_HISTORY` (기본 `2`)
- `OMNINODE_CODING_ENABLE_ONESHOT_UI_CLONE` (기본 `true`)

### 9-5. 운영 하드닝
- `OMNINODE_WS_MAX_MESSAGE_BYTES` (기본 `131072`)
- `OMNINODE_WS_COMMANDS_PER_MINUTE` (기본 `30`)
- `OMNINODE_METRICS_PUSH_INTERVAL_SEC` (기본 `2`)
- `OMNINODE_COMMAND_MAX_LENGTH` (기본 `800`)
- `OMNINODE_AUDIT_LOG_PATH` (기본 `/tmp/omninode_audit.log`)
- `OMNINODE_ENABLE_HEALTH_ENDPOINT` (기본 `true`)
- `OMNINODE_ENABLE_LOCAL_OTP_FALLBACK` (기본 `true`)
- `OMNINODE_KILL_ALLOWLIST`

### 9-6. 상태 파일 경로
- `OMNINODE_LLM_USAGE_STATE_PATH`
- `OMNINODE_COPILOT_USAGE_STATE_PATH`
- `OMNINODE_CONVERSATION_STATE_PATH`
- `OMNINODE_AUTH_SESSION_STATE_PATH`
- `OMNINODE_MEMORY_NOTES_DIR`
- `OMNINODE_CODE_RUNS_DIR`

## 10) 배포 템플릿

- Linux: `deploy/linux/omninode.service`
- macOS: `deploy/macos/com.omninode.agent.plist`

샘플 파일의 실행 경로는 환경에 맞게 수정 후 사용하세요.

## 11) 트러블슈팅

### 11-1. 대시보드 접속은 되는데 인증/응답이 안 됨
- 코어/미들웨어 프로세스가 모두 실행 중인지 확인
- `/healthz` 응답 확인
- OTP 요청 후 인증을 완료했는지 확인

### 11-2. Telegram 응답 없음
- Bot Token/Chat ID/Allowed User ID 확인
- 봇 대화창에서 `/start` 선행 여부 확인
- 설정 탭 `테스트 전송`으로 연결 확인

### 11-3. Groq 429
- 잠시 후 재시도
- Telegram은 자동 전환 정책에 따라 qwen/llama로 폴백
- 필요 시 `/llm usage`로 잔여량 확인

### 11-4. Copilot 관련 오류
- `gh`/`copilot` 설치 여부 확인
- 설정 탭에서 로그인 시작 후 상태 조회
- 모델 목록 새로고침 후 재선택

### 11-5. 코딩 실행 결과가 예상과 다름
- 코딩 탭의 변경 파일 카드에서 실제 생성 경로 확인
- 실행 로그 보기 버튼으로 stdout/stderr 확인

### 11-6. `Copilot Premium 조회 실패: -` 또는 사용률 0%가 비정상
- GitHub 토큰 스코프 확인:
  - `gh auth status -h github.com`
  - `user` 스코프가 없으면:
    - `gh auth refresh -h github.com -s user`
- 미들웨어 재시작 후 대시보드 강력 새로고침(`Cmd+Shift+R`)
- 설정 탭에서 `Copilot 사용량 새로고침` 재실행
- 참고: GitHub usage API가 월 quota를 직접 주지 않는 경우, Omni-node는 기본 quota `300`으로 사용률을 추정합니다.

## 12) 운영 체크리스트

- [ ] `omninode_core` 실행 확인
- [ ] `.NET 9` 미들웨어 실행 확인
- [ ] 대시보드 접속 및 OTP 인증
- [ ] Telegram 연동 저장 및 테스트 전송
- [ ] Groq/Gemini 키 설정
- [ ] Copilot 인증 상태 확인
- [ ] 대화/코딩/루틴 탭 정상 동작 확인
- [ ] `/help`, `/help llm`, `/help routine`, `/help natural` 확인
