import os
import time
import json
import urllib.request
import re

TESTS = [
    {
        "id": "T1_Reasoning",
        "name": "1. Counter-Intuitive Math/Trap",
        "prompt": "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Respond concisely with the mathematical breakdown and the final number only."
    },
    {
        "id": "T2_Coding",
        "name": "2. In-Place Algorithm",
        "prompt": "Write a Python function `rotate(matrix)` that rotates an N x N 2D list 90 degrees clockwise IN-PLACE with O(1) auxiliary space (no creating a second matrix). Provide only the clean Python code and 1 assert statement."
    },
    {
        "id": "T3_JSON_Schema",
        "name": "3. Strict JSON Diff Agent",
        "prompt": "Given the error 'TypeError: Cannot read properties of undefined (reading map) at UserList.tsx:14', generate a valid JSON object with exactly these keys: 'root_cause', 'fix_diff', and 'risk_level'. Output ONLY the raw JSON object. Do not include markdown code blocks (no ```json) or explanation."
    }
]

MODEL = "deepseek-r1-70b-iq2"

def query_ollama(model_name, prompt):
    url = "http://localhost:11434/api/generate"
    payload = {
        "model": model_name,
        "prompt": prompt,
        "stream": False,
        "keep_alive": 0,  # Unload immediately after test
        "options": {
            "temperature": 0.6,
            "num_predict": 400
        }
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
    start_time = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start_time
            eval_count = data.get("eval_count", 0)
            eval_dur_ns = data.get("eval_duration", 1)
            tok_per_sec = (eval_count / (eval_dur_ns / 1e9)) if eval_dur_ns > 0 else 0
            response_text = data.get("response", "")
            thinking_text = data.get("thinking", "")
            
            return {
                "ok": True,
                "elapsed": elapsed,
                "tokens": eval_count,
                "tok_per_sec": tok_per_sec,
                "response": response_text,
                "thinking": thinking_text
            }
    except Exception as e:
        return {"ok": False, "error": str(e), "elapsed": time.time() - start_time, "tokens": 0, "tok_per_sec": 0, "response": "", "thinking": ""}

def run():
    print(f"\n==================== Benchmarking: {MODEL} ====================")
    results = {}
    for test in TESTS:
        tid = test["id"]
        print(f"  Running {test['name']} ... ", end="", flush=True)
        res = query_ollama(MODEL, test["prompt"])
        results[tid] = res
        if res["ok"]:
            print(f"Done in {res['elapsed']:.2f}s | {res['tokens']} tokens ({res['tok_per_sec']:.1f} t/s)")
        else:
            print(f"Failed: {res.get('error', 'Unknown')}")
    
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "r1_70b_results.json"), "w") as f:
        json.dump(results, f, indent=2)
    print("\nR1 70B Benchmark completed.")

if __name__ == "__main__":
    run()
