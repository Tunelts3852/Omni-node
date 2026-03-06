루프 0007 작업을 완료했고, P6 최소 구현 단위 1건으로 `외부 관제(webhook/log collector)` 문구를 비차단 백로그 표준 문구로 통일했습니다.  
검색 경로는 Gemini grounding 단일 경로, 생성 경로 멀티 제공자 유지, fail-closed/count-lock 기준은 그대로 유지했습니다.

갱신한 필수 파일 9개:
- [01_work_done.md](/Users/songhabin/Omni-node/gemini-retriever-plan/loop-automation/runtime/loops/loop-0007/01_work_done.md)
- [02_remaining_tasks.md](/Users/songhabin/Omni-node/gemini-retriever-plan/loop-automation/runtime/loops/loop-0007/02_remaining_tasks.md)
- [03_unresolved_errors.md](/Users/songhabin/Omni-node/gemini-retriever-plan/loop-automation/runtime/loops/loop-0007/03_unresolved_errors.md)
- [04_passed_runs.md](/Users/songhabin/Omni-node/gemini-retriever-plan/loop-automation/runtime/loops/loop-0007/04_passed_runs.md)
- [05_changed_files.md](/Users/songhabin/Omni-node/gemini-retriever-plan/loop-automation/runtime/loops/loop-0007/05_changed_files.md)
- [06_next_loop_focus.md](/Users/songhabin/Omni-node/gemini-retriever-plan/loop-automation/runtime/loops/loop-0007/06_next_loop_focus.md)
- [CURRENT_STATUS.md](/Users/songhabin/Omni-node/gemini-retriever-plan/loop-automation/runtime/state/CURRENT_STATUS.md)
- [CURRENT_REMAINING_TASKS.md](/Users/songhabin/Omni-node/gemini-retriever-plan/loop-automation/runtime/state/CURRENT_REMAINING_TASKS.md)
- [CURRENT_UNRESOLVED_ERRORS.md](/Users/songhabin/Omni-node/gemini-retriever-plan/loop-automation/runtime/state/CURRENT_UNRESOLVED_ERRORS.md)

추가로 히스토리 루프 문서(0001/0002/0003/0004/0006)의 `03_unresolved_errors.md` 문구도 동일 표준으로 통일했습니다.

검증:
- `rg -n "guard webhook/log collector live URL 미설정 ..."` 대상 파일(상태 2개 + unresolved 6개) 검출 확인
- `rg -n "외부 관제 URL(webhook/log collector) (미연동|실연동 미설정|실연동은)" ...` 미검출(exit 1) 확인

LOOP_DONE