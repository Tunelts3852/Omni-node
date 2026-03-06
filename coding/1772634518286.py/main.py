   import sys, subprocess, pathlib

   filename = "gugudan_1772634518286.py"
   content = """for i in range(2, 10):
       for j in range(1, 10):
           print(f"{i} * {j} = {i*j}")
   """
   pathlib.Path(filename).write_text(content, encoding="utf-8")

   result = subprocess.run([sys.executable, filename], capture_output=True, text=True)
   print(result.stdout, end="")
   if result.stderr:
       print(result.stderr, file=sys.stderr)