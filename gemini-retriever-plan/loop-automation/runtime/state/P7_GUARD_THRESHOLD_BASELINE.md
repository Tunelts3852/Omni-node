# P7 guard 임계치 운영 기준선 (로컬 + 텔레그램)

- 동결 시각(UTC): 2026-03-05T02:06:00Z
- 스키마: `guard_threshold_baseline.v1`
- 스냅샷 파일: `gemini-retriever-plan/loop-automation/runtime/state/P7_GUARD_THRESHOLD_BASELINE.json`
- 키 정책: `GeminiKeySource=keychain|secure_file_600`
- 키 필수 범위: `test`, `validation`, `regression`, `production_run`
- 채널 범위: `chat`, `coding`, `telegram`

## 임계치 고정값(2차 튜닝 최종)

| id | metricType | warn | critical | minTotal |
| --- | --- | ---: | ---: | ---: |
| `guard_blocked_rate` | `rate` | 0.45 | 0.65 | 8 |
| `retry_required_rate` | `rate` | 0.45 | 0.70 | 8 |
| `count_lock_unsatisfied_rate` | `rate` | 0.10 | 0.20 | 4 |
| `citation_validation_failed_rate` | `rate` | 0.10 | 0.20 | 4 |
| `telegram_guard_meta_blocked_count` | `count` | 1 | 2 | 1 |

## 검증 기준

1. `omninode-dashboard/check-guard-threshold-lock.js`는 기본값으로 본 스냅샷 JSON을 읽어 `omninode-dashboard/app.js`의 임계치/채널 고정값 일치 여부를 검증한다.
2. 불일치가 1건이라도 있으면 회귀를 실패 처리한다.
