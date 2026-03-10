# Omni-node 미들웨어 AGENTS

이 디렉터리는 C# 미들웨어 본체다. 아래 규칙을 우선 따른다.

## 구조 규칙

- `CommandService`는 기능별 partial 파일에 책임을 나눈다.
- WebSocket 명령은 가능한 한 `Ws*Dispatcher`에 추가하고, `WebSocketGateway`는 조립에 집중시킨다.
- 애플리케이션 계층은 `src/Application/` 아래의 얇은 wrapper 또는 도메인 서비스로 둔다.
- 새 상태 파일이나 디렉터리를 도입하면 `Infrastructure/Persistence`, `Infrastructure/Paths`, 문서를 함께 갱신한다.

## 변경 원칙

- 기존 검색 가드, 루틴, 텔레그램 흐름을 우회하지 않는다.
- 외부 도구 상태 점검이나 CLI 분기는 `Program.cs`에서 명시적으로 처리한다.
- 직렬화 형식이 추가되면 WebSocket, CLI, 저장 파일 간 형식을 일관되게 유지한다.

## 검증

- 기본: `dotnet build apps/omninode-middleware/OmniNode.Middleware.csproj`
- 통합: `npm test`
- 샌드박스 연계가 있으면 `python3 apps/omninode-sandbox/executor.py --code "print('ok')"`까지 확인한다.
