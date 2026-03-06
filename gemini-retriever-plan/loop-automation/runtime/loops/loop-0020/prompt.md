당신은 Omni-node Gemini 전환 자동 개발 루프를 수행하는 Codex 에이전트입니다.

반드시 아래 문서를 기준으로 작업하세요.
- GEMINI_SEARCH_RETRIEVER_INTEGRATION_PLAN.md
- gemini-retriever-plan/loop-automation/runtime/state/CURRENT_STATUS.md
- gemini-retriever-plan/loop-automation/runtime/state/CURRENT_REMAINING_TASKS.md
- gemini-retriever-plan/loop-automation/runtime/state/CURRENT_UNRESOLVED_ERRORS.md

이전 루프 참조 경로:
- gemini-retriever-plan/loop-automation/runtime/loops/loop-0019

현재 루프 번호: 20
현재 루프 리포트 경로: gemini-retriever-plan/loop-automation/runtime/loops/loop-0020

정책 강제:
- GeminiKeySource = keychain | secure_file_600
- GeminiKeyRequiredFor = test, validation, regression, production_run
- 현재 운영 범위 = 로컬 + 텔레그램 봇
- guard webhook/log collector live URL 미설정은 비차단 백로그로 처리

이번 루프 실행 규칙:
1) 활성 단계(P0~P7)에서 구현 가능한 최소 단위 1개를 수행하세요.
2) 검색은 Gemini grounding 단일 경로를 사용하세요.
3) 생성은 멀티 제공자 경로를 유지하세요.
4) fail-closed와 count-lock 기준을 유지하세요.
5) 아래 파일을 모두 갱신하세요.
   - gemini-retriever-plan/loop-automation/runtime/loops/loop-0020/01_work_done.md
   - gemini-retriever-plan/loop-automation/runtime/loops/loop-0020/02_remaining_tasks.md
   - gemini-retriever-plan/loop-automation/runtime/loops/loop-0020/03_unresolved_errors.md
   - gemini-retriever-plan/loop-automation/runtime/loops/loop-0020/04_passed_runs.md
   - gemini-retriever-plan/loop-automation/runtime/loops/loop-0020/05_changed_files.md
   - gemini-retriever-plan/loop-automation/runtime/loops/loop-0020/06_next_loop_focus.md
6) 누적 상태 파일을 갱신하세요.
   - gemini-retriever-plan/loop-automation/runtime/state/CURRENT_STATUS.md
   - gemini-retriever-plan/loop-automation/runtime/state/CURRENT_REMAINING_TASKS.md
   - gemini-retriever-plan/loop-automation/runtime/state/CURRENT_UNRESOLVED_ERRORS.md
7) 로컬+텔레그램 운영 범위에서 필수인 항목을 우선 처리하세요.
   - 대화/코딩/텔레그램 경로 품질/회귀를 우선
   - 외부 관제 URL(webhook/log collector) 연동은 사용자 요청 시에만 진행

리포트 작성 규칙:
- 한국어로 작성하세요.
- 실행 명령, 수정 파일, 검증 결과를 근거 중심으로 기록하세요.
- 다음 루프 우선 작업은 3개 이내로 작성하세요.

작업 완료 후 마지막 줄에 아래 토큰을 적으세요:
LOOP_DONE
