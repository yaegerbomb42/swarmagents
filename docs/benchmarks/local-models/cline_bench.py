import time
import json
import urllib.request
import re
import subprocess
import os

CLINE_SYSTEM_PROMPT = """You are Cline, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.

You have access to tools:
<write_to_file>
<path>file path here</path>
<content>
file content here
</content>
</write_to_file>

<execute_command>
<command>command string here</command>
</execute_command>

Always use the proper tool tags to make changes. Think step by step before emitting tools."""

TASKS = [
    {
        "id": "Task_A_Cline_Refactor",
        "name": "Task A: Cline Full-Stack Refactor & Tool Calling",
        "prompt": """A React TypeScript component in src/components/UserProfile.tsx has a memory leak and race condition:
```tsx
import React, { useState, useEffect } from 'react';

export const UserProfile = ({ userId }: { userId: string }) => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/users/${userId}`)
      .then(res => res.json())
      .then(json => {
        setData(json);
        setLoading(false);
      });
  }, [userId]);

  if (loading) return <div>Loading...</div>;
  return <div>{data?.name}</div>;
};
```
Requirements:
1. Fix the race condition and memory leak when userId changes rapidly or unmounts using AbortController.
2. Add strongly-typed User interface (id, name, email, role).
3. Handle error states with proper UI.
4. Output your answer by calling <write_to_file> for src/components/UserProfile.tsx and <execute_command> to run the typecheck test.
"""
    },
    {
        "id": "Task_B_RateLimiter",
        "name": "Task B: Production Concurrency Rate Limiter",
        "prompt": """Implement a production-grade Sliding Window Log Rate Limiter class in Python (`src/rate_limiter.py`).
Requirements:
1. Thread-safe using threading.Lock.
2. Methods: `allow_request(user_id: str) -> bool`, `get_remaining_tokens(user_id: str) -> int`, `cleanup_expired()`.
3. Configurable max_requests and window_seconds.
4. Provide a complete test file `tests/test_rate_limiter.py` with unittest covering burst limits, concurrency with multiple threads, and time expiration.
Use <write_to_file> for both files and <execute_command> for running pytest.
"""
    }
]

MODELS = [
    {"name": "bonsai-2:27b", "type": "ollama", "ram_gb": 8.3},
    {"name": "flint:latest", "type": "ollama", "ram_gb": 22.0},
    {"name": "qwen3.8:27b", "type": "ollama", "ram_gb": 18.0},
    {"name": "Qwen3.8-Flash-Next-Coder", "type": "llama-server", "ram_gb": 28.0}
]

def unload_ollama(model_name):
    try:
        url = "http://localhost:11434/api/generate"
        payload = {"model": model_name, "keep_alive": 0}
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception:
        pass
    subprocess.run(["ollama", "stop", model_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def query_ollama(model_name, prompt):
    url = "http://localhost:11434/api/generate"
    payload = {
        "model": model_name,
        "system": CLINE_SYSTEM_PROMPT,
        "prompt": prompt,
        "stream": False,
        "keep_alive": 0,
        "options": {
            "temperature": 0.5,
            "num_predict": 1200
        }
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
    start_time = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
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
    finally:
        unload_ollama(model_name)

def start_llama_server():
    subprocess.run(["pkill", "-9", "llama-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    cmd = [
        os.environ.get("LLAMA_SERVER", "llama-server"),
        "-m", os.environ.get("QWEN_GGUF", "Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf"),
        "--load-mode", "mmap",
        "--override-tensor", "per_layer_token_embd.weight=CPU",
        "-ctk", "q4_0", "-ctv", "q4_0",
        "-c", "16384",
        "-b", "512", "-ub", "512",
        "--port", "8080",
        "--host", "127.0.0.1"
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(30):
        time.sleep(2)
        try:
            with urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=2) as resp:
                if resp.status == 200:
                    break
        except Exception:
            pass
    return proc

def query_llama_server(prompt):
    url = "http://127.0.0.1:8080/v1/chat/completions"
    payload = {
        "messages": [
            {"role": "system", "content": CLINE_SYSTEM_PROMPT},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.5,
        "max_tokens": 1200
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
    start_time = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - start_time
            usage = data.get("usage", {})
            tokens = usage.get("completion_tokens", 0)
            timings = data.get("timings", {})
            tok_per_sec = timings.get("predicted_per_second", (tokens / elapsed) if elapsed > 0 else 0)
            msg = data.get("choices", [{}])[0].get("message", {})
            response_text = msg.get("content", "")
            reasoning_text = msg.get("reasoning_content", "")
            return {
                "ok": True,
                "elapsed": elapsed,
                "tokens": tokens,
                "tok_per_sec": tok_per_sec,
                "response": response_text,
                "thinking": reasoning_text
            }
    except Exception as e:
        return {"ok": False, "error": str(e), "elapsed": time.time() - start_time, "tokens": 0, "tok_per_sec": 0, "response": "", "thinking": ""}

def run():
    results = {}
    print("=================================================================")
    print("   Cline Coding Agent Benchmark (Strict Sequential Isolation)    ")
    print("=================================================================")
    
    for m in MODELS:
        mname = m["name"]
        mtype = m["type"]
        results[mname] = {}
        print(f"\n---> Testing Model: {mname} ({m['ram_gb']} GB)")
        
        proc = None
        if mtype == "llama-server":
            print("     Starting isolated llama-server instance...")
            proc = start_llama_server()
            time.sleep(2)
        
        for task in TASKS:
            tid = task["id"]
            print(f"     [Running {task['name']}] ... ", end="", flush=True)
            if mtype == "ollama":
                res = query_ollama(mname, task["prompt"])
            else:
                res = query_llama_server(task["prompt"])
            
            results[mname][tid] = res
            if res["ok"]:
                has_write = "<write_to_file>" in res["response"]
                has_exec = "<execute_command>" in res["response"]
                print(f"Done in {res['elapsed']:.1f}s | {res['tokens']} tok ({res['tok_per_sec']:.1f} t/s) | Tools: write={has_write}, exec={has_exec}")
            else:
                print(f"Failed: {res.get('error', 'Unknown')}")
        
        if proc:
            print("     Shutting down llama-server and freeing memory...")
            proc.terminate()
            subprocess.run(["pkill", "-9", "llama-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(2)
            
        time.sleep(2)
        
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "cline_bench_results.json"), "w") as f:
        json.dump(results, f, indent=2)
    print("\nBenchmark successfully finished! Results saved to cline_bench_results.json")

if __name__ == "__main__":
    run()
