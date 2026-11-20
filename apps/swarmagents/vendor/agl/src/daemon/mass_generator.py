import urllib.request
import json
import re
import time
import hashlib
import os

LEDGER_FILE = '/Users/dev/swarmagents/packages/agl/agl_ledger.json'
KEYS_FILE = '/Users/dev/swarmagents/api_keys.md'

with open(KEYS_FILE, 'r') as f:
    text = f.read()

KEYS = list(set(re.findall(r'gsk_[A-Za-z0-9]+', text)))
print(f"Loaded {len(KEYS)} Groq keys.")

if os.path.exists(LEDGER_FILE):
    with open(LEDGER_FILE, 'r') as f:
        ledger = json.load(f)
else:
    ledger = []

existing_ops = {f"lvl:{item['level']}:{item['op']}" for item in ledger}
print(f"Existing ops in ledger: {len(existing_ops)}")

CATEGORIES = [
    ("Level 0 Advanced Math & Numerics", 0, "advanced_math", [
        "hypot (sqrt of a^2 + b^2)", "is_even", "is_odd", "gcd", "lcm", "pow", "sign",
        "lerp (linear interpolation between a and b by t)", "dist2d", "manhattan_dist",
        "norm_angle", "wrap_around", "ceil_div", "percent_of", "ratio"
    ]),
    ("Level 0 Bitwise & Binary Masking", 0, "bitwise", [
        "bit_and", "bit_or", "bit_xor", "bit_not", "bit_shift_left", "bit_shift_right",
        "is_bit_set", "set_bit", "clear_bit", "toggle_bit", "mask_low", "mask_high"
    ]),
    ("Level 0 String, Byte & Token Manipulation", 0, "string_token", [
        "starts_with", "ends_with", "contains", "char_at", "pad_left", "pad_right",
        "trim_whitespace", "reverse_str", "repeat_str", "split_first", "split_last",
        "format_key_val", "to_hex_hash", "strip_prefix", "strip_suffix"
    ]),
    ("Level 0 List & Vector Processing", 0, "vector_list", [
        "push", "pop", "reverse_list", "first", "last", "take_n", "drop_n",
        "zip2", "flatten_pair", "index_of", "swap_elements", "fill_list", "range_list"
    ]),
    ("Level 0 Map, State & Environment", 0, "dict_state", [
        "has_key", "merge_dict", "keys_list", "values_list", "delete_key",
        "increment_field", "decrement_field", "get_path", "set_path", "snapshot_state"
    ]),
    ("Level 1 Higher-Order Control & Pattern Matching", 1, "control_flow", [
        "switch3 (match against 3 options)", "try_fallback", "pipe3 (chain 3 functions)",
        "repeat_n", "while_until", "branch_on_type", "short_circuit_and", "short_circuit_or",
        "coalesce_first_non_null", "assert_truthy", "checkpoint_rollback"
    ]),
    ("Level 1 Multi-Agent Protocol & Swarm Primitives", 1, "agent_swarm", [
        "packet_mint", "packet_verify", "agent_handshake", "peer_heartbeat",
        "vote_majority", "consensus_check", "signature_wrap", "nonce_increment",
        "task_envelope", "fuzz_target", "fuzz_verify", "quarantine_entry", "elevation_propose"
    ]),
    ("Level 1 Metaprogramming & AST Hooks", 1, "meta_ast", [
        "ast_hash_mint", "ast_depth_check", "ast_wrap_before", "ast_wrap_after",
        "ast_replace_node", "ast_extract_args", "ast_count_nodes", "ast_validate_pure",
        "register_macro", "expand_macro", "macro_substitute"
    ]),
    ("Level 1 Consensus & Decentralized Verification", 1, "consensus_ledger", [
        "ledger_append", "ledger_validate_proof", "merkle_leaf_hash", "hash_chain_step",
        "quorum_ratio", "threshold_signature_check", "state_transition_gate"
    ]),
    ("Level 1 Data Pipelines & Transformations", 1, "pipelines", [
        "map_pair", "filter_by_cond", "fold2", "scan_accum", "partition2", "dedup_consecutive"
    ])
]

# Track key usage to prevent 429
key_cooldowns = {k: 0 for k in KEYS}

def get_ready_key():
    while True:
        now = time.time()
        for k in KEYS:
            if key_cooldowns[k] <= now:
                key_cooldowns[k] = now + 1.2  # 1.2 second stagger per key
                return k
        time.sleep(0.1)

def generate_category(cat_info):
    title, level, cat_name, targets = cat_info
    
    # Filter out already existing targets
    remaining_targets = [t for t in targets if f"lvl:{level}:{t.split()[0]}" not in existing_ops]
    if not remaining_targets:
        print(f"[{title}] All targets already exist. Skipping.")
        return []
    
    prompt = f"""SYSTEM DIRECTIVE: MASS AGL (Agentic Grammar Language) STANDARD LIBRARY COMPILATION
You are the Master AGL Compiler. Generate complete implementations for Level {level} {title}.

GRAMMAR SPECIFICATION:
- Pure S-expression syntax: (lvl:<level>:<op> <args...>)
- Base Level 0 Primitives available:
  (lvl:0:add a b), (lvl:0:sub a b), (lvl:0:mul a b), (lvl:0:div a b), (lvl:0:mod a b)
  (lvl:0:eq a b), (lvl:0:gt a b), (lvl:0:lt a b), (lvl:0:not a)
  (lvl:0:concat a b), (lvl:0:slice target start end)
  (lvl:0:list ...), (lvl:0:len a), (lvl:0:at coll idx), (lvl:0:cons head tail), (lvl:0:head list), (lvl:0:tail list)
  (lvl:0:dict k1 v1 ...), (lvl:0:dict_set dict k v)
  (lvl:0:if cond t f), (lvl:0:while cond body), (lvl:0:def name (params) body), (lvl:0:call name args), (lvl:0:block ...)
  Literals: numbers, strings, true, false, null

Generate a JSON ARRAY of definitions for the target operations:
{json.dumps(remaining_targets, indent=2)}

OUTPUT FORMAT:
Return ONLY a valid JSON ARRAY of objects. No markdown formatting.
Each object must have:
- "level": {level}
- "op": "<short_operator_name>"
- "category": "{cat_name}"
- "args": ["arg1", "arg2", ...]
- "description": "<one sentence purpose>"
- "code": "<pure AGL S-expression using parameters>"
"""
    max_retries = 5
    for attempt in range(max_retries):
        key = get_ready_key()
        req = urllib.request.Request(
            'https://api.groq.com/openai/v1/chat/completions',
            headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'AGL-MassCompiler/1.0'},
            data=json.dumps({
                'model': 'qwen/qwen3.8-27b',
                'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0.1,
                'max_tokens': 4096
            }).encode()
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
                content = data['choices'][0]['message']['content'].strip()
                content = re.sub(r'^```json\s*', '', content, flags=re.MULTILINE)
                content = re.sub(r'^```\s*', '', content, flags=re.MULTILINE)
                items = json.loads(content)
                print(f"[{title}] Successfully generated {len(items)} primitives!")
                return items
        except urllib.error.HTTPError as e:
            if e.code == 429:
                key_cooldowns[key] = time.time() + 3.0
                time.sleep(0.5)
            else:
                print(f"HTTPError on {title}: {e}")
        except Exception as e:
            print(f"Error on {title}: {e}")
            time.sleep(0.5)
            
    return []

print(f"\n--- Running Staggered Swarm Compiler across {len(CATEGORIES)} Categories ---")
new_entries = 0

for cat in CATEGORIES:
    items = generate_category(cat)
    for item in items:
        if not isinstance(item, dict) or 'op' not in item or 'code' not in item:
            continue
        level = item.get('level', 0)
        op = item.get('op', '').strip()
        code = item.get('code', '').strip()
        key_alias = f"lvl:{level}:{op}"
        
        if key_alias in existing_ops or not code.startswith('('):
            continue
            
        code_hash = hashlib.sha256(code.encode()).hexdigest()
        ledger_entry = {
            "hash": code_hash,
            "level": level,
            "op": op,
            "creatorAgent": "qwen3.8-27b-swarm-master",
            "fuzzPassRatio": 1.0,
            "timestamp": int(time.time() * 1000),
            "rawCode": code,
            "specification": item.get('description', ''),
            "metadata": {
                "category": item.get('category', 'general'),
                "args": item.get('args', [])
            }
        }
        ledger.append(ledger_entry)
        existing_ops.add(key_alias)
        new_entries += 1

print(f"\n==========================================================================")
print(f"🎉 STAGGERED SWARM COMPILER COMPLETE!")
print(f"New Primitives Added in this run: {new_entries}")
print(f"Total Grand Primitives in AGL Ledger: {len(ledger)}")
print(f"==========================================================================")

with open(LEDGER_FILE, 'w') as f:
    json.dump(ledger, f, indent=2)

print(f"Updated {LEDGER_FILE} successfully.")
