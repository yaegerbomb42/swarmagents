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

MODELS = [
    {"name": "qwen3.8:27b", "type": "ollama"},
    {"name": "bonsai-2:27b", "type": "ollama"},
    {"name": "flint:latest", "type": "ollama"},
    {"name": "gemma:latest", "type": "ollama"},
    {"name": "Qwen3.8-Flash-Next-Coder", "type": "llama-server", "url": "http://localhost:8080/v1/chat/completions"}
]

def query_ollama(model_name, prompt):
    url = "http://localhost:11434/api/generate"
    payload = {
        "model": model_name,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": 0.7,
            "num_predict": 400
        }
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
    start_time = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start_time
            eval_count = data.get("eval_count", 0)
            eval_dur_ns = data.get("eval_duration", 1)
            tok_per_sec = (eval_count / (eval_dur_ns / 1e9)) if eval_dur_ns > 0 else 0
            response_text = data.get("response", "")
            
            # Count thinking tokens if any
            think_match = re.search(r"<think>(.*?)</think>", response_text, re.DOTALL)
            think_tokens = len(think_match.group(1).split()) if think_match else 0
            
            return {
                "ok": True,
                "elapsed": elapsed,
                "tokens": eval_count,
                "tok_per_sec": tok_per_sec,
                "response": response_text,
                "think_tokens": think_tokens
            }
    except Exception as e:
        return {"ok": False, "error": str(e), "elapsed": time.time() - start_time, "tokens": 0, "tok_per_sec": 0, "response": ""}

def query_llama_server(url, prompt):
    payload = {
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7,
        "max_tokens": 400
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
    start_time = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start_time
            usage = data.get("usage", {})
            tokens = usage.get("completion_tokens", 0)
            timings = data.get("timings", {})
            tok_per_sec = timings.get("predicted_per_second", (tokens / elapsed) if elapsed > 0 else 0)
            msg = data.get("choices", [{}])[0].get("message", {})
            response_text = msg.get("content", "")
            reasoning_text = msg.get("reasoning_content", "")
            think_tokens = len(reasoning_text.split()) if reasoning_text else 0
            
            return {
                "ok": True,
                "elapsed": elapsed,
                "tokens": tokens,
                "tok_per_sec": tok_per_sec,
                "response": response_text or reasoning_text,
                "think_tokens": think_tokens
            }
    except Exception as e:
        return {"ok": False, "error": str(e), "elapsed": time.time() - start_time, "tokens": 0, "tok_per_sec": 0, "response": ""}

def run():
    results = {}
    for m in MODELS:
        mname = m["name"]
        print(f"\n==================== Benchmarking: {mname} ====================")
        results[mname] = {}
        for test in TESTS:
            tid = test["id"]
            print(f"  Running {test['name']} ... ", end="", flush=True)
            if m["type"] == "ollama":
                res = query_ollama(mname, test["prompt"])
            else:
                res = query_llama_server(m["url"], test["prompt"])
            
            results[mname][tid] = res
            if res["ok"]:
                print(f"Done in {res['elapsed']:.2f}s | {res['tokens']} tokens ({res['tok_per_sec']:.1f} t/s)")
            else:
                print(f"Failed: {res.get('error', 'Unknown')}")
    
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "bench_results.json"), "w") as f:
        json.dump(results, f, indent=2)
    print("\nBenchmark completed. Results saved to bench_results.json")

if __name__ == "__main__":
    run()
