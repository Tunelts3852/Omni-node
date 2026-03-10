# Omni-node 대시보드 AGENTS

이 디렉터리는 정적 대시보드 UI다. 아래 규칙을 우선 따른다.

## 구조 규칙

- `app.js`는 상태 조립과 전체 흐름 연결 역할에 집중한다.
- 기능별 로직은 `modules/`에 우선 추가한다.
- 새 패널을 넣을 때는 상태, 렌더러, WebSocket 메시지 처리 지점을 함께 맞춘다.

## UI 규칙

- 기존 패널 레이아웃, 상태 칩, 버튼 스타일을 우선 재사용한다.
- 모바일 세로 레이아웃에서도 패널이 무너지지 않도록 responsive 분기를 함께 본다.
- 서버 이벤트 이름은 대시보드 상태 키와 최대한 직접적으로 대응시킨다.

## 검증

- 기본: `npm test`
- 필요 시: `node --check apps/omninode-dashboard/app.js`
- 필요 시: `node --check apps/omninode-dashboard/worker.js`
