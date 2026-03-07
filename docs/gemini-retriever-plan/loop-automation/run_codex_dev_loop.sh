#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$SCRIPT_DIR"
PLAN_DIR="$(cd "$AUTOMATION_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$PLAN_DIR/.." && pwd)"

RUNTIME_DIR="$AUTOMATION_DIR/runtime"
LOOPS_DIR="$RUNTIME_DIR/loops"
STATE_DIR="$RUNTIME_DIR/state"
STOP_FILE="$RUNTIME_DIR/STOP"
RUN_FILE="$RUNTIME_DIR/RUNNING"
LOCK_DIR="$RUNTIME_DIR/LOCK"
INDEX_FILE="$RUNTIME_DIR/LOOP_INDEX.md"
LAST_LOOP_FILE="$STATE_DIR/last_loop_number.txt"

CODEX_BIN="${CODEX_BIN:-codex}"
CODEX_MODEL="${CODEX_MODEL:-}"
CODEX_EXEC_EXTRA_FLAGS="${CODEX_EXEC_EXTRA_FLAGS:-}"
MAX_LOOPS="${MAX_LOOPS:-0}"
LOOP_SLEEP_SEC="${LOOP_SLEEP_SEC:-2}"
AUTO_CLEAR_STOP="${AUTO_CLEAR_STOP:-1}"

export OMNINODE_ACP_OPTION_SMOKE_PROMOTE_WRITE_RESULT_TO_PREVIOUS="${OMNINODE_ACP_OPTION_SMOKE_PROMOTE_WRITE_RESULT_TO_PREVIOUS:-1}"

SESSION_STARTED_AT="$(date '+%Y-%m-%dT%H:%M:%S%z')"
LOOPS_DONE=0

ensure_state_file() {
    local path="$1"
    local title="$2"
    if [[ ! -f "$path" ]]; then
        cat > "$path" <<EOF2
# $title

_자동 루프가 갱신하는 상태 파일입니다._

EOF2
    fi
}

setup_runtime() {
    mkdir -p "$LOOPS_DIR" "$STATE_DIR"
    ensure_state_file "$STATE_DIR/CURRENT_STATUS.md" "현재 진행 상태"
    ensure_state_file "$STATE_DIR/CURRENT_REMAINING_TASKS.md" "남은 개발 항목"
    ensure_state_file "$STATE_DIR/CURRENT_UNRESOLVED_ERRORS.md" "미해결 오류 목록"

    if [[ ! -f "$INDEX_FILE" ]]; then
        cat > "$INDEX_FILE" <<EOF2
# Codex Loop Index

| loop | status | started_at | ended_at | path |
|---|---|---|---|---|
EOF2
    fi
}

acquire_lock() {
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        echo "[loop] 이미 실행 중인 루프가 있습니다: $LOCK_DIR"
        echo "[loop] 상태 확인: bash \"$AUTOMATION_DIR/status_codex_dev_loop.sh\""
        exit 1
    fi
}

cleanup() {
    rm -f "$RUN_FILE"
    rm -rf "$LOCK_DIR"
}

request_stop_on_signal() {
    touch "$STOP_FILE"
    echo "[loop] 중단 신호 수신(Ctrl+C/TERM). 현재 루프 완료 후 안전 종료합니다."
}

next_loop_number() {
    local last=0
    if [[ -f "$LAST_LOOP_FILE" ]]; then
        last="$(cat "$LAST_LOOP_FILE" 2>/dev/null || echo 0)"
    fi
    if [[ ! "$last" =~ ^[0-9]+$ ]]; then
        last=0
    fi
    echo $((last + 1))
}

write_running_file() {
    local loop_id="$1"
    local loop_started="$2"
    local status="$3"
    cat > "$RUN_FILE" <<EOF2
pid=$$
session_started_at=$SESSION_STARTED_AT
workspace_root=$WORKSPACE_ROOT
current_loop=$loop_id
loop_started_at=$loop_started
status=$status
EOF2
}

create_loop_files() {
    local loop_dir="$1"
    local loop_id="$2"
    local started_at="$3"

    mkdir -p "$loop_dir"

    cat > "$loop_dir/01_work_done.md" <<EOF2
# Loop $loop_id - 작업 완료 내역

- 시작 시각: $started_at
- 상태: 작성 필요

## 이번 루프에서 실제로 개발/수정/구현한 내용

EOF2

    cat > "$loop_dir/02_remaining_tasks.md" <<EOF2
# Loop $loop_id - 남은 개발 항목

## 아직 남은 항목

EOF2

    cat > "$loop_dir/03_unresolved_errors.md" <<EOF2
# Loop $loop_id - 미해결 오류

## 처리하지 못한 오류

EOF2

    cat > "$loop_dir/04_passed_runs.md" <<EOF2
# Loop $loop_id - 통과한 실행/검증

## 실행해서 통과한 항목

EOF2

    cat > "$loop_dir/05_changed_files.md" <<EOF2
# Loop $loop_id - 변경 파일

## 이번 루프에서 수정/생성한 파일

EOF2

    cat > "$loop_dir/06_next_loop_focus.md" <<EOF2
# Loop $loop_id - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

EOF2
}

build_prompt_file() {
    local loop_num="$1"
    local loop_rel="$2"
    local prompt_file="$3"
    local prev_loop_rel="$4"

    cat > "$prompt_file" <<EOF2
당신은 Omni-node Gemini 전환 자동 개발 루프를 수행하는 Codex 에이전트입니다.

반드시 아래 문서를 기준으로 작업하세요.
- GEMINI_SEARCH_RETRIEVER_INTEGRATION_PLAN.md
- gemini-retriever-plan/loop-automation/runtime/state/CURRENT_STATUS.md
- gemini-retriever-plan/loop-automation/runtime/state/CURRENT_REMAINING_TASKS.md
- gemini-retriever-plan/loop-automation/runtime/state/CURRENT_UNRESOLVED_ERRORS.md

이전 루프 참조 경로:
- $prev_loop_rel

현재 루프 번호: $loop_num
현재 루프 리포트 경로: $loop_rel

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
   - $loop_rel/01_work_done.md
   - $loop_rel/02_remaining_tasks.md
   - $loop_rel/03_unresolved_errors.md
   - $loop_rel/04_passed_runs.md
   - $loop_rel/05_changed_files.md
   - $loop_rel/06_next_loop_focus.md
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
EOF2
}

append_loop_index() {
    local loop_id="$1"
    local status="$2"
    local started="$3"
    local ended="$4"
    local loop_rel="$5"
    echo "| $loop_id | $status | $started | $ended | $loop_rel |" >> "$INDEX_FILE"
}

main() {
    if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
        echo "[loop] codex 실행 파일을 찾을 수 없습니다: $CODEX_BIN"
        exit 1
    fi

    setup_runtime
    acquire_lock
    trap cleanup EXIT
    trap request_stop_on_signal INT TERM

    if [[ "$AUTO_CLEAR_STOP" == "1" ]]; then
        rm -f "$STOP_FILE"
    fi

    echo "[loop] 시작: $SESSION_STARTED_AT"
    echo "[loop] 워크스페이스: $WORKSPACE_ROOT"
    echo "[loop] 정지 요청 파일: $STOP_FILE"
    echo "[loop] codex 실행 모드: unsandboxed (--dangerously-bypass-approvals-and-sandbox)"
    echo "[loop] ACP 스모크 자동 승격 기본값: OMNINODE_ACP_OPTION_SMOKE_PROMOTE_WRITE_RESULT_TO_PREVIOUS=$OMNINODE_ACP_OPTION_SMOKE_PROMOTE_WRITE_RESULT_TO_PREVIOUS"

    local extra_flags=()
    if [[ -n "$CODEX_EXEC_EXTRA_FLAGS" ]]; then
        # shellcheck disable=SC2206
        extra_flags=($CODEX_EXEC_EXTRA_FLAGS)
    fi

    while true; do
        if [[ -f "$STOP_FILE" ]]; then
            echo "[loop] 정지 요청 감지. 새 루프 시작 없이 종료합니다."
            break
        fi

        if [[ "$MAX_LOOPS" =~ ^[0-9]+$ ]] && (( MAX_LOOPS > 0 )) && (( LOOPS_DONE >= MAX_LOOPS )); then
            echo "[loop] MAX_LOOPS=$MAX_LOOPS 도달. 종료합니다."
            break
        fi

        local loop_num
        loop_num="$(next_loop_number)"
        local loop_id
        loop_id="$(printf '%04d' "$loop_num")"
        local loop_name="loop-$loop_id"
        local loop_dir="$LOOPS_DIR/$loop_name"
        local loop_rel="gemini-retriever-plan/loop-automation/runtime/loops/$loop_name"
        local loop_started
        loop_started="$(date '+%Y-%m-%dT%H:%M:%S%z')"
        local prev_loop_rel="(첫 루프)"
        if (( loop_num > 1 )); then
            prev_loop_rel="gemini-retriever-plan/loop-automation/runtime/loops/loop-$(printf '%04d' $((loop_num - 1)))"
        fi

        create_loop_files "$loop_dir" "$loop_id" "$loop_started"

        local prompt_file="$loop_dir/prompt.md"
        local raw_log_file="$loop_dir/codex_raw.log"
        local last_message_file="$loop_dir/codex_last_message.md"

        build_prompt_file "$loop_num" "$loop_rel" "$prompt_file" "$prev_loop_rel"
        write_running_file "$loop_id" "$loop_started" "running"

        echo "[loop] ===== $loop_name 시작 ====="

        local cmd=("$CODEX_BIN" "exec" "--cd" "$WORKSPACE_ROOT" "--dangerously-bypass-approvals-and-sandbox" "-o" "$last_message_file")
        if [[ -n "$CODEX_MODEL" ]]; then
            cmd+=("--model" "$CODEX_MODEL")
        fi
        if (( ${#extra_flags[@]} > 0 )); then
            cmd+=("${extra_flags[@]}")
        fi
        cmd+=("-")

        : > "$raw_log_file"
        set +e
        (
            trap '' INT TERM
            "${cmd[@]}" < "$prompt_file" >> "$raw_log_file" 2>&1
        ) &
        local codex_pid=$!

        tail -n +1 -f "$raw_log_file" &
        local tail_pid=$!

        while kill -0 "$codex_pid" 2>/dev/null; do
            sleep 1
        done

        wait "$codex_pid"
        local exit_code="$?"

        kill "$tail_pid" >/dev/null 2>&1 || true
        wait "$tail_pid" >/dev/null 2>&1 || true
        set -e

        local loop_ended
        loop_ended="$(date '+%Y-%m-%dT%H:%M:%S%z')"
        local loop_status="ok"
        if (( exit_code != 0 )); then
            loop_status="failed($exit_code)"
            cat >> "$loop_dir/03_unresolved_errors.md" <<EOF2

## 스크립트 감지 오류
- codex exec 종료 코드: $exit_code
- 확인 로그: $loop_rel/codex_raw.log
EOF2
        fi

        echo "$loop_num" > "$LAST_LOOP_FILE"
        append_loop_index "$loop_id" "$loop_status" "$loop_started" "$loop_ended" "$loop_rel"
        write_running_file "$loop_id" "$loop_started" "idle"

        echo "[loop] ===== $loop_name 종료 ($loop_status) ====="

        LOOPS_DONE=$((LOOPS_DONE + 1))

        if [[ -f "$STOP_FILE" ]]; then
            echo "[loop] 정지 요청 감지. 현재 루프까지 완료 후 종료합니다."
            break
        fi

        if [[ "$LOOP_SLEEP_SEC" =~ ^[0-9]+$ ]] && (( LOOP_SLEEP_SEC > 0 )); then
            sleep "$LOOP_SLEEP_SEC"
        fi
    done

    echo "[loop] 전체 종료. 총 실행 루프: $LOOPS_DONE"
}

main "$@"
