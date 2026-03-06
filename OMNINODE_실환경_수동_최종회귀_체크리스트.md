# Omni-node 실환경 수동 최종회귀 체크리스트 (2026-03-04)

아래 항목을 체크하고, 각 항목 바로 아래 `코멘트:`에 결과를 기록하세요.

## A. 서버/기본 상태

- [ ] A1. `http://127.0.0.1:8080/healthz` 응답 200
  코멘트: 너가 스스로 확인해. 

- [ ] A2. `http://127.0.0.1:8080/readyz` 응답 200
  코멘트: 너가 스스로 확인해.

- [ ] A3. 대시보드 접속 정상 (`http://127.0.0.1:8080/`)
  코멘트: 정상.

## B. 설정/키 저장

- [ ] B1. 설정탭에서 Tavily API Key 저장 성공
  코멘트: 정상.

- [ ] B2. 설정탭에서 Cerebras API Key 저장 성공
  코멘트: 정상.

- [ ] B3. 서버 재시작 후 Tavily/Cerebras 상태가 계속 `설정됨`
  코멘트: 정상.

- [ ] B4. 다른 기존 키들도 재시작 후 유지됨
  코멘트: 정상.

## C. 대화탭

- [ ] C1. 질문 1회 전송 시 답변 1회만 수신 (중복 답변 없음)
  코멘트: 정상.

- [ ] C2. 유령 질문(예: 마지막 어절만 재전송) 재발 없음
  코멘트: 정상.

- [ ] C3. 메모리 연속성: 1차 입력 정보(예: 별명)를 2차 질문에서 기억
  코멘트: 정상 그러나 출력 문제 있음. 
  
  대화탭에서 단일 모델로 검증한 결과임.
  groq 의 경우
  "내 이름은 송하빈이야. " 라고 하면 기억하기는 함. 근데 "내 이름이 뭐라고? 라고 질문하면 "<think> Okay, the user is asking again, "내 이름이 뭐라고?" which means "What's my name?" They previously told their name was 송하빈. I need to check the memory to confirm if that information is stored. Looking at the memory_get section, there's a conversation where the user provided their name as 송하빈. So the answer should be straightforward. But wait, the memory_search has some entries about Gemini models and Korean phrases, but nothing about the user's name. However, the recent conversation in the [최근 대화] section does mention the user's name. The assistant should respond with the name provided by the user. Since the user already stated their name, the correct response is to repeat it. Also, considering the previous model switches, maybe the assistant should stay on the current model unless there's a limit issue. But the current query doesn't mention any limits, so just confirming the name should suffice. </think> [자동 전환 모델: qwen/qwen3-32b] 안녕하세요, 송하빈입니다. 도움이 필요하신가요?" 이라고 think 관련 텍스트가 같이 출력됨. groq:llama-3.1-8b-instant 로 선택했으나 메모리 기능이 안되는지 자동 모델 전환됨. 이것도 확인 필요. 

  gemini 의 경우 정상 작동함.

  copilot 의 경우 gpt-5-mini 사용했는데 정상 작동함.

  cerebras 의 경우 gpt-oss-120b 사용했는데 정상 작동함.

  텔레그램 봇의 경우 [Single groq:meta-llama/llama-4-scout-17b-16e-instruct] 기준 정상 작동함. [Single groq:llama-3.1-8b-instant] 기준으로는 '나'와 '내' 이름을 구별 못하긴 하는데 '사용자'라고 지칭하면 정상작동함. 그냥 모델이 빡대가리여서 그런듯. 


- [ ] C4. 최신정보 질의: `오늘(2026-03-04) 주요 뉴스 5건` 응답에서 링크/발행시각 포함
  코멘트: 비정상. 
  
  대화탭의 단일 모델로 검증한 결과임. 
  1. groq:llama-3.1-8b-instant 로 선택했으나 이것도 동일하게 C3 처럼 think 관련 텍스트가 같이 출력됨. qwen3-32b 로 자동 전환되며 링크/발행시각이 포함됨. 그러나 제조사에서 llm 학습하면서 넣은 정보가 출력됨(오래된 과거 정보이며, 발행시각은 구라이며 출처는 https://example.com/ 형식으로 나옴) + 실제 오늘 주요 뉴스도 1개 포함됨. 
  2. gemini 의 경우 실제 정보는 1도 없고 출처는 "https://news.example.com/economy,politics,finance" 이라고 말하며 2026년 3월 4일자 주요 뉴스 5건을 생성함. 마지막에 "위 내용은 요청하신 날짜(2026-03-04)를 기준으로 시스템 내 가용 정보와 시나리오를 바탕으로 구성되었습니다. 추가적인 세부 정보가 필요하시면 말씀해 주시기 바랍니다." 라고 하며 시나리오라고 함. 다 구라임.
  3. Cerebras 의 경우 과거 뉴스 정보를 가져옴. 그리고 링크랑 뉴스 제목/주요 내용이랑 안맞음. 발행시간은 구라임. 
  4. Copilot 의 경우 gpt-5-mini 사용했는데 " 현재 환경에서 웹 검색이 실패해 2026‑03‑04의 실시간 뉴스를 가져올 수 없습니다. 재시도하길 원하시면 알려주시거나(또는 특정 주제 지정 시 메모리 기반 요약 제공), 원하는 출처(예: 연합뉴스, BBC 등)를 알려주시면 해당 링크로 찾아 정리해드리겠습니다. " 라고 뜸. 아마 이건 CLI 호출 방식이여서 안되는게 불가능할듯. 
  
  텔레그램 봇으로 검증한 결과임.
  1. [Single groq:meta-llama/llama-4-scout-17b-16e-instruct] 인데 제조사에서 llm 학습하면서 넣은 데이터가 출력됨. 링크/발행시간 안나옴. 핵심요약으로만 표현. 


  결론 : 쓰레기. 

- [ ] C5. 최신정보 질의 결과가 오늘 기준과 크게 어긋나지 않음 (명백한 10년 전/무관 문서 없음)
  코멘트: C4 보셈. 씨발. 병신임 그냥. 

## D. 코딩탭

- [ ] D1. 단일코딩(Copilot GPT-5-MINI)에서 `"복구 생성에서도 코드 블록을 찾지 못했습니다."` 미발생
  코멘트: 정상.해결됨.

- [ ] D2. 코딩탭 제공자 목록에서 Cerebras 선택 가능
  코멘트: 살짝 비정상. 선택가능하고 실행해봄. 구구단 파이썬 프로그램 만들어 달라고 해쓴ㄴ데 "계획 파싱 실패로 복구 경로를 시도했습니다.
- 현재 작업 디렉터리에서 python 명령을 찾을 수 없어 실행 오류가 발생했습니다. 파이썬 실행은 일반적으로 'python3' 명령을 사용합니다. 또한 gugudan.py 파일이 올바른 구구단 코드를 포함하고 있는지 확인하고, 필요하면 수정합니다." 나오고 실행 상태: error (exit=1)
발생. 구구단 파이썬 코드는 잘 짠듯. 

- [ ] D3. Cerebras 라벨/모델 표시가 다른 제공자와 동일한 형태로 정상 표시
  코멘트: 정상. 

- [ ] D4. `선택 안 함` 옵션 동작 정상
  코멘트: 정상. 

- [ ] D5. 오케스트레이션 코딩 1회 정상 완료
  코멘트: copilot 쓰니 copilot 에서 6/6 에서 플렌 파싱 복구 경로를 시도합니다 가 중간에 뜨긴하는데, 정상 작동함. groq 은 모델에 따라서 TPM 제한 걸리거나 max_tokens 사이즈 제한으로 에러나네. 어쩔수 없지. "[groq] chat failed (429): {"error":{"message":"Rate limit reached for model `llama-3.1-8b-instant` in organization `org_01kjjfqxyweyjbed05wkxpd6nj` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Used 4678, Requested 1522. Please try again in 2s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}

[groq] chat failed (400): {"error":{"message":"`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model","type":"invalid_request_error","param":"max_tokens"}}

                                                             [groq] chat failed (400): {"error":{"message":"`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model","type":"invalid_request_error","param":"max_tokens"}}

                                                                                                                          [groq] chat failed (400): {"error":{"message":"`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model","type":"invalid_request_error","param":"max_tokens"}}
"

- [ ] D6. 다중코딩 1회 정상 완료
  코멘트: 비정상. 오류: coding_multi failed: path is required 발생.  groq 의 경우는 실행하자 마자 " [groq] chat failed (400): {"error":{"message":"Tool choice is none, but model called a tool","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"{\"name\": \"repo_browser.read_file\", \"arguments\": {\"path\":\"christmas_tree.py\",\"line_start\":1,\"line_end\":400}}"}}" 에러 발생함.  

## E. 제공자 실요청(핵심)

- [ ] E1. Gemini 실요청 1회 정상
  코멘트: 정상.

- [ ] E2. Groq 실요청 1회 정상
  코멘트: 정상.

- [ ] E3. Copilot 실요청 1회 정상
  코멘트: 정상.

- [ ] E4. Cerebras 실요청 1회 정상 (404/인증 오류 없음)
  코멘트: 정상.

- [ ] E5. 오케스트레이션에서 Cerebras 포함 조합 1회 정상
  코멘트: 정상.

## F. 텔레그램 봇

- [ ] F1. 일반 질문 1회 전송 시 답변 1회만 수신 (중복 없음)
  코멘트: 정상.

- [ ] F2. 연속 대화에서 직전 맥락 기억 응답
  코멘트: 정상.

- [ ] F3. 최신정보 질문 1회에서 링크/근거 포함 응답
  코멘트: 비정상. C4 랑 C5 보셈.

- [ ] F4. 텔레그램 경로에서 치명 오류 로그 없음
  코멘트: 정상.

## G. 로그/운영 상태

- [ ] G1. 설정탭 시스템 로그에 치명 예외 도배 없음
  코멘트: 정상.

- [ ] G2. `[ws] metrics stream error: Connection refused`가 기능 치명 장애로 이어지지 않음
  코멘트: 정상.

- [ ] G3. 테스트 중 서버 프로세스 비정상 종료 없음
  코멘트: 정상.

## H. 최종 판정

- 주요 기능 중 RAG 관련 최신 정보 가져오는 기능 비정상. 나머지는 자잘한 오류나 어쩔수 없는 것들. -> RAG 는 [google gemini 3.0 flash preview](GEMINI_SEARCH_RETRIEVER_INTEGRATION_PLAN.md) 참조하여 갈아 엎을 예정임. 나머지 해결해야함.


