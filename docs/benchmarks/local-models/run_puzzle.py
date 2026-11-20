import time
import json
import urllib.request
import subprocess
import os

PUZZLE_PROMPT = """You are an execution engine running under strict evaluation mode. 
Solve the following puzzle by reasoning step-by-step in a hidden scratchpad block (<scratchpad>...</scratchpad>), and output ONLY the final answer in a designated block (<answer>...</answer>).

### PUZZLE SPECIFICATION:
You have a 4-liter bucket (B4) and a 9-liter bucket (B9), both initially empty. An infinite water supply and an infinite drain are available.
Standard allowed operations:
- FILL(x): Fill bucket x to maximum capacity.
- EMPTY(x): Empty bucket x completely.
- POUR(x, y): Pour water from bucket x to bucket y until either x is empty or y is full.

### NON-STANDARD CONSTRAINTS:
1. The B4 bucket has a leak: immediately after any POUR operation where B4 is either the source or destination, B4 instantly loses exactly 1 liter of water (if it has 1 or more liters). FILL and EMPTY operations on B4 do NOT trigger the leak.
2. B9 does not leak.
3. The drain has a clog limit: the operation EMPTY(9) cannot be performed if B9 contains strictly more than 6 liters of water.
4. You may never perform two identical operations back-to-back.
5. Goal: Leave exactly 6 liters of water in B9, while B4 contains exactly 0 liters.

### OUTPUT REQUIREMENTS:
1. Provide the strictly minimal sequence of operations (fewest total steps).
2. Inside <scratchpad>, trace each step with the exact water levels: (Step k: OP -> B4: [val], B9: [val]).
3. In <answer>, print ONLY the list of operations separated by semicolons (e.g., FILL(9); POUR(9, 4); ...). Do not include any other text or punctuation inside <answer>."""

MODELS = [
    {"name": "bonsai-2:27b", "type": "ollama"},
    {"name": "flint:latest", "type": "ollama"},
    {"name": "qwen3.8:27b", "type": "ollama"},
    {"name": "Qwen3.8-Flash-Next-Coder", "type": "llama-server"}
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
        "prompt": prompt,
        "stream": False,
        "keep_alive": 0,
        "options": {
            "temperature": 0.2,
            "num_predict": 2500
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
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "max_tokens": 2500
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
    for m in MODELS:
        mname = m["name"]
        mtype = m["type"]
        print(f"Testing {mname} ... ", end="", flush=True)
        proc = None
        if mtype == "llama-server":
            proc = start_llama_server()
            time.sleep(2)
            res = query_llama_server(PUZZLE_PROMPT)
            proc.terminate()
            subprocess.run(["pkill", "-9", "llama-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            res = query_ollama(mname, PUZZLE_PROMPT)
            
        results[mname] = res
        print(f"Done in {res['elapsed']:.1f}s | {res['tokens']} tokens ({res['tok_per_sec']:.1f} t/s)")
        time.sleep(2)

    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "puzzle_results.json"), "w") as f:
        json.dump(results, f, indent=2)

if __name__ == "__main__":
    run()
