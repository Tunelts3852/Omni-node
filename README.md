# Omni-node

업데이트 기준: 2026-03-07

Omni-node는 로컬 PC 제어, LLM 오케스트레이션, 코딩 자동 실행, 텔레그램 연동, 메모리 노트, 웹 검색 보강, 루틴 스케줄링을 한 저장소에 모아 둔 로컬 에이전트 프로젝트입니다.

이 저장소는 제품 소스만 있는 단일 애플리케이션 저장소가 아닙니다. 실제 런타임 소스, 운영 문서, 회귀 스크립트, 실험용 작업공간, 런타임 산출물까지 함께 들어 있습니다.

## 한눈에 보기

- 실제 런타임 중심 모듈: `omninode-core/`, `omninode-middleware/`, `omninode-dashboard/`, `omninode-sandbox/`
- 작업공간/산출물: `coding/`, `.runtime/`, `runtime/`
- 설계/계획 문서: `gemini-retriever-plan/`, 루트 운영 문서들
- 테스트 도구: Playwright, Node 기반 회귀 스크립트, GitHub Actions 워크플로

## 빠른 시작

권장 순서는 `코어 -> 미들웨어 -> 대시보드 접속`입니다.

```bash
make -C omninode-core
./omninode-core/omninode_core
```

다른 터미널에서:

```bash
dotnet run --project omninode-middleware/OmniNode.Middleware.csproj
```

접속 주소:

- 대시보드: `http://127.0.0.1:8080/`
- WebSocket: `ws://127.0.0.1:8080/ws/`
- 헬스체크: `http://127.0.0.1:8080/healthz`
- 준비상태: `http://127.0.0.1:8080/readyz`

자세한 실행 절차는 [사용법_빠른시작.md](사용법_빠른시작.md)를 보세요.

## 문서 맵

### 이번에 정리한 루트 문서

| 문서 | 내용 |
|---|---|
| [사용법_빠른시작.md](사용법_빠른시작.md) | 설치 전제조건, 실행 순서, 대시보드/텔레그램 사용 흐름 |
| [기술스택_정리.md](기술스택_정리.md) | 언어, 런타임, 외부 서비스, 테스트/배포 스택 정리 |
| [아키텍처_흐름.md](아키텍처_흐름.md) | 인증, 대화/코딩, 검색 가드, 루틴 실행 흐름 |
| [디렉터리_가이드.md](디렉터리_가이드.md) | 저장소 전체 디렉터리와 주요 파일 안내 |
| [환경변수_및_상태파일.md](환경변수_및_상태파일.md) | 주요 환경변수, 시크릿 로딩 방식, 상태 파일 위치 |
| [검증_가이드.md](검증_가이드.md) | 빌드/스모크/회귀 검증 명령 모음 |

### 기존 루트 문서

| 문서 | 내용 |
|---|---|
| [도구_통합_패널_사용_가이드.md](도구_통합_패널_사용_가이드.md) | 설정 탭 provider/tool/rag 패널 사용법 |
| [토큰_메모리_초기화_가이드.md](토큰_메모리_초기화_가이드.md) | 토큰 한도와 메모리 초기화 절차 |
| [OMNINODE_실환경_수동_최종회귀_체크리스트.md](OMNINODE_실환경_수동_최종회귀_체크리스트.md) | 실환경 수동 점검 체크리스트 |
| [GEMINI_SEARCH_RETRIEVER_INTEGRATION_PLAN.md](GEMINI_SEARCH_RETRIEVER_INTEGRATION_PLAN.md) | Gemini 검색 리트리버 전환 설계 |

## 시스템 개요

```mermaid
flowchart TD
    U["사용자(대시보드)"] --> G["WebSocketGateway"]
    T["텔레그램 사용자"] --> TL["TelegramUpdateLoop"]
    G --> CS["CommandService"]
    TL --> CS
    CS --> PR["ProviderRegistry / ToolRegistry"]
    CS --> LR["LlmRouter"]
    CS --> SG["LegacyGeminiGroundingSearchGateway"]
    CS --> MEM["ConversationStore / MemoryNoteStore / MemorySearchTool"]
    CS --> CODE["UniversalCodeRunner / PythonSandboxClient"]
    CS --> UDS["UdsCoreClient"]
    LR --> P["Gemini / Groq / Cerebras / Copilot / Codex"]
    UDS --> CORE["omninode-core"]
    CODE --> SB["omninode-sandbox"]
```

핵심 구조 요약:

- `omninode-core`: UDS 소켓과 단일 인스턴스 락을 담당하는 얇은 C 데몬
- `omninode-middleware`: 실질적인 본체. HTTP/WebSocket, LLM 라우팅, 메모리, 검색, 루틴, 텔레그램, 코딩 실행을 담당
- `omninode-dashboard`: 번들러 없이 서빙되는 정적 React UMD 대시보드
- `omninode-sandbox`: Python 코드 실행을 제한된 별도 프로세스로 수행

## 저장소 스냅샷

`.git` 제외 기준 현재 워크스페이스에는 총 2,794개 파일이 있습니다.

| 경로 | 파일 수 | 성격 |
|---|---:|---|
| `coding/` | 1,698 | 코딩 작업공간, 예제, 루틴 산출물, 가상환경 |
| `node_modules/` | 549 | Playwright 의존성 |
| `gemini-retriever-plan/` | 303 | 검색 전환 계획 및 루프 자동화 기록 |
| `omninode-middleware/` | 128 | .NET 9 미들웨어 소스와 체크 스크립트 |
| `.runtime/` | 71 | guard 회귀 아티팩트 |
| `omninode-dashboard/` | 19 | 대시보드 UI와 체크 스크립트 |
| `omninode-core/` | 3 | C 코어 데몬 |
| `deploy/` | 3 | systemd/launchd 템플릿 |
| `runtime/` | 2 | 현재 상태 스냅샷 |
| `omninode-sandbox/` | 1 | Python 샌드박스 실행기 |

주의할 점:

- `coding/venv/`, `node_modules/`, `omninode-middleware/bin/`, `omninode-middleware/obj/` 같은 생성 산출물이 저장소 안에 있습니다.
- 루트 `package.json`은 앱 실행 스크립트 저장소가 아니라 Playwright 개발 의존성 선언에 가깝습니다.
- 프런트엔드는 별도 dev server가 아니라 미들웨어가 정적 파일을 직접 서빙합니다.

## 현재 구현 관점에서 중요한 포인트

- 자동 제공자 우선순위는 `gemini -> groq -> cerebras -> copilot -> codex` 순서입니다.
- 검색 경로는 `GeminiGroundedRetriever` 기반의 Gemini grounding 단일 경로입니다.
- 검색 응답은 `SearchAnswerGuard`의 fail-closed 정책을 통과해야 하며, 근거가 부족하면 답변이 차단됩니다.
- 대시보드는 OTP 기반 인증을 사용하고, 텔레그램이 미설정이면 로컬 OTP fallback 로그로도 인증할 수 있습니다.
- 루틴은 `~/.omninode/routines.json` 상태와 `coding/routines/` 실행 산출물을 함께 사용합니다.

## 대표 진입 파일

| 경로 | 역할 |
|---|---|
| `omninode-core/src/main.c` | 단일 인스턴스 락과 UDS 서버 |
| `omninode-middleware/src/Program.cs` | 전체 서비스 조립과 실행 진입점 |
| `omninode-middleware/src/WebSocketGateway.cs` | HTTP/WS 엔드포인트, 인증, 대시보드 서빙 |
| `omninode-middleware/src/CommandService.Commands.cs` | 대화/코딩/루틴 핵심 로직 |
| `omninode-dashboard/index.html` | 대시보드 HTML 진입점 |
| `omninode-dashboard/app.js` | 단일 앱 파일 |
| `omninode-dashboard/worker.js` | 로그/WS 파싱 보조 워커 |
| `omninode-sandbox/executor.py` | Python 샌드박스 실행기 |

## 이번 점검에서 확인한 대표 명령

2026-03-07 현재 아래 명령은 로컬에서 확인했습니다.

```bash
make -C omninode-core
dotnet build omninode-middleware/OmniNode.Middleware.csproj
python3 omninode-sandbox/executor.py --code "print('ok')"
node --check omninode-dashboard/app.js
node --check omninode-dashboard/worker.js
```

보다 자세한 검증 항목은 [검증_가이드.md](검증_가이드.md)를 보세요.
