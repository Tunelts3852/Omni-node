# Loop 0014 - 변경 파일

## 이번 루프에서 수정/생성한 파일

1. `omninode-dashboard/app.js`
- `count_lock_unsatisfied_rate` 임계치 2차 튜닝 반영
- `warn: 0.2 -> 0.1`
- `critical: 0.3 -> 0.2`

2. `omninode-dashboard/check-guard-threshold-lock.js`
- `count_lock_unsatisfied_rate` 고정 회귀 정규식을 2차 튜닝 값으로 동기화

3. `gemini-retriever-plan/loop-automation/runtime/loops/loop-0014/01_work_done.md`
- 루프 14 작업 완료 내역 기록

4. `gemini-retriever-plan/loop-automation/runtime/loops/loop-0014/02_remaining_tasks.md`
- 루프 14 기준 잔여 작업 갱신

5. `gemini-retriever-plan/loop-automation/runtime/loops/loop-0014/03_unresolved_errors.md`
- 루프 14 기준 미해결 오류 갱신

6. `gemini-retriever-plan/loop-automation/runtime/loops/loop-0014/04_passed_runs.md`
- 루프 14 통과 실행/검증 기록

7. `gemini-retriever-plan/loop-automation/runtime/loops/loop-0014/05_changed_files.md`
- 루프 14 변경 파일 목록 갱신

8. `gemini-retriever-plan/loop-automation/runtime/loops/loop-0014/06_next_loop_focus.md`
- 다음 루프 우선 작업 갱신

9. `gemini-retriever-plan/loop-automation/runtime/state/CURRENT_STATUS.md`
- 누적 상태 갱신(`count_lock_unsatisfied_rate` 2차 튜닝 1건 반영)

10. `gemini-retriever-plan/loop-automation/runtime/state/CURRENT_REMAINING_TASKS.md`
- 누적 남은 작업 갱신(2차 튜닝 잔여 1개 규칙 기준으로 재정리)

11. `gemini-retriever-plan/loop-automation/runtime/state/CURRENT_UNRESOLVED_ERRORS.md`
- 누적 미해결 오류 갱신(2차 튜닝 부분 적용 상태 갱신)
