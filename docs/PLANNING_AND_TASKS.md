# Omni-node Planning And Tasks

업데이트 기준: 2026-03-10

이 문서는 현재 코드 기준의 작업 계획과 Background Task Graph 기능 사용법을 정리합니다.

## 1. 현재 범위

지금 구현된 Planning 기능은 아래 흐름을 지원합니다.

- 계획 생성
- 계획 리뷰
- 계획 승인
- 승인된 계획 실행
- `fast` / `interview` 생성 모드
- `~/.omninode/plans/` 영속 저장

지금 구현된 Background Task Graph 기능은 아래 흐름을 지원합니다.

- plan -> task graph 생성
- task graph 목록/상세 조회
- task graph 실행
- 개별 task 취소
- task stdout/stderr/result.json 조회
- `~/.omninode/tasks/`와 `workspace/.runtime/tasks/` 상태 복구

계획 리뷰는 휴리스틱 점검과 reviewer 라우트 LLM 요약을 함께 사용합니다. 따라서 단계 수 부족, 제약 누락, 검증 공백, rollback 부재 같은 위험을 먼저 잡고, reviewer 모델 요약이 그 아래에 추가됩니다.

주의:

- 현재 `Run plan`은 승인된 계획으로 새 task graph를 만들고 즉시 실행을 시작합니다.
- 실행 완료 상태는 background monitor가 `execution.json`과 plan 상태에 반영합니다.

## 2. 저장 경로

기본 상태 루트는 `~/.omninode`이며 계획 관련 파일은 아래에 저장됩니다.

```text
~/.omninode/plans/index.json
~/.omninode/plans/<plan-id>/plan.json
~/.omninode/plans/<plan-id>/review.json
~/.omninode/plans/<plan-id>/execution.json
```

Task Graph 관련 기본 경로는 아래와 같습니다.

```text
~/.omninode/tasks/index.json
~/.omninode/tasks/<graph-id>.json
workspace/.runtime/tasks/<graph-id>/<task-id>/stdout.log
workspace/.runtime/tasks/<graph-id>/<task-id>/stderr.log
workspace/.runtime/tasks/<graph-id>/<task-id>/result.json
```

## 3. 슬래시 명령

웹 명령창과 텔레그램에서 공통으로 아래 명령을 사용할 수 있습니다.

```text
/plan list
/plan get <plan-id>
/plan create [--mode fast|interview] [--constraint <제약>]... <요청>
/plan review <plan-id>
/plan approve <plan-id>
/plan run <plan-id>
/task list
/task create <plan-id>
/task status <graph-id>
/task run <graph-id>
/task cancel <graph-id> <task-id>
/task output <graph-id> <task-id>
```

텔레그램에서는 slash 없이도 `계획 생성 ...`, `계획 리뷰 plan_...`, `작업 상태 graph_...`, `task output ...` 같은 자연어/command-like 입력이 같은 명령층으로 연결됩니다.

예시:

```text
/plan create AGENTS.md와 첨부 설계를 반영해 doctor 기능 구현
/plan create --constraint 사용자가 요청한 내용 외 변경 금지 --constraint 문서도 같이 수정 대시보드 plans 패널 추가
/plan review plan_20260308123000001
/plan approve plan_20260308123000001
/plan run plan_20260308123000001
/task create plan_20260308123000001
/task run graph_20260308123500001
/task status graph_20260308123500001
```

## 4. 대시보드

설정 탭에 `작업 계획` 패널과 `Background Task Graph` 패널이 추가되었습니다.

- 요청과 제약사항을 입력해 계획 생성
- `fast` 또는 `interview` 모드 선택
- 저장된 계획 목록 조회
- 선택한 계획 상세 보기
- 리뷰, 승인, 실행 버튼 사용
- 선택한 plan id로 task graph 생성
- graph별 task 상태, dependency, 로그 tail 확인
- running/pending task 취소
- 개별 task의 `stdout`, `stderr`, `result.json` 확인

모바일 레이아웃에서는 설정 탭 안의 `계획` 섹션에서 같은 기능을 사용할 수 있습니다.

## 5. 현재 실행 의미

`Run plan`은 이제 아래 흐름으로 동작합니다.

1. 승인된 plan으로 새 task graph 생성
2. 생성된 graph를 즉시 실행
3. plan 상태를 `Running`으로 저장
4. background monitor가 graph 종료를 감시
5. 종료 후 `execution.json`과 plan 상태를 `Completed` 또는 `Approved`로 갱신

Task Graph 실행기의 동작은 아래와 같습니다.

1. 선택한 plan으로 graph 생성
2. graph 안의 ready node를 category 기준으로 실행
3. coding/refactor/documentation/verification은 단일 workspace lane에서 순차 실행
4. analysis/research 계열은 병렬 실행 가능
5. 상태와 로그를 파일로 남기고 세션 재접속 후 다시 조회 가능

실무 권장 흐름:

1. 큰 작업이면 먼저 `작업 계획`에서 범위를 고정
2. `리뷰`로 빠진 검증과 리스크 확인
3. 승인 후 `Run plan` 또는 `Task graph`로 실행
4. 끝난 뒤 `Notebook / Handoff`에서 `decision`, `verification` 기록

## 6. 검증 포인트

Planning 추가 후 최소 확인 순서는 아래입니다.

```bash
dotnet build apps/omninode-middleware/OmniNode.Middleware.csproj
node --check apps/omninode-dashboard/app.js
node --check apps/omninode-dashboard/modules/plans-renderers.js
node --check apps/omninode-dashboard/modules/task-graph-renderers.js
```

가능하면 대시보드 설정 탭에서 아래 시나리오도 같이 확인합니다.

1. 계획 생성
2. 계획 리뷰
3. 계획 승인
4. 계획 실행
5. `~/.omninode/plans/` 파일 생성 확인
6. `/task create <plan-id>`
7. `/task run <graph-id>`
8. `~/.omninode/tasks/` 및 `workspace/.runtime/tasks/` 파일 생성 확인
