# AGENTS / Skills / Commands 가이드

업데이트 기준: 2026-03-10

이 문서는 Omni-node가 프로젝트 문맥을 어떻게 읽는지, 어떤 파일을 보존해야 하는지, 새 문맥 파일을 어떻게 구성하면 되는지 빠르게 확인하기 위한 실무용 가이드입니다.

## 1. 문맥 탐색 순서

Omni-node의 project context 스캔은 아래 순서로 정보를 모읍니다.

1. 전역 instruction: `~/.omninode/AGENTS.md`
2. 프로젝트 루트와 현재 작업 디렉터리 사이의 `AGENTS.override.md`, `AGENTS.md`
3. fallback 문서: 기본값은 `TEAM_GUIDE.md`, `.agents.md`
4. 프로젝트 skill: `<project-root>/.omni/skills/**/SKILL.md`
5. 전역 skill: `~/.omninode/skills/**/SKILL.md`
6. 프로젝트 command template: `<project-root>/.omni/commands/*.md`
7. 전역 command template: `~/.omninode/commands/*.md`

핵심 규칙:

- 가까운 디렉터리의 `AGENTS.override.md`가 가장 구체적인 지시로 취급됩니다.
- `AGENTS.md`는 일반 규칙, `AGENTS.override.md`는 하위 경로 전용 예외 규칙에 적합합니다.
- fallback 문서는 instruction으로 합쳐지지만, 이름은 환경변수로 바꿀 수 있습니다.

## 2. 바로 쓰는 체크리스트

프로젝트 문맥을 추가할 때는 아래 네 가지만 확인하면 됩니다.

1. 저장소 루트 `AGENTS.md`에 전체 규칙을 둡니다.
2. 특정 앱 하위 디렉터리에만 예외가 있으면 `AGENTS.override.md`를 둡니다.
3. 재사용 가능한 작업 패턴은 `.omni/skills/<name>/SKILL.md`로 분리합니다.
4. 반복 프롬프트는 `.omni/commands/<name>.md`로 분리합니다.

설정 탭 대응:

- 설정 탭 `프로젝트 문맥` 패널의 `문맥 스캔`은 이 문서에서 설명한 순서대로 instruction source를 다시 읽습니다.
- 같은 패널에서 `skills 새로고침`, `commands 새로고침`은 `.omni/skills`, `.omni/commands`와 전역 경로를 다시 조회합니다.

## 3. 권장 디렉터리 예시

```text
Omni-node/
├── AGENTS.md
├── TEAM_GUIDE.md
├── apps/
│   └── omninode-dashboard/
│       └── AGENTS.override.md
└── .omni/
    ├── skills/
    │   └── ui-review/
    │       └── SKILL.md
    └── commands/
        └── review-release.md
```

## 4. 예시 템플릿

### 4.1 루트 `AGENTS.md`

```md
# 프로젝트 공통 규칙

- 모든 응답은 한국어로 작성한다.
- 사용자가 요청한 범위 밖 구조 변경은 하지 않는다.
- 검증 가능한 변경이면 build 또는 check를 함께 실행한다.
```

### 4.2 하위 `apps/omninode-dashboard/AGENTS.md`

```md
# 대시보드 전용 예외

- app.js는 조립만 담당하고 새 로직은 modules/에 둔다.
- 새 패널을 추가하면 상태, 렌더러, WebSocket 처리 지점을 같이 수정한다.
```

`AGENTS.override.md`도 계속 지원하지만, 현재 저장소는 앱 단위 규칙을 `apps/omninode-dashboard/AGENTS.md`, `apps/omninode-middleware/AGENTS.md`처럼 하위 `AGENTS.md`로 두는 방식을 함께 사용한다.

### 4.3 `.omni/skills/ui-review/SKILL.md`

```md
---
name: ui-review
description: 대시보드 패널 추가 전 레이아웃, 모바일 깨짐, 상태 흐름을 점검한다.
---

새 설정 패널을 추가할 때는 desktop grid, mobile section, ws message 처리 여부를 먼저 확인한다.
```

### 4.4 `.omni/commands/review-release.md`

```md
# release-check

목표:
- 이번 변경에서 배포 직전 확인해야 할 리스크만 짧게 정리한다.

출력:
- 변경 영향
- 검증 결과
- 남은 리스크
```

## 5. 환경변수

문맥 스캔 동작은 아래 환경변수로 조절합니다.

| 환경변수 | 기본값 | 의미 |
|---|---|---|
| `OMNINODE_PROJECT_CONTEXT_FALLBACK_FILENAMES` | `TEAM_GUIDE.md,.agents.md` | 함께 읽을 fallback 파일 목록 |
| `OMNINODE_PROJECT_CONTEXT_MAX_BYTES` | `65536` | instruction 병합 텍스트 최대 바이트 |

## 6. 보존 규칙

아래 경로는 재생성 캐시가 아니라 프로젝트 문맥 원본입니다.

- `AGENTS.md`
- `AGENTS.override.md`
- `.omni/skills/`
- `.omni/commands/`
- `~/.omninode/AGENTS.md`
- `~/.omninode/skills/`
- `~/.omninode/commands/`

정리 기준은 [docs/CLEANUP.md](./CLEANUP.md)도 함께 봅니다.
