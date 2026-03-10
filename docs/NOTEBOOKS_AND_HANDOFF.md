# Omni-node Notebooks And Handoff

업데이트 기준: 2026-03-10

이 문서는 현재 코드 기준의 notebook / handoff 기능 저장 위치, 사용 흐름, 템플릿을 정리합니다.

## 1. 현재 범위

지금 구현된 범위는 아래와 같습니다.

- 프로젝트별 `learnings.md`, `decisions.md`, `verification.md`, `handoff.md` 영속 저장
- 대시보드 Settings 탭의 `Notebook / Handoff` 패널
- 웹 슬래시 명령과 텔레그램 명령
- WebSocket `notebook_get`, `notebook_append`, `handoff_create`
- doctor / plan / task graph / refactor 결과를 notebook으로 빠르게 옮기는 보조 버튼

핵심 원칙:

- 비워 둔 `projectKey`는 현재 프로젝트 루트 기준으로 자동 계산됩니다.
- append는 markdown 문서에 `## <Kind> · <timestamp>` 블록으로 누적됩니다.
- handoff는 learnings / decisions / verification 미리보기를 모아 새 `handoff.md`를 다시 생성합니다.
- handoff의 `## Next` 구간은 기록 유무에 따라 다음 액션 제안을 자동으로 채웁니다.

## 2. 저장 경로

기본 상태 루트는 `~/.omninode`입니다.

```text
~/.omninode/notebooks/<project-key>/learnings.md
~/.omninode/notebooks/<project-key>/decisions.md
~/.omninode/notebooks/<project-key>/verification.md
~/.omninode/notebooks/<project-key>/handoff.md
```

정리 기준:

- 이 경로는 재생성 캐시가 아니라 세션 간 인수인계 원본입니다.
- 장기 작업을 이어갈 계획이면 삭제하지 않는 편이 맞습니다.

## 3. 사용 방법

### 3.1 슬래시 명령

```text
/notebook show [project-key]
/notebook append <learning|decision|verification> <내용>
/handoff [project-key]
```

예시:

```text
/notebook show
/notebook append decision plan_run은 task graph를 통해 실행한다
/notebook append verification doctor 결과에서 fail check는 없었다
/handoff
```

텔레그램에서는 slash 없이도 `노트북 보여줘`, `verification 노트에 ... 추가해`, `handoff 만들어줘` 같은 자연어/command-like 입력을 같은 경로로 보낼 수 있습니다.

### 3.2 대시보드

설정 탭에 `Notebook / Handoff` 패널이 추가되었습니다.

- `project key`를 직접 입력하거나 비워 두고 현재 프로젝트 키를 사용
- `append kind` 선택 후 자유 입력으로 기록 추가
- `선택 plan -> decision`
- `선택 graph -> verification`
- `doctor -> verification`
- `refactor -> verification`
- `Handoff 생성`

자동 템플릿 버튼 의미:

- `선택 plan -> decision`: 현재 선택한 plan의 목표, 제약사항, review 요약, 최근 execution 상태를 decision 템플릿으로 변환
- `선택 graph -> verification`: 현재 선택한 task graph와 선택 task의 결과를 verification 템플릿으로 변환
- `doctor -> verification`: 최근 doctor 보고서의 warn/fail 중심 요약을 verification으로 기록
- `refactor -> verification`: 최근 refactor preview와 이슈 목록을 verification으로 기록

모바일 세로 레이아웃에서는 Settings 탭의 `노트` 섹션에서 같은 기능을 사용합니다.

## 4. 바로 쓰는 템플릿

### 4.1 learning

```text
문제:
- 무엇이 반복해서 막혔는가

교훈:
- 다음 세션에서 바로 적용할 규칙

근거:
- 어떤 증상, 로그, 결과를 보고 그렇게 판단했는가
```

### 4.2 decision

```text
결정:
- 무엇을 하기로 했는가

이유:
- 왜 이 방향을 선택했는가

보류한 대안:
- 이번에는 하지 않기로 한 선택지
```

### 4.3 verification

```text
검증 대상:
- 무엇을 확인했는가

실행:
- 어떤 명령, 어떤 UI 흐름, 어떤 보고서를 사용했는가

결과:
- 성공/실패와 핵심 수치 또는 메시지
```

## 5. handoff 체크리스트

handoff를 만들기 전에 최소 아래 세 줄은 채우는 편이 안전합니다.

1. 가장 최근 decision 1개 이상
2. 가장 최근 verification 1개 이상
3. 다음 세션이 바로 이어받을 수 있는 next action 한 줄

권장 순서:

1. 변경 완료 후 verification append
2. 방향이 바뀌었으면 decision append
3. handoff 생성

## 6. 검증 포인트

최소 검증 순서는 아래입니다.

```bash
dotnet build apps/omninode-middleware/OmniNode.Middleware.csproj
node --check apps/omninode-dashboard/app.js
node --check apps/omninode-dashboard/modules/notebooks-state.js
node --check apps/omninode-dashboard/modules/notebooks-renderers.js
node --check apps/omninode-dashboard/modules/ws-notebooks.js
```

가능하면 실제로 아래 시나리오도 확인합니다.

1. notebook 조회
2. decision append
3. verification append
4. handoff 생성
5. `~/.omninode/notebooks/<project-key>/` 아래 파일 생성 확인

권장 운영 루틴:

1. 작업 도중 반복 교훈은 `learning`
2. 방향을 바꾼 이유는 `decision`
3. 실제 실행/검증 결과는 `verification`
4. 세션 종료 직전 `Handoff 생성`
