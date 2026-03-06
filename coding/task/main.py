   #!/usr/bin/env python3
   import os
   import json
   import shutil
   import datetime
   from pathlib import Path

   OUT_DIR = Path("ai_models_by_country")
   JSON_PATH = OUT_DIR / "models_by_country.json"
   README_PATH = OUT_DIR / "README.md"
   BACKUP_DIR = OUT_DIR / "backups"


   models_by_country = {
       "USA": [
           {"name": "GPT-4", "provider": "OpenAI", "notes": "General-purpose commercial LLM"},
           {"name": "GPT-3.5", "provider": "OpenAI", "notes": "Earlier generation by OpenAI"},
           {"name": "PaLM 2", "provider": "Google", "notes": "Google's family of LLMs (via Google
  Research/DeepMind)"},
           {"name": "Claude 2 / 3", "provider": "Anthropic", "notes": "Safety-focused assistant
  models"},
           {"name": "LLaMA 2", "provider": "Meta", "notes": "Research and commercial variants from
   Meta"}
       ],
       "China": [
           {"name": "ERNIE Bot", "provider": "Baidu", "notes": "Baidu's large model family"},
           {"name": "Tongyi Qianwen", "provider": "Alibaba", "notes": "Alibaba's LLM series"},
           {"name": "PanGu-Alpha", "provider": "Huawei", "notes": "Huawei's foundational models"},
           {"name": "Ziya", "provider": "Zhipu AI", "notes": "Chinese open/research models"}
       ],
       "France": [
           {"name": "Mistral", "provider": "Mistral AI", "notes": "High-performance models from
  France"}
       ],
       "Germany": [
           {"name": "Luminous / Aleph Alpha", "provider": "Aleph Alpha", "notes": "European
  research-oriented LLMs"}
       ],
       "United Kingdom": [
           {"name": "Gemini (DeepMind)", "provider": "DeepMind / Google", "notes": "DeepMind's
  models; integrated with Google ecosystem"}
       ],
       "Canada": [
           {"name": "Cohere Command", "provider": "Cohere", "notes": "Commercial LLMs from Cohere
  (Canada)"}
       ],
       "Israel": [
           {"name": "Jurassic-2", "provider": "AI21 Labs", "notes": "Large models from AI21 Labs"}
       ],
       "South Korea": [
           {"name": "HyperCLOVA", "provider": "Naver", "notes": "Naver's Korean-centric LLM"},
           {"name": "KoGPT", "provider": "Kakao Brain", "notes": "Kakao Brain's Korean LLM"}
       ],
       "Japan": [
           {"name": "Rinna", "provider": "Rinna Co.", "notes": "Japanese language-focused models"}
       ],
       "Russia": [
           {"name": "YaLM", "provider": "Yandex", "notes": "Yandex's language models"},
           {"name": "GigaChat / Sber", "provider": "Sber", "notes": "Sber's consumer-oriented
  LLMs"}
       ],
       "India": [
           {"name": "Indic LLM initiatives", "provider": "AI4Bharat / Bhashini / Research",
  "notes": "Research and localization initiatives for Indic languages (multiple projects)"}
       ]
   }

   def ensure_dirs():
       OUT_DIR.mkdir(parents=True, exist_ok=True)
       BACKUP_DIR.mkdir(parents=True, exist_ok=True)

   def backup_if_exists(path: Path):
       if path.exists():
           ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
           dest = BACKUP_DIR / f"{path.name}.{ts}.bak"
           shutil.copy2(path, dest)

   def write_json(path: Path, data):
       backup_if_exists(path)
       with path.open("w", encoding="utf-8") as f:
           json.dump(data, f, ensure_ascii=False, indent=2)

   def write_readme(path: Path, data):
       backup_if_exists(path)
       lines = [
           "# AI Models by Country",
           "",
           "This file lists notable large language models (LLMs) and their providers, organized by
   country.",
           "",
           "Generated on: " + datetime.datetime.utcnow().isoformat() + "Z",
           "",
           "Structure:",
           "- JSON file: models_by_country.json",
           "",
           "Examples:",
           "",
       ]
       for country, models in data.items():
           lines.append(f"## {country}")
           for m in models:
               name = m.get("name", "unknown")
               provider = m.get("provider", "unknown")
               notes = m.get("notes", "")
               lines.append(f"- {name} — {provider}" + (f" — {notes}" if notes else ""))
           lines.append("")
       with path.open("w", encoding="utf-8") as f:
           f.write("\n".join(lines))

   def validate_data(data):
       if not isinstance(data, dict):
           raise ValueError("Top-level structure must be a dict mapping country -> list")
       if len(data) < 3:
           raise ValueError("Expected at least 3 countries in the dataset")
       for country, models in data.items():
           if not isinstance(models, list):
               raise ValueError(f"Models for {country} must be a list")
           if len(models) == 0:
               raise ValueError(f"No models listed for {country}")
           for m in models:
               if not isinstance(m, dict):
                   raise ValueError(f"Model entry for {country} is not an object: {m}")
               if "name" not in m or "provider" not in m:
                   raise ValueError(f"Model entry missing required fields for {country}: {m}")

   def pretty_print_console(data):
       print("국가별 주요 AI LLM 모델:")
       print("=" * 40)
       for country in sorted(data.keys()):
           print(f"\n{country}:")
           for m in data[country]:
               name = m.get("name")
               provider = m.get("provider")
               notes = m.get("notes", "")
               line = f" - {name} ({provider})"
               if notes:
                   line += f" — {notes}"
               print(line)
       print("\n파일 생성 위치:", str(OUT_DIR.resolve()))
       print("JSON 파일:", str(JSON_PATH.resolve()))
       print("README:", str(README_PATH.resolve()))
       print("\n완료: 데이터가 생성/검증되었습니다.")

   def run_tests(data):
       # Basic automated checks
       validate_data(data)
       # Ensure common global players are present
       usa_names = {m["name"] for m in data.get("USA", [])}
       assert "GPT-4" in usa_names or "PaLM 2" in usa_names, "Expected major US models present"
       # country count sanity
       assert len(data.keys()) >= 6, "Expected several countries listed"

   def main():
       ensure_dirs()
       try:
           validate_data(models_by_country)
       except Exception as e:
           print("데이터 검증 실패:", e)
           raise

       write_json(JSON_PATH, models_by_country)
       write_readme(README_PATH, models_by_country)

       # Run tests
       try:
           run_tests(models_by_country)
       except AssertionError as ae:
           print("테스트 실패:", ae)
           raise
       except Exception as e:
           print("예상치 못한 오류:", e)
           raise

       pretty_print_console(models_by_country)

   if __name__ == "__main__":
       main()