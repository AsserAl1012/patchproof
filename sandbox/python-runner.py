import ast
import copy
import datetime
import difflib
import json
import math
import re
import sys

CERTIFICATE_SCHEMA = "patchproof.certificate.v2"
PATCHPROOF_VERSION = "0.4.0"
DEFAULT_LIMITS = {
    "maxSourceChars": 12000,
    "maxTests": 100,
    "maxDomainSize": 2400,
    "maxCounterexamples": 8,
    "maxCandidates": 8,
    "minMutationScore": 0.5,
    "minEvidenceScore": 0,
}

SAFE_BUILTINS = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
    "enumerate": enumerate, "float": float, "int": int, "isinstance": isinstance,
    "len": len, "list": list, "max": max, "min": min, "range": range,
    "reversed": reversed, "round": round, "set": set, "sorted": sorted,
    "str": str, "sum": sum, "tuple": tuple, "zip": zip,
    "ValueError": ValueError, "TypeError": TypeError, "IndexError": IndexError,
    "KeyError": KeyError, "ZeroDivisionError": ZeroDivisionError,
}
FORBIDDEN_NODES = (
    ast.Import, ast.ImportFrom, ast.ClassDef, ast.AsyncFunctionDef, ast.Await,
    ast.Global, ast.Nonlocal, ast.With, ast.AsyncWith, ast.Try, ast.Raise,
    ast.Delete, ast.Yield, ast.YieldFrom, ast.Lambda,
)
FORBIDDEN_NAMES = {
    "__import__", "breakpoint", "compile", "delattr", "dir", "eval", "exec",
    "getattr", "globals", "help", "input", "locals", "memoryview", "object",
    "open", "setattr", "super", "type", "vars",
}

PYTHON_TEMPLATES = [
    ("upper-bound-variable", "Replace lower-bound variable in upper-bound check", ["local-branch-change", "range-boundary"], [(r">\s*min\b", "> max")]),
    ("slice-limit-off-by-one", "Remove off-by-one from slice limit", ["boundary-change", "collection-size"], [(r"\[:\s*limit\s*-\s*1\s*\]", "[:limit]")]),
    ("missing-increment", "Add missing increment to returned value", ["arithmetic-change"], [(r"return\s+value\s*$", "return value + 1")]),
]


def main():
    try:
        apply_resource_limits()
        request = json.loads(sys.stdin.read() or "{}")
        operation = request.get("operation", "run")
        value = request.get("value") or {}
        result = verify_certificate(value) if operation == "verify" else run_patchproof(value)
        write({"ok": True, "result": result})
    except Exception as error:
        write({"ok": False, "error": {"message": str(error)}})


def write(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False))


def apply_resource_limits():
    try:
        import resource
        memory = 256 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    except (ImportError, ValueError, OSError):
        pass


def run_patchproof(raw):
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    data = normalize_input(raw)
    tests = parse_tests(data["testsText"], data["limits"])
    old_program = compile_function(data["source"])
    precondition = compile_predicate(data["preconditionText"], True, "precondition")
    may_change = compile_predicate(data["mayChangeText"], False, "may-change predicate")
    postcondition = compile_predicate(data["postconditionText"], True, "postcondition")
    baseline = run_tests(old_program["fn"], tests)
    bug_tests = [item for item in baseline["tests"] if not item["pass"]]
    passing_tests = [item for item in baseline["tests"] if item["pass"]]
    domain = build_domain(tests, data["limits"], precondition)
    if not domain:
        raise ValueError("The precondition excluded every generated input. Relax it or add broader tests.")
    candidates = generate_candidates(data)
    validated = [validate_candidate(candidate, old_program, tests, [item["name"] for item in bug_tests], may_change, postcondition, domain, data["limits"]) for candidate in candidates]
    accepted = [candidate for candidate in validated if candidate["accepted"]]
    selected = max(accepted or validated, key=lambda candidate: candidate["evidenceScore"])
    certificate = build_certificate(data, started_at, old_program, baseline, bug_tests, passing_tests, domain, validated, selected)
    return {
        "startedAt": started_at,
        "functionName": old_program["name"],
        "baseline": baseline,
        "candidates": validated,
        "selected": selected,
        "certificate": certificate,
        "logs": build_logs(baseline, validated, selected, domain),
    }


def normalize_input(raw):
    limits = dict(DEFAULT_LIMITS)
    limits.update(raw.get("limits") or {})
    for key in ("maxSourceChars", "maxTests", "maxDomainSize", "maxCounterexamples", "maxCandidates"):
        value = limits[key]
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError(f"{key} must be a positive integer.")
        if value > DEFAULT_LIMITS[key]:
            raise ValueError(f"{key} cannot exceed the verifier cap of {DEFAULT_LIMITS[key]}.")
    for key in ("minMutationScore", "minEvidenceScore"):
        value = float(limits[key])
        if value < 0 or value > 1:
            raise ValueError(f"{key} must be between 0 and 1.")
        limits[key] = value
    source = str(raw.get("source") or "")
    if not source.strip():
        raise ValueError("Source is required.")
    if len(source) > limits["maxSourceChars"]:
        raise ValueError(f"Source exceeds {limits['maxSourceChars']} characters.")
    candidate_patches = []
    for index, candidate in enumerate((raw.get("candidatePatches") or [])[:limits["maxCandidates"]]):
        item = {"source": candidate} if isinstance(candidate, str) else candidate
        if not isinstance(item, dict) or not str(item.get("source") or "").strip():
            raise ValueError(f"Candidate patch {index + 1} has no source.")
        candidate_patches.append({
            "source": str(item["source"]),
            "title": str(item.get("title") or f"Generated candidate {index + 1}"),
            "rationale": str(item.get("rationale") or "Generated by the configured model provider."),
            "generator": str(item.get("generator") or "model"),
            "provenance": item.get("provenance"),
        })
    return {
        "language": "python",
        "source": source,
        "testsText": str(raw.get("testsText") or json.dumps(raw.get("tests") or [])),
        "bugReport": str(raw.get("bugReport") or ""),
        "preconditionText": str(raw.get("preconditionText") or raw.get("precondition") or ""),
        "mayChangeText": str(raw.get("mayChangeText") or raw.get("mayChange") or ""),
        "postconditionText": str(raw.get("postconditionText") or raw.get("postcondition") or ""),
        "executionMode": str(raw.get("executionMode") or "python-process-engine"),
        "candidatePatches": candidate_patches,
        "modelProvenance": raw.get("modelProvenance"),
        "limits": limits,
    }


def parse_tests(text, limits):
    try:
        parsed = json.loads(text)
    except Exception as error:
        raise ValueError(f"Tests must be valid JSON: {error}")
    if not isinstance(parsed, list) or not parsed:
        raise ValueError("Tests JSON must be a non-empty array.")
    if len(parsed) > limits["maxTests"]:
        raise ValueError(f"Too many tests. The configured limit is {limits['maxTests']}.")
    tests = []
    for index, item in enumerate(parsed):
        if not isinstance(item, dict) or not isinstance(item.get("args"), list):
            raise ValueError(f"Test {index + 1} must include an args array.")
        tests.append({
            "name": str(item.get("name") or f"case {index + 1}"),
            "args": item["args"],
            "expect": item.get("expect"),
            "hasExpect": "expect" in item,
            "expectError": item.get("expectError"),
        })
    return tests


def validate_ast(tree, label, function_mode=False):
    if function_mode:
        body = tree.body
        functions = [node for node in body if isinstance(node, ast.FunctionDef)]
        other = [node for node in body if not isinstance(node, ast.FunctionDef) and not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str))]
        if len(functions) != 1 or other:
            raise ValueError("Python source must contain exactly one named function and no top-level executable statements.")
        if functions[0].decorator_list:
            raise ValueError("Python function decorators are not allowed.")
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.decorator_list:
            raise ValueError("Python function decorators are not allowed.")
        if isinstance(node, FORBIDDEN_NODES):
            raise ValueError(f"Unsafe {label}: {type(node).__name__} is not allowed.")
        if isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            raise ValueError(f"Unsafe {label}: name '{node.id}' is not allowed.")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise ValueError(f"Unsafe {label}: private/dunder attributes are not allowed.")


def compile_function(source):
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as error:
        raise ValueError(f"Could not compile Python function: {error.msg} at line {error.lineno}")
    validate_ast(tree, "source", True)
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef))
    namespace = {"__builtins__": SAFE_BUILTINS}
    exec(compile(tree, "<patchproof-python>", "exec"), namespace, namespace)
    return {"name": function.name, "fn": namespace[function.name], "source": source}


def compile_predicate(text, default, label):
    expression = str(text or "").strip()
    if not expression:
        return lambda args, result, observation: default
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as error:
        raise ValueError(f"Invalid {label}: {error.msg}")
    validate_ast(tree, label)
    code = compile(tree, f"<patchproof-{label}>", "eval")
    return lambda args, result, observation: bool(eval(code, {"__builtins__": SAFE_BUILTINS}, {"args": args, "result": result, "observation": observation}))


def generate_candidates(data):
    source = data["source"]
    candidates = []
    seen = set()
    for supplied in data["candidatePatches"]:
        if supplied["source"] == source or supplied["source"] in seen:
            continue
        seen.add(supplied["source"])
        candidates.append(candidate_record(len(candidates), "model-generated", supplied["title"], supplied["source"], ["model-generated", "requires-bounded-validation"], supplied["generator"], supplied.get("provenance"), supplied["rationale"], source))
    for template_id, title, risk, replacements in PYTHON_TEMPLATES:
        if len(candidates) >= data["limits"]["maxCandidates"]:
            break
        patched = source
        for pattern, replacement in replacements:
            patched = re.sub(pattern, replacement, patched, flags=re.MULTILINE)
        if patched == source or patched in seen:
            continue
        seen.add(patched)
        candidates.append(candidate_record(len(candidates), template_id, title, patched, risk, "local-template", None, "Python repair operator matched the submitted source.", source))
    if not candidates:
        candidates.append(candidate_record(0, "no-local-template", "No safe local template matched", source, ["no-change"], "none", None, "No Python repair operator matched.", source))
    return candidates[:data["limits"]["maxCandidates"]]


def candidate_record(index, template_id, title, source, risk, generator, provenance, rationale, old_source):
    return {
        "id": f"p{index + 1}", "templateId": template_id, "title": title,
        "source": source, "diff": unified_diff(old_source, source), "risk": risk,
        "generator": generator, "provenance": provenance,
        "plannerTrace": {"score": 0, "matchedTerms": [], "rationale": rationale},
    }


def validate_candidate(candidate, old_program, tests, failing_names, may_change, postcondition, domain, limits):
    result = dict(candidate)
    result.update({"accepted": False, "evidenceScore": 0, "explicitTests": None, "preservation": None, "postcondition": None, "boundedProof": None, "mutation": None, "compileError": None, "fixedBug": False, "fixedFailingTests": [], "rejectionReasons": []})
    try:
        new_program = compile_function(candidate["source"])
    except Exception as error:
        result["compileError"] = str(error)
        result["rejectionReasons"].append("Candidate did not compile as a safe named function.")
        return result
    if new_program["name"] != old_program["name"]:
        result["compileError"] = f"Candidate declares {new_program['name']}, expected {old_program['name']}."
        result["rejectionReasons"].append("Candidate changed the target function name.")
        return result
    explicit = run_tests(new_program["fn"], tests)
    preservation = check_preservation(old_program["fn"], new_program["fn"], domain, may_change, limits["maxCounterexamples"])
    post = check_postcondition(new_program["fn"], domain, postcondition, limits["maxCounterexamples"])
    mutation = mutation_check(candidate["source"], tests, domain, may_change, postcondition, limits["maxCounterexamples"])
    result.update({"explicitTests": explicit, "preservation": preservation, "postcondition": post, "mutation": mutation})
    result["boundedProof"] = {
        "status": "no-counterexample-in-finite-envelope" if not preservation["counterexamples"] and not post["counterexamples"] else "counterexample-found",
        "domainSize": len(domain), "preserveCases": preservation["checked"],
        "mayChangeCases": preservation["skippedMayChange"], "postconditionCases": post["checked"],
    }
    passes = {item["name"]: item["pass"] for item in explicit["tests"]}
    result["fixedFailingTests"] = [name for name in failing_names if passes.get(name)]
    result["fixedBug"] = bool(failing_names) and len(result["fixedFailingTests"]) == len(failing_names)
    explicit_pass = explicit["failCount"] == 0
    preserve_pass = not preservation["counterexamples"]
    post_pass = not post["counterexamples"]
    if not failing_names: result["rejectionReasons"].append("No failing test was observed before repair.")
    if not result["fixedBug"]: result["rejectionReasons"].append("The original failing evidence was not fully fixed.")
    if not explicit_pass: result["rejectionReasons"].append("One or more executable tests failed after repair.")
    if not preserve_pass: result["rejectionReasons"].append("Behavior changed outside the may-change predicate.")
    if not post_pass: result["rejectionReasons"].append("The postcondition failed within the finite envelope.")
    if mutation["score"] < limits["minMutationScore"]: result["rejectionReasons"].append(f"Mutation score was below {limits['minMutationScore']}.")
    result["evidenceScore"] = evidence_score(result["fixedBug"], explicit_pass, preserve_pass, post_pass, mutation["score"], result["boundedProof"]["status"], len(domain))
    if result["evidenceScore"] < limits["minEvidenceScore"]: result["rejectionReasons"].append(f"Evidence score was below {limits['minEvidenceScore']}.")
    result["accepted"] = not result["rejectionReasons"]
    return result


def observe(fn, args):
    cloned = copy.deepcopy(args)
    before = copy.deepcopy(cloned)
    try:
        value = fn(*cloned)
        return {"ok": True, "value": normalize_value(value), "mutatedArgs": normalize_value(cloned) if cloned != before else None}
    except Exception as error:
        return {"ok": False, "error": f"{type(error).__name__}: {error}", "mutatedArgs": None}


def normalize_value(value):
    if isinstance(value, float):
        if math.isnan(value): return {"__patchproof": "NaN"}
        if value == math.inf: return {"__patchproof": "Infinity"}
        if value == -math.inf: return {"__patchproof": "-Infinity"}
    try:
        json.dumps(value, allow_nan=False)
        return copy.deepcopy(value)
    except Exception:
        return {"__patchproof": "non-json", "repr": repr(value)}


def run_tests(fn, tests):
    rows = []
    for test in tests:
        observation = observe(fn, test["args"])
        passed = (not observation["ok"] and str(test["expectError"]) in observation.get("error", "")) if test["expectError"] else observation["ok"] and observation["value"] == normalize_value(test["expect"])
        row = {key: value for key, value in test.items() if key != "hasExpect"}
        row.update({"observation": observation, "pass": passed})
        rows.append(row)
    return {"tests": rows, "passCount": sum(1 for row in rows if row["pass"]), "failCount": sum(1 for row in rows if not row["pass"])}


def check_preservation(old_fn, new_fn, domain, may_change, maximum):
    counterexamples, checked, skipped = [], 0, 0
    for args in domain:
        old, new = observe(old_fn, args), observe(new_fn, args)
        result = new.get("value") if new["ok"] else None
        if may_change(copy.deepcopy(args), result, new):
            skipped += 1
            continue
        checked += 1
        if old != new:
            counterexamples.append({"args": args, "old": old, "next": new})
            if len(counterexamples) >= maximum: break
    return {"checked": checked, "skippedMayChange": skipped, "counterexamples": counterexamples}


def check_postcondition(fn, domain, predicate, maximum):
    counterexamples = []
    checked = 0
    for args in domain:
        observation = observe(fn, args)
        result = observation.get("value") if observation["ok"] else None
        checked += 1
        if not predicate(copy.deepcopy(args), result, observation):
            counterexamples.append({"args": args, "observation": observation})
            if len(counterexamples) >= maximum: break
    return {"checked": checked, "counterexamples": counterexamples}


def mutation_check(source, tests, domain, may_change, postcondition, maximum):
    replacements = [(r">=", ">"), (r">", ">="), (r"<=", "<"), (r"<", "<="), (r"\+\s*1", "- 1"), (r"-\s*1", "+ 1"), (r"return\s+max\b", "return min"), (r"return\s+min\b", "return max"), (r"\[:\s*limit\s*\]", "[:limit - 1]")]
    mutants, seen = [], set()
    for pattern, replacement in replacements:
        mutated = re.sub(pattern, replacement, source)
        if mutated != source and mutated not in seen:
            seen.add(mutated)
            mutants.append({"label": pattern, "source": mutated})
    mutants = mutants[:8]
    if not mutants:
        return {"total": 0, "killed": 0, "score": 0.5, "survivors": [], "note": "No simple source mutants could be generated."}
    original = compile_function(source)["fn"]
    killed, survivors = 0, []
    for mutant in mutants:
        try:
            fn = compile_function(mutant["source"])["fn"]
        except Exception:
            killed += 1
            continue
        failed = run_tests(fn, tests)["failCount"] > 0 or bool(check_preservation(original, fn, domain, may_change, maximum)["counterexamples"]) or bool(check_postcondition(fn, domain, postcondition, maximum)["counterexamples"])
        if failed: killed += 1
        else: survivors.append(mutant["label"])
    return {"total": len(mutants), "killed": killed, "score": killed / len(mutants), "survivors": survivors}


def build_domain(tests, limits, precondition):
    arity = max(len(test["args"]) for test in tests)
    values = [values_for_index(tests, index) for index in range(arity)]
    results, current = [], []
    explored, max_explored = 0, max(limits["maxDomainSize"] * 100, 10000)
    def visit(index):
        nonlocal explored
        if len(results) >= limits["maxDomainSize"] or explored >= max_explored: return
        if index == len(values):
            explored += 1
            if precondition(copy.deepcopy(current), None, None): results.append(copy.deepcopy(current))
            return
        for value in values[index]:
            current.append(value); visit(index + 1); current.pop()
            if len(results) >= limits["maxDomainSize"] or explored >= max_explored: break
    visit(0)
    return results


def values_for_index(tests, index):
    observed = [test["args"][index] for test in tests if index < len(test["args"])]
    values = []
    for value in observed: push_unique(values, value)
    if any(isinstance(value, (int, float)) and not isinstance(value, bool) for value in observed):
        for value in [-10, -5, -1, 0, 1, 2, 3, 5, 6, 9, 10, 11, 12, 20]: push_unique(values, value)
        for value in observed:
            if isinstance(value, (int, float)) and not isinstance(value, bool): push_unique(values, value - 1); push_unique(values, value + 1)
    if any(isinstance(value, str) for value in observed):
        for value in ["", " ", "Hello", "Hello World", "Hello   World", "  API Client  ", "red blue green", "Already-Ok", "tabs\tand spaces", "MiXeD Case"]: push_unique(values, value)
    if any(isinstance(value, list) for value in observed):
        for value in [[], [1], [1, 2], [1, 2, 3], [0, 0, 0], ["a", "b", "c"]]: push_unique(values, value)
    return values[:18]


def push_unique(values, candidate):
    if candidate not in values: values.append(copy.deepcopy(candidate))


def evidence_score(fixed, explicit, preserve, post, mutation, proof, domain_size):
    score = (0.16 if fixed else 0) + (0.22 if explicit else 0) + (0.22 if preserve else 0) + (0.18 if post else 0) + (0.1 if proof == "no-counterexample-in-finite-envelope" else 0) + min(0.12, mutation * 0.12)
    if domain_size < 20: score -= 0.05
    return max(0, min(1, score))


def build_certificate(data, started_at, old_program, baseline, bug_tests, passing_tests, domain, candidates, selected):
    residual = []
    if not bug_tests: residual.append("No failing test was observed before repair, so PatchProof refused certification.")
    if len(domain) < 100: residual.append("Finite behavioral envelope is small; add tests to broaden generated inputs.")
    if not data["postconditionText"].strip(): residual.append("No postcondition was provided, so bug-fix proof is limited to explicit tests.")
    if not selected.get("boundedProof") or selected["boundedProof"]["status"] != "no-counterexample-in-finite-envelope": residual.append("Selected patch has at least one bounded counterexample.")
    if selected.get("mutation", {}).get("survivors"): residual.append(f"{len(selected['mutation']['survivors'])} simple patch mutants survived validation.")
    replay_input = {key: data[key] for key in ("language", "source", "testsText", "bugReport", "preconditionText", "mayChangeText", "postconditionText", "executionMode", "candidatePatches", "modelProvenance", "limits")}
    run_id = fnv_hash(json.dumps(replay_input, sort_keys=True, separators=(",", ":")))
    validation = {"compileError": selected["compileError"]} if not selected.get("explicitTests") else {
        "explicitTests": {"passed": selected["explicitTests"]["passCount"], "failed": selected["explicitTests"]["failCount"], "total": len(selected["explicitTests"]["tests"]), "fixedFailingTests": selected["fixedFailingTests"]},
        "behavioralPreservation": {"checkedCases": selected["preservation"]["checked"], "mayChangeCases": selected["preservation"]["skippedMayChange"], "counterexamples": selected["preservation"]["counterexamples"]},
        "postcondition": {"checkedCases": selected["postcondition"]["checked"], "counterexamples": selected["postcondition"]["counterexamples"]},
        "boundedProof": selected["boundedProof"], "mutation": selected["mutation"],
    }
    return {
        "schema": CERTIFICATE_SCHEMA, "verifierVersion": PATCHPROOF_VERSION, "runId": run_id,
        "status": "certified" if selected["accepted"] else "rejected", "generatedAt": started_at,
        "target": {"language": "python", "function": old_program["name"], "execution": data["executionMode"]},
        "bugEvidence": {"report": data["bugReport"], "failingBefore": [item["name"] for item in bug_tests], "passingBefore": [item["name"] for item in passing_tests]},
        "selectedPatch": {"id": selected["id"], "template": selected["templateId"], "accepted": selected["accepted"], "evidenceScore": round(selected["evidenceScore"], 3), "fixedBug": selected["fixedBug"], "riskTags": selected["risk"], "generator": selected["generator"], "provenance": selected.get("provenance"), "source": selected["source"], "diff": selected["diff"], "rejectionReasons": selected["rejectionReasons"]},
        "validation": validation,
        "candidateSummary": [{"id": item["id"], "title": item["title"], "generator": item["generator"], "provenance": item.get("provenance"), "accepted": item["accepted"], "evidenceScore": round(item["evidenceScore"], 3), "compileError": item["compileError"], "rejectionReasons": item["rejectionReasons"], "failedTests": [test["name"] for test in (item.get("explicitTests") or {}).get("tests", []) if not test["pass"]]} for item in candidates],
        "behavioralEnvelope": {"precondition": data["preconditionText"], "mayChangePredicate": data["mayChangeText"], "postcondition": data["postconditionText"], "finiteDomainSize": len(domain), "correctnessClaim": "The selected Python patch fixes the explicit tests and preserves old observations for generated inputs outside the may-change predicate. The postcondition is checked across the generated finite domain."},
        "repair": {"modelProvenance": data["modelProvenance"], "suppliedCandidates": len(data["candidatePatches"]), "evaluatedCandidates": len(candidates)},
        "limits": data["limits"], "residualRisk": residual,
        "replay": {"command": "patchproof verify certificate.json", "deterministic": True, "input": replay_input},
    }


def verify_certificate(certificate):
    mismatches = []
    if not isinstance(certificate, dict): return {"valid": False, "mismatches": ["Certificate must be a JSON object."], "reproduced": None}
    if certificate.get("schema") != CERTIFICATE_SCHEMA: mismatches.append(f"Unsupported schema: expected {CERTIFICATE_SCHEMA}, got {certificate.get('schema', 'missing')}.")
    replay = certificate.get("replay", {}).get("input")
    if not replay: return {"valid": False, "mismatches": mismatches + ["Certificate does not include replay.input."], "reproduced": None}
    reproduced = run_patchproof(replay)["certificate"]
    compare_values(certificate, reproduced, "certificate", mismatches)
    return {"valid": not mismatches, "mismatches": mismatches, "reproduced": reproduced}


def compare_values(expected, actual, path, mismatches):
    if len(mismatches) >= 25 or path == "certificate.generatedAt" or expected == actual: return
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(set(expected) | set(actual)): compare_values(expected.get(key), actual.get(key), f"{path}.{key}", mismatches)
    elif isinstance(expected, list) and isinstance(actual, list):
        for index in range(max(len(expected), len(actual))): compare_values(expected[index] if index < len(expected) else None, actual[index] if index < len(actual) else None, f"{path}[{index}]", mismatches)
    else: mismatches.append(f"{path} mismatch: expected {short(expected)}, got {short(actual)}.")


def short(value):
    text = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return text if len(text) <= 160 else text[:157] + "..."


def fnv_hash(text):
    value = 2166136261
    for char in text:
        value ^= ord(char)
        value = (value * 16777619) & 0xffffffff
    return f"run_{value:08x}"


def unified_diff(old, new):
    return "\n".join(difflib.unified_diff(old.splitlines(), new.splitlines(), fromfile="old", tofile="new", lineterm="")) or "No diff generated."


def build_logs(baseline, candidates, selected, domain):
    rows = [f"Baseline: {baseline['passCount']}/{len(baseline['tests'])} tests passed before repair.", f"Generated finite behavioral envelope with {len(domain)} input combinations."]
    for item in candidates:
        tests = f"{item['explicitTests']['passCount']}/{len(item['explicitTests']['tests'])}" if item.get("explicitTests") else "compile error"
        rows.append(f"{item['id']}: {'accepted' if item['accepted'] else 'rejected'}; tests={tests}; score={item['evidenceScore']:.2f}")
    rows.append(f"Selected {selected['id']} with evidence score {selected['evidenceScore']:.2f}.")
    return rows


if __name__ == "__main__":
    main()
